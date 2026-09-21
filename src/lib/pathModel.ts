/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Internal typed path model.
 *
 * Single source of truth for how field paths are parsed, normalized, read,
 * updated and deleted across server errors, client validation, tainted state,
 * constraints, form data and snapshots.
 *
 * A path is an array of `PathSegment`s that explicitly distinguishes between
 * object keys (`string`) and array indices (`number`).
 *
 * String path grammar (superset of the previous dotted/bracketed format):
 * - Object keys: `name`, `user.email`
 * - Array indices: `tags[0]`, `[0]` (non-negative integers)
 * - Bracketed keys containing any character: `[weird.key]`, `[a[b]c]`
 *   by escaping `]` and `\` as `\]` and `\\` inside the brackets.
 * - An empty quoted key `[]` represents an actual empty-string key.
 *
 * Example:
 *   parsePath('a[1][we.ird\]]') === ['a', 1, 'we.ird]']
 */

export type PathSegment = string | number;
export type TypedPath = readonly PathSegment[];

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype']);
const INDEX_RE = /^(?:0|[1-9][0-9]*)$/;

export function isIndexSegment(segment: PathSegment): segment is number {
	return typeof segment === 'number';
}

export function isForbiddenKey(key: PropertyKey): boolean {
	return typeof key === 'string' && FORBIDDEN_KEYS.has(key);
}

function assertSafeSegment(segment: PathSegment) {
	if (typeof segment === 'string' && FORBIDDEN_KEYS.has(segment)) {
		throw new Error("Cannot set an object's `__proto__` or `prototype` property");
	}
}

function assertSafePath(path: TypedPath) {
	for (const segment of path) assertSafeSegment(segment);
}

//#region Parsing and formatting

/**
 * Parse a string path into typed segments.
 * Numeric-looking segments (both `[0]` and `.0`) become array indices.
 */
export function parsePath(path: string): PathSegment[] {
	if (!path) return [];

	const output: PathSegment[] = [];
	let i = 0;
	let expectDot = false;

	function pushBare(start: number) {
		const key = path.slice(start, i);
		if (key) output.push(INDEX_RE.test(key) ? Number(key) : key);
	}

	while (i < path.length) {
		if (path[i] === '.') {
			i++;
			expectDot = false;
			continue;
		}

		if (path[i] === '[') {
			i++;
			let bare = '';
			while (i < path.length && path[i] !== ']') {
				if (path[i] === '\\' && i + 1 < path.length && (path[i + 1] === ']' || path[i + 1] === '\\')) {
					bare += path[i + 1];
					i += 2;
				} else {
					bare += path[i];
					i++;
				}
			}
			if (i < path.length && path[i] === ']') i++; // consume closing bracket
			output.push(INDEX_RE.test(bare) ? Number(bare) : bare);
			expectDot = true;
			continue;
		}

		if (expectDot) {
			// Missing separator between a bracket group and a bare key;
			// treat the dot as optional to stay lenient with old formats.
			expectDot = false;
		}

		const start = i;
		while (i < path.length && path[i] !== '.' && path[i] !== '[') i++;
		pushBare(start);
		expectDot = false;
	}

	return output;
}

function escapeBracketKey(key: string): string {
	return /[[\].]/.test(key) || INDEX_RE.test(key)
		? `[${key.replace(/\\/g, '\\\\').replace(/]/g, '\\]')}]`
		: key;
}

/**
 * Format typed segments into the canonical string representation.
 * Compatible with the previous mergePath output for normal keys and indices,
 * while using brackets (with escaping) for keys containing dots/brackets.
 */
export function formatPath(path: TypedPath): string {
	let output = '';
	for (const segment of path) {
		if (typeof segment === 'number') {
			output += `[${segment}]`;
		} else if (!output) {
			output += escapeBracketKey(segment);
		} else {
			const key = escapeBracketKey(segment);
			output += key.startsWith('[') ? key : `.${key}`;
		}
	}
	return output;
}

/** Normalize adapter-produced paths, turning numeric strings into indices. */
export function normalizePath(path: readonly PropertyKey[]): PathSegment[] {
	return path.map((segment) => {
		if (typeof segment === 'number') return segment;
		if (typeof segment === 'symbol') return String(segment);
		return INDEX_RE.test(segment) ? Number(segment) : segment;
	});
}

/** Stable identity key for a path, used for comparisons and Set membership. */
export function pathId(path: TypedPath): string {
	return path
		.map((segment) =>
			typeof segment === 'number'
				? `#${segment}`
				: `$${segment.replace(/\\/g, '\\\\').replace(/#/g, '\\#')}`
		)
		.join('/');
}

/**
 * Compare two paths.
 * By default numeric indices and numeric strings are considered equal
 * (matching how JS object access works); strict keeps the distinction.
 */
