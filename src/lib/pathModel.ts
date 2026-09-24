/**
 * Internal typed field-path model.
 *
 * All parsing, normalization, reading, immutable updating and deletion of
 * field paths is centralized here, so that server errors, client validation,
 * tainted state, constraints and snapshot restore all consume the same
 * representation instead of re-interpreting path strings on their own.
 *
 * A path is a list of segments. Each segment is either an object key or an
 * array index, so keys that merely *look* numeric can be told apart from
 * real array indices, and keys containing `.`, `[`, `]` or quotes round-trip
 * safely through the string format using a quoted bracket escape form:
 *
 *   tags[0].label           [key tags, index 0, key label]
 *   meta["weird.key"]       [key meta, key "weird.key"]
 *   ["a.b"].c               [key "a.b", key c]
 */

export type PathSegment =
	| { readonly kind: 'key'; readonly key: string }
	| { readonly kind: 'index'; readonly index: number };

export type FieldPath = readonly PathSegment[];

/**
 * Keys that must never be written, to prevent prototype pollution.
 * Matches the safety boundary previously enforced by traversal.ts.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'prototype']);

export class PathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PathError';
	}
}

function assertSafeKey(key: string) {
	if (UNSAFE_KEYS.has(key)) {
		throw new PathError("Cannot set an object's `__proto__` or `prototype` property");
	}
}

export function assertSafePath(path: FieldPath): void {
	for (const seg of path) {
		if (seg.kind === 'key') assertSafeKey(seg.key);
	}
}

function assertValidIndex(index: number) {
	if (!Number.isInteger(index) || index < 0) {
		throw new PathError(`Invalid array index in path: ${index}`);
	}
}

///// Parsing //////////////////////////////////////////////////////////////////

function unquote(content: string): string {
	try {
		return JSON.parse(content) as string;
	} catch {
		// Tolerate malformed quoting by stripping the surrounding quotes.
		return content.replace(/^"|"$/g, '');
	}
}

/**
 * Parse a string path into typed segments.
 *
 * - `a.b[0].c` - regular object/array access.
 * - `a.0` - a bare numeric segment is normalized to an array index,
 *   matching the historical splitPath/mergePath normalization.
 * - `["key.with[special]chars"]` - quoted bracket escape form for keys
 *   containing `.`, `[`, `]`, quotes or backslashes, and for keys that are
 *   empty or fully numeric.
 * - The empty string is the root path and parses to zero segments.
 */
export function parseFieldPath(path: string): PathSegment[] {
	const segments: PathSegment[] = [];
	if (path === '') return segments;

	const pushBare = (bare: string) => {
		if (bare === '') return;
		if (/^\d+$/.test(bare)) segments.push({ kind: 'index', index: Number(bare) });
		else segments.push({ kind: 'key', key: bare });
	};

	let bare = '';
	let i = 0;
	while (i < path.length) {
		const ch = path[i];
		if (ch === '.') {
			pushBare(bare);
			bare = '';
			i++;
			continue;
		}
		if (ch === '[') {
			pushBare(bare);
			bare = '';
			// Find the closing bracket, honoring quoted strings with escapes.
			let j = i + 1;
			let content = '';
			if (path[j] === '"') {
				let closed = false;
				while (j < path.length) {
					if (path[j] === '\\') {
						content += path[j] + (path[j + 1] ?? '');
						j += 2;
						continue;
					}
					if (path[j] === '"') {
						j++;
						closed = true;
						break;
					}
					content += path[j];
					j++;
				}
				if (closed && path[j] === ']') {
					segments.push({ kind: 'key', key: unquote('"' + content + '"') });
					i = j + 1;
					continue;
				}
				// Malformed quoted segment; treat the rest as a bare key.
				segments.push({ kind: 'key', key: unquote('"' + content + '"') });
				i = j;
				continue;
			}
			while (j < path.length && path[j] !== ']') {
				content += path[j];
				j++;
			}
			if (j < path.length) {
				// Closed bracket
				if (content === '') {
					// Empty brackets carry no segment (historical behavior).
				} else if (/^\d+$/.test(content)) {
					segments.push({ kind: 'index', index: Number(content) });
				} else {
					segments.push({ kind: 'key', key: content });
				}
				i = j + 1;
				continue;
			}
			// Unterminated bracket; treat the rest as a bare key.
			pushBare(content);
			i = j;
			continue;
		}
		bare += ch;
		i++;
	}
	pushBare(bare);

	return segments;
}

///// Formatting ///////////////////////////////////////////////////////////////

