/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Internal typed field-path model — the single source of truth for parsing,
 * normalizing, formatting, reading, immutably updating and deleting nested
 * form data.
 *
 * A canonical path is a sequence of typed segments:
 * - `number` segments are array indices.
 * - `string` segments are object keys (the empty string is a valid key).
 *
 * String grammar (parsePath/formatPath):
 * - `name`, `a.b`        -> bare object keys, joined with dots
 * - `[0]`, `a[0].b`      -> array indices
 * - `["x.y"]`, `['a[0]']` -> quoted keys for names containing special chars
 * - The escape character (backslash) escapes `.`, `[`, `]`, both quote
 *   characters and itself, inside bare and quoted tokens.
 * - The empty path `[]` represents the form root (form-level errors).
 */

export type PathSegment = string | number;
export type TypedPath = PathSegment[];

type AnyPath = TypedPath | readonly (string | number | symbol)[];

const DIGITS = '0123456789';
const BACKSLASH = String.fromCharCode(92);

export function isAllDigits(key: string) {
	return key.length > 0 && [...key].every((c) => DIGITS.includes(c));
}

/**
 * Keys on the existing prototype-pollution security boundary.
 * They are rejected everywhere the model parses or writes paths.
 */
export function isDangerousKey(key: string) {
	return key === '__proto__' || key === 'prototype';
}

function throwKeyError(key: string): never {
	throw new Error("Cannot access an object's `" + key + '` property');
}

/**
 * Removes one level of backslash escaping from a raw path token.
 */
function unescapeToken(raw: string) {
	let output = '';
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === BACKSLASH && i + 1 < raw.length) {
			output += raw[++i];
		} else {
			output += raw[i];
		}
	}
	return output;
}

function checkKey(key: string) {
	if (isDangerousKey(key)) throwKeyError(key);
	return key;
}

/**
 * Parses a path string (or an existing segment array) into a typed path.
 */
export function parsePath(
	path: string | AnyPath
): TypedPath {
	if (typeof path !== 'string') {
		const result: TypedPath = [];
		for (const segment of path) {
			if (typeof segment === 'number') {
				result.push(segment);
			} else {
				result.push(checkKey(String(segment)));
			}
		}
		return result;
	}

	const result: TypedPath = [];

	const pushKey = (key: string, bracketNotation: boolean) => {
		checkKey(key);
		if (bracketNotation && isAllDigits(key)) result.push(Number(key));
		else result.push(key);
	};

	let i = 0;

	while (i < path.length) {
		const ch = path[i];

		// Separator between bare keys
		if (ch === '.') {
			i++;
			continue;
		}

		if (ch === '[') {
			const start = ++i;

			if (path[i] === '"' || path[i] === "'") {
				const quote = path[i++];
				let raw = '';

				for (;;) {
					if (i >= path.length) {
						throw new Error(`Unterminated quoted key in path: "${path}"`);
					}
					if (path[i] === BACKSLASH) {
						raw += path[i] + (path[i + 1] ?? '');
						i += 2;
						continue;
					}
					if (path[i] === quote) {
						i++;
						break;
					}
					raw += path[i++];
				}

				if (path[i] !== ']') throw new Error(`Expected closing bracket in path: "${path}"`);
				i++;

				const key = unescapeToken(raw);
				// [""] is the canonical way to address an empty-string key.
				// Quoted keys are always object keys, even if all digits.
				result.push(checkKey(key));
				continue;
			}

			// Unquoted bracket content, read until the closing bracket.
			let raw = '';
			let closed = false;
			for (;;) {
				if (i >= path.length) break;
				if (path[i] === BACKSLASH) {
					raw += path[i] + (path[i + 1] ?? '');
					i += 2;
					continue;
				}
				if (path[i] === ']') {
					closed = true;
					i++;
					break;
				}
				raw += path[i++];
			}

			// Empty brackets [] are separators, matching the legacy split behavior.
			if (closed && start >= 1 && raw === '') continue;
			pushKey(unescapeToken(raw), true);
			continue;
		}

		// Bare token, up to the next unescaped dot or opening bracket.
		let raw = '';
		for (;;) {
			if (i >= path.length) break;
			if (path[i] === BACKSLASH) {
				raw += path[i] + (path[i + 1] ?? '');
				i += 2;
				continue;
			}
			if (path[i] === '.' || path[i] === '[') break;
			raw += path[i++];
		}

		const key = unescapeToken(raw);
		if (key === '') continue;
		pushKey(key, false);
	}

	return result;
}

