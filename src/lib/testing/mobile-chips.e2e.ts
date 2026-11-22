/**
 * Shared mobile chips must keep SVG icons and labels on one line inside the border.
 * API fixtures reproduce the reported list and service-detail states without host writes.
 * Geometry checks catch wrapping even when the label is still considered visible.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ContainerData } from '$lib/types';
import type { BrainStatus } from '$lib/brainTypes';

const containers: ContainerData[] = [
	{
		id: 'cccccccccccc',
		name: '/chip-devcontainer',
		projectName: 'chip-devcontainer',
		state: 'running',
		isDevcontainer: true,
		ports: {},
		image: 'fixture:latest'
	},
	{
		id: 'dddddddddddd',
		name: '/chip-service',
		projectName: 'chip-service',
		state: 'running',
		isDevcontainer: false,
		ports: {},
		image: 'fixture:26.0.63',
		composeProject: 'chip-stack',
		composeService: 'app1-asd-a',
		sandboxTag: '26.0.63'
	}
];

/** Supply read-only fixtures; no real Brain grant or Docker change is made. */
async function setup(page: Page): Promise<void> {
	const now = Date.now();
	const status: BrainStatus = {
		enabled: true,
		executions: [],
		audit: [],
		grants: containers.map((container) => ({
			id: `fixture-${container.id}`,
			containerId: container.id,
			containerName: container.name,
			kind: container.isDevcontainer ? 'devcontainer' : 'service',
			startedAt: new Date(now - 60_000).toISOString(),
			user: 'fixture',
			userSource: 'fixture',
			exposure: [],
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + 59 * 60_000).toISOString(),
			runningExecutions: 0
		}))
	};
	await page.route('**/api/containers', (route) => route.fulfill({ json: containers }));
	await page.route('**/api/brain', (route) => route.fulfill({ json: status }));
	const origin = test.info().project.use.baseURL!;
	const login = await page.request.post('/login', {
		form: { password: 'playwright-test-password' },
		headers: { Origin: origin, 'x-sveltekit-action': 'true' }
	});
	expect(login.ok()).toBe(true);
	await page.goto('/mobile/containers');
	await expect(
		page.getByTestId('container-row').filter({ hasText: 'chip-devcontainer' })
	).toBeVisible();
}

/** Check actual icon/text boxes, not visibility alone: wrapped text can remain visible. */
async function expectSingleLine(chip: Locator): Promise<void> {
	await expect(chip).toBeVisible();
	const geometry = await chip.evaluate((element) => {
		const border = element.getBoundingClientRect();
		const icon = element.querySelector('svg')!.getBoundingClientRect();
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const text: DOMRect[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!node.textContent?.trim()) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			text.push(...range.getClientRects());
		}
		return {
			height: border.height,
			iconInside: icon.top >= border.top && icon.bottom <= border.bottom,
			textInside: text.every((box) => box.top >= border.top && box.bottom <= border.bottom),
			textAfterIcon: text.every((box) => box.left >= icon.right),
			centreOffset: Math.max(
				...text.map((box) => Math.abs((box.top + box.bottom - icon.top - icon.bottom) / 2))
			)
		};
	});
	expect(geometry.height).toBe(24);
	expect(geometry.iconInside).toBe(true);
	expect(geometry.textInside).toBe(true);
	expect(geometry.textAfterIcon).toBe(true);
	expect(geometry.centreOffset).toBeLessThanOrEqual(3);
}

for (const width of [320, 393, 834]) {
	for (const theme of ['dark', 'light']) {
		test(`icons stay inside chips at ${width}px in ${theme} mode`, async ({ page }) => {
			await page.setViewportSize({ width, height: 852 });
			await page.addInitScript(
				(value) => localStorage.setItem('devcontainer-dashboard-theme', value),
				theme
			);
			await setup(page);
			const row = page.getByTestId('container-row').filter({ hasText: 'chip-devcontainer' });
			await expectSingleLine(row.getByTestId('mobile-chip'));
			await row.click();
			await expectSingleLine(
				page.getByTestId('mobile-chip').filter({ hasText: 'Brain shell access' })
			);
			await page.goto('/mobile/services/container/dddddddddddd');
			await expectSingleLine(page.getByTestId('mobile-chip').filter({ hasText: '26.0.63' }));
			await expectSingleLine(
				page.getByTestId('mobile-chip').filter({ hasText: 'Brain shell access' })
			);
			await page.goto('/mobile/services/chip-stack');
			const version = page.getByTestId('mobile-chip').filter({ hasText: '26.0.63' });
			await expectSingleLine(version);
			// A long version must truncate without making the document wider.
			await version
				.locator('span')
				.evaluate((label) => label.append('very-long-version'.repeat(20)));
			await expect(version).toHaveCSS('white-space', 'nowrap');
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
			).toBeLessThanOrEqual(0);
			expect(
				await version.locator('span').evaluate((label) => label.scrollWidth > label.clientWidth)
			).toBe(true);
		});
	}
}
