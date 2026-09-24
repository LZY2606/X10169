/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Internal typed path model.
 *
 * Every part of superforms that works with field locations (server errors,
 * client validation, tainted state, constraints, form data and snapshots)
 * consumes this single representation, instead of splitting/joining strings
 * on its own.
 *
 * A path is a sequence of {@link PathSegment}s that explicitly distinguishes
 * object keys from array indices. Stringified form (used in FormData field
 * names) supports quoted segments, so object keys containing dots, brackets
 * or any other character round-trip losslessly:
 *
 *   tags[0].name            -> [index 0, key "name"]
   "user.name"             -> [key 'user.name']
 *   "a]b"[2]                -> [key 'a]b', index 2]
 *
 * The unquoted form keeps the historical superforms syntax (`a.b`, `[0]`),
 * so public form data shapes and serialization stay compatible.
 */

export type PathKey = string;

export type PathSegment =
	| { kind: 'key'; key: PathKey }
	| { kind: 'index'; index: number };

export type FieldPath = PathSegment[];

/** Anything accepted by the path functions: canonical strings, segments or legacy path arrays. */
export type PathInput = string | FieldPath | (string | number | symbol)[];

export const ROOT_PATH: FieldPath = [];

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype']);

export function isForbiddenKey(key: PathKey) {
	return FORBIDDEN_KEYS.has(key);
}

function assertSafeKey(key: PathKey) {
	if (isForbiddenKey(key)) {
		throw new Error("Cannot set an object's `__proto__` or `prototype` property");
	}
}

const DIGITS = /^\d+$/;

export function isIndexSegment(segment: PathSegment): segment is Extract<PathSegment, { kind: 'index' }> {
	return segment.kind === 'index';
}

/**
 * Parse a path string into the typed representation.
 *
 * Grammar:
 * - `name`            -> object key
 * - `name.nested`     -> nested object keys
 * - `[0]` / `[2]`     -> array index (only all-digit bracket contents)
 * - `["x.y"]` / `[1]` (quoted digits) -> object key, escaping is JSON-like
 *                                        (`\"`, `\\`, `\n`, ...)
 * - empty brackets and bare empty segments are ignored, as before
 */
export function parsePath(input: string): FieldPath {
	const path: FieldPath = [];
	const length = input.length;
	let i = 0;

	function pushKey(key: string) {
		if (key.length) path.push({ kind: 'key', key });
	}

	while (i < length) {
		const char = input[i];

		if (char === '.') {
			i++;
			continue;
		}

		if (char === '[') {
			const closing = input.indexOf(']', i + 1);
			if (closing === -1) {
				// Malformed, treat the rest as a literal key (historical leniency)
				pushKey(input.slice(i + 1));
				break;
			}

			const inner = input.slice(i + 1, closing);
			i = closing + 1;

			if (!inner.length) continue;

			if (inner[0] === '"' || inner[0] === "'") {
				const quote = inner[0];
				if (inner.length >= 2 && inner[inner.length - 1] === quote) {
					path.push({ kind: 'key', key: unescapeQuoted(inner.slice(1, -1), quote) });
				} else {
					pushKey(inner);
				}
			} else if (DIGITS.test(inner)) {
				path.push({ kind: 'index', index: Number(inner) });
			} else {
				pushKey(inner);
			}

			continue;
		}

		// Unquoted token, read until the next separator
		let end = i;
		while (end < length && input[end] !== '.' && input[end] !== '[') end++;
		const token = input.slice(i, end);
		i = end;

		if (DIGITS.test(token)) path.push({ kind: 'index', index: Number(token) });
		else pushKey(token);
	}

	return path;
}

function unescapeQuoted(value: string, quote: string): string {
	if (!value.includes('\\')) return value;

	let output = '';
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char !== '\\' || i === value.length - 1) {
			output += char;
			continue;
		}

		const next = value[++i];
		if (next === 'n') output += '\n';
		else if (next === 't') output += '\t';
		else if (next === 'r') output += '\r';
		else output += next ?? quote;
	}
	return output;
}

/**
 * Convert any accepted path input to the typed representation.
 * Numbers become array indices, strings become object keys (even digit strings).
 */
export function toSegments(path: PathInput): FieldPath {
	if (typeof path === 'string') return parsePath(path);

	const segments: FieldPath = [];
	for (const part of path) {
		if (typeof part === 'number') {
			segments.push({ kind: 'index', index: part });
		} else if (typeof part === 'object' && part !== null && 'kind' in part) {
			segments.push(part as PathSegment);
		} else {
			const key = String(part);
			if (DIGITS.test(key)) segments.push({ kind: 'index', index: Number(key) });
			else if (key.length) segments.push({ kind: 'key', key });
		}
	}
	return segments;
}

