/**
 * Typed path model.
 *
 * The single internal representation for field paths, used by server errors,
 * client validation, tainted, constraints and snapshot restore. A path is a
 * list of segments, where each segment is either an object key or an array
 * index. The string format is compatible with the historical format
 * (`a.b[0].c`), with an escaped quoted form (`a["b.c"]`, `a["0"]`) for keys
 * that contain special characters or are purely numeric.
 *
 * All parsing, formatting, reading, immutable updating and deletion of paths
 * goes through this module, so every store interprets paths identically.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type PathSegment =
	| { readonly kind: 'key'; readonly key: string }
	| { readonly kind: 'index'; readonly index: number };

export type TypedPath = readonly PathSegment[];

/**
 * Anything that can be interpreted as a path: a string accessor,
 * a legacy array of keys/indices, or a typed path.
 */
export type PathInput = string | readonly (string | number | symbol)[] | TypedPath;

const NUMERIC = /^\d+$/;

///// Safety //////////////////////////////////////////////////////////////////

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype']);

/**
 * Existing safety boundary: paths that could lead to prototype pollution
 * are rejected, both when reading and writing.
 */
export function assertSafeSegments(segments: TypedPath): void {
	for (const seg of segments) {
		if (seg.kind === 'key' && FORBIDDEN_KEYS.has(seg.key)) {
			throw new Error("Cannot set an object's `__proto__` or `prototype` property");
		}
	}
}

///// Parsing /////////////////////////////////////////////////////////////////

/**
 * Parse a string accessor into a typed path.
 *
 * - `a.b[0].c` - classic format
 * - `a.0.b` - numeric dot segments are treated as array indices
 * - `a["b.c"]`, `a["0"]`, `a["]"]` - escaped quoted keys
 * - Empty segments are skipped, so `''` is the root path.
 */
export function parsePath(path: string): PathSegment[] {
	const segments: PathSegment[] = [];
	const len = path.length;
	let i = 0;
	let key = '';
	let hasKey = false;

	function pushKey() {
		if (!hasKey) return;
		if (NUMERIC.test(key)) segments.push({ kind: 'index', index: Number(key) });
		else segments.push({ kind: 'key', key });
		key = '';
		hasKey = false;
	}

	while (i < len) {
		const ch = path[i];

		if (ch === '.' || ch === ']') {
			pushKey();
			i++;
		} else if (ch === '[') {
			pushKey();
			if (path[i + 1] === '"') {
				// Escaped quoted key: ["..."] with \" and \\ escapes
				let unescaped = '';
				let j = i + 2;
				while (j < len) {
					const c = path[j];
					if (c === '\\' && j + 1 < len) {
						unescaped += path[j + 1];
						j += 2;
					} else if (c === '"') {
						break;
					} else {
						unescaped += c;
						j++;
					}
				}
				segments.push({ kind: 'key', key: unescaped });
				// Skip to after the closing bracket
				const close = path.indexOf(']', j);
				i = close === -1 ? len : close + 1;
			} else {
				const close = path.indexOf(']', i);
				const inner = close === -1 ? path.slice(i + 1) : path.slice(i + 1, close);
				if (NUMERIC.test(inner)) segments.push({ kind: 'index', index: Number(inner) });
				else if (inner.length) segments.push({ kind: 'key', key: inner });
				i = close === -1 ? len : close + 1;
			}
		} else {
			key += ch;
			hasKey = true;
			i++;
		}
	}
	pushKey();

	return segments;
}

///// Formatting //////////////////////////////////////////////////////////////

/**
 * Keys that can be represented without escaping. Purely numeric keys must be
 * quoted, since they would otherwise be parsed as array indices.
 */
