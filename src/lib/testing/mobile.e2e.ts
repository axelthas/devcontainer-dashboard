/**
 * Phone and tablet layout regressions for issue #35. Run against the compiled custom server.
 *
 * Chromium device emulation checks layout, hit areas and the terminal sheet. It is not
 * evidence of real iOS keyboard or installation behaviour: the on-screen keyboard is
 * simulated with a stubbed `window.visualViewport`.
 */
import { expect, test, type Page } from '@playwright/test';
import { loginTerminalTest } from './terminalFixtures';

const PHONE = { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true };
/** Hit areas may round to 43.5 px under device scale factors. */
const MIN_TARGET = 43.5;

declare global {
	interface Window {
		/** Test hook: simulate an on-screen keyboard of `inset` px; 0 closes it. */
		__setKeyboard?: (inset: number, offsetTop?: number) => void;
	}
}

/** Horizontal overflow of the document in CSS px; 0 means no sideways page scroll. */
async function documentOverflow(page: Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

/** Visible controls whose hit area is smaller than 44 x 44 px. Terminal internals are excluded. */
async function smallTargets(page: Page, min: number): Promise<string[]> {
	return page.evaluate((limit) => {
		const controls = document.querySelectorAll<HTMLElement>(
			'button, [role="button"], [role="tab"], select, summary'
		);
		return [...controls]
			.filter((element) => !element.closest('.xterm') && element.checkVisibility())
			.map((element) => ({ element, box: element.getBoundingClientRect() }))
			.filter(({ box }) => box.width > 0 && (box.width < limit || box.height < limit))
			.map(
				({ element, box }) =>
					`${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 30)} ` +
					`${Math.round(box.width)}x${Math.round(box.height)}`
			);
	}, min);
}

/** Replace `window.visualViewport` with a controllable stub before the app starts. */
async function stubVisualViewport(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const fake = new EventTarget();
		let height: number | null = null;
		let offsetTop = 0;
		Object.defineProperties(fake, {
			height: { get: () => height ?? window.innerHeight },
			width: { get: () => window.innerWidth },
			offsetTop: { get: () => offsetTop },
			offsetLeft: { value: 0 },
			scale: { value: 1 }
		});
		Object.defineProperty(window, 'visualViewport', { configurable: true, value: fake });
		window.__setKeyboard = (inset, top = 0) => {
			height = inset > 0 ? window.innerHeight - inset - top : null;
			offsetTop = top;
			fake.dispatchEvent(new Event('resize'));
		};
	});
}

