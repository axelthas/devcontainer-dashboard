/**
 * Grant extension browser regressions. A deterministic Brain API fixture supplies a grant
 * that ends in four minutes and a pending time request; the fixture records the operator's
 * extend and dismiss calls instead of changing a real grant.
 */
import { expect, test, type Page } from '@playwright/test';

interface Fixture {
	extended: number[];
	dismissed: number;
}

/** Authenticate before the page's first load. */
async function login(page: Page) {
	const response = await page.request.post('/login', {
		form: { password: 'playwright-test-password' },
		headers: { Origin: 'http://127.0.0.1:4173', 'x-sveltekit-action': 'true' }
	});
	expect(response.ok()).toBe(true);
}

/** Serve one ending grant with a pending request, and apply extend and dismiss calls. */
async function mockBrain(page: Page): Promise<Fixture> {
	const fixture: Fixture = { extended: [], dismissed: 0 };
	const now = Date.now();
	const grant: Record<string, unknown> = {
		id: 'g_fixture',
		containerId: 'aabbccddeeff',
		containerName: 'fixture_container',
		kind: 'devcontainer',
		startedAt: '2026-01-01T00:00:00.000Z',
		user: 'axel',
		userSource: 'container',
		exposure: [],
		createdAt: new Date(now - 11 * 60_000).toISOString(),
		expiresAt: new Date(now + 4 * 60_000).toISOString(),
		runningExecutions: 1,
		timeRequest: {
			minutes: 60,
			reason: 'The full browser suite needs about 35 more minutes.',
			at: new Date(now - 30_000).toISOString(),
			status: 'pending'
		}
	};
	const audit: Record<string, unknown>[] = [];
	const execution = {
		id: 'x_fixture',
		grantId: 'g_fixture',
		containerName: 'fixture_container',
		kind: 'command',
		command: 'npx playwright test --workers=1',
		goal: 'Run the full browser suite on one worker.',
		user: 'axel',
		interactive: false,
		controller: 'brain',
		status: 'running',
		startedAt: new Date(now - 6 * 60_000).toISOString()
	};
	await page.route('**/api/brain', (route) =>
		route.fulfill({
			json: { enabled: true, grants: [grant], executions: [execution], audit: [...audit] }
		})
	);
	await page.route('**/api/brain/executions/**', (route) =>
		route.fulfill({
			json: {
				executionId: 'x_fixture',
				text: 'fixture output',
				cursor: 0,
				nextCursor: 14,
				truncatedBefore: false,
				more: false,
				status: 'running'
			}
		})
	);
	await page.route('**/api/brain/grants/g_fixture/time-request', (route) => {
		fixture.dismissed++;
		delete grant.timeRequest;
		return route.fulfill({ json: { dismissed: 1 } });
	});
	await page.route('**/api/brain/grants/g_fixture', (route) => {
		const { minutes } = route.request().postDataJSON() as { minutes: number };
		fixture.extended.push(minutes);
		grant.expiresAt = new Date(
			Date.parse(String(grant.expiresAt)) + minutes * 60_000
		).toISOString();
		delete grant.timeRequest;
		audit.unshift({
			at: new Date().toISOString(),
			tool: 'extend',
			target: 'fixture_container',
			grantId: 'g_fixture',
			detail: `by ${minutes} minutes, ends ${grant.expiresAt}`,
			outcome: 'ok'
		});
		return route.fulfill({ json: grant });
	});
	return fixture;
}

test('desktop: an ending grant warns and extends from the menu', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page);
	const fixture = await mockBrain(page);
	await page.goto('/');
	const pane = page.getByRole('complementary', { name: 'Brain' });
	await expect(pane.getByTestId('brain-ending-count')).toHaveText('1 ending soon');
	await expect(pane.getByTestId('brain-ending')).toContainText(/Access ends in [34]:\d\d\./);
	await expect(pane.getByTestId('brain-ending')).toContainText('1 running command stops');
	const request = pane.getByTestId('brain-time-request');
	await expect(request).toContainText('Brain asks for 1 hour more');
	await expect(request).toContainText('The full browser suite needs about 35 more minutes.');

	await request.getByRole('button', { name: 'Other duration' }).click();
	const menu = pane.getByRole('menu', { name: 'Extend access to fixture_container' });
	await expect(menu.getByRole('menuitem')).toHaveCount(3);
	await expect(menu.getByRole('menuitem', { name: /\+1 hour/ })).toContainText(
		'Brain asked for this'
	);
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);

	await pane
		.getByRole('button', { name: /^Extend/ })
		.first()
		.click();
	await pane.getByRole('menuitem', { name: /\+15 min/ }).click();
	await expect.poll(() => fixture.extended).toEqual([15]);
	await expect(pane.getByTestId('brain-ending')).toHaveCount(0);
	await expect(pane.getByTestId('brain-time-request')).toHaveCount(0);
	await expect(pane.locator('[data-brain-event="extend"]')).toContainText(
		'You extended access by 15 minutes'
	);
});

test('desktop: dismissing a time request changes no grant', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page);
	const fixture = await mockBrain(page);
	await page.goto('/');
	const request = page.getByTestId('brain-time-request');
	await request.getByRole('button', { name: 'Dismiss' }).click();
	await expect.poll(() => fixture.dismissed).toBe(1);
	await expect(request).toHaveCount(0);
	expect(fixture.extended).toEqual([]);
});

test('mobile: the strip warns and opens the Extend access sheet', async ({ page }) => {
	await page.setViewportSize({ width: 393, height: 852 });
	await login(page);
	const fixture = await mockBrain(page);
	await page.goto('/mobile/containers');
	const strip = page.getByTestId('brain-strip-ending');
	await expect(strip).toContainText(/Ends in [34]:\d\d · fixture_container/);
	await strip.click();
	await expect(page).toHaveURL(/\/mobile\/brain\?extend=g_fixture/);
	const sheet = page.getByTestId('brain-extend-sheet');
	await expect(sheet).toBeVisible();
	const choices = sheet.getByTestId('brain-extend-choice');
	await expect(choices).toHaveCount(3);
	await expect(choices.nth(1)).toContainText('Brain asked for this');
	await expect(sheet.getByTestId('brain-extend-confirm')).toHaveText('Extend by 1 hour');
	await choices.nth(0).click();
	await sheet.getByTestId('brain-extend-confirm').click();
	await expect.poll(() => fixture.extended).toEqual([15]);
	await expect(sheet).toBeHidden();
	await expect(page.getByTestId('brain-ending')).toHaveCount(0);
	await expect(page.getByTestId('brain-event').first()).toContainText(
		'You extended access by 15 minutes'
	);
	// Later status polls must not reopen the sheet from the link.
	await page.waitForTimeout(5500);
	await expect(sheet).toBeHidden();
});
