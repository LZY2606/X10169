/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	ensureNode,
	formatPath,
	isForbiddenKey,
	locateNode,
	normalizePath,
	type PathSegment,
	samePath
} from './pathModel.js';

export type { PathSegment, TypedPath } from './pathModel.js';

export type PathData = {
	parent: any;
	key: string;
	value: any;
	/** Typed segments; array indices are numbers, object keys are strings. */
	segments: PathSegment[];
	/** Stringified version of `segments`, kept for backward compatibility. */
	path: (string | number | symbol)[];
	isLeaf: boolean;
	set: (value: any) => 'skip';
};

function setPath<T extends object>(parent: T, key: PropertyKey, value: any) {
	// Prevent prototype injection
	if (isForbiddenKey(key)) {
		throw new Error("Cannot set an object's `__proto__` or `prototype` property");
	}

	(parent as Record<PropertyKey, unknown>)[key as string] = value;
	return 'skip' as const;
}

function toPathData(node: { parent: any; key: string; index: number | string; value: any; exists: boolean },
	segments: PathSegment[],
	isLeaf: boolean
): PathData {
	return {
		parent: node.parent,
		key: node.key,
		value: node.value,
		segments,
		path: segments.map(String),
		isLeaf,
		set: (v) => setPath(node.parent, node.index, v)
	};
}

function isInvalidPath(segments: PathSegment[], pathData: PathData) {
	return (
		pathData.value !== undefined &&
		typeof pathData.value !== 'object' &&
		pathData.segments.length < segments.length
	);
}

export function pathExists<T extends object>(
	obj: T,
	path: (string | number | symbol)[],
	options: {
		value?: (value: unknown) => boolean;
		modifier?: (data: PathData) => undefined | unknown | void;
	} = {}
): PathData | undefined {
	if (!options.modifier) {
		options.modifier = (pathData) =>
			isInvalidPath(normalizePath(path), pathData) ? undefined : pathData.value;
	}

	const exists = traversePath(obj, path, options.modifier);
	if (!exists) return undefined;

	if (options.value === undefined) return exists;
	return options.value(exists.value) ? exists : undefined;
}

export function traversePath<T extends object>(
	obj: T,
	realPath: (string | number | symbol)[],
	modifier?: (data: PathData) => undefined | unknown | void
): PathData | undefined {
	const segments = normalizePath(realPath);
	if (!segments.length) return undefined;

	if (segments.some((segment) => isForbiddenKey(segment))) {
		throw new Error("Cannot set an object's `__proto__` or `prototype` property");
	}

	let parent: any = obj;

	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		const key = Array.isArray(parent) && typeof segment === 'number' ? segment : String(segment);

		const value = modifier
			? modifier({
					parent,
					key: String(key),
					value: parent[key],
					segments: segments.slice(0, i + 1),
					path: segments.slice(0, i + 1).map(String),
					isLeaf: false,
					set: (v) => setPath(parent, key, v)
				})
			: parent[key];

		if (value === undefined) return undefined;
		parent = value;
	}

	const last = segments[segments.length - 1];
	const lastKey = Array.isArray(parent) && typeof last === 'number' ? last : String(last);

	return {
		parent,
		key: String(lastKey),
		value: parent[lastKey],
		segments,
		path: segments.map(String),
		isLeaf: true,
		set: (v) => setPath(parent, lastKey, v)
	};
}

type TraverseStatus = 'abort' | 'skip' | unknown | void;

export function traversePaths<T extends object>(
	parent: T,
	modifier: (data: PathData) => TraverseStatus,
	prefix: PathSegment[] = []
): TraverseStatus {
	if (!parent || typeof parent !== 'object') return;

	const keys: string[] = Array.isArray(parent)
		? parent.map((_, index) => String(index))
		: Object.keys(parent as object);

	for (const key of keys) {
		const rawKey: PathSegment = Array.isArray(parent) ? Number(key) : key;
		const value = (parent as Record<string, unknown>)[key];
		const isLeaf = value === null || typeof value !== 'object';
		const segments = normalizePath(prefix.concat(rawKey));

		const pathData: PathData = {
			parent,
			key,
			value,
			segments,
			path: segments.map(String),
			isLeaf,
			set: (v) => setPath(parent, rawKey, v)
		};

		const status = modifier(pathData);

		if (status === 'abort') return status;
		else if (status === 'skip') continue;
		else if (!isLeaf) {
			const status = traversePaths(value as object, modifier, segments);
			if (status === 'abort') return status;
		}
	}
}

// Thanks to https://stackoverflow.com/a/31129384/70894
function eqSet(xs: Set<unknown>, ys: Set<unknown>) {
	return xs === ys || (xs.size === ys.size && Array.from(xs).every((x) => ys.has(x)));
}

/**
 * Compare two objects and return the differences as typed paths.
 */
export function comparePaths(newObj: unknown, oldObj: unknown): PathSegment[][] {
	const diffPaths = new Map<string, PathSegment[]>();

	function builtInDiff(one: Date | Set<unknown> | File, other: Date | Set<unknown> | File) {
		if (one instanceof Date && other instanceof Date && one.getTime() !== other.getTime())
			return true;
		if (one instanceof Set && other instanceof Set && !eqSet(one, other)) return true;
		if (one instanceof File && other instanceof File && one !== other) return true;
		return false;
	}

	function isBuiltin(data: unknown): data is Date | Set<unknown> | File {
		return data instanceof Date || data instanceof Set || data instanceof File;
	}

	function addDiff(path: PathSegment[]) {
		diffPaths.set(path.map((p) => `${typeof p}:${String(p)}`).join('|'), path);
		return 'skip';
	}

	function checkPath(data: PathData, compareTo: object) {
		const otherData = compareTo ? traversePath(compareTo, data.segments) : undefined;

		if (isBuiltin(data.value)) {
			if (!isBuiltin(otherData?.value) || builtInDiff(data.value, otherData.value)) {
				return addDiff(data.segments);
			}
		}

		if (data.isLeaf) {
			if (!otherData || data.value !== otherData.value) {
				addDiff(data.segments);
			}
		}
	}

	traversePaths(newObj as object, (data) => checkPath(data, oldObj as object));
	traversePaths(oldObj as object, (data) => checkPath(data, newObj as object));

	// Need to sort the list so the shortest paths comes first
	const output = Array.from(diffPaths.values());
	output.sort((a, b) => a.length - b.length);
	return output;
}

export function setPaths(
	obj: Record<string, unknown>,
	paths: (string | number | symbol)[][],
	value:
		| NonNullable<unknown>
		| ((path: PathSegment[], data: PathData) => unknown)
		| null
		| undefined,
	options?: { mode?: 'object' | 'array' | 'auto' }
) {
	const isFunction = typeof value === 'function';

	for (const rawPath of paths) {
		const path = normalizePath(rawPath);
		if (!path.length) continue;
		if (path.some((segment) => isForbiddenKey(segment))) {
			throw new Error("Cannot set an object's `__proto__` or `prototype` property");
		}

		const node = ensureNode(obj, path, { mode: options?.mode ?? 'object' });

		if (isForbiddenKey(node.index)) {
			throw new Error("Cannot set an object's `__proto__` or `prototype` property");
		}

		const currentData = toPathData(
			{ ...node, exists: true },
			path,
			true
		);

		node.parent[node.index] = isFunction
			? (value as (p: PathSegment[], d: PathData) => unknown)(path, currentData)
			: value;
	}
}

export { formatPath as mergePath, samePath };
