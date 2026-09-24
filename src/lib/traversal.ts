/* eslint-disable @typescript-eslint/no-explicit-any */

import {
	formatPath,
	isForbiddenKey,
	locatePath,
	toLegacyPath,
	toSegments,
	type PathLocation
} from './fieldPath.js';

export type PathData = {
	parent: any;
	key: string;
	value: any;
	path: (string | number | symbol)[];
	isLeaf: boolean;
	set: (value: any) => 'skip';
};

function setPath(parent: Record<PropertyKey, unknown>, key: PropertyKey, value: any) {
	// Prevent prototype injection
	if (key === '__proto__' || key === 'prototype') {
		throw new Error("Cannot set an object's `__proto__` or `prototype` property");
	}

	parent[key] = value;
	return 'skip' as const;
}

function toPathData(location: PathLocation, isLeaf: boolean): PathData {
	return {
		parent: location.parent,
		key: String(location.key),
		value: location.value,
		path: location.path.map((p) => String(p)),
		isLeaf,
		set: (value) => setPath(location.parent, location.key, value)
	};
}

function isInvalidPath(originalPath: (string | number | symbol)[], pathData: PathData) {
	return (
		pathData.value !== undefined &&
		typeof pathData.value !== 'object' &&
		pathData.path.length < originalPath.length
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
		options.modifier = (pathData) => (isInvalidPath(path, pathData) ? undefined : pathData.value);
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
	if (!realPath.length) return undefined;

	const segments = toSegments(realPath);

	const location = locatePath(obj, segments, (context) => {
		if (!modifier) return context.value;

		const prefixSegments = context.segments.slice(0, context.depth + 1);
		const pathData: PathData = {
			parent: context.parent,
			key: String(context.key),
			value: context.value,
			path: toLegacyPath(prefixSegments).map((p) => String(p)),
			isLeaf: false,
			set: (value) => setPath(context.parent, context.key, value)
		};

		return modifier(pathData);
	});

	return location ? toPathData(location, true) : undefined;
}

type TraverseStatus = 'abort' | 'skip' | unknown | void;

export function traversePaths<T extends object>(
	parent: T,
	modifier: (data: PathData) => TraverseStatus,
	path: (string | number | symbol)[] = []
): TraverseStatus {
	for (const key in parent) {
		const value = (parent as Record<string, unknown>)[key] as any;
		const isLeaf = value === null || typeof value !== 'object';

		const pathData: PathData = {
			parent,
			key,
			value,
			path: path.concat([key]),
			isLeaf,
			set: (v) => setPath(parent as Record<PropertyKey, unknown>, key, v)
		};

		const status = modifier(pathData);

		if (status === 'abort') return status;
		else if (status === 'skip') continue;
		else if (!isLeaf) {
			const status = traversePaths(value, modifier, pathData.path as any);
			if (status === 'abort') return status;
		}
	}
}

// Thanks to https://stackoverflow.com/a/31129384/70894
function eqSet(xs: Set<unknown>, ys: Set<unknown>) {
	return xs === ys || (xs.size === ys.size && [...xs].every((x) => ys.has(x)));
}

/**
 * Compare two objects and return the differences as paths.
 */
export function comparePaths(newObj: unknown, oldObj: unknown) {
	const diffPaths = new Map<string, (string | number | symbol)[]>();

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

	function checkPath(data: PathData, compareTo: object) {
		const otherData = compareTo ? traversePath(compareTo, data.path) : undefined;

		function addDiff() {
			diffPaths.set(formatPath(data.path, { quoteSpecial: true }), data.path);
			return 'skip';
		}

		if (isBuiltin(data.value)) {
			if (!isBuiltin(otherData?.value) || builtInDiff(data.value, otherData.value)) {
				return addDiff();
			}
		}

		if (data.isLeaf) {
			if (!otherData || data.value !== otherData.value) {
				addDiff();
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
		| ((path: (string | number | symbol)[], data: PathData) => unknown)
		| null
		| undefined
) {
	const isFunction = typeof value === 'function';

	for (const path of paths) {
		const segments = toSegments(path);
		const leaf = locatePath(obj, segments, (context) => {
			if (context.value === undefined || typeof context.value !== 'object') {
				// If a previous check tainted the node, but the search goes deeper,
				// so it needs to be replaced with a (parent) node
				(context.parent as Record<PropertyKey, unknown>)[context.key] = {};
			}
			return (context.parent as Record<PropertyKey, unknown>)[context.key];
		});

		if (leaf) {
			// Prevent prototype injection
			if (leaf.segment.kind === 'key' && isForbiddenKey(leaf.segment.key)) {
				throw new Error("Cannot set an object's `__proto__` or `prototype` property");
			}

			const leafData = toPathData(leaf, true);
			(leaf.parent as Record<PropertyKey, unknown>)[leaf.key] = isFunction
				? value(
						toLegacyPath(segments),
						leafData
					)
				: value;
		}
	}
}
