/**
 * Shared behavior tests: a single nested schema and a single operation
 * sequence, observed simultaneously through server errors, client
 * validation, tainted, constraints, form data and snapshot restore.
 *
 * Every observation goes through the same internal typed path model
 * (src/lib/pathModel.ts), so these tests fail if any entry point starts
 * interpreting paths differently (e.g. errors pointing at one array
 * element while tainted points at another).
 */
import './mockSvelte.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { z } from 'zod/v3';
import { zod } from '$lib/adapters/zod.js';
import { superForm, arrayProxy, fieldProxy, type SuperForm } from '$lib/client/index.js';
import { superValidate, setError, type SuperValidated } from '$lib/superValidate.js';

const itemSchema = z.object({
	title: z.string().min(2),
	qty: z.number().int().min(0)
});

const schema = z.object({
	name: z.string().min(2),
	items: z.array(itemSchema).min(1),
	address: z.object({ city: z.string().min(2) }).optional(),
	meta: z
		.object({
			'weird.key': z.string().min(1).optional()
		})
		.optional()
});

type Schema = z.infer<typeof schema>;

const validItems = [
	{ title: 'aa', qty: 1 },
	{ title: 'bb', qty: 2 },
	{ title: 'cc', qty: 3 }
];

let validated: SuperValidated<Schema>;
let form: SuperForm<Schema>;

beforeEach(async () => {
	validated = await superValidate(zod(schema));
	form = superForm(validated, { validators: zod(schema), dataType: 'json' });
});

function validData(): Schema {
	return { name: 'ok', items: structuredClone(validItems) };
}

