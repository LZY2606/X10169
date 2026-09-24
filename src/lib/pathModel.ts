/**
 * Internal typed path model.
 *
 * A single, shared representation for field paths, used by server-side error
 * mapping, client validation, tainted/constraints stores and snapshot restore.
 * Instead of every entry point splitting/joining path strings on its own,
 * paths are parsed once into typed segments that explicitly distinguish
 * object keys from array indices.
 *
 * String format (compatible with the previous splitPath/mergePath behavior):
 *
 *   user.addresses[0].city   -> key(user), key(addresses), index(0), key(city)
 *   ["a.b"].x                -> key("a.b"), key(x)   (quoted key, for special chars)
 *   ''                       -> root path (empty segment list)
 *
 * Keys containing dots, brackets, quotes or backslashes, empty keys, and
 * (for disambiguation) purely numeric keys are stored as key segments and
 * formatted with the quoted form. Numeric strings normalize to index
 * segments, matching the historical mergePath contract.
 */

export type PathSegment =
	| { readonly kind: 'key'; readonly key: string }
	| { readonly kind: 'index'; readonly index: number };

export type FieldPath = readonly PathSegment[];

const NUMERIC = /^\d+$/;

/**
 * Keys that must never be written, to prevent prototype pollution.
 * Same security boundary as traversal.ts.
 */
function assertSafeKey(key: string) {
	if (key === '__proto__' || key === 'prototype') {
		throw new Error("Cannot set an object's `__proto__` or `prototype` property");
	}
}

function isUnsafeKey(key: string) {
	return key === '__proto__' || key === 'prototype' || key === 'constructor';
}

/**
 * Parse a string path into typed segments.
 * The root path ('') parses to an empty segment list.
 */
export function parsePath(path: string): PathSegment[] {
	const segments: PathSegment[] = [];
	const n = path.length;
	let i = 0;
	let key = '';

	function pushKey() {
		if (key !== '') {
			segments.push({ kind: 'key', key });
			key = '';
		}
	}

	while (i < n) {
		const ch = path[i];

		if (ch === '.') {
			pushKey();
			i++;
		} else if (ch === '[') {
			pushKey();
			const next = path[i + 1];
			if (next === '"' || next === "'") {
				// Quoted key: ["a.b"] or ['a.b'], backslash escapes the next char.
				const quote = next;
				let j = i + 2;
				let quoted = '';
				while (j < n && path[j] !== quote) {
					if (path[j] === '\\' && j + 1 < n) {
						quoted += path[j + 1];
						j += 2;
					} else {
						quoted += path[j];
						j++;
					}
				}
				segments.push({ kind: 'key', key: quoted });
				// Skip closing quote and bracket, if present.
				i = j < n ? j + 1 : n;
				if (path[i] === ']') i++;
			} else {
				const close = path.indexOf(']', i);
				const content = close === -1 ? path.slice(i + 1) : path.slice(i + 1, close);
				if (NUMERIC.test(content)) {
					segments.push({ kind: 'index', index: parseInt(content, 10) });
				} else if (content !== '') {
					segments.push({ kind: 'key', key: content });
				}
				i = close === -1 ? n : close + 1;
			}
		} else if (ch === ']') {
			// Stray bracket, treated as a separator for backwards compatibility.
			pushKey();
			i++;
		} else {
			key += ch;
			i++;
		}
	}
	pushKey();

	return segments;
}

