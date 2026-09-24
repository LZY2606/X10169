import { describe, it, expect } from 'vitest';
import {
	deletePath,
	formatPath,
	getPath,
	objectPath,
	parsePath,
	pathsEqual,
	removeArrayIndices,
	segmentsFromArray,
	setPathImmutable,
	toKeyArray,
	type PathSegment
} from '$lib/pathModel.js';

describe('Path model: parsing', () => {
	it('should parse dot and bracket notation into typed segments', () => {
		expect(parsePath('user.addresses[0].city')).toEqual([
			{ kind: 'key', key: 'user' },
			{ kind: 'key', key: 'addresses' },
			{ kind: 'index', index: 0 },
			{ kind: 'key', key: 'city' }
		]);
	});

	it('should parse the root path as an empty segment list', () => {
		expect(parsePath('')).toEqual([]);
	});

	it('should parse quoted keys with special characters', () => {
		expect(parsePath('["a.b"].x')).toEqual([
			{ kind: 'key', key: 'a.b' },
			{ kind: 'key', key: 'x' }
		]);
		expect(parsePath('a["b[0]"]')).toEqual([
			{ kind: 'key', key: 'a' },
			{ kind: 'key', key: 'b[0]' }
		]);
		expect(parsePath("['it\\'s']")).toEqual([{ kind: 'key', key: "it's" }]);
		expect(parsePath('["a\\"b\\\\c"]')).toEqual([{ kind: 'key', key: 'a"b\\c' }]);
	});

	it('should parse an empty quoted key', () => {
		expect(parsePath('[""]')).toEqual([{ kind: 'key', key: '' }]);
	});

	it('should keep backwards-compatible behavior for plain paths', () => {
		expect(parsePath('a..b')).toEqual([
			{ kind: 'key', key: 'a' },
			{ kind: 'key', key: 'b' }
		]);
		expect(parsePath('[12]')).toEqual([{ kind: 'index', index: 12 }]);
		expect(parsePath('a[foo]')).toEqual([
			{ kind: 'key', key: 'a' },
			{ kind: 'key', key: 'foo' }
		]);
	});
});

describe('Path model: formatting', () => {
	it('should format segments into canonical string form', () => {
		expect(
			formatPath([
				{ kind: 'key', key: 'user' },
				{ kind: 'key', key: 'addresses' },
				{ kind: 'index', index: 2 },
				{ kind: 'key', key: 'city' }
			])
		).toBe('user.addresses[2].city');
		expect(formatPath([])).toBe('');
	});

	it('should quote keys that need escaping', () => {
		expect(formatPath([{ kind: 'key', key: 'a.b' }])).toBe('["a.b"]');
		expect(formatPath([{ kind: 'key', key: '' }])).toBe('[""]');
		expect(formatPath([{ kind: 'key', key: '5' }])).toBe('["5"]');
		expect(formatPath([{ kind: 'key', key: 'x"y' }])).toBe('["x\\"y"]');
	});

	it('should normalize key arrays, treating numeric strings as indices', () => {
		expect(segmentsFromArray(['tags', '2', 'name'])).toEqual([
			{ kind: 'key', key: 'tags' },
			{ kind: 'index', index: 2 },
			{ kind: 'key', key: 'name' }
		]);
		expect(toKeyArray(segmentsFromArray(['a', 1]))).toEqual(['a', 1]);
	});

	it('should strip indices for object paths (shape/constraints lookups)', () => {
		const segments = parsePath('user.addresses[3].city');
		expect(formatPath(objectPath(segments))).toBe('user.addresses.city');
	});

	it('should compare paths structurally', () => {
		expect(pathsEqual(parsePath('a[0].b'), parsePath('a[0].b'))).toBe(true);
		expect(pathsEqual(parsePath('a[0].b'), parsePath('a[1].b'))).toBe(false);
		expect(pathsEqual(parsePath('a'), parsePath('a.b'))).toBe(false);
	});
});