describe('Shared path behavior across stores', () => {
	it('should expose constraints at the same paths as the schema', () => {
		const constraints = get(form.constraints);
		expect(constraints?.name?.minlength).toBe(2);
		expect(constraints?.items?.title?.minlength).toBe(2);
		expect(constraints?.address?.city?.minlength).toBe(2);
	});

	it('should keep errors, tainted and form data aligned through validation', async () => {
		form.form.set(validData());
		// Start observing tainted from a clean slate
		form.tainted.set(undefined);

		const result = await form.validateForm({ update: true });
		expect(result.valid).toBe(true);
		expect(get(form.errors)).toEqual({});

		// Introduce an error in the middle of the array
		form.form.update(($form) => {
			$form.items[1].title = 'x';
			return $form;
		});
		const invalid = await form.validateForm({ update: true });
		expect(invalid.valid).toBe(false);

		const errors = get(form.errors);
		expect(errors.items?.[0]).toBeUndefined();
		expect(errors.items?.[1]?.title).toEqual(['String must contain at least 2 character(s)']);
		expect(errors.items?.[2]).toBeUndefined();

		// Tainted observed through the same paths
		const tainted = get(form.tainted);
		expect(tainted?.items?.[1]?.title).toBe(true);
		expect(form.isTainted('items[1].title' as never)).toBe(true);
		expect(form.isTainted('items[0].title' as never)).toBe(false);
	});

	it('should migrate errors when an array element is removed from the middle', async () => {
		form.form.set(validData());
		form.form.update(($form) => {
			$form.items[1].title = 'x';
			return $form;
		});
		await form.validateForm({ update: true });
		expect(get(form.errors).items?.[1]?.title).toBeDefined();

		const proxy = arrayProxy(form, 'items');
		// Remove the first element; the invalid item moves to index 0
		proxy.values.update(($items) => $items.slice(1));

		expect(get(form.form).items.map((i) => i.title)).toEqual(['x', 'cc']);

		const errors = get(form.errors);
		// The error follows its element to index 0, nothing is left at index 1
		expect(errors.items?.[0]?.title).toEqual(['String must contain at least 2 character(s)']);
		expect(errors.items?.[1]).toBeUndefined();
	});

	it('should handle same-valued elements at different positions', async () => {
		const data = validData();
		data.items = [
			{ title: 'same', qty: 0 },
			{ title: 'same', qty: 0 },
			{ title: 'other', qty: 1 }
		];
		form.form.set(data);
		form.form.update(($form) => {
			$form.items[2].qty = -1;
			return $form;
		});
		await form.validateForm({ update: true });

		const errors = get(form.errors);
		expect(errors.items?.[0]).toBeUndefined();
		expect(errors.items?.[1]).toBeUndefined();
		expect(errors.items?.[2]?.qty).toBeDefined();
	});

	it('should handle optional objects appearing and disappearing', async () => {
		form.form.set(validData());

		// Appear with an invalid value
		form.form.update(($form) => {
			$form.address = { city: 'x' };
			return $form;
		});
		await form.validateForm({ update: true });
		expect(get(form.errors).address?.city).toBeDefined();
		expect(get(form.tainted)?.address?.city).toBe(true);

		// Disappear again
		form.form.update(($form) => {
			$form.address = undefined;
			return $form;
		});
		const result = await form.validateForm({ update: true });
		expect(result.valid).toBe(true);
		// Public contract: previous errors are cleared to undefined, not deleted
		expect(get(form.errors).address?.city).toBeUndefined();
	});

	it('should support actual key names containing special characters', async () => {
		form.form.set(validData());

		// Write through the escaped path form
		const proxy = fieldProxy(form, 'meta["weird.key"]' as never);
		proxy.set('hello' as never);

		const data = get(form.form);
		expect(data.meta?.['weird.key']).toBe('hello');
		// No nested structure may be created for the special key
		expect(data.meta).toEqual({ 'weird.key': 'hello' });
		expect('weird' in (data.meta ?? {})).toBe(false);

		// Server-side errors land on the same literal key
		const posted = await superValidate(zod(schema));
		const failure = setError(posted, 'meta["weird.key"]' as never, 'bad');
		expect(failure.data.form.errors.meta?.['weird.key']).toEqual(['bad']);
	});

	it('should reset to initial values across all stores', async () => {
		form.form.set(validData());
		form.form.update(($form) => {
			$form.items[0].title = 'x';
			return $form;
		});
		await form.validateForm({ update: true });
		expect(get(form.errors).items?.[0]?.title).toBeDefined();
		expect(form.isTainted()).toBe(true);

		form.reset();

		expect(get(form.form)).toEqual(validated.data);
		expect(get(form.errors)).toEqual({});
		expect(get(form.tainted)).toBeUndefined();
		expect(form.isTainted()).toBe(false);
	});

	it('should restore an old snapshot across all stores', async () => {
		form.form.set(validData());
		form.form.update(($form) => {
			$form.items[2].title = 'x';
			return $form;
		});
		await form.validateForm({ update: true });

		const snapshot = form.capture();
		expect(snapshot.errors.items?.[2]?.title).toBeDefined();

		// Diverge: fix the error and change data
		form.form.update(($form) => {
			$form.items[2].title = 'fixed';
			$form.name = 'changed';
			return $form;
		});
		await form.validateForm({ update: true });
		// Errors are cleared to undefined rather than deleted (public contract)
		expect(get(form.errors).items?.[2]?.title).toBeUndefined();

		// Restore the old snapshot
		form.restore(snapshot);

		expect(get(form.form).items[2].title).toBe('x');
		expect(get(form.form).name).toBe('ok');
		expect(get(form.errors).items?.[2]?.title).toBeDefined();
		expect(get(form.tainted)).toEqual(snapshot.tainted);
	});

	it('should keep multiple form ids independent', async () => {
		const other = superForm(await superValidate(zod(schema), { id: 'other' }), {
			validators: zod(schema),
			id: 'other',
			dataType: 'json'
		});

		form.form.set(validData());
		form.form.update(($form) => {
			$form.items[0].title = 'x';
			return $form;
		});
		await form.validateForm({ update: true });

		expect(get(form.errors).items?.[0]?.title).toBeDefined();
		expect(get(other.errors)).toEqual({});
		expect(get(other.tainted)).toBeUndefined();
	});

	it('should consume server-returned array item errors on the client', async () => {
		const posted = await superValidate(
			{ name: 'ok', items: [{ title: 'x', qty: 0 }, ...validItems.slice(1)] },
			zod(schema)
		);
		expect(posted.valid).toBe(false);
		expect(posted.errors.items?.[0]?.title).toBeDefined();
		expect(posted.errors.items?.[1]).toBeUndefined();

		const postedForm = superForm(posted, { validators: zod(schema), dataType: 'json' });
		const errors = get(postedForm.errors);
		expect(errors.items?.[0]?.title).toBeDefined();
		expect(errors.items?.[1]).toBeUndefined();
		// Form data echoes the posted (invalid) data
		expect(get(postedForm.form).items[0].title).toBe('x');
	});
});