function needsQuoting(key: string): boolean {
	return (
		!key.length ||
		DIGITS.test(key) ||
		key.includes('.') ||
		key.includes('[') ||
		key.includes(']')
	);
}

function escapeQuoted(value: string): string {
	return value.replace(/["\\\n\r\t]/g, (char) => {
		switch (char) {
			case '"':
				return '\\"';
			case '\\':
				return '\\\\';
			case '\n':
				return '\\n';
			case '\r':
				return '\\r';
			case '\t':
				return '\\t';
			default:
				return char;
		}
	});
}

/**
 * Format a typed path back to its string form.
 *
 * By default digit-only object keys are rendered as `[0]`, matching the
 * historical mergePath output. With `quoteSpecial` they are quoted (`["0"]`),
 * which is the canonical, round-trippable form used internally for keys that
 * may contain special characters.
 */
export function formatPath(
	path: PathInput,
	options: { quoteSpecial?: boolean } = {}
): string {
	const segments = toSegments(path);
	let output = '';

	for (const segment of segments) {
		if (segment.kind === 'index') {
			output += `[${segment.index}]`;
			continue;
		}

		const { key } = segment;
		if (needsQuoting(key)) {
			if (options.quoteSpecial || DIGITS.test(key) || /[[\]]/.test(key) || key.includes('.')) {
				output += `["${escapeQuoted(key)}"]`;
				continue;
			}
		}

		output += output.length ? `.${key}` : key;
	}

	return output;
}

/** Legacy adapter path arrays, as produced by validation libraries. */
export function toLegacyPath(path: FieldPath): (string | number)[] {
	return path.map((segment) =>
		segment.kind === 'index' ? segment.index : segment.key
	);
}

/** Drop array indices, yielding the path in the schema/constraints shape tree. */
export function objectPath(path: PathInput): string[] {
	return toSegments(path)
		.filter((segment): segment is Extract<PathSegment, { kind: 'key' }> => segment.kind === 'key')
		.map((segment) => segment.key);
}

export function samePath(a: PathInput, b: PathInput): boolean {
	const left = toSegments(a);
	const right = toSegments(b);
	if (left.length !== right.length) return false;
	return left.every((segment, i) => {
		const other = right[i];
		return segment.kind === other.kind
			? segment.kind === 'index'
				? segment.index === (other as { index: number }).index
				: segment.key === (other as { key: string }).key
			: false;
	});
}

export function isRootPath(path: PathInput): boolean {
	return toSegments(path).length === 0;
}

/////////////////////////////////////////////////////////////////////

export type PathLocation = {
	parent: Record<PropertyKey, unknown> | unknown[];
	segment: PathSegment;
	/** Storage key: number on arrays, string on plain objects. */
	key: string | number;
	value: unknown;
	segments: FieldPath;
	path: (string | number)[];
};

type Recordish = Record<PropertyKey, unknown>;

function isContainer(value: unknown): value is Recordish | unknown[] {
	return !!value && typeof value === 'object';
}

function storageKey(node: unknown, segment: PathSegment): string | number {
	return segment.kind === 'index' && Array.isArray(node) ? segment.index
		: segment.kind === 'index' ? String(segment.index)
		: segment.key;
}

function readStorage(node: unknown, segment: PathSegment): unknown {
	if (!isContainer(node)) return undefined;
	return (node as Recordish)[storageKey(node, segment)];
}

function assertSafeSegment(segment: PathSegment) {
	if (segment.kind === 'key') assertSafeKey(segment.key);
}

export type CreateContext = {
	parent: Recordish | unknown[];
	segment: PathSegment;
	key: string | number;
	value: unknown;
	/** Zero-based depth of the visited segment in the path. */
	depth: number;
	segments: FieldPath;
};

/**
 * Walk a path, returning the leaf location. Mirrors the historical
 * traversePath contract: returns undefined when an intermediate value is
 * missing (or when `create` yields undefined).
 *
 * When `create` is provided, missing/non-object intermediate nodes are passed
 * to it; the returned container replaces the node and the walk continues.
 */
export function locatePath(
	root: unknown,
	path: PathInput,
	create?: (context: CreateContext) => unknown | void
): PathLocation | undefined {
	const segments = toSegments(path);
	if (!segments.length) return undefined;

	for (const segment of segments) assertSafeSegment(segment);

	let node: unknown = root;

	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];

		if (!isContainer(node)) return undefined;

		let value = readStorage(node, segment);

		if (create && (value === undefined || typeof value !== 'object')) {
			const created = create({
				parent: node as Recordish,
				segment,
				key: storageKey(node, segment),
				value,
				depth: i,
				segments
			});
			if (created === undefined) return undefined;
			value = created;
		}

		if (value === undefined) return undefined;
		node = value;
	}

	if (!isContainer(node)) return undefined;

	const segment = segments[segments.length - 1];
	return {
		parent: node as Recordish,
		segment,
		key: storageKey(node, segment),
		value: readStorage(node, segment),
		segments,
		path: toLegacyPath(segments)
	};
}

