/**
 * Engine switches replace only the browser viewer (#42). The shell process, its PID, and
 * its retained output must survive; no start request or input replay may occur.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginTerminalTest, selectTerminal } from './terminalFixtures';

interface SwitchWatch {
	/** Terminal start requests. A switch must only probe and attach. */
	starts: number;
	/** Input frames sent by the browser, per session. */
	inputs: string[];
	exits: string[];
}

/** Observe start requests and real socket frames of one test-owned session. */
function watchSwitches(page: Page, session: string): SwitchWatch {
	const watch: SwitchWatch = { starts: 0, inputs: [], exits: [] };
	page.on('request', (request) => {
		if (
			request.method() === 'POST' &&
			new URL(request.url()).pathname === '/api/terminal/sessions' &&
			request.postDataJSON()?.id === session
		)
			watch.starts++;
	});
	page.on('websocket', (socket) => {
		const url = new URL(socket.url());
		if (url.pathname !== '/api/terminal') return;
		const id = url.searchParams.get('sessionId')!;
		// Other test files run in parallel against the same server.
		if (id !== session) return;
		socket.on('framesent', ({ payload }) => {
			if (JSON.parse(payload.toString()).type === 'data') watch.inputs.push(id);
		});
		socket.on('framereceived', ({ payload }) => {
			if (JSON.parse(payload.toString()).type === 'exit') watch.exits.push(id);
		});
	});
	return watch;
}

/** Start only a test-owned shell through the real authenticated API. */
async function createShell(page: Page, id: string) {
	const response = await page.request.post('/api/terminal/sessions', {
		headers: { Origin: new URL(page.url()).origin },
		data: { id, name: `Engine ${id}`, kind: 'shell', cwd: '/tmp' }
	});
	expect(response.ok()).toBe(true);
}

/** Remove only the identity created by this test. */
async function stopShell(page: Page, id: string) {
	const response = await page.request.delete('/api/terminal/sessions', {
		headers: { Origin: new URL(page.url()).origin },
		data: { id }
	});
	expect(response.ok()).toBe(true);
}

/** The current viewer host of one tab, whatever the engine. */
function viewer(page: Page, id: string): Locator {
	return page.locator(`[data-terminal-pane="${id}"] [data-terminal-engine]`);
}

/** Pick an engine in the drawer switcher. */
async function switchEngine(page: Page, label: string) {
	await page.locator('[data-terminal-engine-switcher]').click();
	await page.getByRole('menuitemradio', { name: label, exact: true }).click();
}

/** Wait until the new viewer has reattached; input is gated until the socket is ready. */
async function attached(page: Page, id: string) {
	await expect(page.locator(`[data-terminal-pane="${id}"]`).getByRole('status')).toHaveCount(0);
}

/** Type an output-only marker into the focused viewer and return the shell PID. */
async function shellPid(page: Page, id: string): Promise<string> {
	const token = crypto.randomUUID().replaceAll('-', '');
	await page.keyboard.type(`printf '%s:%s:%s\\n' '${token}' "$$" 'pid'`);
	await page.keyboard.press('Enter');
	const pattern = new RegExp(`${token}:(\\d+):pid`);
	await expect
		.poll(async () => (await viewer(page, id).innerText()).match(pattern)?.[1])
		.toMatch(/^\d+$/);
	return (await viewer(page, id).innerText()).match(pattern)![1];
}

