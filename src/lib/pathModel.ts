/* eslint-disable @typescript-eslint/no-explicit-any */
import { pathExists, traversePath } from './traversal.js';

/**
 * Internal typed path model.
 *
 * Every string path in the library (server errors, client validation,
 * tainted state, constraints, snapshots and form data transport) is parsed
 * into this representation before being consumed, so object keys and array
 * indices can never be confused.
 *
 * Grammar:
 * - Root: the empty string -> no segments.
 * - Object access: `name`, `a.b`, `["quoted name"]` or `['quoted name']`.
 * - Array access: `[0]`.
 * - Escapes inside unquoted keys: `\.` `\[` `\]` `\"` `\'` `\\` and `\`
 *   before any other character (which yields the character itself).
 * - Empty segments from consecutive dots (`a..b`) are ignored, matching the
 *   historical dot notation. Empty keys require `[""]`.
 */

export type KeySegment = { kind: 'key'; key: string };
export type IndexSegment = { kind: 'index'; index: number };
export type PathSegment = KeySegment | IndexSegment;
export type TypedPath = PathSegment[];

export function keySegment(key: string): KeySegment {
	return { kind: 'key', key };
}

export function indexSegment(index: number): IndexSegment {
	return { kind: 'index', index };
}

export const INDEX_RE = /^\d+$/;

export function isIndexKey(key: string): boolean {
	return INDEX_RE.test(key);
}
const FIRST_KEY_RE = /^[A-Za-z_$][\w$-]*$/;
// Characters that need backslash escaping when a key is rendered unquoted.
const UNSAFE_KEY_CHARS = /[.[\]\\'"]/;

function makeIndex(raw: string, start: number): IndexSegment {
	const index = Number(raw);
	if (!Number.isSafeInteger(index)) {
		throw new Error(`Invalid array index "${raw}" at position ${start} in path.`);
	}
	return { kind: 'index', index };
}

/**
 * Parses a string path into typed segments, distinguishing object keys from
 * array indices. Supports escaped special characters and quoted bracket keys.
 */
export function parsePath(path: string): TypedPath {
	const segments: TypedPath = [];
	let i = 0;

	function pushKey(key: string) {
		// Ignore empty unquoted segments (e.g. leading/consecutive dots),
		// preserving the historical splitPath behavior.
		if (key.length) segments.push({ kind: 'key', key });
	}

	while (i < path.length) {
		const ch = path[i];

		if (ch === '.') {
			i++;
			continue;
		}

		if (ch === '[') {
			const close = path.indexOf(']', i + 1);
			if (close === -1) throw new Error(`Unterminated bracket at position ${i} in path.`);

			const inner = path.slice(i + 1, close);
			const quote = inner[0];

			if ((quote === '"' || quote === "'") && inner[inner.length - 1] === quote) {
				segments.push({ kind: 'key', key: unescapeKey(inner.slice(1, -1)) });
			} else if (INDEX_RE.test(inner)) {
				segments.push(makeIndex(inner, i + 1));
			} else {
				segments.push({ kind: 'key', key: unescapeKey(inner) });
			}

			i = close + 1;
			continue;
		}

		// Unquoted key, terminated by a dot or opening bracket.
		let key = '';
		while (i < path.length) {
			const c = path[i];
			if (c === '.' || c === '[') break;
			if (c === '\\' && i + 1 < path.length) {
				key += path[i + 1];
				i += 2;
			} else {
				key += c;
				i++;
			}
		}
		pushKey(key);
	}

	return segments;
}

function unescapeKey(raw: string): string {
	let output = '';
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === '\\' && i + 1 < raw.length) {
			output += raw[i + 1];
			i++;
		} else {
			output += raw[i];
		}
	}
	return output;
}

function escapeKey(key: string): string {
	let output = '';
	for (const ch of key) {
		if (UNSAFE_KEY_CHARS.test(ch)) output += '\\';
		output += ch;
	}
	return output;
}

