/**
 * The dedicated mobile interface (#35) against the compiled custom server and the real
 * Docker host of the test run. Screens that need data the host lacks are skipped.
 *
 * Chromium phone emulation checks routing, layout, hit areas, terminal input and text
 * size. It is not evidence of iOS Safari keyboard or gesture behaviour.
 */
import { expect, test, type Page } from '@playwright/test';
import type { LocalWorkspaceData } from '$lib/types';

const IPHONE_UA =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PHONE = {
	viewport: { width: 393, height: 852 },
	isMobile: true,
	hasTouch: true,
	userAgent: IPHONE_UA
};
/** Hit areas may round to 43.5 px under device scale factors. */
const MIN_TARGET = 43.5;

test.use(PHONE);

/** Sign in through the form action, before any page hydrates. */
async function login(page: Page): Promise<void> {
	const response = await page.request.post('/login', {
		form: { password: 'playwright-test-password' },
		headers: { Origin: 'http://127.0.0.1:4173', 'x-sveltekit-action': 'true' }
	});
	expect(response.ok()).toBe(true);
}

/** Horizontal overflow of the document in CSS px; 0 means no sideways page scroll. */
async function documentOverflow(page: Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

/** Visible controls with a hit area below 44 x 44 px. Terminal internals are excluded. */
async function smallTargets(page: Page): Promise<string[]> {
	return page.evaluate((limit) => {
		const controls = document.querySelectorAll<HTMLElement>(
			'[data-testid="mobile-app"] :is(button, a[href], [role="radio"], [role="checkbox"])'
		);
		return [...controls]
			.filter((element) => !element.closest('.xterm, [data-terminal-engine]'))
			.filter((element) => element.checkVisibility())
			.map((element) => ({ element, box: element.getBoundingClientRect() }))
			.filter(({ box }) => box.width > 0 && (box.width < limit || box.height < limit))
			.map(
				({ element, box }) =>
					`${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 30)} ` +
					`${Math.round(box.width)}x${Math.round(box.height)}`
			);
	}, MIN_TARGET);
}

/**
 * Elements whose content is cut off by an ancestor that clips: the failure that the
 * responsive layout had. Text that wraps or truncates on purpose is not clipped here.
 */
async function clippedControls(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const found: string[] = [];
		for (const element of document.querySelectorAll<HTMLElement>(
			'[data-testid="mobile-app"] :is(button, a[href])'
		)) {
			if (!element.checkVisibility() || element.closest('[role="toolbar"], .xterm')) continue;
			const box = element.getBoundingClientRect();
			if (box.right > window.innerWidth + 0.5 || box.left < -0.5)
				found.push(`${element.textContent?.trim().slice(0, 30)} outside the screen`);
		}
		return found;
	});
}

/** Every screen: no sideways scroll, no clipped controls, no small targets. */
async function expectPhoneFit(page: Page): Promise<void> {
	expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
	expect(await clippedControls(page)).toEqual([]);
	expect(await smallTargets(page)).toEqual([]);
}

/** Workspaces from the API, to choose screens that the host can show. */
async function workspaces(page: Page): Promise<LocalWorkspaceData[]> {
	const response = await page.request.get('/api/workspaces');
	expect(response.ok()).toBe(true);
	return response.json();
}

