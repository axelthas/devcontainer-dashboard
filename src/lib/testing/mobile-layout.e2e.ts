/** Fixed-data regressions for phone layouts, including clipping hidden by overflow containers. */
import { expect, test, type Page } from '@playwright/test';
import { loginTerminalTest } from './terminalFixtures';

/**
 * Return controls clipped horizontally by any ancestor, not just by the document.
 * Native popovers are top-layer elements and therefore escape their DOM ancestors' clipping.
 * Off-screen vertical rows are included: scrolling down must not reveal a broken row.
 */
async function clippedControls(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const failures: string[] = [];
		for (const node of document.querySelectorAll<HTMLElement>('button,a[href],select,input')) {
			if (!node.checkVisibility() || node.closest('.xterm')) continue;
			const box = node.getBoundingClientRect();
			if (!box.width || !box.height) continue;
			let left = 0;
			let right = document.documentElement.clientWidth;
			if (!node.closest(':popover-open')) {
				for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
					if (getComputedStyle(p).overflowX === 'visible') continue;
					const r = p.getBoundingClientRect();
					left = Math.max(left, r.left + p.clientLeft);
					right = Math.min(right, r.left + p.clientLeft + p.clientWidth);
				}
			}
			if (box.left < left - 1 || box.right > right + 1)
				failures.push(
					`${node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 50)} clipped at ${Math.round(box.left)}..${Math.round(box.right)} outside ${Math.round(left)}..${Math.round(right)}`
				);
		}
		return failures;
	});
}

/** Every visible button in a fixture must retain a full touch target. */
async function shortButtons(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll('button')]
			.filter((e) => e.checkVisibility())
			.filter((e) => {
				const r = e.getBoundingClientRect();
				return r.width < 43.5 || r.height < 43.5;
			})
			.map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim() ?? 'button')
	);
}

/** Stable bootstrap and picker responses; mutation endpoints are never allowed in layout tests. */
async function fixedApi(page: Page): Promise<void> {
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url());
		if (route.request().method() !== 'GET') throw new Error(`Unexpected mutation: ${url.pathname}`);
		let data: unknown = [];
		if (url.pathname === '/api/bootstrap')
			data = {
				installed: true,
				name: 'Dev Bootstrap',
				version: '26.0.56',
				currentBranch: 'master',
				availableBranches: ['master']
			};
		if (url.pathname === '/api/repos/branches')
			data = {
				branches: ['master', 'feature/long-branch-name'],
				tags: ['1.0.0', '2.9.22'],
				currentBranch: 'master'
			};
		await route.fulfill({ json: data });
	});
}

/** Open one fixture screen after normal authentication. */
async function screen(page: Page, section: string): Promise<void> {
	await loginTerminalTest(page);
	await fixedApi(page);
	await page.goto(`/demo/mobile?section=${section}`);
	await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
}

