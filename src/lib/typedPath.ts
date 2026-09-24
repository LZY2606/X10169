/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Internal typed path model.
 *
 * A single representation for field paths, consumed by server errors,
 * client validation, tainted state, constraints and snapshots.
 *
 * A {@link TypedPath} is an array of segments that explicitly distinguishes
 * object keys (strings) from array indices (numbers). String path notation is
 * parsed/formatted by {@link parsePath} and {@link formatPath}, which support
 * escaping of keys that contain dots and brackets.
 */

export type ObjectKey = string;
export type ArrayIndex = number;
export type PathKey = ObjectKey | ArrayIndex | symbol;
export type TypedPath = readonly PathKey[];

export type { PathData } from './traversal.js';

const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Keys that must never be written through a path, to prevent prototype
 * pollution. Read access to these segments is also rejected when traversing,
 * matching the previous security boundary of this library.
 */
export function isSafeKey(key: PathKey): boolean {
	if (typeof key === 'number') return Number.isSafeInteger(key) && key >= 0;
	const name = typeof key === 'symbol' ? key.description ?? '' : key;
	return !PROTOTYPE_KEYS.has(name);
}

function assertSafePath(path: TypedPath): void {
	for (const key of path) {
		if (!isSafeKey(key)) {
			throw new Error("Cannot access an object's `__proto__`, `prototype` or `constructor` property");
		}
		if (typeof key === 'number' && (!Number.isSafeInteger(key) || key < 0)) {
			throw new Error(`Array index must be a non-negative safe integer, received ${String(key)}.`);
		}
	}
}

function normalizeSegment(segment: string): PathKey | undefined {
	if (!segment.length) return undefined;
	// All-digit segments are array indices, whether they came from
	// dot notation ("tags.0") or bracket notation ("tags[0]").
	if (/^\d+$/.test(segment)) {
		const index = Number(segment);
		return Number.isSafeInteger(index) ? index : segment;
	}
	return unescapeKey(segment);
}

/**
 * Unescape a key written inside brackets, or after a dot.
 * Only the structural characters and the escape character itself need
 * escaping: `[`, `]`, `.` and `\`.
 */
function unescapeKey(key: string): string {
	if (!key.includes('\\')) return key;
	return key.replace(/\\(.)/g, (_match, escaped: string) => escaped);
}

function escapeKey(key: string): string {
	return key.replace(/[[.\\]]/g, '\\$&');
}

/**
 * Parse a string path into its typed segments.
 *
 * Grammar:
 * - `foo.bar`      -> ['foo', 'bar']
 * - `arr[0]`       -> ['arr', 0]
 * - `arr.0`        -> ['arr', 0]
 * - `weird\.key`   -> ['weird.key']
 * - `[weird.key]`  -> ['weird.key']
 * - `[0]`          -> [0]
 * - `a[b]`         -> ['a', 'b']
 * - empty path     -> [] (root)
 *
 * All-digit segments are always normalized to array indices.
 */
export function parsePath(path: string | null | undefined): TypedPath {
	if (path === null || path === undefined || path === '') return [];

	const output: PathKey[] = [];
	let buffer = '';
	let escaped = false;

	function pushBuffer() {
		if (!buffer.length) return;
		const segment = normalizeSegment(buffer);
		if (segment !== undefined) output.push(segment);
		buffer = '';
	}

	for (let i = 0; i < path.length; i++) {
		const char = path[i];

		if (escaped) {
			buffer += char;
			escaped = false;
			continue;
		}

		if (char === '\\') {
			// Preserve the backslash, unescapeKey resolves it later.
			buffer += char;
			escaped = true;
			continue;
		}

		if (char === '.') {
			pushBuffer();
			continue;
		}

		if (char === '[') {
			pushBuffer();
			// Find the matching, non-escaped closing bracket.
			let j = i + 1;
			let inner = '';
			let innerEscaped = false;
			for (; j < path.length; j++) {
				const bracketChar = path[j];
				if (innerEscaped) {
					inner += bracketChar;
					innerEscaped = false;
					continue;
				}
				if (bracketChar === '\\') {
					inner += bracketChar;
					innerEscaped = true;
					continue;
				}
				if (bracketChar === ']') break;
				inner += bracketChar;
			}

			if (j >= path.length) {
				// Unmatched bracket: treat the rest as a literal key,
				// so parse(format(parse(x))) is stable even for malformed input.
				buffer += path.slice(i);
				break;
			}

			if (inner.length) {
				const segment = normalizeSegment(inner);
				if (segment !== undefined) output.push(segment);
			}
			i = j;
			continue;
		}

		if (char === ']') {
			// Stray closing bracket is part of the key literally.
			buffer += char;
			continue;
		}

		buffer += char;
	}

	pushBuffer();
	return output;
}

