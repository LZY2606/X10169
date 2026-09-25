import { SuperFormError } from './errors.js';

/**
 * Internal typed path model.
 *
 * All parsing, normalization, formatting, reading, immutable updating and
 * deletion of field paths goes through this module, so that server errors,
 * client validation, tainted state, constraints and snapshot restore all
 * consume the same path representation.
 *
 * A path is a list of typed segments, explicitly distinguishing object keys
 * from array indices:
 *
 *   'user.addresses[0].city' -> [key 'user', key 'addresses', index 0, key 'city']
 *
 * Keys that contain special characters (dots, brackets, quotes, backslashes)
 * or that look like an array index can be escaped with a quoted bracket:
 *
 *   'a["b.c"]'   -> [key 'a', key 'b.c']
 *   'a["0"]'     -> [key 'a', key '0']   (object key, NOT an array index)
 *   'a["x\\"]y"]' -> [key 'a', key 'x"]y']
 */

export type PathSegment =
	| { readonly kind: 'key'; readonly key: string }
	| { readonly kind: 'index'; readonly index: number };

export type FieldPath = readonly PathSegment[];

export function keySegment(key: string): PathSegment {
	return { kind: 'key', key };
}

export function indexSegment(index: number): PathSegment {
	return { kind: 'index', index };
}

const NUMERIC = /^\d+$/;

function classifyToken(token: string): PathSegment {
	return NUMERIC.test(token) ? indexSegment(Number(token)) : keySegment(token);
}

/**
 * Parse a string path into typed segments.
 *
 * Compatible with the legacy split behavior for unquoted paths
 * (`a.b[0].c`), and additionally supports quoted bracket escaping for
 * keys containing special characters (`a["b.c"]`, `a['x']`).
 *
 * Never throws: malformed escapes fall back to legacy separator semantics.
 * The root path ('' or only separators) parses to an empty segment list.
 */
export function parsePath(path: string): PathSegment[] {
	const segments: PathSegment[] = [];
	const str = String(path);
	let i = 0;
	let token = '';
	let hasToken = false;

	const pushToken = () => {
		if (!hasToken) return;
		segments.push(classifyToken(token));
		token = '';
		hasToken = false;
	};

	while (i < str.length) {
		const ch = str[i];

		if (ch === '.') {
			pushToken();
			i++;
			continue;
		}

		if (ch === ']') {
			pushToken();
			i++;
			continue;
		}

		if (ch === '[') {
			pushToken();
			const quote = str[i + 1];

			if (quote === '"' || quote === "'") {
				// Quoted (escaped) object key: ["..."] or ['...']
				let j = i + 2;
				let key = '';
				let closed = false;

				while (j < str.length) {
					const c = str[j];
					if (c === '\\' && j + 1 < str.length) {
						key += str[j + 1];
						j += 2;
						continue;
					}
					if (c === quote) {
						if (str[j + 1] === ']') {
							closed = true;
							j += 2;
						}
						break;
					}
					key += c;
					j++;
				}

				if (closed) {
					segments.push(keySegment(key));
					i = j;
					continue;
				}
				// Malformed escape: fall through to legacy separator semantics.
				i++;
				continue;
			}

			const close = str.indexOf(']', i + 1);
			if (close === -1) {
				// Unterminated bracket: legacy separator semantics.
				i++;
				continue;
			}

			const inner = str.slice(i + 1, close);
			if (inner) segments.push(classifyToken(inner));
			i = close + 1;
			continue;
		}

		token += ch;
		hasToken = true;
		i++;
	}

	pushToken();
	return segments;
}

/**
 * Keys that can be formatted without escaping. Numeric-looking keys are
 * excluded, since they would parse back as array indices.
 */