for (const width of [320, 393, 768]) {
	test.describe(`${width}px fixed-data rows`, () => {
		test.use({ viewport: { width, height: 852 }, hasTouch: true, isMobile: true });

		test('container actions fit before and after expansion', async ({ page }) => {
			await screen(page, 'containers');
			expect(await clippedControls(page)).toEqual([]);
			if (width < 768) expect(await shortButtons(page)).toEqual([]);
			const first = page.locator('[data-container-id]').first();
			await first.getByRole('button', { name: 'Details: tern-framework', exact: true }).click();
			await expect(first.getByRole('button', { name: 'Copy Local folder' })).toBeVisible();
			await expect(
				first.getByRole('list', { name: 'Published ports' }).locator(':scope > li')
			).toHaveCount(2);
			expect(await clippedControls(page)).toEqual([]);
			if (width < 768) expect(await shortButtons(page)).toEqual([]);
			if (width === 393)
				await expect(page).toHaveScreenshot('container-details.png', {
					animations: 'disabled',
					fullPage: true
				});
			if (width < 768) {
				await first
					.getByRole('button', { name: 'Container actions: tern-framework', exact: true })
					.click();
				const menu = page.getByRole('menu', { name: 'Actions for tern-framework', exact: true });
				await expect(menu).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: 'Grant Brain' })).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: 'Delete container…' })).toBeVisible();
				expect(await clippedControls(page)).toEqual([]);
				if (width < 768) expect(await shortButtons(page)).toEqual([]);
				if (width === 393)
					await expect(page).toHaveScreenshot('container-actions.png', { animations: 'disabled' });
				// Service selection is nested in the action sheet, but escapes its bounds.
				await menu.getByRole('button', { name: 'Services: tern-framework', exact: true }).click();
				const services = page.getByRole('menu', {
					name: 'Services of tern-framework',
					exact: true
				});
				await expect(services.getByRole('menuitem', { name: /OpenChamber/ })).toBeVisible();
				await services.getByRole('menuitem', { name: 'Close menu', exact: true }).click();
				await expect(menu).toBeHidden();
				await page.keyboard.press('Escape');
				await first.getByRole('button', { name: 'Open with: tern-framework', exact: true }).click();
				await expect(page.getByRole('menu', { name: /Open tern-framework/ })).toBeVisible();
				await page.getByRole('menuitem', { name: /^Terminal/ }).click();
				await expect(page.getByRole('menu', { name: /Open tern-framework/ })).toBeHidden();
			}
		});

		test('long workspace names and expanded repos retain every action', async ({ page }) => {
			await screen(page, 'workspaces');
			expect(await clippedControls(page)).toEqual([]);
			if (width < 768) expect(await shortButtons(page)).toEqual([]);
			await page
				.getByRole('button', { name: 'Workspace: git.polaris-ice.26.0.63', exact: true })
				.click();
			await expect(page.locator('[data-repo="polaris-asd"]')).toBeVisible();
			expect(await clippedControls(page)).toEqual([]);
			if (width < 768) expect(await shortButtons(page)).toEqual([]);
			if (width === 393)
				await expect(page).toHaveScreenshot('workspace-repos.png', {
					animations: 'disabled',
					fullPage: true
				});
			if (width < 768) {
				await page
					.getByRole('button', { name: 'Repository actions: polaris-asd', exact: true })
					.click();
				await expect(
					page.getByRole('menu', { name: 'Repository polaris-asd', exact: true })
				).toBeVisible();
				expect(await clippedControls(page)).toEqual([]);
				if (width < 768) expect(await shortButtons(page)).toEqual([]);
				if (width === 393)
					await expect(page).toHaveScreenshot('repository-actions.png', { animations: 'disabled' });
			}
		});

		test('service details fit; stack removal is not an exposed primary action on phones', async ({
			page
		}) => {
			await screen(page, 'services');
			await page
				.getByRole('button')
				.filter({ has: page.getByRole('heading', { name: 'polaris-ice', exact: true }) })
				.click();
			await page.getByRole('button', { name: 'Details: polaris-ice-atm1', exact: true }).click();
			expect(await clippedControls(page)).toEqual([]);
			if (width < 768) expect(await shortButtons(page)).toEqual([]);
			if (width === 393)
				await expect(page).toHaveScreenshot('service-details.png', {
					animations: 'disabled',
					fullPage: true
				});
			if (width < 768) {
				await expect(
					page.getByRole('button', { name: 'Remove sandbox polaris-ice', exact: true })
				).toBeHidden();
				await page.getByRole('button', { name: 'Stack actions: polaris-ice', exact: true }).click();
				await expect(page.getByRole('menuitem', { name: 'Remove sandbox…' })).toBeVisible();
				expect(await clippedControls(page)).toEqual([]);
				if (width < 768) expect(await shortButtons(page)).toEqual([]);
			}
		});
	});
}

test('the clipping detector catches a child hidden by a card although the page width fits', async ({
	page
}) => {
	await page.setContent(
		'<div style="width:200px;overflow:hidden"><button style="margin-left:180px;width:80px">Clipped action</button></div>'
	);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth === document.documentElement.clientWidth
		)
	).toBe(true);
	expect(await clippedControls(page)).toHaveLength(1);
});

test.describe('phone clipboard', () => {
	test.use({
		viewport: { width: 393, height: 852 },
		hasTouch: true,
		isMobile: true,
		permissions: ['clipboard-read', 'clipboard-write']
	});
	test('copies a full path and an unwrapped shell command', async ({ page }) => {
		await screen(page, 'containers');
		await page.getByRole('button', { name: 'Details: tern-framework', exact: true }).click();
		await page.getByRole('button', { name: 'Copy Local folder', exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toBe('/home/operator/git.workspaces/git.polaris-ice.26.0.63/tern-framework');
		const code = page.locator('[data-container-id]').first().locator('code').first();
		const expected = await code.textContent();
		await page.getByRole('button', { name: 'Copy Terminal command', exact: true }).click();
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
		expect(await code.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe('pre');
	});
});
