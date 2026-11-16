/** Verify the AI window header has service-viewer styling in both themes. */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import AiViewerHeader from './AiViewerHeader.svelte';

const mounted: ReturnType<typeof mount>[] = [];
const targets: HTMLElement[] = [];

/** Remove test-owned DOM and mounted components after each case. */
afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	for (const target of targets.splice(0)) target.remove();
});

describe('AI viewer header', () => {
	it.each([
		['light', false, 'rgb(229, 233, 240)', 'rgb(46, 52, 64)'],
		['dark', true, 'rgb(59, 66, 82)', 'rgb(236, 239, 244)']
	] as const)(
		'uses the service header layout and palette in %s mode',
		(_theme, dark, background, text) => {
			const target = document.createElement('div');
			document.body.append(target);
			targets.push(target);
			mounted.push(
				mount(AiViewerHeader, {
					target,
					props: { path: '/workspaces/fixture/project', label: 'OpenCode TUI', dark }
				})
			);
			const header = target.querySelector('header')!;
			const style = getComputedStyle(header);
			expect(style.height).toBe('44px');
			expect(style.backgroundColor).toBe(background);
			expect(getComputedStyle(header.querySelector('.project')!).color).toBe(text);
			expect(header.textContent).toContain('OpenCode TUI');
			expect(header.querySelector('.path')?.getAttribute('title')).toBe(
				'/workspaces/fixture/project'
			);
			expect(header.querySelector('a[href="/"]')?.textContent).toContain('Dashboard');
		}
	);
});
