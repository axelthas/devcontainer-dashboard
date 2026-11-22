/**
 * Status-bar paint regressions against the built custom server.
 * Browser emulation checks our paint and navigation contract, not the native iPadOS
 * status bar. Include zero insets and real tab clicks: full page loads hid that gap.
 */
import { expect, test } from '@playwright/test';
import { loginTerminalTest } from './terminalFixtures';

const DEVICES = [
	{
		name: 'iPhone',
		viewport: { width: 393, height: 852 },
		userAgent:
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
	},
	{
		name: 'iPad landscape',
		viewport: { width: 1194, height: 834 },
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
	},
	{
		name: 'iPad portrait',
		viewport: { width: 834, height: 1194 },
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
	}
];

for (const device of DEVICES) {
	test.describe(device.name, () => {
		test.use({
			viewport: device.viewport,
			userAgent: device.userAgent,
			isMobile: true,
			hasTouch: true
		});

		for (const theme of ['dark', 'light'] as const) {
			for (const inset of [0, 59]) {
				test(`${theme}: top paint survives tab navigation and scrolling with ${inset}px inset`, async ({
					page
				}) => {
					await page.addInitScript((value) => {
						localStorage.setItem('devcontainer-dashboard-theme', value);
					}, theme);
					await loginTerminalTest(page);
					await page.goto('/mobile/containers');
					const app = page.getByTestId('mobile-app');
					await expect(app).toBeVisible();
					// Confirm hydration and that the top paint strip does not block host controls.
					await page.getByTestId('host-button').click();
					const sheet = page.getByTestId('host-sheet');
					await expect(sheet).toBeVisible();
					await sheet.getByRole('button', { name: 'Done' }).click();
					await expect(sheet).toBeHidden();
					await app.evaluate((element, value) => {
						element.style.setProperty('--mobile-safe-area-top', `${value}px`);
						// The shared shell must survive tab navigation without a document reload.
						element.setAttribute('data-navigation-paint', 'kept');
					}, inset);
					const colour = theme === 'light' ? 'rgb(236, 239, 244)' : 'rgb(46, 52, 64)';
					const tabs = [
						{ id: 'containers', label: 'Containers' },
						{ id: 'workspaces', label: 'Workspaces' },
						{ id: 'services', label: 'Services' },
						{ id: 'terminals', label: 'Terminals' },
						{ id: 'containers', label: 'Containers' }
					];
					for (const [index, tab] of tabs.entries()) {
						if (index > 0) {
							await page
								.getByRole('navigation', { name: 'Sections' })
								.locator(`a[href="/mobile/${tab.id}"]`)
								.click();
						}
						await expect(page).toHaveURL(new RegExp(`/mobile/${tab.id}$`));
						await expect(app).toHaveAttribute('data-navigation-paint', 'kept');
						await expect(
							page.getByRole('heading', { level: 1, name: tab.label, exact: true })
						).toBeVisible();
						const strip = page.getByTestId('mobile-top-safe-area');
						const header = page.getByTestId('mobile-nav-bar');
						// Paint has a nonzero floor; layout padding remains the actual device inset.
						await expect(strip).toHaveCSS('height', `${Math.max(6, inset)}px`);
						await expect(strip).toHaveCSS('position', 'fixed');
						await expect(strip).toHaveCSS('top', '0px');
						await expect(strip).toHaveCSS('background-color', colour);
						await expect(strip).toHaveCSS('pointer-events', 'none');
						const paintBox = await strip.boundingBox();
						expect(paintBox?.width).toBeGreaterThanOrEqual(device.viewport.width * 0.8);
						await expect(page.locator('html')).toHaveCSS('background-color', colour);
						await expect(page.locator('body')).toHaveCSS('background-color', colour);
						await expect(header).toHaveCSS('padding-top', `${inset}px`);
						await expect(header).toHaveCSS('background-color', colour);
						await expect(header).toHaveCSS('backdrop-filter', 'none');
						const box = await page.getByTestId('host-button').boundingBox();
						expect(box).not.toBeNull();
						expect(box!.y).toBeGreaterThanOrEqual(inset);
						// Guarantee scrolling on short Services pages and empty Docker hosts.
						await app.evaluate((element) => {
							element.style.minHeight = '2000px';
						});
						await page.evaluate(() => window.scrollTo(0, 400));
						await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
						const scrolledBox = await strip.boundingBox();
						expect(scrolledBox?.y).toBe(0);
						await expect(strip).toHaveCSS('background-color', colour);
						await expect(page.locator('body')).toHaveCSS('background-color', colour);
						await page.evaluate(() => window.scrollTo(0, 0));
					}
				});
			}
		}
	});
}

test('mobile document paint follows theme changes and does not leak into desktop', async ({
	page
}) => {
	await page.addInitScript(() => {
		localStorage.setItem('devcontainer-dashboard-theme', 'dark');
	});
	await loginTerminalTest(page);
	await page.goto('/mobile/containers');
	await page.getByTestId('host-button').click();
	const sheet = page.getByTestId('host-sheet');
	await expect(sheet).toBeVisible();
	await sheet.getByRole('radio', { name: 'Light', exact: true }).click();
	for (const target of ['html', 'body']) {
		await expect(page.locator(target)).toHaveCSS('background-color', 'rgb(236, 239, 244)');
	}
	await expect(page.getByTestId('mobile-top-safe-area')).toHaveCSS(
		'background-color',
		'rgb(236, 239, 244)'
	);
	await sheet.getByRole('radio', { name: 'Dark', exact: true }).click();
	for (const target of ['html', 'body']) {
		await expect(page.locator(target)).toHaveCSS('background-color', 'rgb(46, 52, 64)');
	}
	// This intentionally leaves mobile; the scoped document background must stop matching.
	await page.goto('/interface?use=desktop');
	await expect(page.getByTestId('mobile-app')).toHaveCount(0);
	for (const target of ['html', 'body']) {
		await expect(page.locator(target)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	}
});