function needsQuoting(key: string) {
	for (const ch of key) {
		if (ch === '.' || ch === '[' || ch === ']' || ch === '"' || ch === "'" || ch === BACKSLASH) {
			return true;
		}
	}
	return false;
}

function quoteKey(key: string) {
	let output = '"';
	for (const ch of key) {
		if (ch === BACKSLASH || ch === '"') {
			output += BACKSLASH;
		}
		output += ch;
	}
	return output + '"';
}

/**
 * Formats a typed path back into its canonical string representation.
 */
export function formatPath(path: TypedPath | readonly PathSegment[]): string {
	let output = '';

	for (const segment of path) {
		if (typeof segment === 'number') {
			output += `[${segment}]`;
			continue;
		}

		const key = String(segment);

		if (isAllDigits(key)) {
			output += `[${key}]`;
		} else if (needsQuoting(key)) {
			output += `[${quoteKey(key)}]`;
		} else {
			output += output ? `.${key}` : key;
		}
	}

	return output;
}

/** Parses and formats a path, yielding its canonical public string form. */
export function normalizePath(
	path: string | AnyPath
): string {
	return formatPath(parsePath(path));
}

const KEY_SEPARATOR = String.fromCharCode(0);

/** Stable identity key for a path, used when comparing or deduplicating. */
export function pathKey(path: AnyPath): string {
	return path.map(String).join(KEY_SEPARATOR);
}

export function pathsEqual(
	a: AnyPath,
	b: AnyPath
) {
	return a.length === b.length && a.every((segment, i) => String(segment) === String(b[i]));
}

export function pathStartsWith(
	path: AnyPath,
	prefix: AnyPath
) {
	return (
		path.length >= prefix.length && prefix.every((segment, i) => String(segment) === String(path[i]))
	);
}

/**
 * Result of locating a path inside an object tree.
 */
export type PathNode<T = any> = {
	parent: any;
	key: string;
	value: T;
	path: TypedPath;
	isLeaf: boolean;
	set: (value: any) => 'skip';
};

const NO_SET = () => {
	throw new Error('The root path cannot be set.');
};

/**
 * Reads a path in an object tree. Returns undefined if any segment is missing.
 * A modifier can create intermediate nodes, exactly like traversePath.
 */
export function getPathNode(
	obj: object,
	path: AnyPath,
	modifier?: (data: PathNode) => undefined | unknown | void
): PathNode | undefined {
	// Root path
	if (!path.length) {
		return {
			parent: undefined,
			key: '',
			value: obj,
			path: [],
			isLeaf: true,
			set: NO_SET
		};
	}

	const typed = path.map((segment) =>
		typeof segment === 'number' ? segment : checkKey(String(segment))
	);

	let parent: any = obj;

	for (let depth = 0; depth < typed.length - 1; depth++) {
		const key = typed[depth];
		const keyString = String(key);
		const current: PathNode = {
			parent,
			key: keyString,
			value: parent == null ? undefined : parent[key as keyof typeof parent],
			path: typed.slice(0, depth + 1),
			isLeaf: false,
			set: (value) => {
				parent[key as keyof typeof parent] = value;
				return 'skip';
			}
		};

		const value = modifier ? modifier(current) : current.value;
		if (value === undefined) return undefined;
		parent = value;
	}

	if (parent == null) return undefined;

	const last = typed[typed.length - 1];
	const keyString = String(last);
	return {
		parent,
		key: keyString,
		value: parent[last as keyof typeof parent],
		path: typed.slice(),
		isLeaf: true,
		set: (value) => {
			if (typeof last === 'string') checkKey(last);
			parent[last as keyof typeof parent] = value;
			return 'skip';
		}
	};
}

