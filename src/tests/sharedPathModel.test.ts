import { describe, it, expect, vi } from 'vitest';

vi.mock('svelte', async (original) => {
	const module = (await original()) as Record<string, unknown>;
	return { ...module, onDestroy: vi.fn() };
});

vi.mock('$app/stores', async () => {
	const { readable } = await import('svelte/store');

	const getStores = () => ({
		navigating: readable(null),
		page: readable({ url: new URL('http://localhost'), params: {} }),
		session: readable(null),
		updated: readable(false)
	});

	const page: typeof import('$app/stores').page = {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		subscribe(fn: any) {
			return getStores().page.subscribe(fn);
		}
	};

	const navigating: typeof import('$app/stores').navigating = {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		subscribe(fn: any) {
			return getStores().navigating.subscribe(fn);
		}
	};

	return { getStores, navigating, page };
});

import { get } from 'svelte/store';
import { z } from 'zod/v3';
import { zod } from '$lib/adapters/zod.js';
import { superValidate, setError, type SuperValidated } from '$lib/superValidate.js';
import { superForm, type SuperForm } from '$lib/client/index.js';
import {
	parsePath,
	formatPath,
	normalizePath,
	pathKey,
	setIn,
	deleteIn,
	getPath,
	remapMetadataTree,
	deepEqual,
	alignArrays,
	setPathNodes
} from '$lib/pathModel.js';

const schema = z.object({
	name: z.string().min(2),
	items: z
		.object({
			tag: z.string().min(1),
			nested: z.object({ value: z.number().min(0) }).array()
		})
		.array(),
	optional: z
		.object({
			flag: z.boolean()
		})
		.optional(),
	meta: z.record(z.string()),
	score: z.number().min(0)
});

type Schema = z.infer<typeof schema>;

const defaults: Schema = {
	name: 'Initial',
	items: [
		{ tag: 'a', nested: [{ value: 1 }, { value: 2 }] },
		{ tag: 'b', nested: [{ value: 3 }] },
		{ tag: 'c', nested: [] }
	],
	optional: { flag: true },
	meta: {},
	score: 10
};

async function makeForm(initial: Partial<Schema> = defaults) {
	const validated = await superValidate(initial, zod(schema));
	const form = superForm(validated, { validators: zod(schema), dataType: 'json' });
	return { validated, form };
}

describe('Typed path model - parse/format round trip', () => {
	const paths = [
		'name',
		'a.b.c',
		'items[0].tag',
		'items[12].nested[3].value',
		'items[0]',
		'a[0][1]',
		// Actual field names containing special characters (escaped form)
		'meta["a.b"]',
		'meta["a[0]"]',
		'meta["a]b"]',
		"meta['x.y']",
		'meta["quo\\"te"]',
		'meta["back\\\\slash"]'
	];

	it('parse(format(parse(path))) is stable (parse-format-parse idempotence)', () => {
		for (const path of paths) {
			const first = parsePath(path);
			const formatted = formatPath(first);
			const second = parsePath(formatted);
			expect(second).toEqual(first);
			expect(formatPath(second)).toBe(formatted);
		}
	});

	it('distinguishes object keys from array indices', () => {
		expect(parsePath('items[0].tag')).toEqual(['items', 0, 'tag']);
		expect(parsePath('items.0.tag')).toEqual(['items', '0', 'tag']);
		expect(normalizePath('items.0.tag')).toBe('items[0].tag');
		expect(parsePath('items[0]')[1]).toBeTypeOf('number');
		expect(parsePath('items["0"]')[1]).toBe('0');
	});

	it('round-trips special keys verbatim', () => {
		expect(getPath({ meta: { 'a.b': 1 } }, parsePath('meta["a.b"]'))).toBe(1);
		expect(normalizePath('meta["a[0]"]')).toBe('meta["a[0]"]');
		expect(parsePath('meta["quo\\"te"]')).toEqual(['meta', 'quo"te']);
		expect(parsePath('meta["back\\\\slash"]')).toEqual(['meta', 'back\\slash']);
	});

	it('handles root and empty segments within the security boundary', () => {
		expect(parsePath('')).toEqual([]);
		expect(parsePath('a..b')).toEqual(['a', 'b']);
		expect(() => parsePath('__proto__.polluted')).toThrowError();
		expect(() => parsePath('a.prototype.b')).toThrowError();
	});

	it('rejects prototype-pollution keys on writes', () => {
		expect(() => setPathNodes({}, [parsePath('__proto__')], { x: 1 })).toThrowError();
		expect(() =>
			setIn({ a: {} }, parsePath('a.prototype.x'), 1 as unknown as never)
		).toThrowError();
	});
});

describe('Typed path model - immutable structural sharing', () => {
	const tree = {
		name: 'x',
		items: [
			{ tag: 'a', nested: [{ value: 1 }] },
			{ tag: 'b', nested: [{ value: 2 }] }
		],
		other: { keep: true }
	};

	it('setIn changes only the target branch', () => {
		const next = setIn(tree, parsePath('items[1].nested[0].value'), 42);

		expect(getPath(next, parsePath('items[1].nested[0].value'))).toBe(42);
		// Untouched branches keep their references
		expect(next.other).toBe(tree.other);
		expect(next.items[0]).toBe(tree.items[0]);
		expect(next.items[1].nested[0]).not.toBe(tree.items[1].nested[0]);
		// No deep clone of the whole form
		expect(next).not.toBe(tree);
		expect(next.items).not.toBe(tree.items);
		expect(next.items[1]).not.toBe(tree.items[1]);
	});

	it('deleteIn preserves references outside the deleted branch', () => {
		const next = deleteIn(tree, 'items[0]');
		expect((next.items as unknown[]).length).toBe(1);
		expect(next.items[0]).toBe(tree.items[1]);
		expect(next.other).toBe(tree.other);
	});

	it('setIn never copies the whole form on the hot path', () => {
		const large = { a: { deep: { leaf: 1 } }, b: { untouched: new Array(100).fill(0) } };
		const next = setIn(large, 'a.deep.leaf', 2);
		expect(next.b).toBe(large.b);
		expect(next.a).not.toBe(large.a);
	});
});

