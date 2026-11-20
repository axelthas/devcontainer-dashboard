/**
 * Shared, reactive view of the visual viewport for phone layouts.
 *
 * One tracker runs for the whole app (started in the root layout). It publishes the values
 * as runes for components and as CSS custom properties on the document element:
 * `--keyboard-inset`, `--visual-viewport-height` and `--visual-viewport-top`.
 */
import { isKeyboardOpen, keyboardInset, type ViewportMetrics } from './keyboardInset';

/** Reactive visual viewport metrics. Values stay at their defaults until tracking starts. */
class VisualViewportState {
	layoutHeight = $state(0);
	height = $state(0);
	offsetTop = $state(0);
	/** Pixels hidden by the on-screen keyboard. */
	inset = $derived(keyboardInset(this.metrics()));
	/** True while an on-screen keyboard is open. */
	keyboardOpen = $derived(isKeyboardOpen(this.metrics()));

	/** Current values as plain metrics. */
	metrics(): ViewportMetrics {
		return { layoutHeight: this.layoutHeight, height: this.height, offsetTop: this.offsetTop };
	}
}

export const visualViewportState = new VisualViewportState();

/**
 * Start tracking. Feature-detects `window.visualViewport`; without it the values follow
 * `innerHeight` and the keyboard is never reported open. Returns the cleanup function.
 */
export function trackVisualViewport(target: Window = window): () => void {
	const viewport = target.visualViewport;
	const root = target.document.documentElement;
	const update = () => {
		visualViewportState.layoutHeight = target.innerHeight;
		visualViewportState.height = viewport?.height ?? target.innerHeight;
		visualViewportState.offsetTop = viewport?.offsetTop ?? 0;
		root.style.setProperty('--keyboard-inset', `${visualViewportState.inset}px`);
		root.style.setProperty('--visual-viewport-height', `${visualViewportState.height}px`);
		root.style.setProperty('--visual-viewport-top', `${visualViewportState.offsetTop}px`);
	};
	update();
	viewport?.addEventListener('resize', update);
	viewport?.addEventListener('scroll', update);
	target.addEventListener('resize', update);
	target.addEventListener('orientationchange', update);
	return () => {
		viewport?.removeEventListener('resize', update);
		viewport?.removeEventListener('scroll', update);
		target.removeEventListener('resize', update);
		target.removeEventListener('orientationchange', update);
		for (const name of ['--keyboard-inset', '--visual-viewport-height', '--visual-viewport-top'])
			root.style.removeProperty(name);
	};
}
