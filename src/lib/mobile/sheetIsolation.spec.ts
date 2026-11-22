import { describe, expect, it } from 'vitest';
import { canScrollFor } from './sheetIsolation';

describe('canScrollFor', () => {
	const list = { content: 900, visible: 400 };

	it('lets a scroller in the middle move both ways', () => {
		expect(canScrollFor({ ...list, offset: 200 }, 30)).toBe(true);
		expect(canScrollFor({ ...list, offset: 200 }, -30)).toBe(true);
	});

	it('stops a drag past the top', () => {
		expect(canScrollFor({ ...list, offset: 0 }, 30)).toBe(false);
		expect(canScrollFor({ ...list, offset: 0 }, -30)).toBe(true);
	});

	it('stops a drag past the end, with subpixel rounding', () => {
		expect(canScrollFor({ ...list, offset: 499.5 }, -30)).toBe(false);
		expect(canScrollFor({ ...list, offset: 499.5 }, 30)).toBe(true);
	});

	it('never lets content that fits scroll', () => {
		expect(canScrollFor({ offset: 0, content: 400.5, visible: 400 }, -30)).toBe(false);
		expect(canScrollFor({ offset: 0, content: 400, visible: 400 }, 30)).toBe(false);
	});

	it('ignores a drag of zero', () => {
		expect(canScrollFor({ ...list, offset: 200 }, 0)).toBe(false);
	});
});
