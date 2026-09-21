import { describe, it, expect } from 'vitest';
import {
	parsePath,
	formatPath,
	getPath,
	setPathImmutable,
	deletePathImmutable,
	migratePathForArrayChange,
	remapArrayNode,
	detectArrayChange,
	keySegment,
	indexSegment,
	pathEquals,
	pathStartsWith,
	toPropertyKeys,
	fromPropertyKeys
} from '$lib/pathModel.js';
import { splitPath, mergePath } from '$lib/stringPath.js';

describe('Path parsing', () => {
	it('should parse dot and bracket notation', () => {
		expect(parsePath('user.addresses[0].city')).toEqual([
			keySegment('user'),
			keySegment('addresses'),
			indexSegment(0),
			keySegment('city')
		]);
	});

	it('should parse the root path as an empty path', () => {
		expect(parsePath('')).toEqual([]);
		expect(formatPath([])).toBe('');
	});

	it('should ignore empty unquoted segments, as before', () => {
		expect(parsePath('a..b')).toEqual([keySegment('a'), keySegment('b')]);
		expect(parsePath('a[]')).toEqual([keySegment('a')]);
	});

	it('should distinguish object keys from array indices', () => {
		const path = parsePath('a[0].b');
		expect(path[1]).toEqual(indexSegment(0));
		expect(path[2]).toEqual(keySegment('b'));
		// A quoted numeric is an actual string key, not an index
		expect(parsePath('a["0"]')).toEqual([keySegment('a'), keySegment('0')]);
	});

	it('should support the escape form for keys with special characters', () => {
		expect(parsePath('["weird.key"]')).toEqual([keySegment('weird.key')]);
		expect(parsePath('a["b[0]"]')).toEqual([keySegment('a'), keySegment('b[0]')]);
		expect(parsePath("a['it\\'s']")).toEqual([keySegment('a'), keySegment("it's")]);
		expect(parsePath('["a\\"b"]')).toEqual([keySegment('a"b')]);
		// Quoted empty key is explicit and preserved
		expect(parsePath('a[""]')).toEqual([keySegment('a'), keySegment('')]);
	});

	it('should format special keys with the escape form', () => {
		expect(formatPath([keySegment('weird.key')])).toBe('["weird.key"]');
		expect(formatPath([keySegment('a'), keySegment('b[0]')])).toBe('a["b[0]"]');
		expect(formatPath([keySegment('0')])).toBe('["0"]');
		expect(formatPath([keySegment('a'), indexSegment(3)])).toBe('a[3]');
		expect(formatPath([keySegment('user'), keySegment('name')])).toBe('user.name');
	});

	it('should stay compatible with the legacy splitPath/mergePath pair', () => {
		expect(splitPath('tags[2].name')).toEqual(['tags', 2, 'name']);
		expect(mergePath(['tags', 2, 'name'])).toBe('tags[2].name');
		expect(mergePath(['tags', '2', 'name'])).toBe('tags[2].name');
		expect(mergePath(splitPath('user.addresses[0].city'))).toBe('user.addresses[0].city');
	});

	it('should convert between typed paths and property keys', () => {
		const typed = parsePath('a[1].b');
		expect(toPropertyKeys(typed)).toEqual(['a', 1, 'b']);
		expect(fromPropertyKeys(['a', 1, 'b'])).toEqual(typed);
		expect(fromPropertyKeys(['a', '1'])).toEqual([keySegment('a'), indexSegment(1)]);
	});
});

describe('Path comparison', () => {
	it('should compare paths by segment identity', () => {
		expect(pathEquals(parsePath('a[0]'), parsePath('a[0]'))).toBe(true);
		expect(pathEquals(parsePath('a[0]'), parsePath('a["0"]'))).toBe(false);
		expect(pathEquals(parsePath('a.b'), parsePath('a.b.c'))).toBe(false);
	});

	it('should detect prefixes', () => {
		expect(pathStartsWith(parsePath('a.b.c'), parsePath('a.b'))).toBe(true);
		expect(pathStartsWith(parsePath('a.b'), parsePath('a.b.c'))).toBe(false);
		expect(pathStartsWith(parsePath('a.b'), parsePath('a.b'))).toBe(true);
	});
});

describe('Path reading', () => {
	const data = {
		user: { name: 'A', tags: ['x', 'y'] },
		'weird.key': { deep: 42 }
	};

	it('should read nested values', () => {
		expect(getPath(data, parsePath('user.tags[1]'))).toBe('y');
		expect(getPath(data, parsePath('["weird.key"].deep'))).toBe(42);
	});

	it('should read the root path as the object itself', () => {
		expect(getPath(data, [])).toBe(data);
	});

	it('should read missing and out-of-bounds paths as undefined', () => {
		expect(getPath(data, parsePath('user.tags[10]'))).toBeUndefined();
		expect(getPath(data, parsePath('missing.path'))).toBeUndefined();
		expect(getPath(data, parsePath('user.name.first'))).toBeUndefined();
	});

	it('should never read through the prototype chain', () => {
		expect(getPath(data, parsePath('constructor'))).toBeUndefined();
		expect(getPath({ a: 1 }, parsePath('__proto__'))).toBeUndefined();
		expect(getPath([], parsePath('__proto__'))).toBeUndefined();
	});
});

