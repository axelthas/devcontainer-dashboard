/**
 * Mobile status-bar paint regressions against the built custom server.
 * Chromium does not reproduce iOS system blur or publish a notch inset. Supply a
 * nonzero CSS inset to check our geometry and paint contract, not native iOS behaviour.
 */
import { expect, test } from '@playwright/test';
import { loginTerminalTest } from './terminalFixtures';

const PHONE = {
	viewport: { width: 393, height: 852 },
	isMobile: true,
	hasTouch: true,
	userAgent:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
};

test.use(PHONE);

for (const theme of ['dark', 'light'] as const) {
	for (const inset of [0, 59]) {
		test(`${theme}: opaque top edge with ${inset}px safe area, before and after scroll`, async ({
			page
		}) => {
			await page.addInitScript((value) => {
				localStorage.setItem('devcontainer-dashboard-theme', value);
			}, theme);
			await loginTerminalTest(page);
			const colour = theme === 'light' ? 'rgb(236, 239, 244)' : 'rgb(46, 52, 64)';
			for (const section of ['containers', 'workspaces', 'services', 'terminals']) {
				await page.goto(`/mobile/${section}`);
				await expect(page.getByTestId('mobile-app')).toBeVisible();
				await page.addStyleTag({
					content: `.mobile-app { --mobile-safe-area-top: ${inset}px; }`
				});
				const strip = page.getByTestId('mobile-top-safe-area');
				const header = page.getByTestId('mobile-nav-bar');
				await expect(strip).toHaveCSS('height', `${inset}px`);
				await expect(strip).toHaveCSS('position', 'fixed');
				await expect(strip).toHaveCSS('top', '0px');
				await expect(strip).toHaveCSS('background-color', colour);
				await expect(strip).toHaveCSS('pointer-events', 'none');
				await expect(header).toHaveCSS('padding-top', `${inset}px`);
				await expect(header).toHaveCSS('background-color', colour);
				await expect(header).toHaveCSS('backdrop-filter', 'none');
				const host = page.getByTestId('host-button');
				const box = await host.boundingBox();
				expect(box).not.toBeNull();
				expect(box!.y).toBeGreaterThanOrEqual(inset);
				// Guarantee a scrollable page even on a Docker host with no containers.
				await page.getByTestId('mobile-app').evaluate((element) => {
					element.style.minHeight = '2000px';
				});
				await page.evaluate(() => window.scrollTo(0, 400));
				await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
				const stripBox = await strip.boundingBox();
				expect(stripBox?.y).toBe(0);
				await expect(strip).toHaveCSS('background-color', colour);
				await expect(header).toHaveCSS('backdrop-filter', 'none');
				await page.evaluate(() => window.scrollTo(0, 0));
			}
		});
	}
}
