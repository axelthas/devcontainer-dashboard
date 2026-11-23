/**
 * Brain split-view browser regressions. The compiled custom server handles login and the
 * dashboard; a deterministic Brain API fixture supplies commands without touching grants
 * or processes on the operator's running dashboard.
 */
import { expect, test, type Page } from '@playwright/test';

const grant = {
	id: 'g_fixture',
	containerId: 'aabbccddeeff',
	containerName: 'fixture_container',
	kind: 'devcontainer',
	startedAt: '2026-01-01T00:00:00.000Z',
	user: 'axel',
	userSource: 'container',
	exposure: [],
	createdAt: '2026-11-23T00:00:00.000Z',
	expiresAt: '2099-11-23T00:00:00.000Z',
	runningExecutions: 1,
	intent: 'Improve the Brain split view'
};
const running = {
	id: 'x_fixture',
	grantId: grant.id,
	containerName: grant.containerName,
	kind: 'command',
	command: 'sleep 60',
	goal: 'Wait for the fixture command.',
	user: 'axel',
	interactive: false,
	controller: 'brain',
	status: 'running',
	startedAt: '2026-11-23T14:00:00.000Z'
};
const finished = {
	...running,
	id: 'x_done',
	// One long unbroken token: it must wrap inside the pane, not widen the cards.
	command: `printf '${'x'.repeat(240)}' && echo done`,
	goal: 'Show the completed result.',
	status: 'exited',
	exitCode: 0,
	startedAt: '2026-11-23T13:59:00.000Z'
};

/** A call that started no command; its long detail must truncate inside the card. */
const refused = {
	at: '2026-11-23T13:58:00.000Z',
	tool: 'execute',
	target: grant.containerName,
	detail: `printf '${'z'.repeat(300)}'`,
	outcome: 'error'
};

/** Authenticate before the page's first load. */
async function login(page: Page) {
	const response = await page.request.post('/login', {
		form: { password: 'playwright-test-password' },
		headers: { Origin: 'http://127.0.0.1:4173', 'x-sveltekit-action': 'true' }
	});
	expect(response.ok()).toBe(true);
}

/** Every Brain card, row and output box stays inside the pane's scroll area. */
async function expectPaneFits(page: Page) {
	const fit = await page.getByTestId('brain-pane-scroll').evaluate((scroll) => {
		const right = scroll.getBoundingClientRect().right + 0.5;
		const wide = [...scroll.querySelectorAll('section, li, pre')].filter(
			(node) => node.getBoundingClientRect().right > right
		).length;
		return { wide, horizontal: scroll.scrollWidth - scroll.clientWidth };
	});
	expect(fit).toEqual({ wide: 0, horizontal: 0 });
}

/** The page has no horizontal scroll at the current viewport. */
async function expectNoPageOverflow(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(0);
}

/** Return fixture status and output without creating a real command or grant. */
async function mockBrain(page: Page) {
	await page.route('**/api/brain', async (route) => {
		await route.fulfill({
			json: { enabled: true, grants: [grant], executions: [running, finished], audit: [refused] }
		});
	});
	await page.route('**/api/brain/executions/**', async (route) => {
		const id = new URL(route.request().url()).pathname.split('/').at(-1);
		await route.fulfill({
			json: {
				executionId: id,
				text: id === 'x_done' ? 'y'.repeat(500) : 'fixture output',
				cursor: 0,
				nextCursor: 14,
				truncatedBefore: false,
				more: false,
				status: id === 'x_done' ? 'exited' : 'running',
				exitCode: id === 'x_done' ? 0 : undefined
			}
		});
	});
}

test('desktop: split remains interactive, resizes and opens terminals only on request', async ({
	page
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page);
	await mockBrain(page);
	await page.goto('/');
	const pane = page.getByRole('complementary', { name: 'Brain' });
	await expect(pane).toBeVisible();
	await expect(pane.getByTestId('brain-intent')).toHaveText(
		'Working on Improve the Brain split view'
	);
	await expect(pane.getByText('Wait for the fixture command.')).toBeVisible();
	await expect(pane.getByLabel('Command output').first()).toHaveText('fixture output');
	await pane.getByRole('button', { name: /Show the completed result\./ }).click();
	await expect(pane.getByLabel('Command output')).toHaveCount(2);
	await expectPaneFits(page);
	await pane.getByRole('button', { name: 'Brain uses ⅓ of the width' }).click();
	await expectPaneFits(page);
	await page.setViewportSize({ width: 900, height: 900 });
	await expectPaneFits(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await pane.getByRole('button', { name: 'Brain uses ½ of the width' }).click();
	await expect(page.getByLabel('Close Brain tab for fixture_container')).toHaveCount(0);
	const separator = page.getByRole('separator', { name: 'Resize the Brain pane' });
	await expect(separator).toHaveAttribute('aria-valuenow', '50');
	await separator.focus();
	await page.keyboard.press('ArrowLeft');
	await expect(separator).toHaveAttribute('aria-valuenow', '55');
	await page.keyboard.press('Home');
	await expect(separator).toHaveAttribute('aria-valuenow', '50');
	await pane.getByLabel('Close the Brain pane').click();
	await expect(pane).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Active Devcontainers' })).toBeVisible();
	await page.getByRole('button', { name: /Brain · 1 grant/ }).click();
	await expect(pane).toBeVisible();
	await pane.getByRole('button', { name: 'Open terminal to take over' }).click();
	await expect(page.getByLabel('Close Brain tab for fixture_container')).toBeVisible();
});

test('mobile: the Brain strip opens the grouped command view', async ({ page }) => {
	await page.setViewportSize({ width: 393, height: 852 });
	await login(page);
	await mockBrain(page);
	await page.goto('/mobile/containers');
	const strip = page.getByTestId('brain-strip');
	await expect(strip).toContainText('Wait for the fixture command.');
	await strip.click();
	await expect(page).toHaveURL(/\/mobile\/brain$/);
	await expect(page.getByTestId('brain-intent')).toHaveText(
		'Working on Improve the Brain split view'
	);
	const step = page.getByTestId('brain-step').filter({ hasText: 'Wait for the fixture command.' });
	await expect(step).toContainText('running');
	await expect(page.getByRole('button', { name: 'Collapse fixture_container' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Brain' })).toHaveAttribute('aria-current', 'page');
	await expectNoPageOverflow(page);
	await step.click();
	await expect(page).toHaveURL(/\/mobile\/brain\/x_fixture$/);
	await expect(page.getByRole('heading', { name: 'Wait for the fixture command.' })).toBeVisible();
	await expect(page.getByLabel('Command output')).toHaveText('fixture output');
	await expect(page.getByTestId('brain-open-terminal')).toHaveText('Open terminal to take over');
	await expectNoPageOverflow(page);
	// The long command and its long output wrap on the narrowest supported phone.
	await page.setViewportSize({ width: 320, height: 640 });
	await page.goto('/mobile/brain/x_done');
	await expect(page.getByRole('heading', { name: 'Show the completed result.' })).toBeVisible();
	await expect(page.getByLabel('Command output')).toHaveText('y'.repeat(500));
	await expectNoPageOverflow(page);
	await page.goto('/mobile/brain');
	await expect(page.getByTestId('brain-step')).toHaveCount(2);
	await expectNoPageOverflow(page);
});
