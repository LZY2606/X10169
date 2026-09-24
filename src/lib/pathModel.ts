/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Internal typed path model.
 *
 * Single representation used for parsing, normalizing, reading,
 * immutable updating and deleting nested paths shared by:
 * - server errors (mapErrors/setError/updateErrors)
 * - client validation (Form__displayNewErrors)
 * - tainted fields
 * - constraints
 * - snapshot capture/restore
 *
 * A path is an ordered list of segments that explicitly distinguishes
 * object keys from array indices:
 *
 * - { kind: 'key', key: string } - object property
 * - { kind: 'index', index: number } - array position
 *
 * String form (canonical):
 * - object keys: `name`, or `["weird.key"]` / `["with \"quote\""]`
 * - array indices: `[0]`
 *
 * The bracket-quoted form is required for keys containing path
 * separators (`.`, `[`, `]`) or quotes/backslashes, so a round-trip
 * parse -> format -> parse is always stable.
 */

export type KeySegment = { kind: 'key'; key: string };
export type IndexSegment = { kind: 'index'; index: number };
export type PathSegment = KeySegment | IndexSegment;

/** Typed path; empty array represents the root. */
export type TypedPath = PathSegment[];

/** Anything accepted by the model: typed paths, strings or token arrays. */
export type PathInput = TypedPath | string | readonly (string | number | symbol)[];

/** Keys that must never be written through the model (prototype pollution). */
export const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function isRootPath(path: PathInput): boolean {
	return toPath(path).length === 0;
}

const INDEX_RE = /^(0|[1-9][0-9]*)$/;
const BARE_SPECIAL_RE = /[[\].]/;

/**
 * Convert loose token arrays (as produced by adapters and traversal)
 * into the typed representation.
 * Numeric strings and numbers become array indices, everything else keys.
 */
export function fromTokens(tokens: readonly (string | number | symbol)[]): TypedPath {
	const path: TypedPath = [];
	for (const token of tokens) {
		if (typeof token === 'number') {
			if (Number.isInteger(token) && token >= 0) path.push({ kind: 'index', index: token });
			continue;
		}
		const key = typeof token === 'symbol' ? token.description ?? '' : token;

		// Empty segments are ignored, matching the historical boundary
		// (e.g. ".a..b" and "a[]" resolve to a/b).
		if (!key) continue;

		if (INDEX_RE.test(key)) path.push({ kind: 'index', index: Number(key) });
		else path.push({ kind: 'key', key });
	}
	return path;
}

/**
 * Parse a string path into the typed representation.
 *
 * Supported syntax:
 *   name            object key
 *   name.sub        dot-separated keys
 *   items[0]        array index
 *   items[0].name   mixed
 *   ["weird.key"]   bracket-quoted object key (double or single quotes),
 *                   with `\\` and the quote escaped using backslash
 *   [literal]       bracket-delimited key without quotes
 *
 * Empty segments are ignored. Throws for prototype-pollution keys.
 */
export function parsePath(
	input: string,
	options: { allowDangerous?: boolean } = {}
): TypedPath {
	const path: TypedPath = [];
	const pushKey = (key: string) => {
		if (!key) return;
		if (!options.allowDangerous && DANGEROUS_KEYS.has(key)) throw dangerousError(key);
		path.push({ kind: 'key', key });
	};
	const pushBracket = (content: string, quoted: boolean) => {
		if (!content && !quoted) return; // [] behaves like an empty segment
		if (!quoted && INDEX_RE.test(content)) {
			path.push({ kind: 'index', index: Number(content) });
		} else {
			pushKey(content);
		}
	};

	const len = input.length;
	let i = 0;
	let bare = '';

	const flushBare = () => {
		pushKey(bare);
		bare = '';
	};

	while (i < len) {
		const ch = input[i];

		if (ch === '.') {
			flushBare();
			i++;
			continue;
		}

		if (ch === '[') {
			flushBare();
			i++;

			const quote = input[i] === '"' || input[i] === "'" ? input[i] : undefined;
			if (quote) {
				i++;
				let content = '';
				let closed = false;
				while (i < len) {
					const c = input[i];
					if (c === '\\') {
						const next = input[i + 1];
						if (next === '\\' || next === quote) {
							content += next;
							i += 2;
							continue;
						}
						// Unknown escape keeps the backslash, so parsing is reversible.
						content += c;
						i++;
						continue;
					}
					if (c === quote) {
						closed = true;
						i++;
						break;
					}
					content += c;
					i++;
				}
				if (!closed || input[i] !== ']') {
					throw new TypeError(`Unterminated quoted path segment in "${input}"`);
				}
				i++; // consume ]
				pushBracket(content, true);
			} else {
				let content = '';
				let closed = false;
				while (i < len) {
					const c = input[i];
					if (c === ']') {
						closed = true;
						i++;
						break;
					}
					content += c;
					i++;
				}
				if (!closed) throw new TypeError(`Unterminated bracket in path "${input}"`);
				pushBracket(content, false);
			}
			continue;
		}

		bare += ch;
		i++;
	}
	flushBare();

	return path;
}