/**
 * Normalize an array of segments (as produced by validation adapters or
 * previous split/join implementations) into the typed representation.
 * Numeric strings become numbers, everything else stays a string key.
 */
export function normalizePath(path: Iterable<string | number | symbol>): TypedPath {
	const output: PathKey[] = [];
	for (const segment of path) {
		if (typeof segment === 'number') {
			if (!Number.isSafeInteger(segment) || segment < 0) continue;
			output.push(segment);
		} else if (typeof segment === 'symbol') {
			output.push(segment);
		} else if (segment === '') {
			// Empty segments (e.g. form-level paths) are dropped, like splitPath did.
			continue;
		} else if (/^\d+$/.test(segment) && Number.isSafeInteger(Number(segment))) {
			output.push(Number(segment));
		} else {
			output.push(segment);
		}
	}
	return output;
}

function needsBracket(key: string): boolean {
	return /^\d+$/.test(key) || /[[\].\\]/.test(key);
}

/**
 * Format a typed path back to string notation.
 * The first segment uses dot-less notation, subsequent object keys are joined
 * with dots unless they need escaping, in which case bracketed notation is
 * used. Array indices always use bracket notation.
 */
export function formatPath(path: TypedPath | Iterable<string | number | symbol>): string {
	let output = '';
	let first = true;

	for (const rawKey of path) {
		if (typeof rawKey === 'number') {
			output += `[${rawKey}]`;
			first = false;
			continue;
		}

		const key = typeof rawKey === 'symbol' ? String(rawKey.description ?? '') : rawKey;

		if (first) {
			output += needsBracket(key) ? `[${escapeKey(key)}]` : escapeKey(key);
			first = false;
		} else if (needsBracket(key)) {
			output += `[${escapeKey(key)}]`;
		} else {
			output += `.${escapeKey(key)}`;
		}
	}

	return output;
}

export function isRootPath(path: TypedPath): boolean {
	return path.length === 0;
}

export function samePath(a: TypedPath, b: TypedPath): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export function pathStartsWith(path: TypedPath, prefix: TypedPath): boolean {
	if (prefix.length > path.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (path[i] !== prefix[i]) return false;
	}
	return true;
}

type Dict = Record<PropertyKey, any>;

export type TreeModifier = (data: TreePathData) => undefined | unknown | void | 'skip' | 'abort';

export type TreePathData = {
	parent: any;
	key: PathKey;
	value: any;
	path: TypedPath;
	isLeaf: boolean;
	set: (value: any) => void;
};

function containerAt(value: unknown): value is Dict {
	return value !== null && typeof value === 'object';
}

/**
 * Read a value at a typed path. Returns undefined when the path doesn't exist
 * or an intermediate value isn't an object/array.
 *
 * If `modifier` is provided, it's invoked for every intermediate node and may
 * create missing containers (it receives the parent and current key). The
 * return value of the modifier is used as the next node to traverse.
 */
export function getPath(
	root: any,
	path: TypedPath,
	modifier?: (data: Omit<TreePathData, 'isLeaf' | 'set'> & { set: (value: any) => void }) => unknown
): TreePathData | undefined {
	if (!path.length) return undefined;
	assertSafePath(path);

	let parent: any = root;

	for (let i = 0; i < path.length; i++) {
		const key = path[i];
		const isLeaf = i === path.length - 1;

		if (!containerAt(parent)) return undefined;

		const set = (value: any) => {
			assertSafePath([key]);
			parent[key] = value;
		};

		if (!isLeaf) {
			let next = parent[key];
			if (modifier) {
				const returned = modifier({ parent, key, value: next, path: path.slice(0, i + 1), set });
				if (returned !== undefined) next = returned;
			}
			if (next === undefined) return undefined;
			parent = next;
		} else {
			return {
				parent,
				key,
				value: parent[key],
				path,
				isLeaf: true,
				set
			};
		}
	}

	return undefined;
}

/**
 * Returns true if a path exists (optionally matching a value predicate).
 */
export function existsPath(
	root: any,
	path: TypedPath,
	options: {
		value?: (value: unknown) => boolean;
		modifier?: (data: TreePathData) => undefined | unknown | void;
	} = {}
): TreePathData | undefined {
	const leaf = getPath(root, path, options.modifier);
	if (!leaf) return undefined;
	if (options.value && !options.value(leaf.value)) return undefined;
	return leaf;
}

function isInvalidIntermediate(originalPath: TypedPath, data: TreePathData): unknown {
	if (
		data.value !== undefined &&
		typeof data.value !== 'object' &&
		data.path.length < originalPath.length
	) {
		return undefined;
	}
	return data.value;
}

/**
 * Immutable, structural-sharing update of a tree. Only the branches touched by
 * `path` get new container references; sibling branches keep their identity.
 *
 * `value` can be a function receiving the previous leaf value.
 * `createArrays` controls whether missing intermediate numeric segments build
 * arrays (used by form proxies) or plain objects (the default, used by error
 * and tainted trees).
 */
