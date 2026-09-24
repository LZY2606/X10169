import { describe, expect, it } from 'vitest';
import {
	deletePathImmutable,
	deletePathMutable,
	formatPath,
	migrateTreeIndexes,
	parsePath,
	readPath,
	setPathImmutable,
	setPathMutable,
	shiftTreeIndexes,
	toPath,
	toTokens,
	truncateTreeIndexes,
	type TypedPath
} from '$lib/pathModel.js';
import { splitPath, mergePath } from '$lib/stringPath.js';

describe('parsePath', () => {
	it('parses dot-separated object keys', () => {
		expect(toTokens(parsePath('a.b.c'))).toStrictEqual(['a', 'b', 'c']);
	});

	it('parses array indices with typed segments', () => {
		const path: TypedPath = parsePath('tags[0].name');
		expect(path).toStrictEqual([
			{ kind: 'key', key: 'tags' },
			{ kind: 'index', index: 0 },
			{ kind: 'key', key: 'name' }
		]);
	});

	it('parses bracket-only and leading-bracket forms', () => {
		expect(toTokens(parsePath('[0]'))).toStrictEqual([0]);
		expect(toTokens(parsePath('a[12]'))).toStrictEqual(['a', 12]);
		expect(toTokens(parsePath('items[0][1]'))).toStrictEqual(['items', 0, 1]);
	});

	it('parses bracket-quoted keys with dots and brackets', () => {
		expect(toTokens(parsePath('["weird.name"]'))).toStrictEqual(['weird.name']);
		expect(toTokens(parsePath('a["b.c"].d'))).toStrictEqual(['a', 'b.c', 'd']);
		expect(toTokens(parsePath("['[x]'].z"))).toStrictEqual(['[x]', 'z']);
		expect(toTokens(parsePath('["say \\"hi\\""]'))).toStrictEqual(['say "hi"']);
		expect(toTokens(parsePath('["back\\\\slash"]'))).toStrictEqual(['back\\slash']);
	});

	it('accepts unquoted bracket keys', () => {
		expect(toTokens(parsePath('a[weird-key]'))).toStrictEqual(['a', 'weird-key']);
	});

	it('ignores empty segments (historical boundary)', () => {
		expect(toTokens(parsePath(''))).toStrictEqual([]);
		expect(toTokens(parsePath('.a..b.'))).toStrictEqual(['a', 'b']);
		expect(toTokens(parsePath('a[].b'))).toStrictEqual(['a', 'b']);
		expect(toTokens(parsePath('[""]'))).toStrictEqual([]);
	});

	it('keeps numeric object keys distinct from indices in the typed model', () => {
		const keyPath = parsePath('["0"]');
		expect(keyPath[0]).toStrictEqual({ kind: 'key', key: '0' });
		const indexPath = parsePath('[0]');
		expect(indexPath[0]).toStrictEqual({ kind: 'index', index: 0 });
	});

	it('throws for prototype-pollution keys', () => {
		expect(() => parsePath('__proto__')).toThrow();
		expect(() => parsePath('a.prototype.b')).toThrow();
		expect(() => parsePath('a["__proto__"]')).toThrow();
		expect(() => parsePath('constructor.polluted')).not.toThrow();
	});

	it('throws for unterminated quoted/bracket segments', () => {
		expect(() => parsePath('a["unterminated')).toThrow();
		expect(() => parsePath('a[0')).toThrow();
	});

	it('remains compatible with the historical splitPath/mergePath output', () => {
		expect(splitPath('tags[0].name')).toStrictEqual(['tags', '0', 'name']);
		expect(splitPath('a..b')).toStrictEqual(['a', 'b']);
		expect(mergePath(['tags', 0, 'name'])).toBe('tags[0].name');
		expect(mergePath(['a', 'b'])).toBe('a.b');
	});
});

describe('formatPath', () => {
	it('formats ordinary paths identically to historical mergePath', () => {
		expect(formatPath('tags[0].name')).toBe('tags[0].name');
		expect(formatPath('a.b')).toBe('a.b');
		expect(formatPath('[0]')).toBe('[0]');
	});

	it('escapes special keys in bracket-quoted form', () => {
		expect(formatPath(parsePath('["weird.name"]'))).toBe('["weird.name"]');
		expect(formatPath(parsePath('a["b[c]"].d'))).toBe('a["b[c]"].d');
		expect(formatPath(parsePath('["0"]'))).toBe('["0"]');
		expect(formatPath(parsePath('["say \\"hi\\""]'))).toBe('["say \\"hi\\""]');
	});
});