export function samePath(a: TypedPath, b: TypedPath, strict = false): boolean {
	if (a.length !== b.length) return false;
	return a.every((segment, i) => {
		const other = b[i];
		if (strict) return segment === other;
		if (typeof segment === 'number' || typeof other === 'number') {
			return Number(segment) === Number(other);
		}
		return segment === other;
	});
}

/** Convert a path to string keys, e.g. for lookup in a plain-object metadata tree. */
export function stringKeys(path: TypedPath): string[] {
	return path.map(String);
}

//#endregion

//#region Reading

export type NodeLocation = {
	parent: any;
	key: string;
	index: number;
	value: any;
	exists: boolean;
};

function asKey(parent: unknown, segment: PathSegment): string | number {
	return Array.isArray(parent) && typeof segment === 'number' ? segment : String(segment);
}

/**
 * Read a node location without creating anything.
 * Returns undefined if any intermediate container is missing.
 */
export function locateNode(obj: unknown, path: TypedPath): NodeLocation | undefined {
	if (!path.length) return undefined;
	assertSafePath(path);

	let parent: any = obj;

	for (let i = 0; i < path.length - 1; i++) {
		if (parent === null || typeof parent !== 'object') return undefined;
		const key = asKey(parent, path[i]);
		const value = parent[key];
		if (value === undefined || value === null) return undefined;
		parent = value;
	}

	if (parent === null || typeof parent !== 'object') return undefined;

	const index = path.length - 1;
	const key = asKey(parent, path[index]);
	return {
		parent,
		key: String(key),
		index: key as number,
		value: parent[key],
		exists: key in parent
	};
}

export type ContainerMode = 'object' | 'array' | 'auto';

function createContainer(segment: PathSegment | undefined, mode: ContainerMode): any {
	if (mode === 'array' || (mode === 'auto' && typeof segment === 'number')) return [];
	return {};
}

export type EnsureOptions = {
	/** What intermediate containers are created as. Metadata trees default to objects. */
	mode?: ContainerMode;
};

/**
 * Ensure a leaf location exists, creating intermediate containers according to `mode`.
 */
export function ensureNode(obj: any, path: TypedPath, options: EnsureOptions = {}): NodeLocation {
	if (!path.length) throw new Error('Cannot ensure the root path.');
	assertSafePath(path);
	const mode = options.mode ?? 'object';

	let parent: any = obj;

	for (let i = 0; i < path.length; i++) {
		const segment = path[i];
		const key = asKey(parent, segment);

		if (i === path.length - 1) {
			return {
				parent,
				key: String(key),
				index: key as number,
				value: parent[key],
				exists: key in parent
			};
		}

		if (parent[key] === undefined || parent[key] === null || typeof parent[key] !== 'object') {
			parent[key] = createContainer(path[i + 1], mode);
		}
		parent = parent[key];
	}

	// Unreachable, but keeps types happy
	throw new Error('ensureNode failed.');
}

/** Read a value at a path, or undefined if it doesn't exist. */
export function getPath(obj: unknown, path: TypedPath): unknown {
	return locateNode(obj, path)?.value;
}

//#endregion

//#region Mutable updates

export type SetPathOptions = EnsureOptions & {
	/** Delete the key instead of setting it. */
	remove?: boolean;
	/**
	 * Prune empty parent containers (objects without keys, or empty arrays)
	 * after a removal. Defaults to true for `removePath`.
	 */
	prune?: boolean;
};

/**
 * Mutably set (or delete) a value at a path, creating intermediate containers.
 * Metadata trees (errors/tainted/constraints) should use the default 'object' mode.
 */
export function setPathValue(
	obj: any,
	path: TypedPath,
	value: unknown,
	options: SetPathOptions = {}
): boolean {
	if (!path.length) throw new Error('Cannot set the root path.');
	assertSafePath(path);

	const node = ensureNode(obj, path, { mode: options.mode ?? 'object' });

	if (options.remove) {
		if (!(node.index in node.parent)) return false;
		delete node.parent[node.index];
		if (options.prune ?? true) pruneParents(obj, path);
		return true;
	}

	node.parent[node.index] = value;
	return true;
}

/** Mutably delete a path, pruning empty parent containers by default. */
export function removePath(
	obj: any,
	path: TypedPath,
	options: Omit<SetPathOptions, 'remove'> = {}
): boolean {
	return setPathValue(obj, path, undefined, {
		...options,
		remove: true,
		prune: options.prune ?? true
	});
}

function isEmptyContainer(value: unknown): boolean {
	if (Array.isArray(value)) return value.length === 0;
	if (value && typeof value === 'object') return Object.keys(value).length === 0;
	return false;
}