describe('Path model: reading', () => {
	const data = {
		user: { names: ['a', 'b'] },
		'a.b': { c: 1 },
		constructor: 'shadowed'
	};

	it('should read values through typed paths', () => {
		expect(getPath(data, parsePath('user.names[1]'))).toBe('b');
		expect(getPath(data, parsePath('["a.b"].c'))).toBe(1);
		expect(getPath(data, [])).toBe(data);
	});

	it('should return undefined for missing and out-of-bounds paths', () => {
		expect(getPath(data, parsePath('user.missing.deep'))).toBeUndefined();
		expect(getPath(data, parsePath('user.names[5]'))).toBeUndefined();
		expect(getPath(data, parsePath('user.names[-1]'))).toBeUndefined();
	});

	it('should not read prototype-pollution related keys', () => {
		expect(getPath(data, parsePath('__proto__'))).toBeUndefined();
		expect(getPath({}, parsePath('constructor.prototype'))).toBeUndefined();
	});
});

describe('Path model: immutable update', () => {
	it('should set values with structural sharing', () => {
		const data = { a: { b: 1, c: { d: 2 } }, e: [1, 2] };
		const result = setPathImmutable(data, parsePath('a.c.d'), 42);

		expect(result).not.toBe(data);
		expect(result.a).not.toBe(data.a);
		expect(result.a.c).not.toBe(data.a.c);
		expect(result.a.c.d).toBe(42);
		// Untouched branches keep their identity
		expect(result.a.b).toBe(1);
		expect(result.e).toBe(data.e);
		expect(data.a.c.d).toBe(2);
	});

	it('should create intermediate structures and extend arrays', () => {
		const result = setPathImmutable({}, parsePath('a[1].b'), 'x') as Record<
			string,
			{ b: string }[]
		>;
		expect(Array.isArray(result.a)).toBe(true);
		expect(result.a[1].b).toBe('x');
	});

	it('should replace the root for an empty path', () => {
		expect(setPathImmutable({ a: 1 }, [], { b: 2 })).toEqual({ b: 2 });
	});

	it('should throw on prototype-pollution keys', () => {
		expect(() => setPathImmutable({}, parsePath('__proto__'), 1)).toThrow(/__proto__/);
		expect(() => setPathImmutable({}, parsePath('a.prototype'), 1)).toThrow(/prototype/);
	});
});

describe('Path model: deletion', () => {
	it('should splice arrays so element paths migrate stably', () => {
		const data = { tags: ['a', 'b', 'c'] };
		const result = deletePath(data, parsePath('tags[1]'));
		expect(result.tags).toEqual(['a', 'c']);
		expect(data.tags).toEqual(['a', 'b', 'c']);
	});

	it('should delete object keys immutably', () => {
		const data = { a: { b: 1, c: 2 }, d: 3 };
		const result = deletePath(data, parsePath('a.b'));
		expect(result.a).toEqual({ c: 2 });
		expect(result.d).toBe(3);
		expect(data.a).toEqual({ b: 1, c: 2 });
	});

	it('should be a no-op for root, missing and out-of-bounds paths', () => {
		const data = { a: [1], b: 2 };
		expect(deletePath(data, [])).toBe(data);
		expect(deletePath(data, parsePath('missing.deep'))).toBe(data);
		expect(deletePath(data, parsePath('a[5]'))).toBe(data);
	});

	it('should throw on prototype-pollution keys', () => {
		expect(() => deletePath({}, parsePath('__proto__'))).toThrow(/__proto__/);
	});
});

describe('Path model: array index migration', () => {
	it('should shift numeric keys down and drop removed indices', () => {
		const errors = { 0: ['e0'], 2: ['e2'], _errors: ['arr'] };
		expect(removeArrayIndices(errors, [1])).toEqual({ 0: ['e0'], 1: ['e2'], _errors: ['arr'] });
		expect(removeArrayIndices(errors, [0, 2])).toEqual({ _errors: ['arr'] });
		expect(removeArrayIndices(errors, [])).toBe(errors);
	});

	it('should splice actual arrays', () => {
		expect(removeArrayIndices([true, true, true], [1])).toEqual([true, true]);
	});
});

///// Property tests ////////////////////////////////////////////////////

