/**
 * Shared behavior tests for the typed path model.
 *
 * Every test observes the same nested schema and operation sequence through
 * all path-consuming surfaces at once: errors, tainted, constraints, form
 * data and snapshots, on both server (superValidate) and client (superForm).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { z } from 'zod/v3';
import { zod } from '$lib/adapters/zod.js';
import { superValidate, setError, type SuperValidated } from '$lib/superValidate.js';
import { superForm, arrayProxy, type SuperForm } from '$lib/client/index.js';

const schema = z.object({
	name: z.string().min(2),
	tags: z.array(z.string().min(2)).min(1),
	addresses: z.array(z.object({ city: z.string().min(2) })).min(1),
	meta: z.object({ note: z.string().min(1) }).optional()
});

type Schema = z.infer<typeof schema>;

const validData: Schema = {
	name: 'Alice',
	tags: ['aa', 'bb', 'cc'],
	addresses: [{ city: 'Lund' }, { city: 'Oslo' }]
};

let validated: SuperValidated<Schema>;
let form: SuperForm<Schema>;

beforeEach(async () => {
	validated = await superValidate(zod(schema));
	form = superForm(validated, { validators: zod(schema), dataType: 'json' });
});

describe('Server errors and constraints share the same nested structure', () => {
	it('should map server errors for array items to the same paths as the client', async () => {
		const result = await superValidate(
			{ ...validData, tags: ['ok', 'x', 'ok'], addresses: [{ city: 'Lund' }, { city: '' }] },
			zod(schema)
		);

		expect(result.valid).toBe(false);
		// Array item errors are addressed by index, objects by key
		expect(result.errors.tags?.[1]).toBeTruthy();
		expect(result.errors.tags?.[0]).toBeUndefined();
		expect(result.errors.addresses?.[1]?.city).toBeTruthy();
		expect(result.errors.addresses?.[0]).toBeUndefined();
	});

	it('should expose constraints along the same object-only paths', () => {
		const constraints = get(form.constraints);
		expect(constraints?.name?.minlength).toBe(2);
		expect(constraints?.tags?.minlength).toBe(2);
		// No indices in the constraints structure, object keys only
		expect(constraints?.addresses?.city?.minlength).toBe(2);
		expect(constraints?.meta?.note?.minlength).toBe(1);
	});

	it('should set errors for array items with setError using the shared path format', async () => {
		const failure = setError(validated, 'tags[2]', 'Not allowed');
		expect(failure.status).toBe(400);
		expect(validated.errors.tags?.[2]).toEqual(['Not allowed']);
		expect(validated.errors.tags?.[0]).toBeUndefined();
	});
});

describe('Client validation, tainted and errors observe the same paths', () => {
	it('should align errors and tainted on the same array indices', async () => {
		form.form.update(($form) => ({ ...$form, tags: ['ok', 'x', 'ok'] }), { taint: true });
		await form.validateForm({ update: true });

		const errors = get(form.errors);
		const tainted = get(form.tainted) as Record<string, Record<number, boolean>>;

		expect(errors.tags?.[1]).toBeTruthy();
		expect(errors.tags?.[0]).toBeUndefined();
		expect(errors.tags?.[2]).toBeUndefined();
		// The tainted structure addresses the same element as the errors structure
		expect(tainted.tags[1]).toBe(true);
		expect(form.isTainted('tags[1]')).toBe(true);
		expect(form.isTainted('tags[0]')).toBe(true);
	});

	it('should migrate errors to the same element when an array element is removed in the middle', async () => {
		const withTags = await superValidate(
			{ name: 'ok', tags: ['aa', 'bb', 'cc'], addresses: [{ city: 'Lund' }] },
			zod(schema)
		);
		const arrayForm = superForm(withTags, { validators: zod(schema), dataType: 'json' });
		const { values } = arrayProxy(arrayForm, 'tags');

		arrayForm.errors.set({ tags: { 0: ['e0'], 2: ['e2'] } } as never);

		// Remove the middle element 'bb'
		values.update((arr) => [arr[0], arr[2]]);

		expect(get(arrayForm.form).tags).toEqual(['aa', 'cc']);
		// 'cc' moved from index 2 to index 1, and its error followed
		expect(get(arrayForm.errors)).toEqual({ tags: { 0: ['e0'], 1: ['e2'] } });
		// Tainted is recomputed against the clean state at the same indices,
		// so errors and tainted address the same element after the removal
		expect(arrayForm.isTainted('tags[0]')).toBe(false);
		expect(arrayForm.isTainted('tags[1]')).toBe(true);
	});

	it('should migrate errors for duplicate values at different positions', async () => {
		const withTags = await superValidate(
			{ name: 'ok', tags: ['aa', 'aa', 'bb'], addresses: [{ city: 'Lund' }] },
			zod(schema)
		);
		const arrayForm = superForm(withTags, { validators: zod(schema), dataType: 'json' });
		const { values } = arrayProxy(arrayForm, 'tags');

		arrayForm.errors.set({ tags: { 2: ['last'] } } as never);

		// Remove the first 'aa'; identical values must not confuse the migration
		values.update((arr) => [arr[1], arr[2]]);

		expect(get(arrayForm.form).tags).toEqual(['aa', 'bb']);
		expect(get(arrayForm.errors)).toEqual({ tags: { 1: ['last'] } });
	});

	it('should drop errors for elements removed from the end', async () => {
		const withTags = await superValidate(
			{ name: 'ok', tags: ['aa', 'bb', 'cc'], addresses: [{ city: 'Lund' }] },
			zod(schema)
		);
		const arrayForm = superForm(withTags, { validators: zod(schema), dataType: 'json' });
		const { values } = arrayProxy(arrayForm, 'tags');

		arrayForm.errors.set({ tags: { 0: ['e0'], 2: ['e2'] } } as never);

		values.update((arr) => arr.slice(0, 1));

		expect(get(arrayForm.errors)).toEqual({ tags: { 0: ['e0'] } });
	});

	it('should handle an optional object appearing and disappearing', () => {
		form.form.update(($form) => ({ ...$form, meta: { note: 'hello' } }), { taint: true });
		expect(form.isTainted('meta.note')).toBe(true);
		expect(get(form.tainted)).toEqual({ meta: { note: true } });

		form.form.update(
			($form) => {
				const copy = { ...$form };
				delete copy.meta;
				return copy;
			},
			{ taint: true }
		);

		// Back to the clean state, so nothing is tainted anymore
		expect(form.isTainted()).toBe(false);
		expect(form.isTainted('meta')).toBe(false);
	});
});

describe('Keys with special characters', () => {
	const specialSchema = z.object({
		'a.b[1]': z.string().min(2),
		normal: z.string()
	});

	it('should map server errors for special keys without splitting them', async () => {
		const result = await superValidate({ 'a.b[1]': 'x', normal: 'ok' }, zod(specialSchema));
		expect(result.valid).toBe(false);
		expect(result.errors['a.b[1]']).toBeTruthy();
		expect((result.errors as Record<string, unknown>).a).toBeUndefined();
	});

	it('should validate and taint special keys through their escaped path form', async () => {
		const special = await superValidate(zod(specialSchema));
		const specialForm = superForm(special, { validators: zod(specialSchema) });

		const path = '["a.b[1]"]' as never;
		const errors = await specialForm.validate(path, {
			value: 'x' as never,
			update: true,
			taint: true
		});

		expect(errors).toBeTruthy();
		expect(get(specialForm.errors)['a.b[1]']).toBeTruthy();
		expect(get(specialForm.form)['a.b[1]']).toBe('x');
		expect(specialForm.isTainted(path)).toBe(true);
		expect(get(specialForm.tainted)).toEqual({ 'a.b[1]': true });
	});
});

describe('Reset and snapshot restore', () => {
	it('should reset form data, errors and tainted to the initial values', async () => {
		const initial = get(form.form);

		form.form.update(($form) => ({ ...$form, name: 'x', tags: ['ok', 'x'] }), { taint: true });
		await form.validateForm({ update: true });
		expect(get(form.errors).tags?.[1]).toBeTruthy();
		expect(form.isTainted()).toBe(true);

		form.reset();

		expect(get(form.form)).toEqual(initial);
		expect(get(form.errors)).toEqual({});
		expect(get(form.tainted)).toBeUndefined();
		expect(form.isTainted()).toBe(false);
	});

	it('should restore an old snapshot across all stores', async () => {
		form.form.update(($form) => ({ ...$form, name: 'Snapshot', tags: ['ok', 'x'] }), {
			taint: true
		});
		await form.validateForm({ update: true });

		const snapshot = form.capture();
		expect(snapshot.tainted).toEqual({ name: true, tags: { 0: true, 1: true } });

		// Diverge from the snapshot
		form.form.update(($form) => ({ ...$form, name: 'Other', tags: [] }), { taint: true });
		form.errors.set({});

		form.restore(snapshot);

		expect(get(form.form)).toEqual(snapshot.data);
		expect(get(form.errors)).toEqual(snapshot.errors);
		expect(get(form.tainted)).toEqual(snapshot.tainted);
		expect(get(form.constraints)).toEqual(snapshot.constraints);
	});
});

describe('Multiple forms on the same page', () => {
	it('should keep stores for different form ids isolated', async () => {
		const first = superForm(await superValidate(zod(schema), { id: 'first' }), {
			validators: zod(schema),
			dataType: 'json',
			id: 'first'
		});
		const second = superForm(await superValidate(zod(schema), { id: 'second' }), {
			validators: zod(schema),
			dataType: 'json',
			id: 'second'
		});

		first.form.update(($form) => ({ ...$form, name: 'Changed' }), { taint: true });

		expect(get(first.form).name).toBe('Changed');
		expect(get(first.tainted)).toEqual({ name: true });
		expect(get(second.form).name).toBe('');
		expect(get(second.tainted)).toBeUndefined();
	});
});

///// mockSvelte.ts (must be copy/pasted here) ////////////////////////////////

import { vi } from 'vitest';

vi.mock('svelte', async (original) => {
	const module = (await original()) as Record<string, unknown>;
	return {
		...module,
		onDestroy: vi.fn()
	};
});

vi.mock('$app/stores', async () => {
	const { readable, writable } = await import('svelte/store');

	const getStores = () => ({
		navigating: readable(null),
		page: readable({ url: new URL('http://localhost'), params: {} }),
		session: writable(null),
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

	return {
		getStores,
		navigating,
		page
	};
});
