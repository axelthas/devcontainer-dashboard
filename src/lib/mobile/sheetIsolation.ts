/**
 * Isolation of the page behind an open bottom sheet (#35).
 *
 * `showModal()` makes the page inert for clicks and focus, but it does not stop scrolling:
 * a drag on the dimmed backdrop, on the sheet header, or past the end of the sheet content
 * still moves the page on iOS Safari. This module adds the two missing parts:
 *
 * - `lockPageScroll()` stops page scrolling while one or more sheets are open, and keeps
 *   the scroll position. Locks are counted, so a sheet over a sheet keeps the page locked.
 * - `guardSheetTouches()` cancels each touch drag in a sheet that no scroller inside the
 *   sheet can take, so the gesture never chains to the page.
 */

/** Scroll metrics of one element along one axis. */
export interface ScrollMetrics {
	/** Current offset: `scrollTop` or `scrollLeft`. */
	offset: number;
	/** Content size: `scrollHeight` or `scrollWidth`. */
	content: number;
	/** Visible size: `clientHeight` or `clientWidth`. */
	visible: number;
}

/**
 * Tell if a scroller can move for a finger drag of `drag` px.
 * A positive drag (finger moves down or right) shows earlier content.
 */
export function canScrollFor(metrics: ScrollMetrics, drag: number): boolean {
	if (drag === 0) return false;
	if (metrics.content - metrics.visible <= 1) return false;
	if (drag > 0) return metrics.offset > 0;
	return metrics.offset + metrics.visible < metrics.content - 1;
}

let locks = 0;
let saved: { scrollY: number; overflow: string; overscroll: string } | null = null;

/**
 * Stop page scrolling until the returned release function is called.
 * The last release restores the styles and the scroll position.
 */
export function lockPageScroll(): () => void {
	const root = document.documentElement;
	if (locks === 0) {
		saved = {
			scrollY: window.scrollY,
			overflow: root.style.overflow,
			overscroll: root.style.overscrollBehavior
		};
		root.style.overflow = 'hidden';
		root.style.overscrollBehavior = 'none';
		root.dataset.sheetOpen = '';
	}
	locks += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		locks -= 1;
		if (locks > 0 || !saved) return;
		root.style.overflow = saved.overflow;
		root.style.overscrollBehavior = saved.overscroll;
		delete root.dataset.sheetOpen;
		// A focus change or a keyboard can move the page while it is locked.
		if (window.scrollY !== saved.scrollY) window.scrollTo(0, saved.scrollY);
		saved = null;
	};
}

/** Number of open page-scroll locks. For tests. */
export function openLocks(): number {
	return locks;
}

/** Elements that scroll by themselves along an axis, from `target` up to `boundary`. */
function scrollers(target: Element, boundary: Element, axis: 'x' | 'y'): HTMLElement[] {
	const found: HTMLElement[] = [];
	for (let node: Element | null = target; node; node = node.parentElement) {
		if (node instanceof HTMLElement) {
			const style = getComputedStyle(node);
			const overflow = axis === 'y' ? style.overflowY : style.overflowX;
			if (overflow === 'auto' || overflow === 'scroll') found.push(node);
		}
		if (node === boundary) break;
	}
	return found;
}

/** Tell if a scroller between `target` and `boundary` can take a drag of `dx`, `dy`. */
function dragHasScroller(target: Element, boundary: Element, dx: number, dy: number): boolean {
	const axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
	const drag = axis === 'x' ? dx : dy;
	return scrollers(target, boundary, axis).some((element) =>
		canScrollFor(
			axis === 'x'
				? { offset: element.scrollLeft, content: element.scrollWidth, visible: element.clientWidth }
				: {
						offset: element.scrollTop,
						content: element.scrollHeight,
						visible: element.clientHeight
					},
			drag
		)
	);
}

/**
 * Cancel touch drags in `sheet` that no scroller in the sheet can take. Drags on the
 * backdrop target the dialog itself and are always cancelled. Returns the cleanup.
 */
export function guardSheetTouches(sheet: HTMLElement): () => void {
	let lastX = 0;
	let lastY = 0;

	const start = (event: TouchEvent) => {
		if (event.touches.length !== 1) return;
		lastX = event.touches[0].clientX;
		lastY = event.touches[0].clientY;
	};

	const move = (event: TouchEvent) => {
		// Two fingers: the browser zoom gesture. The page does not scroll from it.
		if (event.touches.length !== 1 || !event.cancelable) return;
		const touch = event.touches[0];
		const dx = touch.clientX - lastX;
		const dy = touch.clientY - lastY;
		lastX = touch.clientX;
		lastY = touch.clientY;
		const target = event.target instanceof Element ? event.target : sheet;
		// Caret and selection drags in a text field stay with the field.
		if (target.closest('input, textarea, [contenteditable="true"]')) return;
		if (target === sheet || !dragHasScroller(target, sheet, dx, dy)) event.preventDefault();
	};

	sheet.addEventListener('touchstart', start, { passive: true });
	sheet.addEventListener('touchmove', move, { passive: false });
	return () => {
		sheet.removeEventListener('touchstart', start);
		sheet.removeEventListener('touchmove', move);
	};
}