/** Convenience read, returning the value or undefined. */
export function getPath<T = any>(
	obj: object | null | undefined,
	path: AnyPath
): T | undefined {
	return obj == null ? undefined : getPathNode(obj, path)?.value;
}

/**
 * Sets one or more paths in a tree, creating plain-object intermediate
 * nodes as needed. Mutates `obj`; values may be a function of the path and
 * the current node. This is the only mutating writer in the model.
 */
export function setPathNodes(
	obj: Record<string, unknown>,
	paths: AnyPath[],
	value:
		| NonNullable<unknown>
		| ((path: TypedPath, data: PathNode) => unknown)
		| null
		| undefined
) {
	const isFunction = typeof value === 'function';

	for (const rawPath of paths) {
		const path = parsePath(rawPath);
		if (!path.length) continue;

		const leaf = getPathNode(obj, path, ({ parent, key, value }) => {
			if (value === undefined || typeof value !== 'object') {
				parent[key] = {};
			}
			return parent[key];
		});

		if (leaf) {
			if (typeof path[path.length - 1] === 'string') checkKey(leaf.key);
			leaf.parent[leaf.key] = isFunction ? (value as any)(path, leaf) : value;
		}
	}
}

/**
 * Removes a path from a tree. Empty parent nodes are pruned up to (but not
 * including) the root. Returns true when the leaf existed.
 */
export function deletePath(
	obj: Record<string, unknown>,
	path: AnyPath
): boolean {
	if (!path.length) return false;

	const leaf = getPathNode(obj, path);
	if (!leaf) return false;
	if (!(leaf.key in leaf.parent)) return false;

	if (Array.isArray(leaf.parent)) {
		// Keep array positions stable; genuine element removal is handled by
		// the identity remap, so deletion here only clears the slot.
		leaf.parent[Number(leaf.key)] = undefined;
	} else {
		delete leaf.parent[leaf.key];
	}

	// Prune now-empty plain-object parents.
	for (let depth = path.length - 1; depth > 0; depth--) {
		const node = getPathNode(obj, path.slice(0, depth));
		if (
			node &&
			node.value &&
			typeof node.value === 'object' &&
			!Array.isArray(node.value) &&
			Object.values(node.value).every((value) => value === undefined)
		) {
			if (depth - 1 === 0) {
				delete (obj as Record<string, unknown>)[String(path[0])];
			} else {
				const parentNode = getPathNode(obj, path.slice(0, depth - 1));
				if (parentNode && parentNode.value && !Array.isArray(parentNode.value)) {
					delete parentNode.parent[String(path[depth - 1])];
				}
			}
		} else {
			break;
		}
	}

	return true;
}

function shallowClone(value: any) {
	return Array.isArray(value) ? value.slice() : { ...value };
}

/**
 * Immutable structural-sharing write: only the nodes on the path are cloned,
 * everything outside the target branch keeps its reference.
 */
export function setIn<T extends object>(
	obj: T,
	path: AnyPath,
	value: unknown | ((current: any) => unknown)
): T {
	const typed = parsePath(path);
	if (!typed.length) return value as T;

	const setValue = typeof value === 'function' ? (value as (current: any) => unknown) : () => value;

	function recurse(current: any, depth: number): any {
		const segment = typed[depth];

		if (depth === typed.length - 1) {
			if (current == null || typeof current !== 'object') {
				current = typeof segment === 'number' ? [] : {};
			}
			const clone = shallowClone(current);
			if (typeof segment === 'string') checkKey(segment);
			clone[segment as keyof typeof clone] = setValue(current?.[segment as keyof typeof current]);
			return clone;
		}

		if (current == null || typeof current !== 'object') {
			current = typeof segment === 'number' ? [] : {};
		}

		const clone = shallowClone(current);
		clone[segment as keyof typeof clone] = recurse(
			current[segment as keyof typeof current],
			depth + 1
		);
		return clone;
	}

	return recurse(obj, 0) as T;
}