function dangerousError(key: string) {
	return new Error(`Cannot use "${key}" as a path segment (prototype pollution protection).`);
}

function quoteBracketKey(key: string) {
	return '["' + key.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
}

/**
 * Format a typed path back to its canonical string form.
 * Keys containing `.`, `[`, `]`, quote or backslash, and numeric-looking
 * keys, use the bracket-quoted form.
 */
export function formatPath(path: PathInput): string {
	const typed = toPath(path, { allowDangerous: true });
	let out = '';

	for (const segment of typed) {
		if (segment.kind === 'index') {
			out += `[${segment.index}]`;
			continue;
		}

		const { key } = segment;
		if (
			!key ||
			BARE_SPECIAL_RE.test(key) ||
			INDEX_RE.test(key) ||
			key.includes('"') ||
			key.includes('\\')
		) {
			out += quoteBracketKey(key);
		} else if (out) {
			out += '.' + key;
		} else {
			out = key;
		}
	}

	return out;
}

/** Normalize any accepted path input into the typed representation. */
export function toPath(
	input: PathInput,
	options: { allowDangerous?: boolean } = {}
): TypedPath {
	if (Array.isArray(input)) {
		// Typed paths pass through; token arrays are converted.
		if (input.every((s) => typeof s === 'object' && s !== null && 'kind' in s)) {
			return input as unknown as TypedPath;
		}
		const path = fromTokens(input as unknown as readonly (string | number | symbol)[]);
		assertSafe(path, options.allowDangerous);
		return path;
	}
	return parsePath(String(input), options);
}

export function assertSafe(path: TypedPath, allow = false) {
	if (allow) return;
	for (const segment of path) {
		if (segment.kind === 'key' && DANGEROUS_KEYS.has(segment.key)) {
			throw dangerousError(segment.key);
		}
	}
}

/** Loose token representation used by traversal helpers. */
export function toTokens(path: PathInput): (string | number)[] {
	return toPath(path).map((segment) =>
		segment.kind === 'index' ? segment.index : segment.key
	);
}

/** All-string representation (historical splitPath output). */
export function toKeyStrings(path: PathInput): string[] {
	return toPath(path, { allowDangerous: true }).map((segment) =>
		String(segment.kind === 'index' ? segment.index : segment.key)
	);
}

export type Tree = Record<string, any> | any[];

export type ReadResult = {
	parent: any;
	key: string;
	index: number | undefined;
	value: any;
	exists: boolean;
};

/** Read a value along a typed path without creating intermediates. */
export function readPath(obj: unknown, input: PathInput): ReadResult | undefined {
	const path = toPath(input);
	if (!path.length) return undefined;

	let parent: any = obj;
	for (let i = 0; i < path.length - 1; i++) {
		const segment = path[i];
		const key = segment.kind === 'index' ? segment.index : segment.key;
		if (parent == null) return undefined;
		parent = parent[key];
		if (parent === undefined || parent === null) return undefined;
	}

	const last = path[path.length - 1];
	if (parent == null || typeof parent !== 'object') return undefined;

	if (last.kind === 'key') {
		return {
			parent,
			key: last.key,
			index: undefined,
			value: parent[last.key],
			exists: Object.prototype.hasOwnProperty.call(parent, last.key)
		};
	}

	return {
		parent,
		key: String(last.index),
		index: last.index,
		value: parent[last.index],
		exists: last.index < parent.length
	};
}

export type MutateOptions = {
	/** Called when an intermediate node is missing. Return the node to create. */
	create?: (segment: PathSegment, parent: any, key: string | number) => any;
	/** Skip the prototype-pollution check (used by trusted internal calls). */
	allowDangerous?: boolean;
};

/**
 * Mutate a tree along a path.
 * @param value Value to assign, or a callback receiving the current leaf info.
 * @returns true if the path existed/could be created and was written.
 */