// Keys that can be written bare without changing meaning when reparsed:
// non-empty, not fully numeric (would reparse as an index) and without
// any character that is structural in the string format.
const BARE_KEY = /^(?!\d+$)[^.\[\]"\\]+$/;

/**
 * Format typed segments into the canonical string representation.
 * Inverse of parseFieldPath: parseFieldPath(formatFieldPath(p)) deep-equals p.
 */
export function formatFieldPath(path: FieldPath): string {
	let output = '';
	for (const seg of path) {
		if (seg.kind === 'index') {
			assertValidIndex(seg.index);
			output += `[${seg.index}]`;
		} else if (BARE_KEY.test(seg.key)) {
			output += output ? '.' + seg.key : seg.key;
		} else {
			output += `[${JSON.stringify(seg.key)}]`;
		}
	}
	return output;
}

///// Conversion ///////////////////////////////////////////////////////////////

/**
 * Convert a loose path array (as produced by tree traversal) into typed
 * segments. Numbers become indices; fully numeric strings become indices
 * (historical mergePath contract); everything else becomes an object key.
 */
export function segmentsFromPathArray(path: readonly (string | number | symbol)[]): PathSegment[] {
	return path.map((part) => {
		if (typeof part === 'number') {
			if (Number.isInteger(part) && part >= 0) return { kind: 'index', index: part };
			return { kind: 'key', key: String(part) };
		}
		const key = String(part);
		if (typeof part === 'string' && /^\d+$/.test(key)) {
			return { kind: 'index', index: Number(key) };
		}
		return { kind: 'key', key };
	});
}

/**
 * Convert typed segments back to a plain key array, for consumption by the
 * mutable traversal engine in traversal.ts.
 */
export function segmentsToPathArray(path: FieldPath): (string | number)[] {
	return path.map((seg) => (seg.kind === 'index' ? seg.index : seg.key));
}

///// Comparison ///////////////////////////////////////////////////////////////

export function pathsEqual(a: FieldPath, b: FieldPath): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const sa = a[i];
		const sb = b[i];
		if (sa.kind !== sb.kind) return false;
		if (sa.kind === 'key' && sb.kind === 'key' && sa.key !== sb.key) return false;
		if (sa.kind === 'index' && sb.kind === 'index' && sa.index !== sb.index) return false;
	}
	return true;
}

export function isPathPrefix(prefix: FieldPath, path: FieldPath): boolean {
	if (prefix.length > path.length) return false;
	return pathsEqual(prefix, path.slice(0, prefix.length));
}

///// Reading //////////////////////////////////////////////////////////////////

/**
 * Read the value at a path. Returns undefined if any part is missing.
 * Throws on prototype-polluting keys, matching the traversal.ts boundary.
 */
export function getPath(obj: unknown, path: FieldPath): unknown {
	assertSafePath(path);
	let node = obj;
	for (const seg of path) {
		if (node === null || node === undefined || typeof node !== 'object') return undefined;
		if (seg.kind === 'index') {
			assertValidIndex(seg.index);
			node = Array.isArray(node)
				? node[seg.index]
				: (node as Record<string, unknown>)[String(seg.index)];
		} else {
			node = (node as Record<string, unknown>)[seg.key];
		}
	}
	return node;
}

///// Immutable updating ///////////////////////////////////////////////////////

function setIn(node: unknown, path: FieldPath, depth: number, value: unknown): unknown {
	const seg = path[depth];
	const last = depth === path.length - 1;

	if (seg.kind === 'index') {
		assertValidIndex(seg.index);
		if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
			// Numeric-like key on a plain object (errors/tainted trees).
			const copy = { ...(node as Record<string, unknown>) };
			copy[String(seg.index)] = last
				? value
				: setIn(copy[String(seg.index)], path, depth + 1, value);
			return copy;
		}
		const arr = Array.isArray(node) ? node.slice() : [];
		arr[seg.index] = last ? value : setIn(arr[seg.index], path, depth + 1, value);
		return arr;
	}

	const copy = (
		node !== null && typeof node === 'object'
			? Array.isArray(node)
				? node.slice()
				: { ...(node as Record<string, unknown>) }
			: {}
	) as Record<string, unknown>;
	copy[seg.key] = last ? value : setIn(copy[seg.key], path, depth + 1, value);
	return copy;
}

/**
 * Immutably set the value at a path, cloning only the containers along the
 * target branch (structural sharing). Sibling branches keep their identity,
 * so hot paths never deep-clone the whole form.
 *
 * The root path (zero segments) replaces the whole value.
 */