/** Immutable structural-sharing delete. */
export function deleteIn<T extends object>(obj: T, path: AnyPath): T {
	const typed = parsePath(path);
	if (!typed.length) return obj;

	function recurse(current: any, depth: number): any {
		const segment = typed[depth] as PropertyKey;
		if (current == null || typeof current !== 'object') return current;

		const clone = shallowClone(current);

		if (depth === typed.length - 1) {
			if (Array.isArray(clone) && typeof segment !== 'string') {
				clone.splice(Number(segment), 1);
			} else {
				delete clone[segment];
			}
			return clone;
		}

		clone[segment] = recurse(current[segment], depth + 1);
		return clone;
	}

	return recurse(obj, 0) as T;
}

/**
 * Deep structural equality used for aligning array elements by value
 * (the second strategy, after reference identity).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;

	if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
	if (a instanceof File && b instanceof File) return a === b;
	if (a instanceof Set && b instanceof Set) {
		if (a.size !== b.size) return false;
		for (const value of a) if (!b.has(value)) return false;
		return true;
	}

	if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
		return false;
	}

	const aIsArray = Array.isArray(a);
	const bIsArray = Array.isArray(b);
	if (aIsArray !== bIsArray) return false;

	if (aIsArray && bIsArray) {
		if (a.length !== b.length) return false;
		return a.every((value, i) => deepEqual(value, b[i]));
	}

	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;

	return aKeys.every((key) =>
		deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
	);
}

/**
 * Aligns two arrays by element identity/value, yielding the mapping from
 * old indices to new indices for surviving elements.
 * - Object identity (`===`) is preferred.
 * - Equal primitives/values are then matched with an LCS, which handles
 *   duplicate values correctly ("same value at different positions").
 * Elements are matched in order, so insertion/deletion in the middle
 * produces a shift rather than random rematching.
 */
export function alignArrays(oldArr: unknown[], newArr: unknown[]): Map<number, number> {
	const mapping = new Map<number, number>();
	const usedOld = new Set<number>();
	const usedNew = new Set<number>();

	// 1. Reference identity takes precedence (stable across clones in tests).
	for (let j = 0; j < newArr.length; j++) {
		if (typeof newArr[j] !== 'object' || newArr[j] === null) continue;
		for (let i = 0; i < oldArr.length; i++) {
			if (usedOld.has(i) || usedNew.has(j)) continue;
			if (oldArr[i] === newArr[j]) {
				mapping.set(i, j);
				usedOld.add(i);
				usedNew.add(j);
				break;
			}
		}
	}

	// 2. Greedy LCS over deep equality for the remaining elements.
	const candidates: number[] = [];
	for (let i = 0; i < oldArr.length; i++) if (!usedOld.has(i)) candidates.push(i);
	const target: number[] = [];
	for (let j = 0; j < newArr.length; j++) if (!usedNew.has(j)) target.push(j);

	const n = candidates.length;
	const m = target.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] = deepEqual(oldArr[candidates[i]], newArr[target[j]])
				? lcs[i + 1][j + 1] + 1
				: Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (deepEqual(oldArr[candidates[i]], newArr[target[j]])) {
			mapping.set(candidates[i], target[j]);
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}

	return mapping;
}

const INDEX_PATTERN = /^\d+$/;

function isPlainContainer(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Error message arrays (string[]) are leaves in the errors tree, not
 * parallel arrays of the data, so they must not be reindexed.
 */
function isMessageArray(value: unknown): value is unknown[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((entry) => entry === undefined || typeof entry === 'string')
	);
}

function isDataContainer(value: unknown) {
	return (
		!!value &&
		typeof value === 'object' &&
		!(value instanceof Date) &&
		!(value instanceof File) &&
		!(value instanceof Set)
	);
}

