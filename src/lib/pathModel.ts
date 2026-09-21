/**
 * Internal typed path model.
 *
 * All field-path handling in the library (server errors, client validation,
 * tainted, constraints, snapshots, proxies) converges on this single
 * representation, instead of every entry point interpreting path strings
 * on its own.
 *
 * A {@link TypedPath} is a list of segments that explicitly distinguishes
 * object keys from array indices:
 *
 * ```ts
 * { kind: 'key', key: 'tags' } | { kind: 'index', index: 0 }
 * ```
 *
 * The public string format stays compatible with what the library has
 * always produced and consumed (`tags[0]`, `user.name`), with the addition
 * of a quoted escape form for keys that contain special characters:
 *
 * - `tags[0]`        -> key 'tags', index 0
 * - `user.name`      -> key 'user', key 'name'
 * - `["weird.key"]`  -> single key 'weird.key'
 * - `a['b[0]']`      -> key 'a', key 'b[0]'
 * - `a["0"]`         -> key '0' (an actual string key, not an index)
 *
 * Safety boundaries (same as the previous scattered implementations):
 *
 * - The root path (empty string / empty path) is valid to read, but cannot
 *   be set or deleted (a no-op, as before).
 * - Empty unquoted segments (`a..b`, `a[]`) are ignored, as before.
 * - Out-of-bounds array indices read as `undefined`; deleting them is a
 *   no-op; setting them extends the array (previous behavior).
 * - `__proto__` and `prototype` segments throw on set/delete/traverse,
 *   and never resolve through the prototype chain on read.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type PathSegment =
	| { readonly kind: 'key'; readonly key: string }
	| { readonly kind: 'index'; readonly index: number };

export type TypedPath = readonly PathSegment[];

export type PropertyPath = readonly (string | number | symbol)[];

const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'prototype']);

function assertSafeSegments(path: TypedPath) {
	for (const seg of path) {
		if (seg.kind === 'key' && PROTO_POLLUTION_KEYS.has(seg.key)) {
			throw new Error("Cannot set an object's `__proto__` or `prototype` property");
		}
	}
}

///// Segment constructors //////////////////////////////////////////

export function keySegment(key: string): PathSegment {
	return { kind: 'key', key };
}

export function indexSegment(index: number): PathSegment {
	if (!Number.isInteger(index) || index < 0) {
		throw new Error(`Invalid array index in path: ${index}`);
	}
	return { kind: 'index', index };
}

///// Parsing ///////////////////////////////////////////////////////

const NUMERIC_KEY = /^\d+$/;

/**
 * Parse a string path into a typed path.
 * The root path (`''`) parses to an empty path.
 */
export function parsePath(path: string): TypedPath {
	const segments: PathSegment[] = [];
	const str = String(path);
	const len = str.length;
	let pos = 0;
	let current = '';
	let hasCurrent = false;

	const flushKey = () => {
		if (!hasCurrent) return;
		// A bare numeric segment in dot/bracket position is an array index,
		// matching the historical splitPath/mergePath contract.
		if (NUMERIC_KEY.test(current)) segments.push({ kind: 'index', index: Number(current) });
		else segments.push({ kind: 'key', key: current });
		current = '';
		hasCurrent = false;
	};

	while (pos < len) {
		const ch = str[pos];

		if (ch === '.') {
			flushKey();
			pos++;
			continue;
		}

		if (ch === '[') {
			flushKey();
			pos++;
			// Skip whitespace
			while (pos < len && str[pos] === ' ') pos++;

			const quote = str[pos];
			if (quote === '"' || quote === "'") {
				// Quoted key escape form: ["weird.key"]
				pos++;
				let key = '';
				let closed = false;
				while (pos < len) {
					const c = str[pos];
					if (c === '\\' && pos + 1 < len) {
						key += str[pos + 1];
						pos += 2;
						continue;
					}
					if (c === quote) {
						closed = true;
						pos++;
						break;
					}
					key += c;
					pos++;
				}
				if (!closed) {
					// Unterminated quote: treat the rest as a plain key,
					// keeping historical leniency for malformed paths.
					key += '';
				}
				// Consume up to and including the closing bracket
				while (pos < len && str[pos] !== ']') pos++;
				if (pos < len) pos++;
				// A quoted segment is always an object key, even if numeric
				// or empty - it is the explicit escape form.
				segments.push({ kind: 'key', key });
				continue;
			}

			// Unquoted bracket content: [0], [key]
			let content = '';
			while (pos < len && str[pos] !== ']') {
				content += str[pos];
				pos++;
			}
			if (pos < len) pos++; // consume ']'
			content = content.trim();
			if (!content) continue; // Empty brackets are ignored, as before
			if (NUMERIC_KEY.test(content)) segments.push({ kind: 'index', index: Number(content) });
			else segments.push({ kind: 'key', key: content });
			continue;
		}

		current += ch;
		hasCurrent = true;
		pos++;
	}
	flushKey();

	return segments;
}