const SAFE_KEY = /^(?!\d+$)[^.\[\]"'\\]+$/;

/**
 * Format typed segments as a canonical string path.
 * Inverse of parsePath for all segments, escaping keys when needed.
 */
export function formatPath(segments: FieldPath): string {
	let output = '';

	for (const segment of segments) {
		if (segment.kind === 'index') {
			if (!Number.isInteger(segment.index) || segment.index < 0) {
				throw new SuperFormError(`Invalid array index in path: ${segment.index}`);
			}
			output += `[${segment.index}]`;
		} else if (SAFE_KEY.test(segment.key)) {
			output += output ? `.${segment.key}` : segment.key;
		} else {
			output += `["${segment.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
		}
	}

	return output;
}

/**
 * Normalize a string path or a legacy (string | number | symbol) path array
 * into typed segments. Numbers and numeric strings become array indices,
 * matching the legacy mergePath contract.
 */
export function toSegments(path: string | readonly (string | number | symbol)[]): PathSegment[] {
	if (typeof path === 'string') return parsePath(path);

	return path.map((part) => {
		if (typeof part === 'number') return indexSegment(part);
		if (typeof part === 'symbol') return keySegment(String(part));
		return classifyToken(part);
	});
}

/**
 * Convert typed segments to a plain path array, for interop with
 * the traversal functions in traversal.ts.
 */
export function toPathArray(segments: FieldPath): (string | number)[] {
	return segments.map((segment) =>
		segment.kind === 'index' ? segment.index : segment.key
	);
}

/**
 * Structural equality of two segment lists.
 */
export function segmentsEqual(a: FieldPath, b: FieldPath): boolean {
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

/**
 * Only the key segments, e.g. for structures (constraints, schema shape)
 * that don't contain array indices.
 */
export function keySegmentsOnly(segments: FieldPath): PathSegment[] {
	return segments.filter((segment) => segment.kind === 'key');
}

function assertNoPrototypeKeys(segments: FieldPath) {
	for (const segment of segments) {
		if (segment.kind === 'key' && (segment.key === '__proto__' || segment.key === 'prototype')) {
			throw new Error("Cannot set an object's `__proto__` or `prototype` property");
		}
	}
}

function segmentProperty(segment: PathSegment): string | number {
	return segment.kind === 'index' ? segment.index : segment.key;
}

/**
 * Read the value at a path. Returns undefined for the root path,
 * missing branches and out-of-bounds indices, matching traversePath.
 */
export function getPath(obj: unknown, segments: FieldPath): unknown {
	if (!segments.length) return undefined;
	assertNoPrototypeKeys(segments);

	let current = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== 'object') {
			return undefined;
		}
		current = (current as Record<PropertyKey, unknown>)[segmentProperty(segment)];
	}
	return current;
}

type Container = Record<PropertyKey, unknown> | unknown[];

function shallowContainer(node: unknown, segment: PathSegment): Container {
	if (Array.isArray(node)) return node.slice();
	if (node !== null && typeof node === 'object') return { ...(node as object) } as Container;
	// Missing or primitive node: replace with a container matching the
	// next segment kind, mirroring setPaths behavior.
	return segment.kind === 'index' ? [] : {};
}

/**
 * Immutable update: returns a new root with the value set at the path.
 * Only the objects and arrays along the path are copied (structural
 * sharing), so the rest of the tree keeps reference identity.
 * The root path is a no-op, matching setPaths.
 */
export function setPathImmutable<T>(obj: T, segments: FieldPath, value: unknown): T {
	if (!segments.length) return obj;
	assertNoPrototypeKeys(segments);
	return setIn(obj, segments, value) as T;
}

function setIn(node: unknown, segments: FieldPath, value: unknown): unknown {
	const [segment, ...rest] = segments;
	const container = shallowContainer(node, segment);
	(container as Record<PropertyKey, unknown>)[segmentProperty(segment)] = rest.length
		? setIn(
				(container as Record<PropertyKey, unknown>)[segmentProperty(segment)],
				rest,
				value
			)
		: value;
	return container;
}

/**
 * Immutable delete: returns a new root without the value at the path.
 * Array elements are spliced out; object keys are deleted.
 * Only the path branch is copied. Missing branches are a no-op.
 */
export function deletePathImmutable<T>(obj: T, segments: FieldPath): T {
	if (!segments.length) return obj;
	assertNoPrototypeKeys(segments);
	const result = deleteIn(obj, segments);
	return (result === undefined ? obj : result) as T;
}

function deleteIn(node: unknown, segments: FieldPath): unknown {
	if (node === null || node === undefined || typeof node !== 'object') return undefined;

	const [segment, ...rest] = segments;
	const prop = segmentProperty(segment);

	if (rest.length) {
		const child = deleteIn((node as Record<PropertyKey, unknown>)[prop], rest);
		if (child === undefined) return undefined;
		const container = shallowContainer(node, segment);
		(container as Record<PropertyKey, unknown>)[prop] = child;
		return container;
	}

	if (Array.isArray(node)) {
		if (segment.kind !== 'index' || segment.index >= node.length) return undefined;
		const copy = node.slice();
		copy.splice(segment.index, 1);
		return copy;
	}

	if (!(prop in (node as object))) return undefined;
	const copy = { ...(node as Record<PropertyKey, unknown>) };
	delete copy[prop];
	return copy;
}

/**
 * Immutable array element insertion/removal, migrating related path trees
 * (errors, tainted) by element identity instead of string replacement:
 *
 * - Removal (delta -1): the subtree at `index` is dropped, subtrees at
 *   higher indices shift down by one, keeping each subtree attached to
 *   its element.
 * - Insertion (delta +1): subtrees at `index` and above shift up by one.
 *
 * Works on real arrays (form data) and on plain objects with numeric
 * keys (errors/tainted trees). Only the array path branch is copied.
 */
export function shiftArrayElement<T>(
	obj: T,
	arrayPath: FieldPath,
	index: number,
	delta: 1 | -1
): T {
	if (!Number.isInteger(index) || index < 0) {
		throw new SuperFormError(`Invalid array index for shift: ${index}`);
	}
	assertNoPrototypeKeys(arrayPath);
	const result = shiftIn(obj, arrayPath, index, delta);
	return (result === undefined ? obj : result) as T;
}

function shiftIn(node: unknown, path: FieldPath, index: number, delta: 1 | -1): unknown {
	if (!path.length) return shiftContainer(node, index, delta);
	if (node === null || node === undefined || typeof node !== 'object') return undefined;

	const [segment, ...rest] = path;
	const prop = segmentProperty(segment);
	const child = shiftIn((node as Record<PropertyKey, unknown>)[prop], rest, index, delta);
	if (child === undefined) return undefined;

	const container = shallowContainer(node, segment);
	(container as Record<PropertyKey, unknown>)[prop] = child;
	return container;
}

function shiftContainer(node: unknown, index: number, delta: 1 | -1): unknown {
	if (Array.isArray(node)) {
		const copy = node.slice();
		if (delta === -1) {
			if (index >= copy.length) return undefined;
			copy.splice(index, 1);
		} else {
			copy.splice(index, 0, undefined);
		}
		return copy;
	}

	if (node === null || node === undefined || typeof node !== 'object') return undefined;

	const source = node as Record<string, unknown>;
	const output: Record<string, unknown> = {};

	for (const key of Object.keys(source)) {
		if (!NUMERIC.test(key)) {
			output[key] = source[key];
			continue;
		}
		const position = Number(key);
		if (delta === -1) {
			if (position < index) output[key] = source[key];
			else if (position > index) output[String(position - 1)] = source[key];
			// position === index: dropped with its element
		} else {
			output[position >= index ? String(position + 1) : key] = source[key];
		}
	}

	return output;
}

/**
 * Immutable pruning of array-related paths beyond a given length.
 * Used when an array is shortened: numeric keys/indices >= length at the
 * path are removed, so stale entries aren't kept if the array grows again.
 */
export function pruneArrayLength<T>(obj: T, arrayPath: FieldPath, length: number): T {
	assertNoPrototypeKeys(arrayPath);
	const result = pruneIn(obj, arrayPath, length);
	return (result === undefined ? obj : result) as T;
}

function pruneIn(node: unknown, path: FieldPath, length: number): unknown {
	if (!path.length) return pruneContainer(node, length);
	if (node === null || node === undefined || typeof node !== 'object') return undefined;

	const [segment, ...rest] = path;
	const prop = segmentProperty(segment);
	const child = pruneIn((node as Record<PropertyKey, unknown>)[prop], rest, length);
	if (child === undefined) return undefined;

	const container = shallowContainer(node, segment);
	(container as Record<PropertyKey, unknown>)[prop] = child;
	return container;
}

function pruneContainer(node: unknown, length: number): unknown {
	if (Array.isArray(node)) {
		let changed = false;
		const copy = node.slice();
		for (let i = length; i < copy.length; i++) {
			if (i in copy) {
				delete copy[i];
				changed = true;
			}
		}
		return changed ? copy : undefined;
	}

	if (node === null || node === undefined || typeof node !== 'object') return undefined;

	const source = node as Record<string, unknown>;
	let changed = false;
	const output: Record<string, unknown> = {};

	for (const key of Object.keys(source)) {
		if (NUMERIC.test(key) && Number(key) >= length) {
			changed = true;
			continue;
		}
		output[key] = source[key];
	}

	return changed ? output : undefined;
}
