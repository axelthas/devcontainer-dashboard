/**
 * Keyboard inset arithmetic for phones.
 *
 * iOS Safari keeps the layout viewport (and `vh`/`dvh`) unchanged when the on-screen keyboard
 * opens; only the visual viewport shrinks. A fixed panel that must stay above the keyboard
 * therefore needs the part of the layout viewport that the keyboard hides.
 */

/** Insets smaller than this are browser toolbars, not a keyboard. */
export const KEYBOARD_THRESHOLD_PX = 120;

/** The visual viewport as the browser reports it, plus the layout viewport height. */
export interface ViewportMetrics {
	/** `window.innerHeight`: the layout viewport height. */
	layoutHeight: number;
	/** `visualViewport.height`: the visible part above the keyboard. */
	height: number;
	/** `visualViewport.offsetTop`: how far the visible part is scrolled down. */
	offsetTop: number;
}

/** Pixels of the layout viewport hidden below the visual viewport. Never negative. */
export function keyboardInset({ layoutHeight, height, offsetTop }: ViewportMetrics): number {
	if (![layoutHeight, height, offsetTop].every(Number.isFinite)) return 0;
	return Math.max(0, Math.round(layoutHeight - height - offsetTop));
}

/** True when the hidden part is large enough to be an on-screen keyboard. */
export function isKeyboardOpen(metrics: ViewportMetrics): boolean {
	return keyboardInset(metrics) > KEYBOARD_THRESHOLD_PX;
}