export function setInPath<T>(
	root: T,
	path: TypedPath,
	value: unknown | ((previous: any, data: TreePathData | undefined) => unknown),
	options: { createArrays?: boolean } = {}
): T {
	if (!path.length) return root;
	assertSafePath(path);

	const valueFn = typeof value === 'function' ? (value as (...args: any[]) => unknown) : undefined;

	function build(index: number, current: any): any {
		const key = path[index];
		const isLeaf = index === path.length - 1;

		const existing = current ? current[key] : undefined;

		let nextContainer: any;
		if (!isLeaf) {
			const createArray = options.createArrays && typeof path[index + 1] === 'number';
			const base =
				existing !== undefined && typeof existing === 'object'
					? existing
					: createArray
						? []
						: {};
			nextContainer = build(index + 1, base);
		}

		const updatedValue = isLeaf
			? valueFn
				? valueFn(existing, existing !== undefined || current ? getLeaf(current, key) : undefined)
				: value
			: nextContainer;

		if (Array.isArray(current)) {
			const copy = current.slice();
			copy[key as number] = updatedValue;
			return copy;
		}

		return { ...(current ?? {}), [key]: updatedValue };
	}

	function getLeaf(parent: any, key: PathKey): TreePathData | undefined {
		if (!containerAt(parent)) return undefined;
		return {
			parent,
			key,
			value: parent[key],
			path,
			isLeaf: true,
			set: (v: any) => {
				parent[key] = v;
			}
		};
	}

	return build(0, root ?? (options.createArrays && typeof path[0] === 'number' ? [] : {}));
}

/**
 * Immutable deletion of a path. The target key is removed (or, for arrays,
 * spliced). Empty containers are preserved. Returns a structurally shared
 * copy; if the target didn't exist the original root is returned unchanged.
 */
export function deleteInPath<T>(root: T, path: TypedPath): T {
	if (!path.length || root === null || root === undefined) return root;
	assertSafePath(path);

	const leaf = getPath(root, path);
	if (!leaf || !(leaf.key in leaf.parent)) return root;

	function rebuild(index: number, current: any): any {
		const key = path[index];
		if (index === path.length - 1) {
			if (Array.isArray(current)) {
				const copy = current.slice();
				copy.splice(key as number, 1);
				return copy;
			}
			const copy = { ...current };
			delete copy[key];
			return copy;
		}
		const child = current[key];
		const updatedChild = rebuild(index + 1, child);
		if (Array.isArray(current)) {
			const copy = current.slice();
			copy[key as number] = updatedChild;
			return copy;
		}
		return { ...current, [key]: updatedChild };
	}

	return rebuild(0, root);
}

/**
 * Set several paths in a mutable tree (used inside store updaters where the
 * store value is already a fresh draft). Creates missing intermediate objects,
 * matching the historical `setPaths` behavior.
 */
export function setPathsMutable(
	root: Dict,
	paths: TypedPath[],
	value: unknown | ((path: TypedPath, data: TreePathData) => unknown)
): void {
	const valueFn = typeof value === 'function' ? (value as (...args: any[]) => unknown) : undefined;

	for (const path of paths) {
		if (!path.length) continue;
		assertSafePath(path);

		const leaf = getPath(root, path, (data) => {
			if (data.value === undefined || typeof data.value !== 'object') {
				data.set({});
			}
			return data.parent[data.key];
		});

		if (leaf) {
			assertSafePath([leaf.key]);
			leaf.parent[leaf.key] = valueFn ? valueFn(path, leaf) : value;
		}
	}
}

/**
 * Depth-first traversal of an object/array tree. The modifier receives typed
 * paths (numbers for array indices, strings for object keys).
 */
export function walkTree(
	parent: any,
	modifier: (data: TreePathData) => 'abort' | 'skip' | unknown | void,
	path: PathKey[] = []
): 'abort' | 'skip' | unknown | void {
	if (!containerAt(parent)) return;

	for (const key in parent) {
		const rawKey = Array.isArray(parent) ? Number(key) : key;
		const value = parent[rawKey];
		const isLeaf = value === null || typeof value !== 'object';
		const currentPath = path.concat([rawKey]);

		const data: TreePathData = {
			parent,
			key: rawKey,
			value,
			path: currentPath,
			isLeaf,
			set: (v) => {
				assertSafePath([rawKey]);
				parent[rawKey] = v;
			}
		};

		const status = modifier(data);
		if (status === 'abort') return status;
		if (status === 'skip') continue;
		if (!isLeaf) {
			const childStatus = walkTree(value, modifier, currentPath);
			if (childStatus === 'abort') return childStatus;
		}
	}
}