function pruneParents(root: any, path: TypedPath) {
	for (let i = path.length - 2; i >= 0; i--) {
		const node = locateNode(root, path.slice(0, i + 1));
		if (!node || !isEmptyContainer(node.value)) break;
		if (i === 0) break; // keep the root even if empty
		const parentNode = locateNode(root, path.slice(0, i));
		if (!parentNode) break;
		delete parentNode.parent[parentNode.index];
	}
}

//#endregion

//#region Immutable updates

/**
 * Immutably set a value at a path.
 * Only containers along the target branch are cloned; siblings keep
 * their references, so no whole-tree deep copy is performed.
 */
export function setPathImmutable<T>(
	root: T,
	path: TypedPath,
	value: unknown,
	options: EnsureOptions = {}
): T {
	if (!path.length) throw new Error('Cannot set the root path.');
	assertSafePath(path);
	const mode = options.mode ?? 'object';

	const cloneContainer = (container: any, i: number): any => {
		const current = container;
		const next =
			Array.isArray(current)
				? [...current]
				: current && typeof current === 'object'
					? { ...current }
					: createContainer(path[i + 1], mode);

		if (i === path.length - 1) {
			next[asKey(next, path[i])] = value;
			return next;
		}

		const childKey = asKey(next, path[i + 1]);
		const child = next[childKey];
		next[childKey] =
			child && typeof child === 'object'
				? cloneContainer(child, i + 1)
				: cloneContainer(createContainer(path[i + 2], mode), i + 1);
		return next;
	};

	const base =
		root && typeof root === 'object'
			? (root as any)
			: createContainer(path[0], mode);

	return cloneContainer(base, 0) as T;
}

/**
 * Immutably delete a path, optionally pruning emptied parents.
 * Only the target branch gets new container identities.
 */
export function removePathImmutable<T>(
	root: T,
	path: TypedPath,
	options: { prune?: boolean } = {}
): T {
	if (!path.length) return root;
	assertSafePath(path);
	const prune = options.prune ?? false;

	const recurse = (container: any, i: number): any => {
		const key = asKey(container, path[i]);
		if (!(key in container)) return container;

		if (i === path.length - 1) {
			if (Array.isArray(container)) {
				// Keep positional stability in arrays.
				const next = [...container];
				next.splice(key as number, 1);
				return next;
			}
			const next = { ...container };
			delete next[key];
			return next;
		}

		const child = container[key];
		if (!child || typeof child !== 'object') return container;
		const newChild = recurse(child, i + 1);

		if (newChild === child) return container;
		if (prune && isEmptyContainer(newChild)) {
			if (Array.isArray(container)) {
				const next = [...container];
				next.splice(key as number, 1);
				return next;
			}
			const next = { ...container };
			delete next[key];
			return next;
		}

		const next = Array.isArray(container) ? [...container] : { ...container };
		next[key] = newChild;
		return next;
	};

	if (!(root && typeof root === 'object')) return root;
	return recurse(root, 0) as T;
}

//#endregion

//#region Array migration

/**
 * Structural/identity-aware equality for array elements.
 * Falls back from referential identity to a structural comparison of
 * primitives, Dates, arrays and plain objects.
 */
export function sameElement(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
	if (a instanceof File && b instanceof File) return a === b;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => sameElement(v, b[i]));
	}
	if (a && b && typeof a === 'object' && typeof b === 'object') {
		if (a instanceof Date || b instanceof Date) return false;
		if (Array.isArray(a) || Array.isArray(b)) return false;
		const ak = Object.keys(a as object);
		const bk = Object.keys(b as object);
		if (ak.length !== bk.length) return false;
		return ak.every((key) => sameElement((a as any)[key], (b as any)[key]));
	}
	return false;
}

/**
 * Compute a stable index mapping when an array changes.
 *
 * Each new index maps to the old index it originated from (or null when
 * inserted). Elements are first matched by referential identity, then by
 * structural equality; remaining indices are aligned with an order-preserving
 * LCS pass, so deleting the middle shifts only later elements instead of
 * doing a string-level replacement.
 */
