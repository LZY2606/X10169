/**
 * Property-based tests for the internal typed path model.
 *
 * Uses a seeded PRNG (mulberry32) so runs are deterministic and
 * reproducible without adding new dependencies.
 */
import { describe, it, expect } from 'vitest';
import {
	parsePath,
	formatPath,
	getPath,
	setPathImmutable,
	type TypedPath,
	type PathSegment
} from '$lib/pathModel.js';

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const KEY_ALPHABET = [
	'a',
	'name',
	'user',
	'weird.key',
	'br[ac]ket',
	'0',
	'42',
	'with space',
	'quo"te',
	"ap'os",
	'back\\slash',
	'_errors',
	'',
	'x'
];

function randomSegment(rand: () => number): PathSegment {
	if (rand() < 0.4) {
		return { kind: 'index', index: Math.floor(rand() * 4) };
	}
	return { kind: 'key', key: KEY_ALPHABET[Math.floor(rand() * KEY_ALPHABET.length)] };
}

function randomPath(rand: () => number, maxLength = 5): PathSegment[] {
	const length = Math.floor(rand() * (maxLength + 1));
	return Array.from({ length }, () => randomSegment(rand));
}

function randomValue(rand: () => number, depth = 0): unknown {
	const roll = rand();
	if (depth > 3 || roll < 0.4) {
		const scalars = [1, 'two', null, true, 3.14, ''];
		return scalars[Math.floor(rand() * scalars.length)];
	}
	if (roll < 0.7) {
		const length = Math.floor(rand() * 4);
		return Array.from({ length }, () => randomValue(rand, depth + 1));
	}
	const obj: Record<string, unknown> = {};
	const keys = Math.floor(rand() * 4);
	for (let i = 0; i < keys; i++) {
		obj[KEY_ALPHABET[Math.floor(rand() * KEY_ALPHABET.length)]] = randomValue(rand, depth + 1);
	}
	return obj;
}

function deepClone<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

describe('Path model properties', () => {
	it('parse-format-parse is stable for arbitrary typed paths', () => {
		const rand = mulberry32(20260922);
		for (let i = 0; i < 2000; i++) {
			const path = randomPath(rand);
			const formatted = formatPath(path);
			const reparsed = parsePath(formatted);
			expect(reparsed, `round-trip of ${JSON.stringify(path)} (${formatted})`).toEqual(path);
			// Formatting is canonical: a second round-trip is a fixed point
			expect(formatPath(reparsed)).toBe(formatted);
		}
	});

	it('parse-format-parse is stable for arbitrary string paths', () => {
		const rand = mulberry32(1337);
		for (let i = 0; i < 2000; i++) {
			const path = randomPath(rand);
			const asString = formatPath(path);
			// parse . format . parse === parse
			expect(parsePath(formatPath(parsePath(asString)))).toEqual(parsePath(asString));
		}
	});

	it('a legal path update only changes the target branch', () => {
		const rand = mulberry32(4711);
		for (let i = 0; i < 1000; i++) {
			const data = randomValue(rand) as Record<string, unknown>;
			if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;

			// Only legal paths: key segments that do not touch prototype
			// pollution keys (indices are always legal).
			const path = randomPath(rand, 4).filter(
				(seg) => seg.kind === 'index' || (seg.key !== '__proto__' && seg.key !== 'prototype')
			) as TypedPath;
			if (!path.length) continue;

			const value = randomValue(rand);
			const snapshot = deepClone(data);
			const result = setPathImmutable(data, path, value) as Record<string, unknown>;

			// 1. The target now holds the new value
			expect(getPath(result, path)).toEqual(value);

			// 2. The original object is untouched
			expect(data).toEqual(snapshot);

			// 3. Every branch outside the path keeps its identity
			const first = path[0];
			if (first.kind === 'key') {
				for (const key of Object.keys(data)) {
					if (key !== first.key) {
						expect(result[key]).toBe(data[key]);
					}
				}
			}

			// 4. Reading any other generated path is unchanged
			for (let j = 0; j < 5; j++) {
				const other = randomPath(rand, 4);
				if (!other.length) continue; // Empty path reads the root, which changed
				// Compare resolved property keys: key '0' and index 0 are the
				// same JavaScript property on plain objects.
				const propOf = (seg: PathSegment) => (seg.kind === 'key' ? seg.key : String(seg.index));
				const sharesPrefix = propOf(first) === propOf(other[0]);
				if (!sharesPrefix) {
					expect(getPath(result, other)).toEqual(getPath(snapshot, other));
				}
			}
		}
	});

	it('immutable updates never deep-clone: untouched subtrees are identical references', () => {
		const rand = mulberry32(99);
		for (let i = 0; i < 500; i++) {
			const shared = randomValue(rand);
			const data = { target: randomValue(rand), shared };
			const result = setPathImmutable(data, parsePath('target'), randomValue(rand));
			expect(result.shared).toBe(shared);
		}
	});
});