function isSimpleKey(key: string): boolean {
	return key.length > 0 && !NUMERIC.test(key) && !/[.[\]"\\]/.test(key);
}

function quoteKey(key: string): string {
	return `["${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

/**
 * Format a typed path as a string accessor. The inverse of parsePath:
 * `parsePath(formatPath(segments))` returns equal segments.
 */
export function formatPath(segments: TypedPath): string {
	let output = '';
	for (const seg of segments) {
		if (seg.kind === 'index') {
			output += `[${seg.index}]`;
		} else if (isSimpleKey(seg.key)) {
			output += (output ? '.' : '') + seg.key;
		} else {
			output += quoteKey(seg.key);
		}
	}
	return output;
}

///// Normalization ///////////////////////////////////////////////////////////

function isSegment(value: unknown): value is PathSegment {
	return (
		typeof value === 'object' &&
		value !== null &&
		'kind' in value &&
		((value as PathSegment).kind === 'key' || (value as PathSegment).kind === 'index')
	);
}

/**
 * Normalize any path representation into a typed path.
 * Legacy arrays follow the historical contract: numbers and purely numeric
 * strings are array indices, everything else is an object key.
 */
export function toSegments(path: PathInput): PathSegment[] {
	if (typeof path === 'string') return parsePath(path);

	return path.map((part) => {
		if (isSegment(part)) return part;
		if (typeof part === 'number') return { kind: 'index', index: part } as const;
		const key = String(part);
		return NUMERIC.test(key)
			? ({ kind: 'index', index: Number(key) } as const)
			: ({ kind: 'key', key } as const);
	});
}

/**
 * Normalize any path representation into a plain key array,
 * usable for direct property access.
 */
export function toKeys(path: PathInput): (string | number)[] {
	return toSegments(path).map((seg) => (seg.kind === 'index' ? seg.index : seg.key));
}

/**
 * Canonical string for a path, usable as a stable Map/Set key
 * regardless of the input representation.
 */
export function pathKey(path: PathInput): string {
	return formatPath(toSegments(path));
}

/**
 * Whether two paths refer to the same location,
 * regardless of representation.
 */
export function pathEquals(a: PathInput, b: PathInput): boolean {
	return pathKey(a) === pathKey(b);
}

///// Reading /////////////////////////////////////////////////////////////////

/**
 * Read the value at a path, returning undefined if any part is missing.
 */
export function getPath(obj: unknown, path: PathInput): unknown {
	const segments = toSegments(path);
	assertSafeSegments(segments);

	let node = obj;
	for (const seg of segments) {
		if (node === null || node === undefined) return undefined;
		node = (node as any)[seg.kind === 'index' ? seg.index : seg.key];
	}
	return node;
}

///// Immutable updates ///////////////////////////////////////////////////////

function cloneContainer(node: unknown, seg: PathSegment): any {
	if (Array.isArray(node)) return node.slice();
	if (node !== null && typeof node === 'object' && Object.getPrototypeOf(node) === Object.prototype) {
		return { ...node };
	}
	if (node === null || node === undefined || typeof node !== 'object') {
		return seg.kind === 'index' ? [] : {};
	}
	// Non-plain object (Date, File, class instance, ...); cannot set a path
	// inside it, so it is replaced by a fresh container.
	return seg.kind === 'index' ? [] : {};
}

/**
 * Immutably set the value at a path. Only the containers along the path are
 * copied (structural sharing), so untouched branches keep their identity and
 * no deep clone of the whole structure is made.
 */
export function setPathImmutable<T>(root: T, path: PathInput, value: unknown): T {
	const segments = toSegments(path);
	assertSafeSegments(segments);

	if (!segments.length) return value as T;

	function update(node: unknown, depth: number): unknown {
		const seg = segments[depth];
		const key = seg.kind === 'index' ? seg.index : seg.key;
		const copy = cloneContainer(node, seg);
		copy[key] = depth === segments.length - 1 ? value : update(nodeValue(node, key), depth + 1);
		return copy;
	}

	function nodeValue(node: unknown, key: string | number): unknown {
		return node !== null && typeof node === 'object' ? (node as any)[key] : undefined;
	}

	return update(root, 0) as T;
}

/**
 * Immutably delete the value at a path. Array indices are removed by splice
 * (following element identity), object keys are deleted. Branches that do not
 * contain the path keep their identity.
 */
export function deletePathImmutable<T>(root: T, path: PathInput): T {
	const segments = toSegments(path);
	assertSafeSegments(segments);

	if (!segments.length) return root;

	function remove(node: unknown, depth: number): unknown {
		if (node === null || typeof node !== 'object') return node;

		const seg = segments[depth];
		const key = seg.kind === 'index' ? seg.index : seg.key;

		if (depth === segments.length - 1) {
			if (Array.isArray(node)) {
				if (seg.kind !== 'index' || seg.index >= node.length) return node;
				const copy = node.slice();
				copy.splice(seg.index, 1);
				return copy;
			}
			if (!(key in (node as object))) return node;
			const copy = { ...(node as object) } as any;
			delete copy[key];
			return copy;
		}

		const child = (node as any)[key];
		const updated = remove(child, depth + 1);
		if (updated === child) return node;

		const copy: any = Array.isArray(node) ? node.slice() : { ...(node as object) };
		copy[key] = updated;
		return copy;
	}

	return remove(root, 0) as T;
}

///// Array migration /////////////////////////////////////////////////////////

export type ArraySplice = {
	start: number;
	deleteCount: number;
	insertCount: number;
};

/**
 * Infer the most likely splice that turned `prev` into `next`, by comparing
 * element identity from both ends. Used to migrate path-addressed structures
 * (errors, tainted) when array elements are inserted or removed.
 */
export function inferArraySplice(
	prev: readonly unknown[],
	next: readonly unknown[]
): ArraySplice {
	let start = 0;
	const minLength = Math.min(prev.length, next.length);
	while (start < minLength && prev[start] === next[start]) start++;

	let prevEnd = prev.length;
	let nextEnd = next.length;
	while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
		prevEnd--;
		nextEnd--;
	}

	return { start, deleteCount: prevEnd - start, insertCount: nextEnd - start };
}

/**
 * Migrate a path-addressed tree (like errors or tainted) after an array
 * splice: entries inside the removed range are dropped, entries after it are
 * shifted, following the elements rather than their string representation.
 * Non-index keys (like `_errors`) are kept as-is.
 */
export function splicePathTree<T>(
	tree: T,
	arrayPath: PathInput,
	splice: ArraySplice
): T {
	const segments = toSegments(arrayPath);
	const node = segments.length ? getPath(tree, segments) : tree;
	if (node === null || typeof node !== 'object') return tree;

	const delta = splice.insertCount - splice.deleteCount;
	const migrated: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(node)) {
		if (!NUMERIC.test(key)) {
			migrated[key] = value;
			continue;
		}
		const index = Number(key);
		if (index < splice.start) migrated[key] = value;
		else if (index < splice.start + splice.deleteCount) continue;
		else migrated[String(index + delta)] = value;
	}

	return segments.length ? setPathImmutable(tree, segments, migrated) : (migrated as T);
}