describe('read/set/delete', () => {
	it('reads typed paths across objects and arrays', () => {
		const obj = { a: [{ b: 1 }] };
		expect(readPath(obj, 'a[0].b')?.value).toBe(1);
		expect(readPath(obj, 'a[1]')?.exists).toBe(false);
		expect(readPath(obj, 'a[0].missing')).toBeUndefined();
		expect(readPath(obj, '')).toBeUndefined();
	});

	it('mutates only the target leaf, creating intermediate objects', () => {
		const obj: Record<string, unknown> = { a: {} };
		expect(
			setPathMutable(obj, 'a.b[0].c', 42, { create: () => ({}) })
		).toBe(true);
		expect(obj).toStrictEqual({ a: { b: { '0': { c: 42 } } } });
	});

	it('does not create intermediates without a create option', () => {
		const obj: Record<string, unknown> = { a: {} };
		expect(setPathMutable(obj, 'a.b.c', 1)).toBe(false);
		expect(obj).toStrictEqual({ a: {} });
	});

	it('refuses to write dangerous keys through the model', () => {
		expect(() =>
			setPathMutable({}, '__proto__.polluted', true, { create: () => ({}) })
		).toThrow();
	});

	it('immutable update clones only the path branches', () => {
		const obj = { a: { x: 1, y: 2 }, b: { z: 3 }, list: [{ k: 1 }] };
		const before = obj;
		const updated = setPathImmutable(obj, 'a.x', 9, {
			create: (segment) => (segment.kind === 'index' ? [] : {})
		});
		expect(updated).not.toBe(before);
		expect(updated.a).not.toBe(before.a);
		expect(updated.a.x).toBe(9);
		// Sibling and unrelated branches keep identity
		expect(updated.a.y).toBe(2);
		expect(updated.b).toBe(before.b);
		expect(updated.list).toBe(before.list);
	});

	it('immutable update into arrays clones array nodes only', () => {
		const obj = { list: [{ n: 1 }, { n: 2 }] };
		const updated = setPathImmutable(obj, 'list[1].n', 5, {
			create: (segment) => (segment.kind === 'index' ? [] : {})
		});
		expect(Array.isArray(updated.list)).toBe(true);
		expect(updated.list).toStrictEqual([{ n: 1 }, { n: 5 }]);
		expect(updated.list[0]).toBe(obj.list[0]);
	});

	it('returns the same reference when an immutable path is missing', () => {
		const obj = { a: { x: 1 } };
		expect(setPathImmutable(obj, 'a.missing.deep', 1)).toBe(obj);
	});

	it('deletes leaves mutably and immutably', () => {
		const obj = { a: { b: 1, c: 2 } };
		expect(deletePathMutable(obj, 'a.b')).toBe(true);
		expect(obj).toStrictEqual({ a: { c: 2 } });

		const arr = { list: [1, 2, 3] };
		const next = deletePathImmutable(arr, 'list[1]');
		expect(next.list).toStrictEqual([1, 3]);
		expect(next.list).not.toBe(arr.list);
	});
});

describe('tree index migration', () => {
	it('shifts branches on removal at an index', () => {
		const tree = {
			'0': { name: ['e0'] },
			'1': { name: ['e1'] },
			'2': { name: ['e2'] },
			_errors: ['array-error']
		};
		shiftTreeIndexes(tree, [], 1, -1);
		expect(tree).toStrictEqual({
			'0': { name: ['e0'] },
			'1': { name: ['e2'] },
			_errors: ['array-error']
		});
	});

	it('shifts branches on insertion at an index', () => {
		const tree = {
			'0': { name: ['e0'] },
			'1': { name: ['e1'] }
		};
		shiftTreeIndexes(tree, [], 1, 1);
		expect(tree).toStrictEqual({
			'0': { name: ['e0'] },
			'2': { name: ['e1'] }
		});
	});

	it('truncates branches above the new length without touching _errors', () => {
		const tree = {
			'0': { x: ['a'] },
			'1': { x: ['b'] },
			'2': { x: ['c'] },
			_errors: ['form-level']
		};
		truncateTreeIndexes(tree, [], 2);
		expect(tree).toStrictEqual({
			'0': { x: ['a'] },
			'1': { x: ['b'] },
			_errors: ['form-level']
		});
	});

	it('migrates by element identity through middle removal', () => {
		const a = { id: 'a' };
		const b = { id: 'b' };
		const c = { id: 'c' };
		const before = [a, b, c];
		const after = [a, c];
		const tree = {
			'0': { name: ['err-a'] },
			'1': { name: ['err-b'] },
			'2': { name: ['err-c'] },
			_errors: ['arr']
		};
		migrateTreeIndexes(tree, [], before, after);
		expect(tree).toStrictEqual({
			'0': { name: ['err-a'] },
			'1': { name: ['err-c'] },
			_errors: ['arr']
		});
	});

	it('migrates by element identity through middle insertion', () => {
		const a = { id: 'a' };
		const b = { id: 'b' };
		const x = { id: 'x' };
		const tree = {
			'0': { name: ['err-a'] },
			'1': { name: ['err-b'] }
		};
		migrateTreeIndexes(tree, [], [a, b], [a, x, b]);
		expect(tree).toStrictEqual({
			'0': { name: ['err-a'] },
			'2': { name: ['err-b'] }
		});
	});

	it('follows items when reordered', () => {
		const a = { id: 'a' };
		const b = { id: 'b' };
		const tree = {
			'0': ['first'],
			'1': ['second']
		};
		migrateTreeIndexes(tree, [], [a, b], [b, a]);
		expect(tree).toStrictEqual({ '0': ['second'], '1': ['first'] });
	});

	it('migrates nested index branches with the parent item', () => {
		const item0 = { tags: [{ v: 1 }] };
		const item1 = { tags: [{ v: 2 }] };
		const tree = {
			'0': { tags: { '0': ['nested-0'] } },
			'1': { tags: { '0': ['nested-1'] } }
		};
		migrateTreeIndexes(tree, '', [item0, item1], [item1, item0]);
		expect(tree).toStrictEqual({
			'0': { tags: { '0': ['nested-1'] } },
			'1': { tags: { '0': ['nested-0'] } }
		});
	});
});