/** The URL key of a workspace, as the mobile routes write it. */
function workspaceKey(workspace: LocalWorkspaceData): string {
	return workspace.id.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test.describe('interface choice', () => {
	test('a phone opens the mobile interface', async ({ page }) => {
		await login(page);
		await page.goto('/');
		await expect(page).toHaveURL(/\/mobile\/containers$/);
		await expect(page.getByRole('heading', { name: 'Containers', level: 1 })).toBeVisible();
		await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
	});

	test('the desktop choice is kept and can be undone', async ({ page }) => {
		await login(page);
		await page.goto('/mobile/containers');
		await page.getByTestId('host-button').click();
		await page.getByTestId('use-desktop').click();
		await expect(page).toHaveURL(/127\.0\.0\.1:4173\/$/);
		await page.goto('/');
		await expect(page).toHaveURL(/127\.0\.0\.1:4173\/$/);
		// The desktop layout is wider than the phone, so the phone zooms out. Chromium
		// emulation misplaces clicks in a zoomed-out page; follow the link target instead.
		const phoneLayout = page.getByRole('link', { name: 'Phone layout' });
		await expect(phoneLayout).toHaveAttribute('href', '/interface?use=mobile');
		await page.goto((await phoneLayout.getAttribute('href')) ?? '');
		await expect(page).toHaveURL(/\/mobile\/containers$/);
		await page.goto('/');
		await expect(page).toHaveURL(/\/mobile\/containers$/);
	});

	test('the switch accepts only the two interfaces', async ({ page }) => {
		await login(page);
		const response = await page.request.get('/interface?use=tablet', { maxRedirects: 0 });
		expect(response.status()).toBe(400);
	});
});

test.describe('screens fit a phone', () => {
	test.beforeEach(async ({ page }) => login(page));

	for (const tab of ['containers', 'workspaces', 'services', 'terminals'] as const) {
		test(`${tab} tab`, async ({ page }) => {
			await page.goto(`/mobile/${tab}`);
			await expect(
				page.locator(`nav[aria-label="Sections"] a[aria-current="page"]`)
			).toHaveAttribute('href', `/mobile/${tab}`);
			await expectPhoneFit(page);
		});
	}

	test('container detail and visible controls', async ({ page }) => {
		await page.goto('/mobile/containers');
		await page.getByRole('radio', { name: 'All' }).click();
		const row = page.getByTestId('container-row').first();
		test.skip(!(await row.count()), 'The host has no devcontainers.');
		await row.click();
		await expect(page).toHaveURL(/\/mobile\/containers\/[0-9a-f]{12}$/);
		await expectPhoneFit(page);
		await expect(page.getByTestId('container-delete')).toBeVisible();
		await expect(page.getByTestId('container-context')).toBeVisible();
		await page.getByTestId('container-delete').click();
		await expect(page.getByTestId('confirm-action')).toHaveText('Delete container');
		await expectPhoneFit(page);
	});

	test('service container detail follows the container detail', async ({ page }) => {
		await page.goto('/mobile/services');
		const stack = page.getByTestId('stack-row').first();
		test.skip(!(await stack.count()), 'The host has no Compose stacks.');
		await stack.click();
		await page.getByTestId('stack-service').first().click();
		await expect(page).toHaveURL(/\/mobile\/services\/container\/[0-9a-f]{12}$/);
		// Origin leads, as the workspace does on the devcontainer screen.
		await expect(page.getByTestId('service-context')).toBeVisible();
		await expect(page.getByTestId('service-stack')).toBeVisible();
		await expect(page.getByTestId('service-sandbox')).toBeVisible();
		// Controls are on the screen, not behind a menu.
		await expect(page.getByRole('region', { name: 'Container controls' })).toBeVisible();
		await expect(page.getByTestId('service-delete')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Service actions' })).toHaveCount(0);
		await expect(page.getByTestId('service-logs')).toBeEnabled();
		// The server refuses network changes for plain containers, so none are offered.
		await expect(page.getByRole('region', { name: 'Networks' })).toBeVisible();
		await expect(page.getByTestId('network-connect')).toHaveCount(0);
		await expect(page.getByTestId('service-details')).toHaveJSProperty('open', false);
		await expectPhoneFit(page);
		await page.getByTestId('service-delete').click();
		await expect(page.getByTestId('confirm-action')).toHaveText('Delete container');
		await expectPhoneFit(page);
	});

	test('workspace and repository drill-down', async ({ page }) => {
		const workspace = (await workspaces(page)).find((candidate) => candidate.repos.length);
		test.skip(!workspace, 'The host has no workspace with repositories.');
		await page.goto('/mobile/workspaces');
		await page.locator(`a[href="/mobile/workspaces/${workspaceKey(workspace!)}"]`).click();
		await expect(page.getByTestId('repo-row').first()).toBeVisible();
		await expectPhoneFit(page);
		await page.getByTestId('repo-row').first().click();
		await expect(page.getByTestId('repo-ref')).toBeVisible();
		await expectPhoneFit(page);
		await page.getByTestId('repo-ref').click();
		await expect(page.getByTestId('ref-sheet')).toBeVisible();
		await expect(page.getByTestId('ref-sheet').getByText('Reading branches and tags')).toBeHidden({
			timeout: 15_000
		});
		await expectPhoneFit(page);
	});

	test('compose sandbox: version, actions and services', async ({ page }) => {
		const match = (await workspaces(page))
			.flatMap((workspace) => workspace.repos.map((repo) => ({ workspace, repo })))
			.find(({ repo }) => repo.composeFiles?.length);
		test.skip(!match, 'The host has no repository with Compose files.');
		const base = `/mobile/workspaces/${workspaceKey(match!.workspace)}/${encodeURIComponent(match!.repo.name)}/sandbox`;
		await page.goto(base);
		await expect(page.getByTestId('sandbox-version')).toBeVisible();
		// Either the check result or its failure replaces the checking chip.
		await expect(page.getByText('checking')).toBeHidden({ timeout: 30_000 });
		await expect(page.getByTestId('sandbox-pull-start')).toBeVisible();
		await expect(page.getByTestId('sandbox-start')).toBeVisible();
		await expect(page.getByTestId('sandbox-build-start')).toBeVisible();
		await expectPhoneFit(page);

		// Start never pulls: with images missing it is disabled and says why.
		if (await page.getByTestId('sandbox-missing').count()) {
			await expect(page.getByTestId('sandbox-start')).toBeDisabled();
			await expect(page.getByTestId('sandbox-blocker')).toContainText('Start never pulls');
		}

		await page.getByTestId('sandbox-version').click();
		await expect(page.getByTestId('version-sheet')).toBeVisible();
		await expectPhoneFit(page);
		await page.getByTestId('version-sheet').getByRole('button', { name: 'Done' }).click();

		await page.getByTestId('sandbox-actions').click();
		const actions = page.getByTestId('sandbox-actions-sheet');
		await expect(actions.getByRole('button', { name: /Pull only/ })).toBeVisible();
		await expect(actions.getByRole('button', { name: /Build only/ })).toBeVisible();
		await actions.getByRole('button', { name: 'Done' }).click();

		await page.getByTestId('sandbox-services').click();
		await expect(page).toHaveURL(
			new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/services$`)
		);
		const service = page.getByTestId('sandbox-service').first();
		if (await service.count()) {
			await expectPhoneFit(page);
			// A toggle changes the selection and a second toggle restores it.
			const before = await service.getAttribute('aria-checked');
			if ((await service.getAttribute('aria-disabled')) !== 'true') {
				await service.click();
				await expect(service).not.toHaveAttribute('aria-checked', before ?? '');
				await service.click();
				await expect(service).toHaveAttribute('aria-checked', before ?? '');
			}
		}
	});
});

/** A real touch drag through the Chromium input pipeline, so touch handlers run. */
async function touchDrag(page: Page, x: number, y: number, distance: number): Promise<void> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Input.synthesizeScrollGesture', {
		x,
		y,
		yDistance: distance,
		gestureSourceType: 'touch',
		speed: 1200
	});
	await cdp.detach();
}

/** Make the current screen taller than the phone and scroll it to `y`. */
async function scrollableAt(page: Page, y: number): Promise<void> {
	await page.evaluate((top) => {
		const spacer = document.createElement('div');
		spacer.style.height = '2400px';
		spacer.dataset.testSpacer = '';
		// Outside the app root, so a render or hydration cannot remove it.
		document.body.append(spacer);
		window.scrollTo(0, top);
	}, y);
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(y);
}

/**
 * Where keyboard focus is: `sheet` inside the element with `testid`, `browser` when no
 * page element has it (Tab past the last control of a modal dialog goes to the browser
 * toolbar), or the outside element that has it.
 */
async function focusPlace(page: Page, testid: string): Promise<string> {
	return page.evaluate((id) => {
		const active = document.activeElement;
		if (!active || active === document.body) return 'browser';
		if (document.querySelector(`[data-testid="${id}"]`)?.contains(active)) return 'sheet';
		return `outside: ${active.outerHTML.slice(0, 80)}`;
	}, testid);
}

test.describe('sheets isolate the page behind them', () => {
	test.beforeEach(async ({ page }) => login(page));

	test('the host sheet keeps scrolling and focus away from the page', async ({ page }) => {
		await page.goto('/mobile/containers');
		await page.waitForLoadState('networkidle');
		await scrollableAt(page, 300);
		await page.getByTestId('host-button').focus();
		await page.getByTestId('host-button').press('Enter');
		const sheet = page.getByTestId('host-sheet');
		await expect(sheet).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('data-sheet-open', '');

		// Focus starts on the title, not on the SSH host field: no keyboard pops up.
		await expect(sheet.locator('[data-sheet-title]')).toBeFocused();

		// Drags on the backdrop and on the sheet header do not move the page.
		await touchDrag(page, 196, 50, -400);
		await touchDrag(page, 196, 50, 400);
		const box = await sheet.boundingBox();
		await touchDrag(page, 196, (box?.y ?? 0) + 20, 300);
		await page.mouse.move(196, 50);
		await page.mouse.wheel(0, 600);
		await page.waitForTimeout(150);
		expect(await page.evaluate(() => window.scrollY)).toBe(300);

		// Tab never reaches the page behind the sheet, and it comes back to the sheet.
		const places: string[] = [];
		for (let step = 0; step < 14; step++) {
			await page.keyboard.press('Tab');
			places.push(await focusPlace(page, 'host-sheet'));
		}
		expect(places.filter((place) => place.startsWith('outside'))).toEqual([]);
		expect(places.filter((place) => place === 'sheet').length).toBeGreaterThan(places.length / 2);

		// Closing restores the page: same position, focus back on the opener.
		await sheet.getByRole('button', { name: 'Done' }).click();
		await expect(sheet).toBeHidden();
		await expect(page.locator('html')).not.toHaveAttribute('data-sheet-open');
		expect(await page.evaluate(() => window.scrollY)).toBe(300);
		await expect(page.getByTestId('host-button')).toBeFocused();

		// Escape closes it the same way.
		await page.getByTestId('host-button').press('Enter');
		await expect(sheet).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();
		await expect(page.locator('html')).not.toHaveAttribute('data-sheet-open');
	});

	test('+ on Workspaces opens the New workspace sheet', async ({ page }) => {
		await page.goto('/mobile/workspaces');
		await page.getByTestId('new-workspace').click();
		const sheet = page.getByTestId('new-workspace-sheet');
		await expect(sheet).toBeVisible();
		await expect(page).toHaveURL(/\/mobile\/workspaces$/);
		await expect(sheet.getByRole('heading', { name: 'New workspace' })).toBeVisible();
		await expect(sheet.getByText('Reading presets')).toBeHidden({ timeout: 15_000 });
		await expectPhoneFit(page);

		// A preset opens its form in the same sheet; Back returns to the list.
		const preset = sheet.getByTestId('bootstrap-preset').first();
		if (await preset.count()) {
			const name = (await preset.locator('span').first().textContent())?.trim() ?? '';
			await preset.click();
			await expect(sheet.getByTestId('preset-run')).toBeVisible();
			if (name) await expect(sheet.locator('[data-sheet-title]')).toContainText(name);
			await expectPhoneFit(page);
			await sheet.getByTestId('sheet-back').click();
			await expect(sheet.getByTestId('bootstrap-preset').first()).toBeVisible();
		}

		// Dev Bootstrap management is one step away and closes the sheet.
		await sheet.getByTestId('manage-bootstrap').click();
		await expect(page).toHaveURL(/\/mobile\/workspaces\/bootstrap$/);
		await expect(sheet).toBeHidden();
		await expect(page.locator('html')).not.toHaveAttribute('data-sheet-open');
	});
});

declare global {
	interface Window {
		/** Test hook: simulate an on-screen keyboard of `inset` px; 0 closes it. */
		__setKeyboard?: (inset: number) => void;
	}
}

/** Replace `window.visualViewport` with a controllable stub before the app starts. */
async function stubVisualViewport(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const fake = new EventTarget();
		let height: number | null = null;
		Object.defineProperties(fake, {
			height: { get: () => height ?? window.innerHeight },
			width: { get: () => window.innerWidth },
			offsetTop: { value: 0 },
			offsetLeft: { value: 0 },
			scale: { value: 1 }
		});
		Object.defineProperty(window, 'visualViewport', { configurable: true, value: fake });
		window.__setKeyboard = (inset: number) => {
			height = inset > 0 ? window.innerHeight - inset : null;
			fake.dispatchEvent(new Event('resize'));
		};
	});
}

/** Start a host shell from the New shell sheet and wait until it is connected. */
async function openHostShell(page: Page): Promise<string> {
	await page.goto('/mobile/terminals');
	await page.getByRole('button', { name: 'New shell' }).click();
	const sheet = page.getByTestId('new-shell-sheet');
	await sheet.getByRole('region', { name: 'On the host' }).getByRole('button').click();
	await expect(page).toHaveURL(/\/mobile\/terminals\/[^/]+$/);
	await expect(page.getByTestId('key-bar').getByRole('button', { name: 'Escape' })).toBeEnabled({
		timeout: 15_000
	});
	return page.url().split('/').pop() ?? '';
}

test.describe('terminal', () => {
	test.beforeEach(async ({ page }) => login(page));

	test('types, zooms, keeps the size, and ends only on request', async ({ page }) => {
		const id = await openHostShell(page);
		await expect(page.getByRole('navigation', { name: 'Sections' })).toBeHidden();
		await expectPhoneFit(page);

		// Typed keys and key-bar keys use the same input path.
		await page.getByTestId('keyboard-toggle').click();
		await page.keyboard.type("printf 'mobile-%s\\n' marker");
		await page.keyboard.press('Enter');
		const rows = page.locator('[data-testid="terminal-host"] .xterm-rows');
		await expect(rows).toContainText('mobile-marker');

		// A+ makes the text larger; the grid gets fewer columns and the PTY is resized.
		await page.getByTestId('text-size-toggle').click();
		const bar = page.getByTestId('text-size-bar');
		await expect(bar).toBeVisible();
		await expect(page.getByTestId('terminal-grid')).toHaveText(/\d+ × \d+/);
		const before = Number((await page.getByTestId('terminal-grid').textContent())?.split('×')[0]);
		const start = Number((await page.getByTestId('text-size-value').textContent())?.split(' ')[0]);
		for (let step = 0; step < 4; step++) await page.getByTestId('text-larger').click();
		await expect(page.getByTestId('text-size-value')).toHaveText(`${start + 4} pt`);
		await expect
			.poll(async () =>
				Number((await page.getByTestId('terminal-grid').textContent())?.split('×')[0])
			)
			.toBeLessThan(before);
		// The A+ buttons took the focus; give it back to the terminal before typing.
		await page.locator('[data-testid="terminal-host"] textarea').focus();
		await page.keyboard.type('stty size');
		await page.keyboard.press('Enter');
		const cols = Number((await page.getByTestId('terminal-grid').textContent())?.split('×')[0]);
		// `stty size` prints rows and columns; xterm rows have no line breaks in the text.
		await expect(rows).toContainText(new RegExp(`stty size\\d+ ${cols}(?!\\d)`));

		// The size belongs to this phone: a reload keeps it.
		await page.reload();
		await page.getByTestId('text-size-toggle').click();
		await expect(page.getByTestId('text-size-value')).toHaveText(`${start + 4} pt`);
		await page.getByRole('button', { name: 'Reset' }).click();
		await expect(page.getByTestId('text-size-value')).toHaveText('14 pt');

		// Leaving keeps the session; End session stops it.
		await page.getByTestId('mobile-back').click();
		await expect(page.locator(`a[href="/mobile/terminals/${id}"]`)).toBeVisible();
		await page.locator(`a[href="/mobile/terminals/${id}"]`).click();
		await page.getByTestId('session-actions').click();
		await page.getByTestId('end-session').click();
		await page.getByTestId('confirm-action').click();
		await expect(page).toHaveURL(/\/mobile\/terminals$/);
		const sessions = await (await page.request.get('/api/terminal/sessions')).json();
		expect(sessions.some((session: { id: string }) => session.id === id)).toBe(false);
	});

	test('the key bar stays above the on-screen keyboard', async ({ page }) => {
		await stubVisualViewport(page);
		const id = await openHostShell(page);
		await page.evaluate(() => window.__setKeyboard?.(330));
		await expect
			.poll(async () => (await page.getByTestId('key-bar').boundingBox())?.y ?? 0)
			.toBeLessThan(852 - 330);
		const bar = await page.getByTestId('key-bar').boundingBox();
		expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBeLessThanOrEqual(852 - 330 + 1);
		await page.evaluate(() => window.__setKeyboard?.(0));
		await page.request.delete('/api/terminal/sessions', { data: { id } });
	});
});