export function stableIndexMap(
	oldArray: readonly unknown[],
	newArray: readonly unknown[]
): (number | null)[] {
	const n = newArray.length;
	const m = oldArray.length;

	// matched[n] = old index paired with this new index, via identity/equality
	const pair = new Array(n).fill(-1);
	const oldUsed = new Array(m).fill(false);

	function match(identityOnly: boolean) {
		for (let i = 0; i < n; i++) {
			if (pair[i] !== -1) continue;
			for (let j = 0; j < m; j++) {
				if (oldUsed[j]) continue;
				const equal = identityOnly
					? oldArray[j] === newArray[i]
					: sameElement(oldArray[j], newArray[i]);
				if (equal) {
					pair[i] = j;
					oldUsed[j] = true;
					break;
				}
			}
		}
	}

	match(true);
	match(false);

	const unmatchedNew: number[] = [];
	const unmatchedOld: number[] = [];
	for (let i = 0; i < n; i++) if (pair[i] === -1) unmatchedNew.push(i);
	for (let j = 0; j < m; j++) if (!oldUsed[j]) unmatchedOld.push(j);

	// Order-preserving LCS alignment of the unmatched indices, so a removal in
	// the middle shifts later indices exactly once and inserts map to null.
	const dp: number[][] = Array.from({ length: unmatchedNew.length + 1 }, () =>
		new Array(unmatchedOld.length + 1).fill(0)
	);
	for (let a = 1; a <= unmatchedNew.length; a++) {
		for (let b = 1; b <= unmatchedOld.length; b++) {
			dp[a][b] = Math.max(dp[a - 1][b], dp[a][b - 1]);
			if (unmatchedNew[a - 1] !== undefined && unmatchedOld[b - 1] !== undefined) {
				dp[a][b] = Math.max(dp[a][b], dp[a - 1][b - 1] + 1);
			}
		}
	}

	let a = unmatchedNew.length;
	let b = unmatchedOld.length;
	while (a > 0 && b > 0) {
		if (dp[a][b] === dp[a - 1][b - 1] + 1) {
			pair[unmatchedNew[a - 1]] = unmatchedOld[b - 1];
			a--;
			b--;
		} else if (dp[a - 1][b] >= dp[a][b - 1]) {
			a--;
		} else {
			b--;
		}
	}

	return pair.map((j) => (j === -1 ? null : j));
}

/**
 * Migrate a plain-object metadata node (errors/tainted) whose child indices
 * correspond to array elements, according to `indexMap`. Keys that aren't
 * numeric are preserved untouched; `_errors` on the node is kept.
 *
 * Returns the migrated node. The input node is mutated and returned.
 */
export function migrateMetadataNode(
	node: Record<string, unknown> | undefined,
	indexMap: (number | null)[]
): Record<string, unknown> | undefined {
	if (!node || typeof node !== 'object' || Array.isArray(node)) return node;

	const numericEntries: Array<[number, unknown]> = [];
	const passthrough: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(node)) {
		if (INDEX_RE.test(key)) numericEntries.push([Number(key), value]);
		else passthrough[key] = value;
	}

	if (!numericEntries.length) return node;

	const migrated: Record<string, unknown> = { ...passthrough };

	for (let newIndex = 0; newIndex < indexMap.length; newIndex++) {
		const oldIndex = indexMap[newIndex];
		if (oldIndex === null) continue;
		const entry = numericEntries.find(([index]) => index === oldIndex);
		if (entry) migrated[newIndex] = entry[1];
	}

	// Preserve metadata for indices beyond both arrays only if no resize occurred there.
	// Public contract: deleted element metadata is dropped, inserted elements start clean.
	return migrated;
}


/**
 * Recursively migrate a metadata tree (errors/tainted) along array paths that
 * changed between `oldData` and `newData`. Nested arrays are handled by
 * migrating parent arrays first, then recursing into migrated subtrees.
 *
 * Returns the migrated tree; only branches containing arrays get new
 * container identities, `undefined` tombstones are preserved.
 */
export function migrateMetadataTree(
	tree: unknown,
	oldData: unknown,
	newData: unknown
): unknown {
	if (tree === undefined || tree === null) return tree;

	if (Array.isArray(oldData) && Array.isArray(newData)) {
		if (typeof tree !== 'object' || Array.isArray(tree)) return tree;

		const indexMap = stableIndexMap(oldData, newData);
		const migrated = migrateMetadataNode(tree as Record<string, unknown>, indexMap);
		if (!migrated) return migrated;

		for (let newIndex = 0; newIndex < newData.length; newIndex++) {
			const oldIndex = indexMap[newIndex];
			if (oldIndex === null) continue;
			const childTree = migrated[newIndex];
			if (childTree === undefined) continue;
			migrated[newIndex] = migrateMetadataTree(childTree, oldData[oldIndex], newData[newIndex]);
		}

		return migrated;
	}

	if (
		oldData &&
		newData &&
		typeof oldData === 'object' &&
		typeof newData === 'object' &&
		typeof tree === 'object' &&
		!Array.isArray(tree)
	) {
		const oldObj = oldData as Record<string, unknown>;
		const newObj = newData as Record<string, unknown>;
		const node = tree as Record<string, unknown>;
		const keys = Array.from(new Set([...Object.keys(oldObj), ...Object.keys(newObj)]));
		let changed = false;
		const output: Record<string, unknown> = {};

		for (const key of Object.keys(node)) {
			if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
			const child = isForbiddenKey(key)
				? node[key]
				: migrateMetadataTree(node[key], oldObj[key], newObj[key]);
			output[key] = child;
			if (child !== node[key]) changed = true;
		}

		return changed ? output : tree;
	}

	return tree;
}

//#endregion