test('switching between DOM engines keeps the shell, its output, and focus', async ({ page }) => {
	await loginTerminalTest(page);
	const id = `engine-dom-${crypto.randomUUID()}`;
	try {
		await createShell(page, id);
		await page.reload();
		const watch = watchSwitches(page, id);
		await selectTerminal(page, id);
		await attached(page, id);
		await expect(viewer(page, id)).toHaveAttribute('data-terminal-engine', 'xterm');
		const pid = await shellPid(page, id);
		const before = (await viewer(page, id).innerText()).match(/\w{32}:\d+:pid/)![0];

		const inputs = watch.inputs.length;
		await switchEngine(page, 'wterm');
		await expect(viewer(page, id)).toHaveAttribute('data-terminal-engine', 'wterm');
		// The new viewer replays retained output without any browser input.
		await expect(viewer(page, id)).toContainText(before);
		expect(watch.inputs.length).toBe(inputs);
		await expect(page.locator('[data-terminal-engine-switcher]')).toContainText('wterm');
		// Focus moved to the new viewer, so typing reaches the same shell.
		expect(await shellPid(page, id)).toBe(pid);

		await switchEngine(page, 'xterm.js');
		await expect(viewer(page, id)).toHaveAttribute('data-terminal-engine', 'xterm');
		await attached(page, id);
		await expect(viewer(page, id)).toContainText(before);
		expect(await shellPid(page, id)).toBe(pid);
		expect(watch.starts).toBe(0);
		expect(watch.exits).toEqual([]);
	} finally {
		await stopShell(page, id);
	}
});

test('a new shell tab uses the last engine, and other tabs keep theirs', async ({ page }) => {
	await loginTerminalTest(page);
	const id = `engine-pref-${crypto.randomUUID()}`;
	let added: string | null = null;
	try {
		await createShell(page, id);
		await page.reload();
		await selectTerminal(page, id);
		await attached(page, id);
		await switchEngine(page, 'wterm');
		await expect(viewer(page, id)).toHaveAttribute('data-terminal-engine', 'wterm');
		await page.getByRole('button', { name: 'New shell' }).click();
		const tab = page.locator('[data-terminal-tab][aria-selected="true"]');
		added = await tab.getAttribute('data-terminal-tab');
		expect(added).not.toBe(id);
		await expect(viewer(page, added!)).toHaveAttribute('data-terminal-engine', 'wterm');
		await switchEngine(page, 'xterm.js');
		await expect(viewer(page, added!)).toHaveAttribute('data-terminal-engine', 'xterm');
		await expect(viewer(page, id)).toHaveAttribute('data-terminal-engine', 'wterm');
	} finally {
		await stopShell(page, id);
		if (added) await stopShell(page, added);
	}
});

for (const label of ['Wraith', 'Wraith native']) {
	test(`${label} starts or offers xterm.js without stopping the shell`, async ({ page }) => {
		await loginTerminalTest(page);
		const id = `engine-gpu-${crypto.randomUUID()}`;
		try {
			await createShell(page, id);
			await page.reload();
			const watch = watchSwitches(page, id);
			await selectTerminal(page, id);
			await attached(page, id);
			const pid = await shellPid(page, id);
			await switchEngine(page, label);
			const pane = page.locator(`[data-terminal-pane="${id}"]`);
			const fallback = pane.getByRole('button', { name: 'Use xterm.js' });
			const menu = page.locator('[data-terminal-engine-switcher]');
			// Headless Chromium often has no WebGPU. Either outcome is valid; a blank viewer is not.
			await expect
				.poll(async () =>
					(await fallback.count()) > 0 ? 'fallback' : await menu.getAttribute('title')
				)
				.toMatch(/^fallback$|·/);
			test.info().annotations.push({
				type: 'engine',
				description: `${label}: ${(await fallback.count()) > 0 ? await pane.getByRole('status').innerText() : await menu.getAttribute('title')}`
			});
			if ((await fallback.count()) > 0) await fallback.click();
			else await switchEngine(page, 'xterm.js');
			await expect(viewer(page, id)).toHaveAttribute('data-terminal-engine', 'xterm');
			await attached(page, id);
			await viewer(page, id).click();
			expect(await shellPid(page, id)).toBe(pid);
			expect(watch.starts).toBe(0);
			expect(watch.exits).toEqual([]);
		} finally {
			await stopShell(page, id);
		}
	});
}