function mulberry32(seed: number) {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const KEY_POOL = [
	'a',
	'user',
	'name',
	'x1',
	'a.b',
	'b[0]',
	'c]d',
	'e"f',
	"g'h",
	'i\\j',
	'',
	'5',
	'with space',
	'_errors'
];

function randomSegments(rand: () => number): PathSegment[] {
	const length = Math.floor(rand() * 5);
	const segments: PathSegment[] = [];
	for (let i = 0; i < length; i++) {
		if (rand() < 0.4) {
			segments.push({ kind: 'index', index: Math.floor(rand() * 4) });
		} else {
			segments.push({ kind: 'key', key: KEY_POOL[Math.floor(rand() * KEY_POOL.length)] });
		}
	}
	return segments;
}

function segmentsEqual(a: PathSegment[], b: PathSegment[]): boolean {
	return pathsEqual(a, b);
}

describe('Path model: properties', () => {
	it('parse-format-parse is stable', () => {
		const rand = mulberry32(20260919);
		for (let i = 0; i < 2000; i++) {
			const segments = randomSegments(rand);
			const formatted = formatPath(segments);
			const reparsed = parsePath(formatted);
			expect(segmentsEqual(reparsed, segments)).toBe(true);
			expect(formatPath(reparsed)).toBe(formatted);
			// And a third round through the string form stays put
			expect(segmentsEqual(parsePath(formatPath(reparsed)), segments)).toBe(true);
		}
	});

	it('parse-format-parse is stable for arbitrary strings', () => {
		const rand = mulberry32(42);
		const alphabet = 'ab.[]"\'\\0123456789 ';
		for (let i = 0; i < 2000; i++) {
			let str = '';
			const length = Math.floor(rand() * 12);
			for (let j = 0; j < length; j++) {
				str += alphabet[Math.floor(rand() * alphabet.length)];
			}
			const once = parsePath(str);
			const twice = parsePath(formatPath(once));
			expect(segmentsEqual(twice, once)).toBe(true);
		}
	});

	type Tree = { [key: string]: unknown } | unknown[];

	function randomTree(rand: () => number, depth: number): Tree {
		const isArray = rand() < 0.4;
		const size = 1 + Math.floor(rand() * 3);
		const output: Tree = isArray ? [] : {};
		for (let i = 0; i < size; i++) {
			const value =
				depth > 0 && rand() < 0.6 ? randomTree(rand, depth - 1) : Math.floor(rand() * 1000);
			if (isArray) (output as unknown[]).push(value);
			else (output as Record<string, unknown>)['k' + i] = value;
		}
		return output;
	}

	function randomPathInto(rand: () => number, tree: Tree): PathSegment[] {
		const segments: PathSegment[] = [];
		let node: unknown = tree;
		while (node !== null && typeof node === 'object' && rand() < 0.8) {
			if (Array.isArray(node)) {
				if (!node.length) break;
				const index = Math.floor(rand() * node.length);
				segments.push({ kind: 'index', index });
				node = node[index];
			} else {
				const keys = Object.keys(node);
				if (!keys.length) break;
				const key = keys[Math.floor(rand() * keys.length)];
				segments.push({ kind: 'key', key });
				node = (node as Record<string, unknown>)[key];
			}
		}
		return segments;
	}

	it('a legal path update only changes the target branch', () => {
		const rand = mulberry32(1337);
		for (let i = 0; i < 1000; i++) {
			const tree = randomTree(rand, 3);
			const path = randomPathInto(rand, tree);
			if (!path.length) continue;

			const newValue = { brand: 'new-value-' + i };
			const result = setPathImmutable(tree, path, newValue) as Tree;

			// The target branch has the new value
			expect(getPath(result, path)).toBe(newValue);
			// The original is untouched
			expect(getPath(tree, path)).not.toBe(newValue);

			// Every branch not on the path keeps its identity
			assertIdentityOffPath(tree, result, path, 0);
		}
	});

	function assertIdentityOffPath(
		oldNode: unknown,
		newNode: unknown,
		path: PathSegment[],
		at: number
	) {
		if (at >= path.length) return;
		const seg = path[at];
		if (seg.kind === 'index') {
			const oldArr = oldNode as unknown[];
			const newArr = newNode as unknown[];
			for (let j = 0; j < oldArr.length; j++) {
				if (j === seg.index) assertIdentityOffPath(oldArr[j], newArr[j], path, at + 1);
				else expect(newArr[j]).toBe(oldArr[j]);
			}
		} else {
			const oldObj = oldNode as Record<string, unknown>;
			const newObj = newNode as Record<string, unknown>;
			for (const key of Object.keys(oldObj)) {
				if (key === seg.key) assertIdentityOffPath(oldObj[key], newObj[key], path, at + 1);
				else expect(newObj[key]).toBe(oldObj[key]);
			}
		}
	}
});