describe('property tests', () => {
	// Deterministic PRNG so failures can be reproduced via the seed.
	function mulberry32(seed: number) {
		return () => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	const SPECIAL = ['.', '[', ']', '"', "'", '\\', '-', '_', 'x', '0', '10'];

	function randomKey(rand: () => number): string {
		const length = 1 + Math.floor(rand() * 5);
		let key = '';
		for (let i = 0; i < length; i++) {
			key += SPECIAL[Math.floor(rand() * SPECIAL.length)];
		}
		// Exclude the dangerous keys at generation time; they are tested separately.
		if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
			return 'safe_' + key;
		}
		return key;
	}

	it('parse -> format -> parse is stable across 5000 random paths', () => {
		const rand = mulberry32(0x5eed);

		for (let iteration = 0; iteration < 5000; iteration++) {
			const original: TypedPath = [];
			const depth = 1 + Math.floor(rand() * 4);
			for (let i = 0; i < depth; i++) {
				if (rand() < 0.4) {
					original.push({ kind: 'index', index: Math.floor(rand() * 12) });
				} else {
					original.push({ kind: 'key', key: randomKey(rand) });
				}
			}

			const formatted = formatPath(original);
			const reparsed = parsePath(formatted);
			expect(reparsed).toStrictEqual(original);
			expect(formatPath(reparsed)).toBe(formatted);
		}
	});

	it('a legal immutable update changes only the target branch (1000 cases)', () => {
		const rand = mulberry32(0xabcdef);

		function makeTree(depth: number): any {
			if (depth <= 0 || rand() < 0.3) return Math.floor(rand() * 100);
			if (rand() < 0.5) {
				const length = 1 + Math.floor(rand() * 3);
				return Array.from({ length }, () => makeTree(depth - 1));
			}
			return {
				a: makeTree(depth - 1),
				b: makeTree(depth - 1),
				c: makeTree(depth - 1)
			};
		}

		function randomExistingPath(tree: any): TypedPath {
			const path: TypedPath = [];
			let node: any = tree;
			while (node && typeof node === 'object') {
				if (Array.isArray(node)) {
					if (!node.length) break;
					const index = Math.floor(rand() * node.length);
					path.push({ kind: 'index', index });
					node = node[index];
				} else {
					const keys = Object.keys(node);
					if (!keys.length || rand() < 0.4) break;
					const key = keys[Math.floor(rand() * keys.length)];
					path.push({ kind: 'key', key });
					node = node[key];
				}
			}
			// Ensure at least one segment
			if (!path.length) path.push({ kind: 'key', key: 'a' });
			return path;
		}

		function collectIdentities(node: any, prefix: string, bag: Map<string, any>) {
			if (!node || typeof node !== 'object') return;
			bag.set(prefix, node);
			const entries = Array.isArray(node)
				? node.map((v, i) => [String(i), v] as const)
				: Object.entries(node);
			for (const [key, value] of entries) {
				if (value && typeof value === 'object') {
					collectIdentities(
						value,
						prefix + (Array.isArray(node) ? `[${key}]` : prefix ? `.${key}` : key)
					);
				}
			}
		}

		for (let iteration = 0; iteration < 1000; iteration++) {
			const tree = makeTree(3);
			const path = randomExistingPath(tree);
			const canonical = formatPath(path);

			const before = new Map<string, any>();
			collectIdentities(tree, '', before);

			const updated = setPathImmutable(tree, path, 'MARKER', {
				create: (segment) => (segment.kind === 'index' ? [] : {})
			});

			expect(readPath(updated, canonical)?.value).toBe('MARKER');

			const after = new Map<string, any>();
			collectIdentities(updated, '', after);

			// Every node NOT on the target path must keep its identity.
			for (const [id, identity] of before) {
				const onPath =
					canonical === id || canonical.startsWith(id + '.') || canonical.startsWith(id + '[');
				if (!onPath) {
					expect(after.get(id)).toBe(identity);
				}
			}
		}
	});
});