/** Read a value at a path; returns undefined when any segment is missing. */
export function getPath(root: unknown, path: PathInput): unknown {
	return locatePath(root, path)?.value;
}

export type ContainerFactory = (context: CreateContext) => unknown;

/**
 * Historical setPaths behaviour: intermediate nodes become plain objects.
 */
const plainObjectFactory: ContainerFactory = ({ parent, key }) => {
	const container = {};
	(parent as Recordish)[key] = container;
	return container;
};

/** Form data behaviour: indices create arrays, keys create objects. */
export const typedContainerFactory: ContainerFactory = ({ parent, segment, key }) => {
	const container = segment.kind === 'index' ? [] : {};
	(parent as Recordish)[key] = container;
	return container;
};

/**
 * Set a value in place, creating intermediate containers through `factory`.
 * Returns false when the path could not be located/created.
 */
export function setPathMutable(
	root: unknown,
	path: PathInput,
	value: unknown,
	factory: ContainerFactory = plainObjectFactory
): boolean {
	const location = locatePath(
		root,
		path,
		(context) => {
			if (context.value === undefined || typeof context.value !== 'object') {
				return factory(context);
			}
			return context.value;
		}
	);

	if (!location) return false;
	(location.parent as Recordish)[location.key] = value;
	return true;
}

/** Remove a leaf in place. Missing paths are a no-op. */
export function removePathMutable(root: unknown, path: PathInput): boolean {
	const location = locatePath(root, path);
	if (!location) return false;
	if (!(location.key in location.parent)) return false;
	delete (location.parent as Recordish)[location.key as PropertyKey];
	return true;
}

/////////////////////////////////////////////////////////////////////
// Immutable (structural-sharing) operations
/////////////////////////////////////////////////////////////////////

const REMOVE = Symbol('remove-path');

function shallowCloneContainer(value: unknown, nextSegment: PathSegment): Recordish | unknown[] {
	if (Array.isArray(value)) return value.slice();
	if (isContainer(value)) return { ...(value as Recordish) };
	return nextSegment.kind === 'index' ? [] : {};
}

function isEmptyContainer(value: unknown): boolean {
	if (Array.isArray(value)) return value.length === 0;
	if (isContainer(value)) return Object.keys(value).length === 0;
	return false;
}

/**
 * Update a single path immutably. Only containers along the target branch are
 * cloned; every other branch keeps its reference (no deep copy of the tree).
 *
 * Return the {@link REMOVE_PATH} sentinel from `updater` to delete the leaf;
 * emptied parent containers are pruned unless `pruneEmpty` is false.
 */
export function updatePathImmutable(
	root: unknown,
	path: PathInput,
	updater: (location: PathLocation) => unknown,
	options: { pruneEmpty?: boolean } = {}
): unknown {
	const segments = toSegments(path);
	if (!segments.length) return root;

	for (const segment of segments) assertSafeSegment(segment);

	const { pruneEmpty = true } = options;

	// Clone the spine top-down.
	const spine: { node: Recordish | unknown[]; segment: PathSegment }[] = [];
	const rootClone = shallowCloneContainer(root, segments[0]);
	spine.push({ node: rootClone, segment: segments[0] });

	for (let i = 0; i < segments.length - 1; i++) {
		const parent = spine[i].node;
		const segment = segments[i];
		const child = shallowCloneContainer(readStorage(parent, segment), segments[i + 1]);
		(parent as Recordish)[storageKey(parent, segment)] = child;
		spine.push({ node: child, segment: segments[i + 1] });
	}

	const leafParent = spine[segments.length - 1].node;
	const leafSegment = segments[segments.length - 1];
	const leafKey = storageKey(leafParent, leafSegment);

	const leafLocation: PathLocation = {
		parent: leafParent,
		segment: leafSegment,
		key: leafKey,
		value: readStorage(leafParent, leafSegment),
		segments,
		path: toLegacyPath(segments)
	};

	const result = updater(leafLocation);

	if (result === REMOVE) delete (leafParent as Recordish)[leafKey as PropertyKey];
	else (leafParent as Recordish)[leafKey] = result;

	// Prune emptied containers bottom-up, never pruning the root itself.
	if (pruneEmpty) {
		for (let i = spine.length - 1; i > 0 && isEmptyContainer(spine[i].node); i--) {
			const parent = spine[i - 1].node;
			const childSegment = spine[i].segment;
			delete (parent as Recordish)[storageKey(parent, childSegment) as PropertyKey];
		}
	}

	return rootClone;
}