describe('Array identity alignment (LCS)', () => {
	it('matches surviving elements when deleting in the middle', () => {
		const oldArr = [defaults.items[0], defaults.items[1], defaults.items[2]];
		const newArr = [defaults.items[0], defaults.items[2]];
		const map = alignArrays(oldArr, newArr);
		expect([...map.entries()]).toEqual([
			[0, 0],
			[2, 1]
		]);
	});

	it('handles same values at different positions via value equality', () => {
		const oldArr = ['a', 'b', 'a'];
		const newArr = ['b', 'a'];
		const map = alignArrays(oldArr, newArr);
		// Ordered LCS: old b(1)->new 0, old a(2)->new 1
		expect(map.get(1)).toBe(0);
		expect(map.get(2)).toBe(1);
	});

	it('handles insertion in the middle', () => {
		const inserted = { tag: 'new', nested: [] };
		const oldArr = [defaults.items[0], defaults.items[1]];
		const newArr = [defaults.items[0], inserted, defaults.items[1]];
		const map = alignArrays(oldArr, newArr);
		expect([...map.entries()]).toEqual([
			[0, 0],
			[1, 2]
		]);
	});

	it('deepEqual distinguishes built-ins', () => {
		expect(deepEqual(new Date(1), new Date(1))).toBe(true);
		expect(deepEqual(new Date(1), new Date(2))).toBe(false);
		expect(deepEqual(new Set([1, 2]), new Set([2, 1]))).toBe(true);
	});
});

describe('Shared metadata migration (errors + tainted same representation)', () => {
	it('migrates both metadata trees identically when elements move', () => {
		const oldData = defaults;
		const newData: Schema = {
			...defaults,
			items: [defaults.items[0], defaults.items[2], defaults.items[1]]
		};

		// Metadata is attached to data indices 0 and 1; index 1 moves to new index 2.
		const tainted = { items: [{ nested: [{ value: true }] }, { tag: true }, undefined] };
		const errors = { items: [{ tag: ['bad'] }, { nested: [{ value: ['low'] }] }, undefined] };

		const migratedTainted = remapMetadataTree(oldData, newData, tainted);
		const migratedErrors = remapMetadataTree(oldData, newData, errors);

		// Item 1 (tag: b) moved to position 2, item 2 (tag: c) to position 1.
		expect(migratedTainted).toEqual({
			items: [{ nested: [{ value: true }, undefined] }, undefined, { tag: true }]
		});
		expect(migratedErrors).toEqual({
			items: [{ tag: ['bad'] }, undefined, { nested: [{ value: ['low'] }] }]
		});

		// The same index mapping is used for every metadata tree.
		expect((migratedTainted as { items: unknown[] }).items.map((_, i) => i)).toEqual([0, 1, 2]);
		expect((migratedErrors as { items: unknown[] }).items.map((_, i) => i)).toEqual([0, 1, 2]);
	});

	it('drops metadata for deleted elements and leaves inserted positions empty', () => {
		const oldData = { items: ['a', 'b', 'c'] };
		const newData = { items: ['a', 'c'] };
		const metadata = { items: [true, true, true] };
		expect(remapMetadataTree(oldData, newData, metadata)).toEqual({ items: [true, true] });
	});
});

describe('Property tests', () => {
	function* pseudoRandom(seed: number) {
		let state = seed;
		for (;;) {
			state = (state * 1664525 + 1013904223) % 4294967296;
			yield state / 4294967296;
		}
	}

	const LEGAL_PATHS: string[] = [
		'name',
		'score',
		'items[0].tag',
		'items[1].nested[0].value',
		'optional.flag',
		'meta["k"]'
	];

	it('parse(format(parse(path))) is stable across 200 generated paths', () => {
		const random = pseudoRandom(42);

		for (let i = 0; i < 200; i++) {
			const length = 1 + Math.floor(random.next().value! * 4);
			const path: (string | number)[] = [];
			for (let d = 0; d < length; d++) {
				if (random.next().value! > 0.5) path.push(Math.floor(random.next().value! * 5));
				else path.push(`k${Math.floor(random.next().value! * 10)}`);
			}

			const formatted = formatPath(path);
			const reparsed = parsePath(formatted);
			expect(reparsed).toEqual(path);
			expect(formatPath(reparsed)).toBe(formatted);
			expect(pathKey(reparsed)).toBe(pathKey(parsePath(normalizePath(formatted))));
		}
	});

	it('updating a legal path changes only that branch, 100 iterations', () => {
		const random = pseudoRandom(7);

		for (let i = 0; i < 100; i++) {
			const path = LEGAL_PATHS[Math.floor(random.next().value! * LEGAL_PATHS.length)];
			const next = setIn(defaults, path, i as never);

			// Exactly the target value changed
			expect(getPath(next, parsePath(path))).toBe(i);

			// Every other legal path kept its value (and identity when possible)
			for (const other of LEGAL_PATHS) {
				if (other === path) continue;
				const before = getPath(defaults, parsePath(other));
				const after = getPath(next, parsePath(other));
				expect(deepEqual(before, after)).toBe(true);
			}
		}
	});
});