export function setPathMutable(
	obj: any,
	input: PathInput,
	value: any | ((leaf: ReadResult) => any),
	options: MutateOptions = {}
): boolean {
	const path = toPath(input, { allowDangerous: options.allowDangerous });
	if (!path.length) return false;
	assertSafe(path, options.allowDangerous);

	let parent: any = obj;
	for (let i = 0; i < path.length - 1; i++) {
		const segment = path[i];
		const key = segment.kind === 'index' ? segment.index : segment.key;

		if (parent[key] === undefined || parent[key] === null || typeof parent[key] !== 'object') {
			if (!options.create) return false;
			parent[key] = options.create(path[i + 1], parent, key);
		}
		parent = parent[key];
	}

	const last = path[path.length - 1];
	const key = last.kind === 'index' ? last.index : last.key;
	const current: ReadResult = {
		parent,
		key: String(key),
		index: last.kind === 'index' ? last.index : undefined,
		value: parent?.[key],
		exists: parent != null && Object.prototype.hasOwnProperty.call(parent, key)
	};

	parent[key] = typeof value === 'function' ? value(current) : value;
	return true;
}

/** Delete a leaf. Returns true when something was removed. */
export function deletePathMutable(obj: any, input: PathInput): boolean {
	const leaf = readPath(obj, input);
	if (!leaf || !leaf.exists) return false;
	if (leaf.index !== undefined) leaf.parent.splice(leaf.index, 1);
	else delete leaf.parent[leaf.key];
	return true;
}

/**
 * Structural (immutable) set: clones only the nodes on the path.
 * Sibling branches keep referential identity, so the hot path never
 * deep-copies the whole form.
 */
export function setPathImmutable<T>(
	obj: T,
	input: PathInput,
	value: any | ((leaf: ReadResult) => any),
	options: MutateOptions = {}
): T {
	const path = toPath(input, { allowDangerous: options.allowDangerous });
	if (!path.length) return obj;
	assertSafe(path, options.allowDangerous);

	const isFunc = typeof value === 'function';

	const walk = (current: any, depth: number): any => {
		const segment = path[depth];
		const key = segment.kind === 'index' ? segment.index : segment.key;

		if (depth === path.length - 1) {
			const leaf: ReadResult = {
				parent: current,
				key: String(key),
				index: segment.kind === 'index' ? segment.index : undefined,
				value: current?.[key],
				exists: current != null && Object.prototype.hasOwnProperty.call(current, key)
			};
			const nextValue = isFunc ? value(leaf) : value;
			if (current === null || current === undefined || typeof current !== 'object') {
				const created = options.create
					? options.create(segment, null, key)
				 : undefined;
				if (created === undefined) return current;
				(created as any)[key] = nextValue;
				return created;
			}
			const cloneNode: any = Array.isArray(current) ? [...current] : { ...current };
			cloneNode[key] = nextValue;
			return cloneNode;
		}

		const next = current?.[key];
		if (next === undefined || next === null || typeof next !== 'object') {
			if (!options.create) return current;
			const created = options.create(path[depth + 1], current, key);
			const populated = walk(created, depth + 1);
			if (current === null || current === undefined || typeof current !== 'object') {
				return populated;
			}
			const cloneNode: any = Array.isArray(current) ? [...current] : { ...current };
			cloneNode[key] = populated;
			return cloneNode;
		}

		const updated = walk(next, depth + 1);
		if (updated === next) return current;

		const cloneNode: any = Array.isArray(current) ? [...current] : { ...current };
		cloneNode[key] = updated;
		return cloneNode;
	};

	return walk(obj, 0) as T;
}

/** Structural delete; only the path branches get new object identities. */
export function deletePathImmutable<T>(obj: T, input: PathInput): T {
	const leaf = readPath(obj, input);
	if (!leaf || !leaf.exists) return obj;
	return setPathImmutable(obj, input, undefined);
}

/** In error/tainted trees, array-shaped nodes are plain objects keyed by indices;
 * real arrays are leaf message collections and must not be traversed. */
function isTreeNode(value: any): value is Record<string, any> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

//#region Array-index tree migration

/** Shift all numeric children of a tree node from `index` upward (insert) or downward (remove). */
function shiftIndexChildren(node: Record<string, any>, index: number, delta: 1 | -1) {
	const keys = Object.keys(node).filter((key) => INDEX_RE.test(key));
	const numeric =
		delta < 0 ? keys.sort((a, b) => Number(a) - Number(b)) : keys.sort((a, b) => Number(b) - Number(a));

	for (const key of numeric) {
		const i = Number(key);
		const affected = delta < 0 ? i > index : i >= index;
		if (!affected) continue;

		const target = i + delta;
		if (delta < 0 && i === index) {
			// Removal: the element at the index is deleted.
			delete node[key];
		} else {
			node[String(target)] = node[key];
			if (delta < 0) delete node[key];
			// For insert, assigning from high to low avoids clobbering.
		}
	}

	// Insertion opens an empty slot at the index.
	if (delta > 0) delete node[String(index)];
}