/**
 * Canonical string representation of a typed path.
 */
export function formatPath(path: TypedPath): string {
	let output = '';

	for (const segment of path) {
		if (segment.kind === 'index') {
			output += `[${segment.index}]`;
		} else {
			const escaped = escapeKey(segment.key);
			if (!output) {
				output = FIRST_KEY_RE.test(escaped) ? escaped : `["${escaped}"]`;
			} else if (FIRST_KEY_RE.test(escaped)) {
				output += `.${escaped}`;
			} else {
				output += `[${escaped.includes('"') ? `'${escaped}'` : `"${escaped}"`}]`;
			}
		}
	}

	return output;
}

/**
 * Converts a typed path to the string/number arrays used by traversal.ts.
 * Keys stay strings, indices become numbers.
 */
export function toPathArray(path: TypedPath): (string | number)[] {
	return path.map((segment) => (segment.kind === 'index' ? segment.index : segment.key));
}

/**
 * Converts a traversal path array (string | number | symbol) to a typed path.
 * Numeric strings and numbers become index segments.
 */
export function fromPathArray(path: readonly (string | number | symbol)[]): TypedPath {
	return path.map((segment) => {
		if (typeof segment === 'number') return { kind: 'index', index: segment };
		const key = String(segment);
		return INDEX_RE.test(key)
			? { kind: 'index', index: Number(key) }
			: { kind: 'key', key };
	});
}

/**
 * Returns only the object-key segments, dropping array indices.
 * Used when indexing into schema shapes and constraints, which don't
 * contain array positions.
 */
export function objectPathOnly(path: TypedPath): TypedPath {
	return path.filter((segment): segment is KeySegment => segment.kind === 'key');
}

/**
 * Reads a value at a typed path. Returns undefined when the path cannot be
 * fully traversed. Applies the existing prototype-pollution guard.
 */
export function readPath(obj: unknown, path: TypedPath): unknown {
	if (!path.length) return obj;
	return traversePath(obj as object, toPathArray(path))?.value;
}

function assertSafeKey(key: string) {
	// Same safety boundary as traversal.ts setPath.
	if (key === '__proto__' || key === 'prototype') {
		throw new Error("Cannot set an object's `__proto__` or `prototype` property");
	}
}

/**
 * Immutable set: returns a new root object where only the containers along
 * the targeted branch are shallow-cloned. Sibling branches keep their
 * reference identity, so the hot path never deep-copies the whole form.
 */
export function setPathImmutable<T>(obj: T, path: TypedPath, value: unknown): T {
	if (!path.length) return value as T;

	function setAt(current: unknown, depth: number): unknown {
		const segment = path[depth];

		if (depth === path.length - 1) {
			if (segment.kind === 'key') {
				assertSafeKey(segment.key);
				const container = current === undefined ? {} : shallowCloneContainer(current);
				(container as Record<string, unknown>)[segment.key] = value;
				return container;
			}
			const container = current === undefined ? [] : shallowCloneContainer(current);
			(container as unknown[])[segment.index] = value;
			return container;
		}

		if (segment.kind === 'key') {
			assertSafeKey(segment.key);
			const container = current === undefined ? {} : shallowCloneContainer(current);
			const next = (container as Record<string, unknown>)[segment.key];
			(container as Record<string, unknown>)[segment.key] = setAt(next, depth + 1);
			return container;
		}

		const container = current === undefined ? [] : shallowCloneContainer(current);
		const next = (container as unknown[])[segment.index];
		(container as unknown[])[segment.index] = setAt(next, depth + 1);
		return container;
	}

	return setAt(obj, 0) as T;
}

/**
 * Immutable delete: returns a new root where the leaf key/index is removed,
 * cloning only the targeted branch. Returns the same object reference when
 * the path does not exist.
 */