function reindexArrayMetadata(
	metadata: Record<string, unknown> | unknown[],
	mapping: Map<number, number>
) {
	const output: any[] & Record<string, unknown> = [] as any;

	for (let index = 0; index < metadata.length; index++) {
		const newIndex = mapping.get(index);
		if (newIndex !== undefined) output[newIndex] = metadata[index];
	}

	if ('_errors' in metadata && (metadata as Record<string, unknown>)._errors !== undefined) {
		output._errors = (metadata as Record<string, unknown>)._errors;
	}

	// Compact trailing holes so the metadata array length matches the new data.
	const maxIndex = Math.max(-1, ...mapping.values());
	output.length = maxIndex + 1;

	return output;
}

/**
 * Walks the *data* tree (`oldData` -> `newData`) and migrates a parallel
 * metadata tree (the tainted object, the errors object, ...) so array
 * entries follow their element's identity/value rather than their old
 * numeric position.
 *
 * - Tainted markers for deleted elements are dropped.
 * - Inserted positions receive no metadata.
 * - Nested objects and arrays inside surviving elements migrate too.
 * - Message arrays (string[]) and scalar metadata are left untouched.
 * - Constraints, which have no index dimension, are unaffected.
 */
export function remapMetadataTree<T extends object>(
	oldData: T,
	newData: T,
	metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
	if (!metadata) return metadata;

	function walk(oldValue: any, newValue: any, currentMeta: any): any {
		if (currentMeta === undefined) return currentMeta;

		const oldIsArray = Array.isArray(oldValue);
		const newIsArray = Array.isArray(newValue);

		// Message arrays are leaves.
		if (isMessageArray(currentMeta)) return currentMeta;

		if (oldIsArray && newIsArray) {
			const mapping = alignArrays(oldValue, newValue);
			const reindexed = reindexArrayMetadata(currentMeta, mapping);

			// Recurse into metadata of surviving elements that are containers.
			for (const [oldIndex, newIndex] of mapping) {
				// Read from the reindexed tree, since currentMeta may contain holes.
				const elementMeta = reindexed[newIndex];
				if (elementMeta === undefined || typeof elementMeta !== 'object') continue;
				const oldItem = oldValue[oldIndex];
				const newItem = newValue[newIndex];
				if (isDataContainer(oldItem) && isDataContainer(newItem)) {
					reindexed[newIndex] = walk(oldItem, newItem, elementMeta);
				}
			}

			return reindexed;
		}

		if (
			(isPlainContainer(currentMeta) || Array.isArray(currentMeta)) &&
			isDataContainer(oldValue) &&
			isDataContainer(newValue)
		) {
			const output: Record<string, unknown> = {};

			for (const [key, value] of Object.entries(currentMeta)) {
				const inNew = Array.isArray(newValue)
					? INDEX_PATTERN.test(key) && Number(key) < newValue.length
					: key in newValue;

				if (inNew) {
					const newKey = Array.isArray(newValue) ? Number(key) : key;
					output[key] = walk(oldValue[newKey], newValue[newKey], value);
				} else {
					// Key disappeared (e.g. an optional object was removed).
					output[key] = undefined;
				}
			}

			return output;
		}

		return currentMeta;
	}

	return walk(oldData, newData, metadata) as Record<string, unknown>;
}

/** True when at least one array along the tree changed length/order. */
export function hasArrayStructureChange(oldData: unknown, newData: unknown): boolean {
	if (!isDataContainer(oldData) || !isDataContainer(newData)) return false;

	const oldIsArray = Array.isArray(oldData);
	const newIsArray = Array.isArray(newData);
	if (oldIsArray !== newIsArray) return true;

	if (oldIsArray && newIsArray) {
		if (oldData.length !== newData.length) return true;

		const mapping = alignArrays(oldData, newData);
		for (let i = 0; i < oldData.length; i++) {
			if (mapping.get(i) !== i) return true;
		}

		for (let i = 0; i < oldData.length; i++) {
			if (hasArrayStructureChange(oldData[i], newData[mapping.get(i)!])) return true;
		}
		return false;
	}

	const oldObj = oldData as Record<string, unknown>;
	const newObj = newData as Record<string, unknown>;

	for (const key of new Set([...Object.keys(oldObj), ...Object.keys(newObj)])) {
		if (hasArrayStructureChange(oldObj[key], newObj[key])) return true;
	}

	return false;
}