/** Sentinel returned from an immutable updater to delete the leaf. */
export const REMOVE_PATH = REMOVE;

export function setPathImmutable(root: unknown, path: PathInput, value: unknown): unknown {
	return updatePathImmutable(root, path, () => value);
}

export function removePathImmutable(root: unknown, path: PathInput, options?: { pruneEmpty?: boolean }): unknown {
	return updatePathImmutable(root, path, () => REMOVE, options);
}

/////////////////////////////////////////////////////////////////////
// Array index migration
/////////////////////////////////////////////////////////////////////

/**
 * Mapping of old array indices. `null` means the element (and its subtree)
 * was removed; a number is the index it migrated to.
 */
export type IndexMap = Map<number, number | null>;

/** Positional contract for removing `count` elements at `removedAt`. */
export function removeIndexMap(
	oldLength: number,
	removedAt: number,
	count = 1
): IndexMap {
	const map: IndexMap = new Map();
	for (let i = 0; i < oldLength; i++) {
		if (i >= removedAt && i < removedAt + count) map.set(i, null);
		else map.set(i, i < removedAt ? i : i - count);
	}
	return map;
}

/** Positional contract for inserting `count` empty elements at `insertedAt`. */
export function insertIndexMap(
	oldLength: number,
	insertedAt: number,
	count = 1
): IndexMap {
	const map: IndexMap = new Map();
	for (let i = 0; i < oldLength; i++) {
		map.set(i, i < insertedAt ? i : i + count);
	}
	return map;
}

/**
 * Build an index map by element identity, using a longest-common-subsequence
 * matching. Equal elements (by `equals`, defaulting to reference equality)
 * keep their pairing, so equal values at different positions migrate stably
 * without relying on string replacement.
 */
export function identityIndexMap<T>(
	oldItems: ArrayLike<T>,
	newItems: ArrayLike<T>,
	equals: (a: T, b: T) => boolean = (a, b) => a === b
): IndexMap {
	const oldLength = oldItems.length;
	const newLength = newItems.length;

	// LCS table
	const lcs: number[][] = Array.from({ length: oldLength + 1 }, () =>
		new Array<number>(newLength + 1).fill(0)
	);
	for (let i = oldLength - 1; i >= 0; i--) {
		for (let j = newLength - 1; j >= 0; j--) {
			lcs[i][j] = equals(oldItems[i], newItems[j])
				? lcs[i + 1][j + 1] + 1
				: Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	const matches = new Map<number, number>();
	let i = 0;
	let j = 0;
	while (i < oldLength && j < newLength) {
		if (equals(oldItems[i], newItems[j])) {
			matches.set(i, j);
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}

	const map: IndexMap = new Map();
	for (let oldIndex = 0; oldIndex < oldLength; oldIndex++) {
		map.set(oldIndex, matches.has(oldIndex) ? (matches.get(oldIndex) as number) : null);
	}
	return map;
}

/**
 * Migrate the indexed children of the array-like node at `arrayPath`,
 * according to `indexMap`. Non-indexed keys (`_errors`, object errors) are
 * preserved. Unchanged trees return the same references; only the affected
 * branch is cloned (plus its spine).
 */
export function migrateArrayPaths<T>(
	tree: T,
	arrayPath: PathInput,
	indexMap: IndexMap
): T {
	const segments = toSegments(arrayPath);
	const location = locatePath(tree, segments);

	if (!location || !isContainer(location.value)) return tree;

	const node = location.value as Recordish;
	const migrated: Recordish = Array.isArray(node) ? [] : {};
	let changed = false;

	for (const key of Object.keys(node)) {
		if (DIGITS.test(key)) {
			const oldIndex = Number(key);
			if (!indexMap.has(oldIndex)) {
				// Unknown to the mapping: keep position (e.g. indices past old length).
				migrated[key] = node[key];
				continue;
			}

			const newIndex = indexMap.get(oldIndex);
			if (newIndex === null || newIndex === undefined) {
				changed = true;
				continue;
			}

			const newKey = Array.isArray(migrated) ? newIndex : String(newIndex);
			migrated[newKey as PropertyKey] = node[key];
			if (newKey !== key) changed = true;
		} else {
			migrated[key] = node[key];
		}
	}

	if (!changed) return tree;

	return setPathImmutable(tree, segments, migrated) as T;
}