///// Formatting ////////////////////////////////////////////////////

const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function formatKey(key: string): string {
	if (SAFE_KEY.test(key)) return key;
	// Escape form for keys containing special characters (including
	// numeric-only keys, which would otherwise parse back as indices).
	return `["${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

/**
 * Format a typed path as a string. The output is canonical:
 * `parsePath(formatPath(p))` is a stable round-trip.
 */
export function formatPath(path: TypedPath): string {
	let output = '';
	for (const seg of path) {
		if (seg.kind === 'index') {
			output += `[${seg.index}]`;
		} else {
			const key = formatKey(seg.key);
			output += output && !key.startsWith('[') ? `.${key}` : key;
		}
	}
	return output;
}

///// Conversion to/from legacy property-key arrays /////////////////

/**
 * Convert a typed path to a plain property-key array, for interop with
 * low-level traversal. Indices become numbers, keys stay strings.
 */
export function toPropertyKeys(path: TypedPath): (string | number)[] {
	return path.map((seg) => (seg.kind === 'index' ? seg.index : seg.key));
}

/**
 * Convert a legacy property-key array (as produced by object traversal)
 * to a typed path. Numbers and numeric strings become indices, matching
 * the historical mergePath contract.
 */
export function fromPropertyKeys(path: PropertyPath): TypedPath {
	const segments: PathSegment[] = [];
	for (const part of path) {
		if (typeof part === 'number') {
			segments.push({ kind: 'index', index: part });
		} else {
			const key = String(part);
			if (NUMERIC_KEY.test(key)) segments.push({ kind: 'index', index: Number(key) });
			else segments.push({ kind: 'key', key });
		}
	}
	return segments;
}

///// Comparison ////////////////////////////////////////////////////

export function pathEquals(a: TypedPath, b: TypedPath): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const segA = a[i];
		const segB = b[i];
		if (segA.kind !== segB.kind) return false;
		if (segA.kind === 'key' && segB.kind === 'key' && segA.key !== segB.key) return false;
		if (segA.kind === 'index' && segB.kind === 'index' && segA.index !== segB.index) return false;
	}
	return true;
}

/**
 * Returns true if `path` starts with `prefix` (a proper or improper prefix).
 */
export function pathStartsWith(path: TypedPath, prefix: TypedPath): boolean {
	if (prefix.length > path.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		const segA = path[i];
		const segB = prefix[i];
		if (segA.kind !== segB.kind) return false;
		if (segA.kind === 'key' && segB.kind === 'key' && segA.key !== segB.key) return false;
		if (segA.kind === 'index' && segB.kind === 'index' && segA.index !== segB.index) return false;
	}
	return true;
}

/**
 * Canonical string key for a path, usable as a Map/Set key.
 */
export function pathKey(path: TypedPath): string {
	return formatPath(path);
}

///// Reading ///////////////////////////////////////////////////////

/**
 * Safe read of a typed path. Never resolves through the prototype chain;
 * missing or out-of-bounds segments read as `undefined`.
 * The root path reads as the object itself.
 */
export function getPath(obj: unknown, path: TypedPath): unknown {
	let current = obj;
	for (const seg of path) {
		if (current === null || typeof current !== 'object') return undefined;
		const key = seg.kind === 'index' ? seg.index : seg.key;
		if (PROTO_POLLUTION_KEYS.has(String(key))) return undefined;
		if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
		current = (current as Record<PropertyKey, unknown>)[key];
	}
	return current;
}

///// Immutable update & delete /////////////////////////////////////

function cloneContainer(value: unknown, nextKind: PathSegment['kind'] | undefined): any {
	if (Array.isArray(value)) return value.slice();
	if (value !== null && typeof value === 'object') return { ...value };
	// Missing or scalar node: create the container the path requires.
	return nextKind === 'index' ? [] : {};
}

/**
 * Immutable set with structural sharing: only the containers along the
 * path are copied, every other branch keeps its identity. The hot path
 * never deep-clones the whole form.
 *
 * Setting the root path is a no-op (historical contract).
 */
export function setPathImmutable<T>(obj: T, path: TypedPath, value: unknown): T {
	assertSafeSegments(path);
	if (!path.length) return obj;

	const setAt = (node: unknown, depth: number): unknown => {
		const seg = path[depth];
		// The container kind is determined by the current segment:
		// an index segment requires an array, a key segment an object.
		const next = cloneContainer(node, seg.kind);
		const key = seg.kind === 'index' ? seg.index : seg.key;
		next[key] = depth === path.length - 1 ? value : setAt(nodeValue(node, key), depth + 1);
		return next;
	};

	return setAt(obj, 0) as T;
}

function nodeValue(node: unknown, key: PropertyKey): unknown {
	if (node === null || typeof node !== 'object') return undefined;
	if (PROTO_POLLUTION_KEYS.has(String(key))) return undefined;
	return (node as Record<PropertyKey, unknown>)[key];
}

/**
 * Immutable delete with structural sharing. Deleting an array index
 * splices the array (elements shift down); deleting an object key removes
 * it. Out-of-bounds and missing paths are a no-op, as is the root path.
 */
export function deletePathImmutable<T>(obj: T, path: TypedPath): T {
	assertSafeSegments(path);
	if (!path.length || obj === null || typeof obj !== 'object') return obj;

	const deleteAt = (node: unknown, depth: number): unknown => {
		if (node === null || typeof node !== 'object') return node;
		const seg = path[depth];
		const key = seg.kind === 'index' ? seg.index : seg.key;
		if (!Object.prototype.hasOwnProperty.call(node, key)) return node;

		if (depth === path.length - 1) {
			if (Array.isArray(node) && seg.kind === 'index') {
				const copy = node.slice();
				copy.splice(seg.index, 1);
				return copy;
			}

			const copy: any = Array.isArray(node) ? node.slice() : { ...node };
			delete copy[key];
			return copy;
		}

		const child = deleteAt((node as Record<PropertyKey, unknown>)[key], depth + 1);
		if (child === (node as Record<PropertyKey, unknown>)[key]) return node;

		const copy: any = Array.isArray(node) ? node.slice() : { ...node };
		copy[key] = child;
		return copy;
	};

	return deleteAt(obj, 0) as T;
}

///// Array insert/remove path migration ////////////////////////////

export type ArrayChange = {
	readonly type: 'insert' | 'remove';
	readonly index: number;
	readonly count: number;
};

/**
 * Migrate a single typed path after elements were inserted into or
 * removed from an array at `arrayPath`. Returns the migrated path, or
 * `null` if the path pointed into a removed element. Paths outside the
 * array are returned unchanged. Operates on typed segments - never on
 * string replacement - so keys with special characters are unaffected.
 */
export function migratePathForArrayChange(
	path: TypedPath,
	arrayPath: TypedPath,
	change: ArrayChange
): TypedPath | null {
	if (!pathStartsWith(path, arrayPath) || path.length === arrayPath.length) {
		return path;
	}

	const seg = path[arrayPath.length];
	if (seg.kind !== 'index') return path;

	const { type, index, count } = change;

	if (type === 'remove') {
		if (seg.index < index) return path;
		if (seg.index < index + count) return null; // Belonged to a removed element
		return replaceSegment(path, arrayPath.length, {
			kind: 'index',
			index: seg.index - count
		});
	}

	// insert
	if (seg.index < index) return path;
	return replaceSegment(path, arrayPath.length, {
		kind: 'index',
		index: seg.index + count
	});
}

function replaceSegment(path: TypedPath, at: number, seg: PathSegment): TypedPath {
	return path.map((existing, i) => (i === at ? seg : existing));
}

/**
 * Remap all element-indexed entries of a subtree node (the object stored
 * at an array path in errors/tainted structures) after an array change.
 * Index keys are shifted, entries for removed elements are dropped, and
 * non-index keys (like `_errors`) are preserved. Returns a new object;
 * the input is not mutated.
 */
export function remapArrayNode<T extends Record<string, unknown>>(node: T, change: ArrayChange): T {
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(node)) {
		if (!NUMERIC_KEY.test(key)) {
			output[key] = node[key];
			continue;
		}
		const idx = Number(key);
		if (change.type === 'remove') {
			if (idx < change.index) output[key] = node[key];
			else if (idx >= change.index + change.count) output[String(idx - change.count)] = node[key];
			// Entries in the removed range are dropped
		} else {
			if (idx < change.index) output[key] = node[key];
			else output[String(idx + change.count)] = node[key];
		}
	}
	return output as T;
}

/**
 * Detect a single contiguous insertion or removal between two versions of
 * an array, by element identity (prefix/suffix comparison). Returns
 * `undefined` when the change is ambiguous (in-place edits, reorderings),
 * in which case callers should fall back to their previous contract.
 */
export function detectArrayChange(
	oldArray: readonly unknown[],
	newArray: readonly unknown[]
): ArrayChange | undefined {
	if (oldArray === newArray) return undefined;
	const oldLength = oldArray.length;
	const newLength = newArray.length;
	if (oldLength === newLength) return undefined;

	let prefix = 0;
	const minLength = Math.min(oldLength, newLength);
	while (prefix < minLength && oldArray[prefix] === newArray[prefix]) prefix++;

	let suffix = 0;
	while (
		suffix < minLength - prefix &&
		oldArray[oldLength - 1 - suffix] === newArray[newLength - 1 - suffix]
	) {
		suffix++;
	}

	const oldMiddle = oldLength - prefix - suffix;
	const newMiddle = newLength - prefix - suffix;

	if (oldMiddle === 0 && newMiddle > 0) {
		return { type: 'insert', index: prefix, count: newMiddle };
	}
	if (newMiddle === 0 && oldMiddle > 0) {
		return { type: 'remove', index: prefix, count: oldMiddle };
	}
	return undefined;
}
