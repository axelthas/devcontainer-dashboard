/**
 * Phone service viewer against the built server. The container list is fixture data and
 * the services are fixture pages on an unused port, so no real container service is used.
 * The test server runs without the service gateway, so links use the legacy URL path.
 */
import { expect, test, type Page } from '@playwright/test';
import type { ContainerData } from '$lib/types';

test.use({
	viewport: { width: 393, height: 852 },
	isMobile: true,
	hasTouch: true,
	userAgent:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
});

/** Host ports of the fixture services; nothing listens on them. */
const OPENCODE = '45991';
const CHAMBER = '45992';

/** Sign in, serve fixture services and a fixture devcontainer, open its screen. */
async function setup(page: Page) {
	await page.request.post('/login', {
		form: { password: 'playwright-test-password' },
		headers: { Origin: 'http://127.0.0.1:4173', 'x-sveltekit-action': 'true' }
	});
	const hits: Record<string, number> = {};
	for (const [port, name] of [
		[OPENCODE, 'OpenCode fixture'],
		[CHAMBER, 'OpenChamber fixture']
	]) {
		await page.route(`http://127.0.0.1:${port}/**`, (route) => {
			hits[port] = (hits[port] ?? 0) + 1;
			return route.fulfill({
				contentType: 'text/html',
				body: `<!doctype html><title>${name}</title><h1>${name}</h1><input aria-label="Message">`
			});
		});
	}
	const container: ContainerData = {
		id: 'eeeeeeeeeeee',
		name: '/fixture-viewer',
		projectName: 'viewer-project',
		state: 'running',
		isDevcontainer: true,
		ports: { '4096': OPENCODE, '3000': CHAMBER },
		image: 'fixture-image',
		localWorkspacePath: '/fixture/git.task-workspace/viewer-project',
		networks: []
	};
	await page.route('**/api/containers', (route) => route.fulfill({ json: [container] }));
	await page.goto('/mobile/containers');
	await page.getByTestId('container-row').filter({ hasText: 'viewer-project' }).click();
	await expect(page).toHaveURL(/\/mobile\/containers\/eeeeeeeeeeee$/);
	return { hits };
}

/** The service's own document inside the viewer. */
const frame = (page: Page) => page.frameLocator('[data-testid="service-frame"]');

test('a service opens inside the app with a phone header', async ({ page, context }) => {
	await setup(page);
	await page.getByText('Port 4096', { exact: false }).click();
	await expect(page).toHaveURL(/\/mobile\/services\/view\?/);
	expect(context.pages()).toHaveLength(1);
	await expect(frame(page).getByRole('heading', { name: 'OpenCode fixture' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
	const header = page.getByTestId('service-header');
	await expect(header).toContainText('viewer-project');
	await expect(page.getByRole('progressbar')).toHaveCount(0);
	// Every header control is a full touch target and the header never widens the page.
	for (const box of await header
		.locator('button')
		.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()))) {
		expect(box.width).toBeGreaterThanOrEqual(43.5);
		expect(box.height).toBeGreaterThanOrEqual(43.5);
	}
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(1);
	await page.getByTestId('service-back').click();
	await expect(page).toHaveURL(/\/mobile\/containers\/eeeeeeeeeeee$/);
});

test('switches in place, keeps opened services loaded, and reloads on request', async ({
	page
}) => {
	const { hits } = await setup(page);
	await page.getByText('Port 4096', { exact: false }).click();
	await expect(frame(page).getByRole('heading', { name: 'OpenCode fixture' })).toBeVisible();
	await frame(page).getByRole('textbox', { name: 'Message' }).fill('draft kept');
	await page.getByTestId('service-title').click();
	const sheet = page.getByTestId('service-switch-sheet');
	await sheet.getByTestId('service-option').filter({ hasText: 'Port 3000' }).click();
	await expect(frame(page).getByRole('heading', { name: 'OpenChamber fixture' })).toBeVisible();
	await expect(page.getByTestId('service-frame-kept')).toHaveCount(1);
	await page.getByTestId('service-title').click();
	await expect(sheet.getByTestId('service-option').filter({ hasText: 'Port 4096' })).toContainText(
		'loaded'
	);
	await sheet.getByTestId('service-option').filter({ hasText: 'Port 4096' }).click();
	// The first service kept its page: no second request and the typed draft is still there.
	await expect(frame(page).getByRole('textbox', { name: 'Message' })).toHaveValue('draft kept');
	expect(hits[OPENCODE]).toBe(1);
	await page.getByTestId('service-more').click();
	await page.getByTestId('service-reload').click();
	await expect.poll(() => hits[OPENCODE]).toBe(2);
	await expect(frame(page).getByRole('textbox', { name: 'Message' })).toHaveValue('');
	// Switches replace the history entry, so one Back leaves the viewer.
	await page.getByTestId('service-back').click();
	await expect(page).toHaveURL(/\/mobile\/containers\/eeeeeeeeeeee$/);
});

test('the service area ends at the keyboard', async ({ page }) => {
	await setup(page);
	await page.getByText('Port 4096', { exact: false }).click();
	await expect(frame(page).getByRole('heading', { name: 'OpenCode fixture' })).toBeVisible();
	// Chromium has no iOS keyboard; set what the viewport tracker publishes for one.
	await page.evaluate(() =>
		document.documentElement.style.setProperty('--visual-viewport-height', '520px')
	);
	const viewer = await page.getByTestId('service-viewer').boundingBox();
	expect(Math.round(viewer!.height)).toBe(520);
	const area = await page.getByTestId('service-area').boundingBox();
	expect(area!.y + area!.height).toBeLessThanOrEqual(521);
});

test('a service that cannot open here explains it, and Back finds the container screen', async ({
	page
}) => {
	await page.request.post('/login', {
		form: { password: 'playwright-test-password' },
		headers: { Origin: 'http://127.0.0.1:4173', 'x-sveltekit-action': 'true' }
	});
	// A gateway link on a server without the gateway: the contract is proxy-disabled.
	await page.goto('/mobile/services/view?cid=ffffffffffff&port=4096&label=OpenCode');
	await expect(page.getByTestId('service-fallback')).toContainText('OpenCode is not available');
	await expect(page.getByTestId('service-frame')).toHaveCount(0);
	await page.getByTestId('service-back').click();
	await expect(page).toHaveURL(/\/mobile\/containers$/);
});