export function deletePathImmutable<T>(obj: T, path: TypedPath): T {
	if (!path.length) return undefined as T;

	function deleteAt(current: unknown, depth: number): unknown | typeof MISSING {
		if (current === undefined || current === null || typeof current !== 'object') {
			return MISSING;
		}

		const segment = path[depth];
		const key = segment.kind === 'index' ? segment.index : segment.key;
		if (segment.kind === 'key') assertSafeKey(segment.key);

		if (!(key in (current as object))) return MISSING;

		if (depth === path.length - 1) {
			const container = shallowCloneContainer(current);
			delete (container as Record<PropertyKey, unknown>)[key];
			return container;
		}

		const next = deleteAt((current as Record<PropertyKey, unknown>)[key], depth + 1);
		if (next === MISSING) return MISSING;

		const container = shallowCloneContainer(current);
		(container as Record<PropertyKey, unknown>)[key] = next;
		return container;
	}

	const result = deleteAt(obj, 0);
	return (result === MISSING ? obj : result) as T;
}

const MISSING = Symbol('missing');

/**
 * Removes every numeric branch at or beyond `length` in the array subtree
 * located at `arrayPath`. Structural truncation used when an array is
 * shortened; stale error/tainted entries can never reappear if the array
 * grows back. Clones only the affected branch.
 */
export function truncateArrayBranch<T>(obj: T, arrayPath: TypedPath, length: number): T {
	const node = arrayPath.length ? readPath(obj, arrayPath) : obj;
	if (!node || typeof node !== 'object') return obj;

	let changed = false;
	const truncated = shallowCloneContainer(node);
	for (const key of Object.keys(truncated as object)) {
		if (INDEX_RE.test(key) && Number(key) >= length) {
			delete (truncated as Record<string, unknown>)[key];
			changed = true;
		}
	}

	if (!changed) return obj;
	if (!arrayPath.length) return truncated as T;
	return setPathImmutable(obj, arrayPath, truncated);
}

/**
 * Migrates numeric sub-paths of an array subtree after an element was
 * inserted or removed at `at`. Indices greater than `at` are shifted by
 * `delta` (+1 for insertion, -1 for removal). This is an identity-preserving
 * structural migration: entries are re-keyed as whole subtrees, never by
 * string replacement. Collisions during insertion are resolved in order.
 */
export function reindexArrayBranch<T>(obj: T, arrayPath: TypedPath, at: number, delta: 1 | -1): T {
	const node = arrayPath.length ? readPath(obj, arrayPath) : obj;
	if (!node || typeof node !== 'object') return obj;

	const entries = Object.entries(node as object)
		.filter(([key]) => INDEX_RE.test(key))
		.map(([key, value]) => [Number(key), value] as [number, unknown]);

	if (!entries.some(([index]) => (delta === -1 ? index >= at : index >= at))) {
		return obj;
	}

	const reindexed = shallowCloneContainer(node) as Record<string, unknown>;

	// Drop every shifted key first, then reinsert in a deterministic order so
	// insertions (delta = 1) never overwrite a sibling that moves as well.
	for (const [index] of entries) {
		if (index >= at) delete reindexed[String(index)];
	}

	const ordered = [...entries].sort((a, b) => (delta === 1 ? b[0] - a[0] : a[0] - b[0]));
	for (const [index, value] of ordered) {
		if (index >= at) reindexed[String(index + delta)] = value;
	}

	if (!arrayPath.length) return reindexed as T;
	return setPathImmutable(obj, arrayPath, reindexed);
}

/**
 * Checks whether `path` exists (key present on its parent) in `obj`.
 */
export function pathExistsTyped(obj: unknown, path: TypedPath): boolean {
	if (!path.length) return obj !== undefined;
	return !!pathExists(obj as object, toPathArray(path));
}

function shallowCloneContainer(value: unknown): unknown {
	if (Array.isArray(value)) return value.slice();
	if (value && typeof value === 'object') return { ...(value as Record<string, unknown>) };
	throw new Error(`Cannot set a nested path through a non-object value: ${String(value)}`);
}
