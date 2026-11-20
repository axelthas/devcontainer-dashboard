/** Unit tests for the keyboard inset arithmetic used by the phone terminal sheet. */
import { describe, expect, it } from 'vitest';
import { isKeyboardOpen, keyboardInset } from './keyboardInset';

describe('keyboardInset', () => {
	it('is zero when the visual viewport fills the layout viewport', () => {
		expect(keyboardInset({ layoutHeight: 852, height: 852, offsetTop: 0 })).toBe(0);
		expect(isKeyboardOpen({ layoutHeight: 852, height: 852, offsetTop: 0 })).toBe(false);
	});

	it('measures the keyboard below a scrolled visual viewport', () => {
		const metrics = { layoutHeight: 852, height: 466, offsetTop: 40 };
		expect(keyboardInset(metrics)).toBe(346);
		expect(isKeyboardOpen(metrics)).toBe(true);
	});

	it('treats a collapsing browser toolbar as no keyboard', () => {
		expect(isKeyboardOpen({ layoutHeight: 852, height: 780, offsetTop: 0 })).toBe(false);
	});

	it('never returns a negative or non-finite inset', () => {
		expect(keyboardInset({ layoutHeight: 700, height: 760, offsetTop: 0 })).toBe(0);
		expect(keyboardInset({ layoutHeight: Number.NaN, height: 500, offsetTop: 0 })).toBe(0);
	});
});