export function setPathImmutable<T>(obj: T, path: FieldPath, value: unknown): T {
	assertSafePath(path);
	if (!path.length) return value as T;
	return setIn(obj, path, 0, value) as T;
}

function deleteIn(node: unknown, path: FieldPath, depth: number): unknown {
	if (node === null || node === undefined || typeof node !== 'object') return node;
	const seg = path[depth];
	const last = depth === path.length - 1;

	if (seg.kind === 'index') {
		assertValidIndex(seg.index);
		if (Array.isArray(node)) {
			if (seg.index >= node.length) return node;
			const arr = node.slice();
			if (last) arr.splice(seg.index, 1);
			else arr[seg.index] = deleteIn(arr[seg.index], path, depth + 1);
			return arr;
		}
		const key = String(seg.index);
		if (!(key in node)) return node;
		const copy = { ...(node as Record<string, unknown>) };
		if (last) delete copy[key];
		else copy[key] = deleteIn(copy[key], path, depth + 1);
		return copy;
	}

	if (!(seg.key in (node as Record<string, unknown>))) return node;
	if (Array.isArray(node)) {
		const arr = node.slice() as unknown as Record<string, unknown>;
		if (last) delete arr[seg.key];
		else arr[seg.key] = deleteIn((node as unknown as Record<string, unknown>)[seg.key], path, depth + 1);
		return arr;
	}
	const copy = { ...(node as Record<string, unknown>) };
	if (last) delete copy[seg.key];
	else copy[seg.key] = deleteIn(copy[seg.key], path, depth + 1);
	return copy;
}

/**
 * Immutably delete the value at a path. Array indices are spliced out so
 * arrays stay contiguous; object keys are removed. Missing paths return the
 * original structure unchanged (same reference).
 */
export function deletePathImmutable<T>(obj: T, path: FieldPath): T {
	assertSafePath(path);
	if (!path.length) return undefined as T;
	return deleteIn(obj, path, 0) as T;
}

///// Array splice migration ///////////////////////////////////////////////////

/**
 * Remap a single path after an array splice, based on segment identity
 * rather than string replacement.
 *
 * - Paths outside the spliced array are returned unchanged.
 * - Paths pointing into the removed range return null (they must be dropped).
 * - Paths past the removed range are shifted by insertCount - deleteCount.
 */
export function remapPathForArraySplice(
	path: FieldPath,
	arrayPath: FieldPath,
	start: number,
	deleteCount: number,
	insertCount = 0
): FieldPath | null {
	if (!isPathPrefix(arrayPath, path)) return path;
	if (path.length === arrayPath.length) return path;

	const seg = path[arrayPath.length];
	const idx =
		seg.kind === 'index' ? seg.index : /^\d+$/.test(seg.key) ? Number(seg.key) : undefined;
	if (idx === undefined) return path; // e.g. an _errors key on the array itself

	if (idx < start) return path;
	if (idx < start + deleteCount) return null;

	const shifted = idx - deleteCount + insertCount;
	return [
		...path.slice(0, arrayPath.length),
		{ kind: 'index', index: shifted },
		...path.slice(arrayPath.length + 1)
	];
}

function remapContainerForSplice(
	node: unknown,
	start: number,
	deleteCount: number,
	insertCount: number
): unknown {
	if (Array.isArray(node)) {
		const copy = node.slice();
		copy.splice(start, deleteCount, ...new Array(insertCount).fill(undefined));
		return copy;
	}
	if (node !== null && typeof node === 'object') {
		// Errors/tainted trees store array item state under numeric keys.
		const output: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node)) {
			if (/^\d+$/.test(key)) {
				const idx = Number(key);
				if (idx < start) output[key] = value;
				else if (idx < start + deleteCount) continue;
				else output[String(idx - deleteCount + insertCount)] = value;
			} else {
				output[key] = value;
			}
		}
		return output;
	}
	return node;
}

/**
 * Immutably migrate a whole errors/tainted-shaped tree after an array in
 * the form data was spliced, so every store keeps pointing at the same
 * logical elements. Only the branch containing the array is cloned.
 */
export function remapTreeForArraySplice<T>(
	tree: T,
	arrayPath: FieldPath,
	start: number,
	deleteCount: number,
	insertCount = 0
): T {
	assertSafePath(arrayPath);
	const node = getPath(tree, arrayPath);
	if (node === null || typeof node !== 'object') return tree;
	const remapped = remapContainerForSplice(node, start, deleteCount, insertCount);
	if (remapped === node) return tree;
	return setPathImmutable(tree, arrayPath, remapped);
}