describe('Immutable update', () => {
	it('should set a value without mutating the original', () => {
		const data = { user: { name: 'A', tags: ['x', 'y'] }, other: 1 };
		const result = setPathImmutable(data, parsePath('user.tags[1]'), 'z');

		expect(getPath(result, parsePath('user.tags[1]'))).toBe('z');
		expect(data.user.tags[1]).toBe('y');
		expect(result).not.toBe(data);
	});

	it('should only clone the target branch (structural sharing)', () => {
		const data = { user: { name: 'A', tags: ['x'] }, untouched: { deep: [1, 2] } };
		const result = setPathImmutable(data, parsePath('user.name'), 'B');

		expect(result.untouched).toBe(data.untouched);
		expect(result.user).not.toBe(data.user);
		expect(result.user.tags).toBe(data.user.tags);
	});

	it('should create containers along the path, arrays for indices', () => {
		const result = setPathImmutable({}, parsePath('a[1].b'), 'v') as Record<string, unknown[]>;
		expect(Array.isArray(result.a)).toBe(true);
		expect(getPath(result, parsePath('a[1].b'))).toBe('v');
	});

	it('should treat setting the root path as a no-op', () => {
		const data = { a: 1 };
		expect(setPathImmutable(data, [], 5)).toBe(data);
	});

	it('should throw on prototype pollution keys', () => {
		expect(() => setPathImmutable({}, parsePath('__proto__'), 1)).toThrow(/__proto__/);
		expect(() => setPathImmutable({}, parsePath('a.prototype'), 1)).toThrow(/prototype/);
		expect(() => setPathImmutable({}, [keySegment('__proto__')], 1)).toThrow(/__proto__/);
	});
});

describe('Immutable delete', () => {
	it('should delete object keys without mutating the original', () => {
		const data = { a: { b: 1, c: 2 }, d: 3 };
		const result = deletePathImmutable(data, parsePath('a.b')) as typeof data;
		expect(result.a.b).toBeUndefined();
		expect(data.a.b).toBe(1);
		expect(result.d).toBe(3);
	});

	it('should splice arrays when deleting an index', () => {
		const data = { tags: ['a', 'b', 'c'] };
		const result = deletePathImmutable(data, parsePath('tags[1]'));
		expect(getPath(result, parsePath('tags'))).toEqual(['a', 'c']);
		expect(data.tags).toEqual(['a', 'b', 'c']);
	});

	it('should treat missing and out-of-bounds paths as a no-op', () => {
		const data = { tags: ['a'] };
		expect(deletePathImmutable(data, parsePath('tags[9]'))).toBe(data);
		expect(deletePathImmutable(data, parsePath('nope.deep'))).toBe(data);
		expect(deletePathImmutable(data, [])).toBe(data);
	});

	it('should throw on prototype pollution keys', () => {
		expect(() => deletePathImmutable({}, parsePath('__proto__'))).toThrow(/__proto__/);
	});
});

describe('Array change detection and path migration', () => {
	it('should detect middle removal by element identity', () => {
		const a = { id: 1 };
		const b = { id: 2 };
		const c = { id: 3 };
		expect(detectArrayChange([a, b, c], [a, c])).toEqual({ type: 'remove', index: 1, count: 1 });
		expect(detectArrayChange([a, b, c], [a, b, a, c])).toEqual({
			type: 'insert',
			index: 2,
			count: 1
		});
		expect(detectArrayChange([a, b], [b, a])).toBeUndefined();
	});

	it('should migrate paths after array removal', () => {
		const arrayPath = parsePath('items');
		const change = { type: 'remove', index: 1, count: 1 } as const;

		// Before the removed element: unchanged
		expect(migratePathForArrayChange(parsePath('items[0].title'), arrayPath, change)).toEqual(
			parsePath('items[0].title')
		);
		// The removed element itself: dropped
		expect(migratePathForArrayChange(parsePath('items[1].title'), arrayPath, change)).toBeNull();
		// After the removed element: shifted down
		expect(migratePathForArrayChange(parsePath('items[2].title'), arrayPath, change)).toEqual(
			parsePath('items[1].title')
		);
		// Unrelated paths: unchanged
		expect(migratePathForArrayChange(parsePath('other[5]'), arrayPath, change)).toEqual(
			parsePath('other[5]')
		);
	});

	it('should migrate paths after array insertion', () => {
		const arrayPath = parsePath('items');
		const change = { type: 'insert', index: 1, count: 2 } as const;

		expect(migratePathForArrayChange(parsePath('items[0]'), arrayPath, change)).toEqual(
			parsePath('items[0]')
		);
		expect(migratePathForArrayChange(parsePath('items[1].x'), arrayPath, change)).toEqual(
			parsePath('items[3].x')
		);
	});

	it('should remap an errors/tainted node, preserving _errors', () => {
		const node = { 0: ['e0'], 1: ['e1'], 2: ['e2'], _errors: ['form'] };
		const remapped = remapArrayNode(node, { type: 'remove', index: 1, count: 1 });
		expect(remapped).toEqual({ 0: ['e0'], 1: ['e2'], _errors: ['form'] });
		// Input is not mutated
		expect(node[2]).toEqual(['e2']);
	});
});