const SAFE_KEY = /^(?!\d+$)[^.[\]"'\\]+$/;

/**
 * Format typed segments into the canonical string representation.
 * Inverse of parsePath: parsePath(formatPath(segments)) deep-equals segments.
 */
export function formatPath(segments: FieldPath): string {
	let out = '';
	for (const seg of segments) {
		if (seg.kind === 'index') {
			out += `[${seg.index}]`;
		} else if (SAFE_KEY.test(seg.key)) {
			out += out ? `.${seg.key}` : seg.key;
		} else {
			out += `["${seg.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
		}
	}
	return out;
}

/**
 * Normalize a key array (from validators, traversal, etc.) into typed segments.
 * Numbers and numeric strings become index segments, everything else a key.
 */
export function segmentsFromArray(path: readonly (string | number | symbol)[]): PathSegment[] {
	return path.map((p) => {
		if (typeof p === 'number') return { kind: 'index', index: p } as const;
		const key = String(p);
		if (NUMERIC.test(key)) return { kind: 'index', index: parseInt(key, 10) } as const;
		return { kind: 'key', key } as const;
	});
}

/**
 * Normalize any supported path representation into typed segments.
 */
export function normalizePath(path: string | readonly (string | number | symbol)[]): PathSegment[] {
	return typeof path === 'string' ? parsePath(path) : segmentsFromArray(path);
}

/**
 * Convert typed segments back to a plain key array for traversal interop.
 */
export function toKeyArray(segments: FieldPath): (string | number)[] {
	return segments.map((seg) => (seg.kind === 'index' ? seg.index : seg.key));
}

/**
 * The path with all array indices removed. Used for lookups in structures
 * that don't contain indices, like the schema shape and constraints.
 */
export function objectPath(segments: FieldPath): PathSegment[] {
	return segments.filter((seg) => seg.kind === 'key');
}

/**
 * Structural equality for two typed paths.
 */
export function pathsEqual(a: FieldPath, b: FieldPath): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x.kind !== y.kind) return false;
		if (x.kind === 'key' && y.kind === 'key' && x.key !== y.key) return false;
		if (x.kind === 'index' && y.kind === 'index' && x.index !== y.index) return false;
	}
	return true;
}

function ownValue(obj: object, key: string): unknown {
	return Object.prototype.hasOwnProperty.call(obj, key)
		? (obj as Record<string, unknown>)[key]
		: undefined;
}

/**
 * Safe read of a typed path. Returns undefined for missing paths and for
 * prototype-pollution related keys. Never throws.
 */
export function getPath(obj: unknown, segments: FieldPath): unknown {
	let current = obj;
	for (const seg of segments) {
		if (current === null || current === undefined || typeof current !== 'object') {
			return undefined;
		}
		if (seg.kind === 'index') {
			if (!Array.isArray(current)) return undefined;
			if (seg.index < 0 || seg.index >= current.length) return undefined;
			current = current[seg.index];
		} else {
			if (isUnsafeKey(seg.key)) return undefined;
			current = ownValue(current, seg.key);
		}
	}
	return current;
}

/**
 * Immutable update of a typed path with structural sharing: only the
 * branches along the path are copied, everything else keeps its identity.
 * An empty path replaces the root. Throws on prototype-pollution keys.
 */
export function setPathImmutable<T>(obj: T, segments: FieldPath, value: unknown): T {
	if (!segments.length) return value as T;
	for (const seg of segments) {
		if (seg.kind === 'key') assertSafeKey(seg.key);
	}
	return setIn(obj, segments, 0, value) as T;
}

function setIn(node: unknown, segments: FieldPath, at: number, value: unknown): unknown {
	const seg = segments[at];
	const last = at === segments.length - 1;

	if (seg.kind === 'index') {
		const arr = Array.isArray(node) ? node.slice() : [];
		arr[seg.index] = last ? value : setIn(arr[seg.index], segments, at + 1, value);
		return arr;
	}

	const obj: Record<string, unknown> = node !== null && typeof node === 'object' ? { ...node } : {};
	obj[seg.key] = last ? value : setIn(obj[seg.key], segments, at + 1, value);
	return obj;
}

/**
 * Immutable delete of a typed path with structural sharing.
 *
 * Deleting an array index splices the array, so subsequent elements (and
 * thereby their paths) shift down by element position, matching the public
 * contract for array element removal. Deleting an object key removes the
 * key. Missing parents, out-of-bounds indices and the root path are no-ops
 * returning the original object.
 */
export function deletePath<T>(obj: T, segments: FieldPath): T {
	if (!segments.length) return obj;
	for (const seg of segments) {
		if (seg.kind === 'key') assertSafeKey(seg.key);
	}
	return deleteIn(obj, segments, 0) as T;
}

function deleteIn(node: unknown, segments: FieldPath, at: number): unknown {
	if (node === null || node === undefined || typeof node !== 'object') return node;

	const seg = segments[at];
	const last = at === segments.length - 1;

	if (last) {
		if (seg.kind === 'index') {
			if (!Array.isArray(node) || seg.index < 0 || seg.index >= node.length) return node;
			return node.slice(0, seg.index).concat(node.slice(seg.index + 1));
		}
		if (Array.isArray(node) || !Object.prototype.hasOwnProperty.call(node, seg.key)) return node;
		const copy = { ...(node as Record<string, unknown>) };
		delete copy[seg.key];
		return copy;
	}

	const child =
		seg.kind === 'index'
			? Array.isArray(node)
				? node[seg.index]
				: undefined
			: (node as Record<string, unknown>)[seg.key];

	if (child === null || child === undefined || typeof child !== 'object') return node;

	const newChild = deleteIn(child, segments, at + 1);
	if (newChild === child) return node;

	if (seg.kind === 'index') {
		const arr = (node as unknown[]).slice();
		arr[seg.index] = newChild;
		return arr;
	}
	const copy = { ...(node as Record<string, unknown>) };
	copy[seg.key] = newChild;
	return copy;
}

/**
 * Migrate a node (errors/tainted style object, or an array) after elements
 * have been removed from the array it mirrors. Entries below a removed index
 * keep their position, entries above shift down, entries at removed indices
 * are dropped. Non-numeric keys (like `_errors`) are preserved.
 */
export function removeArrayIndices<T>(node: T, removed: readonly number[]): T {
	if (!removed.length || node === null || node === undefined || typeof node !== 'object') {
		return node;
	}

	const sorted = [...removed].sort((a, b) => b - a);

	if (Array.isArray(node)) {
		const copy = node.slice() as unknown[];
		for (const index of sorted) {
			if (index >= 0 && index < copy.length) copy.splice(index, 1);
		}
		return copy as T;
	}

	const shift = (index: number) => {
		let output = index;
		for (const r of sorted) {
			if (index > r) output--;
		}
		return output;
	};

	const removedSet = new Set(removed);
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(node as Record<string, unknown>)) {
		const value = (node as Record<string, unknown>)[key];
		if (NUMERIC.test(key)) {
			const index = parseInt(key, 10);
			if (removedSet.has(index)) continue;
			output[String(shift(index))] = value;
		} else {
			output[key] = value;
		}
	}
	return output as T;
}