/** Open a new shell from the drawer and wait until its key bar can send input. */
async function openPhoneShell(page: Page): Promise<string> {
	await page.getByRole('button', { name: 'New shell', exact: true }).click();
	const tab = page.locator('[data-terminal-tab]').last();
	const id = (await tab.getAttribute('data-terminal-tab'))!;
	await expect(page.getByRole('toolbar', { name: 'Terminal keys' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Control C, interrupt' })).toBeEnabled();
	return id;
}

/** Row count of a terminal once the sheet has finished its height transition. */
async function settledRows(page: Page, id: string): Promise<number> {
	const rows = page.locator(`[data-terminal-pane="${id}"] .xterm-rows > div`);
	let last = -1;
	await expect
		.poll(
			async () => {
				const previous = last;
				last = await rows.count();
				return last > 0 && last === previous;
			},
			{ intervals: [400] }
		)
		.toBe(true);
	return last;
}

/** Focus the shell by tapping its screen, then run a command that prints a marker. */
async function runMarker(page: Page, id: string, marker: string): Promise<void> {
	const pane = page.locator(`[data-terminal-pane="${id}"]`);
	await pane.locator('.xterm-screen').click({ position: { x: 25, y: 20 } });
	await page.keyboard.type(`printf '${marker}\\n'`);
	await page.keyboard.press('Enter');
	await expect(pane.locator('.xterm-rows')).toContainText(marker);
}

for (const width of [320, 390, 768, 1280]) {
	test.describe(`${width}px viewport`, () => {
		const touch = width < 1024;
		test.use({ viewport: { width, height: 844 }, isMobile: touch, hasTouch: touch });

		for (const view of ['grid', 'list']) {
			test(`${view} view has no horizontal page overflow`, async ({ page }) => {
				await page.addInitScript((saved) => {
					localStorage.setItem('devcontainer-dashboard-view', saved);
					localStorage.setItem('devcontainer-dashboard-show-stopped', 'true');
				}, view);
				await loginTerminalTest(page);
				await expect(page.getByRole('heading', { level: 1, name: 'DevHarbour' })).toBeVisible();
				expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
				const sections = page.getByRole('navigation', { name: 'Sections' });
				if (width < 768) await expect(sections).toBeVisible();
				else await expect(sections).toBeHidden();
			});
		}
	});
}

test.describe('phone', () => {
	test.use(PHONE);

	test('every visible control has a 44 px hit area', async ({ page }) => {
		await loginTerminalTest(page);
		await page.getByRole('button', { name: 'Host controls' }).click();
		expect(await smallTargets(page, MIN_TARGET)).toEqual([]);
	});

	test('host controls open below the header', async ({ page }) => {
		await loginTerminalTest(page);
		const ssh = page.getByPlaceholder('SSH host');
		await expect(ssh).toBeHidden();
		await page.getByRole('button', { name: 'Host controls' }).click();
		await expect(ssh).toBeVisible();
		await expect(page.getByTitle('Toggle theme')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
		expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
	});

	test('section bar jumps to each section', async ({ page }) => {
		await loginTerminalTest(page);
		const bar = page.getByRole('navigation', { name: 'Sections' });
		for (const [label, id] of [
			['Services', 'services'],
			['Workspaces', 'workspaces'],
			['Containers', 'devcontainers']
		]) {
			await bar.getByRole('link', { name: label }).click();
			await expect(bar.getByRole('link', { name: label })).toHaveAttribute(
				'aria-current',
				'location'
			);
			await expect
				.poll(() =>
					page.locator(`#${id}`).evaluate((node) => {
						const top = node.getBoundingClientRect().top;
						// A short final section cannot align to the top when the document ends.
						const atBottom =
							window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
						return top >= 0 && top < window.innerHeight && (top < 200 || atBottom);
					})
				)
				.toBe(true);
		}
	});

	test('terminal opens as a full-height sheet with a key bar', async ({ page }) => {
		await loginTerminalTest(page);
		await openPhoneShell(page);
		const drawer = page.locator('[data-terminal-drawer]');
		await expect
			.poll(async () => (await drawer.boundingBox())?.height ?? 0)
			.toBeGreaterThan(PHONE.viewport.height * 0.9);
		await expect(page.getByRole('button', { name: 'Maximize terminal' })).toHaveCount(0);
		expect(await smallTargets(page, MIN_TARGET)).toEqual([]);
	});

	test('key bar Ctrl+C interrupts the shell, and collapse keeps the session', async ({ page }) => {
		await loginTerminalTest(page);
		const id = await openPhoneShell(page);
		const pane = page.locator(`[data-terminal-pane="${id}"]`);
		await pane.locator('.xterm-screen').click({ position: { x: 25, y: 20 } });
		await page.keyboard.type('sleep 30');
		await page.keyboard.press('Enter');
		await page.getByRole('button', { name: 'Control C, interrupt' }).click();
		// A still-running sleep would hold the marker back for 30 s.
		await runMarker(page, id, 'mobile-interrupted-ok');

		await page.getByRole('button', { name: 'Toggle terminal drawer' }).click();
		await expect(page.getByRole('toolbar', { name: 'Terminal keys' })).toBeHidden();
		await page.getByRole('button', { name: 'Toggle terminal drawer' }).click();
		// Shells from earlier tests persist on the server, so check this tab, not the tab count.
		await expect(page.locator(`[data-terminal-tab="${id}"]`)).toHaveCount(1);
		await expect(pane.locator('.xterm-rows')).toContainText('mobile-interrupted-ok');
		await runMarker(page, id, 'mobile-same-session-ok');
	});

	test('terminal sheet stays above the on-screen keyboard', async ({ page }) => {
		await stubVisualViewport(page);
		await loginTerminalTest(page);
		const id = await openPhoneShell(page);
		const drawer = page.locator('[data-terminal-drawer]');
		const keys = page.getByRole('toolbar', { name: 'Terminal keys' });
		const fullRows = await settledRows(page, id);

		const inset = 340;
		const offsetTop = 24;
		await page.evaluate(([k, top]) => window.__setKeyboard?.(k, top), [inset, offsetTop]);
		await expect(drawer).toHaveAttribute('data-keyboard-open', 'true');
		const visibleBottom = PHONE.viewport.height - inset;
		await expect
			.poll(async () => {
				const box = await drawer.boundingBox();
				return box ? Math.round(box.y + box.height) : Infinity;
			})
			.toBeLessThanOrEqual(visibleBottom + 1);
		expect(Math.round((await drawer.boundingBox())!.y)).toBe(offsetTop);
		const keyBox = (await keys.boundingBox())!;
		expect(keyBox.y + keyBox.height).toBeLessThanOrEqual(visibleBottom + 1);
		// The terminal refits to the smaller sheet instead of keeping hidden rows.
		expect(await settledRows(page, id)).toBeLessThan(fullRows);

		await page.evaluate(() => window.__setKeyboard?.(0));
		await expect(drawer).not.toHaveAttribute('data-keyboard-open', 'true');
		expect(await settledRows(page, id)).toBe(fullRows);
		await runMarker(page, id, 'mobile-after-keyboard-ok');
	});
});

test.describe('desktop', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('keeps the resizable drawer without a key bar', async ({ page }) => {
		await loginTerminalTest(page);
		await page.getByRole('button', { name: 'New shell', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Maximize terminal' })).toBeVisible();
		await expect(page.getByRole('toolbar', { name: 'Terminal keys' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Host controls' })).toBeHidden();
		await expect(page.getByPlaceholder('SSH host')).toBeVisible();
	});
});
