/**
 * Terminal text size on the phone: an A-/A+ stepper and a pinch gesture change it, and
 * each phone remembers its own size. A change resizes the viewer; the fit then sends the
 * new columns and rows to the PTY, so the process redraws for the new grid.
 */

export const TEXT_SIZE_KEY = 'devharbour-mobile-terminal-font-size';
export const DEFAULT_TEXT_SIZE = 14;
export const MIN_TEXT_SIZE = 10;
export const MAX_TEXT_SIZE = 22;

/** Keep a size inside the supported range, in whole points. */
export function clampTextSize(size: number): number {
	if (!Number.isFinite(size)) return DEFAULT_TEXT_SIZE;
	return Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, Math.round(size)));
}

/** One stepper press: -1, +1, or 0 to reset. */
export function stepTextSize(size: number, step: -1 | 0 | 1): number {
	return step === 0 ? DEFAULT_TEXT_SIZE : clampTextSize(size + step);
}

/** The size during a pinch: the start size scaled by the change in finger distance. */
export function pinchTextSize(startSize: number, startDistance: number, distance: number): number {
	if (!(startDistance > 0) || !(distance > 0)) return clampTextSize(startSize);
	return clampTextSize(startSize * (distance / startDistance));
}

/** Read the stored size; missing or invalid values give the default. */
export function parseTextSize(value: string | null): number {
	if (value === null) return DEFAULT_TEXT_SIZE;
	return clampTextSize(Number(value));
}