/**
 * Migrate index-shaped branches of an error/tainted tree located at
 * `arrayPath` when an item is inserted or removed at `index`.
 *
 * Numeric children are moved structurally (not by string replacement),
 * so keys like `[10]` survive an insertion at `[2]`, and nested
 * index branches follow their parent element.
 *
 * @param delta +1 for insertion, -1 for removal
 */
export function shiftTreeIndexes(
	tree: any,
	arrayPath: PathInput,
	index: number,
	delta: 1 | -1
): void {
	const node = toPath(arrayPath).length ? readPath(tree, arrayPath)?.value : tree;
	if (!node || typeof node !== 'object') return;
	shiftIndexSubtrees(node, index, delta);
}

function shiftIndexSubtrees(node: Record<string, any>, index: number, delta: 1 | -1) {
	shiftIndexChildren(node, index, delta);

	for (const key in node) {
		const child = node[key];
		if (isTreeNode(child)) {
			shiftIndexSubtrees(child, index, delta);
		}
	}
}

/**
 * Drop index branches beyond `length - 1` at the array node and in
 * nested index branches (used when an array was shortened).
 */
export function truncateTreeIndexes(tree: any, arrayPath: PathInput, length: number): void {
	const node = toPath(arrayPath).length ? readPath(tree, arrayPath)?.value : tree;
	if (!node || typeof node !== 'object') return;
	truncateIndexSubtrees(node, length);
}

function truncateIndexSubtrees(node: Record<string, any>, length: number) {
	for (const key in node) {
		if (INDEX_RE.test(key) && Number(key) >= length) {
			delete node[key];
			continue;
		}
		const child = node[key];
		if (isTreeNode(child)) {
			truncateIndexSubtrees(child, length);
		}
	}
}

function identityMap(before: readonly any[], after: readonly any[]): Map<number, number> {
	const n = before.length;
	const m = after.length;
	// Longest common subsequence by referential/primitive identity.
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] =
				before[i] === after[j]
					? dp[i + 1][j + 1] + 1
					: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const mapping = new Map<number, number>();
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (before[i] === after[j]) {
			mapping.set(i, j);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return mapping;
}

/**
 * Migrate the index branches of an error/tainted tree at `arrayPath`
 * from `before` to `after`, following element identity.
 *
 * Items that moved (same reference/primitive value) keep their branch;
 * deleted items lose it; inserted items start with no branch. Branches
 * nested inside item subtrees follow the item they belong to.
 */
export function migrateTreeIndexes(
	tree: any,
	arrayPath: PathInput,
	before: readonly any[],
	after: readonly any[]
): void {
	const rootNode: any = toPath(arrayPath).length ? readPath(tree, arrayPath)?.value : tree;
	if (!rootNode || typeof rootNode !== 'object') return;

	const mapping = identityMap(before, after);
	migrateIndexSubtrees(rootNode, mapping, after.length);
}

function migrateIndexSubtrees(
	node: Record<string, any>,
	mapping: Map<number, number>,
	newLength: number
) {
	const moved: Record<string, any> = {};
	const kept = new Set<string>();

	for (const key in node) {
		if (!INDEX_RE.test(key)) continue;
		const oldIndex = Number(key);
		if (mapping.has(oldIndex)) {
			const newKey = String(mapping.get(oldIndex));
			moved[newKey] = node[key];
			kept.add(newKey);
		}
		delete node[key];
	}

	for (const key of Object.keys(moved)) {
		node[key] = moved[key];
	}

	for (const key in node) {
		const child = node[key];
		if (!isTreeNode(child)) continue;
		if (INDEX_RE.test(key) && Number(key) >= newLength) {
			delete node[key];
			continue;
		}
		migrateIndexSubtrees(child, mapping, newLength);
	}
}

/**
 * Build the default intermediate container for a missing path node:
 * arrays are used when the next segment is an index, otherwise objects.
 */
export function defaultContainer(nextSegment: PathSegment | undefined): any[] | Record<string, any> {
	return nextSegment && nextSegment.kind === 'index' ? [] : {};
}
