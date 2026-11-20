import { describe, expect, it } from 'vitest';
import {
	DEFAULT_TEXT_SIZE,
	MAX_TEXT_SIZE,
	MIN_TEXT_SIZE,
	clampTextSize,
	parseTextSize,
	pinchTextSize,
	stepTextSize
} from './terminalTextSize';

describe('terminal text size', () => {
	it('keeps sizes inside the range', () => {
		expect(clampTextSize(4)).toBe(MIN_TEXT_SIZE);
		expect(clampTextSize(99)).toBe(MAX_TEXT_SIZE);
		expect(clampTextSize(15.6)).toBe(16);
		expect(clampTextSize(Number.NaN)).toBe(DEFAULT_TEXT_SIZE);
	});

	it('steps and resets', () => {
		expect(stepTextSize(14, 1)).toBe(15);
		expect(stepTextSize(14, -1)).toBe(13);
		expect(stepTextSize(MAX_TEXT_SIZE, 1)).toBe(MAX_TEXT_SIZE);
		expect(stepTextSize(19, 0)).toBe(DEFAULT_TEXT_SIZE);
	});

	it('scales with the pinch distance', () => {
		expect(pinchTextSize(14, 100, 150)).toBe(21);
		expect(pinchTextSize(14, 100, 50)).toBe(MIN_TEXT_SIZE);
		expect(pinchTextSize(14, 0, 50)).toBe(14);
	});

	it('reads stored values defensively', () => {
		expect(parseTextSize(null)).toBe(DEFAULT_TEXT_SIZE);
		expect(parseTextSize('18')).toBe(18);
		expect(parseTextSize('huge')).toBe(DEFAULT_TEXT_SIZE);
	});
});
