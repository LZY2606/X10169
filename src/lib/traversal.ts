/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	getPathNode,
	parsePath,
	pathKey,
	setPathNodes,
	type PathNode,
	type TypedPath
} from './pathModel.js';

export type PathData = {
	parent: any;
	key: string;
	value: any;
	path: (string | number | symbol)[];
	isLeaf: boolean;
	set: (value: any) => 'skip';
};

function toData(node: PathNode | undefined): PathData | undefined {
	if (!node) return undefined;
	return {
		parent: node.parent,
		key: node.key,
		value: node.value,
		// Legacy consumers expect stringified segments.
		path: node.path.map((segment) => String(segment)),
		isLeaf: node.isLeaf,
		set: node.set
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
		options.modifier = (pathData) =>
			isInvalidPath(parsePath(path), pathData) ? undefined : pathData.value;
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
	// Empty paths have no node in the legacy traversal contract.
	if (!realPath.length) return undefined;

	const path: TypedPath = parsePath(realPath);
	const adaptedModifier = modifier
		? (node: PathNode) => modifier(toData(node) as PathData)
		: undefined;

	return toData(getPathNode(obj, path, adaptedModifier));
}

type TraverseStatus = 'abort' | 'skip' | unknown | void;

export function traversePaths<T extends object>(
	parent: T,
	modifier: (data: PathData) => TraverseStatus,
	path: (string | number | symbol)[] = []
): TraverseStatus {
	for (const key in parent) {
		const value = parent[key] as any;
		const isLeaf = value === null || typeof value !== 'object';

		const pathData: PathData = {
			parent,
			key,
			value,
			path: path.concat([key]), // path.map(String).concat([key])
			isLeaf,
			set: (v) => {
				// Prevent prototype injection
				if (key === '__proto__' || key === 'prototype') {
					throw new Error("Cannot set an object's `__proto__` or `prototype` property");
				}
				parent[key] = v;
				return 'skip';
			}
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
		//console.log('Compare', data.path, data.value, 'to', otherData?.path, otherData?.value);

		function addDiff() {
			//console.log('Diff', data.path);
			diffPaths.set(pathKey(data.path), data.path);
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
	if (typeof value !== 'function') {
		setPathNodes(obj, paths, value);
		return;
	}

	setPathNodes(obj, paths, (typedPath, node) => {
		const data = toData(node) as PathData;
		return value(typedPath.map((segment) => String(segment)), data);
	});
}
