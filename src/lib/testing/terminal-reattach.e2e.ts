/** Restored shells must attach without manual retry or invalid hidden-pane resizes. */
import { expect, test, type Page } from '@playwright/test';
import { validTerminalDimensions } from '../terminalSizing';
import { loginTerminalTest, selectTerminal } from './terminalFixtures';

const invalidDimensions = [
	undefined,
	null,
	{},
	{ cols: NaN, rows: 24 },
	{ cols: 80, rows: NaN },
	{ cols: Infinity, rows: 24 },
	{ cols: 80, rows: -Infinity },
	{ cols: 0, rows: 24 },
	{ cols: 80, rows: 0 },
	{ cols: -1, rows: 24 },
	{ cols: 80.5, rows: 24 },
	{ cols: 80, rows: 24.5 },
	{ cols: 1001, rows: 24 },
	{ cols: 80, rows: 1001 },
	{ cols: '80', rows: 24 },
	{ cols: 80, rows: null }
];

test('terminal dimensions reject unmeasured and out-of-contract geometry', () => {
	for (const value of invalidDimensions) expect(validTerminalDimensions(value)).toBe(false);
	expect(validTerminalDimensions({ cols: 1, rows: 1 })).toBe(true);
	expect(validTerminalDimensions({ cols: 80, rows: 24 })).toBe(true);
	expect(validTerminalDimensions({ cols: 1000, rows: 1000 })).toBe(true);
});

interface AttachmentWatch {
	ready: Set<string>;
	exits: string[];
	rejections: string[];
	invalidResizes: unknown[];
	resizes: string[];
}

/** Observe real socket frames before navigation, including viewers hidden in the drawer. */
function watchAttachments(page: Page): AttachmentWatch {
	const result: AttachmentWatch = {
		ready: new Set(),
		exits: [],
		rejections: [],
		invalidResizes: [],
		resizes: []
	};
	page.on('websocket', (socket) => {
		const url = new URL(socket.url());
		if (url.pathname !== '/api/terminal') return;
		const id = url.searchParams.get('sessionId')!;
		socket.on('framereceived', ({ payload }) => {
			const message = JSON.parse(payload.toString());
			if (message.type === 'ready') result.ready.add(id);
			if (message.type === 'exit') result.exits.push(id);
			if (message.type === 'missing') result.rejections.push(id);
		});
		socket.on('framesent', ({ payload }) => {
			const message = JSON.parse(payload.toString());
			if (message.type !== 'resize') return;
			result.resizes.push(id);
			if (!validTerminalDimensions(message)) result.invalidResizes.push(message);
		});
		socket.on('close', () => {
			// A hidden attach that immediately closes is not a successful automatic restoration.
			result.rejections.push(id);
		});
	});
	return result;
}

/** Start only a test-owned shell and always stop it through the real authenticated API. */
async function createShell(page: Page, id: string) {
	const response = await page.request.post('/api/terminal/sessions', {
		headers: { Origin: new URL(page.url()).origin },
		data: { id, name: `Reattach ${id}`, kind: 'shell', cwd: '/tmp' }
	});
	expect(response.ok()).toBe(true);
}

/** Remove only identities created by this test, even after a test assertion fails. */
async function stopShells(page: Page, ids: string[]) {
	for (const id of ids) {
		const response = await page.request.delete('/api/terminal/sessions', {
			headers: { Origin: new URL(page.url()).origin },
			data: { id }
		});
		expect(response.ok()).toBe(true);
	}
}

/** Require an output-only marker and the same shell PID; echoed input cannot satisfy this. */
async function assertUsableShell(page: Page, id: string, expectedPid?: string) {
	await selectTerminal(page, id);
	const pane = page.locator(`[data-terminal-pane="${id}"]`);
	await expect(pane.getByRole('button', { name: 'Retry connection' })).toHaveCount(0);
	const token = crypto.randomUUID().replaceAll('-', '');
	await pane.locator('.xterm-screen').click({ position: { x: 25, y: 20 } });
	await page.keyboard.type(`printf '%s:%s:%s\\n' '${token}' "$$" 'attached'`);
	await page.keyboard.press('Enter');
	const pattern = new RegExp(`${token}:(\\d+):attached`);
	await expect
		.poll(async () => (await pane.locator('.xterm-rows').innerText()).match(pattern)?.[1])
		.toMatch(/^\d+$/);
	const pid = (await pane.locator('.xterm-rows').innerText()).match(pattern)![1];
	if (expectedPid) expect(pid).toBe(expectedPid);
	return pid;
}

/** Let session reconciliation create viewers, then require each to attach while still hidden. */
async function assertHiddenAttachments(page: Page, watch: AttachmentWatch, ids: string[]) {
	for (const id of ids) await expect.poll(() => watch.ready.has(id)).toBe(true);
	await expect(page.getByRole('button', { name: 'Toggle terminal drawer' })).toHaveAttribute(
		'aria-expanded',
		'false'
	);
	// Exercise stable attachment beyond the ready message and pending render/resize callbacks.
	await page.waitForTimeout(500);
	expect(watch.invalidResizes).toEqual([]);
	expect(watch.resizes.filter((id) => ids.includes(id))).toEqual([]);
	expect(watch.rejections.filter((id) => ids.includes(id))).toEqual([]);
}

test('reload reattaches hidden sessions without retry and preserves shell PIDs', async ({
	page
}) => {
	await loginTerminalTest(page);
	const ids = [`reload-a-${crypto.randomUUID()}`, `reload-b-${crypto.randomUUID()}`];
	try {
		for (const id of ids) await createShell(page, id);
		await page.reload();
		const pids = [];
		for (const id of ids) pids.push(await assertUsableShell(page, id));

		const watch = watchAttachments(page);
		await page.reload();
		await assertHiddenAttachments(page, watch, ids);
		for (const [index, id] of ids.entries()) await assertUsableShell(page, id, pids[index]);
		expect(watch.invalidResizes).toEqual([]);
		expect(watch.exits.filter((id) => ids.includes(id))).toEqual([]);
	} finally {
		await stopShells(page, ids);
	}
});

test('a second browser tab attaches automatically without interrupting the first', async ({
	page,
	context
}) => {
	await loginTerminalTest(page);
	const ids = [`second-tab-${crypto.randomUUID()}`];
	const second = await context.newPage();
	try {
		await createShell(page, ids[0]);
		await page.reload();
		const pid = await assertUsableShell(page, ids[0]);
		const watch = watchAttachments(second);
		await second.goto('/');
		await assertHiddenAttachments(second, watch, ids);
		await assertUsableShell(second, ids[0], pid);
		await assertUsableShell(page, ids[0], pid);
		expect(watch.invalidResizes).toEqual([]);
	} finally {
		await second.close();
		await stopShells(page, ids);
	}
});

test('closing and reopening the dashboard attaches to the same running shell', async ({
	page,
	context
}) => {
	await loginTerminalTest(page);
	const ids = [`reopen-${crypto.randomUUID()}`];
	const reopened = await context.newPage();
	try {
		await createShell(page, ids[0]);
		await page.reload();
		const pid = await assertUsableShell(page, ids[0]);
		await page.close();
		const watch = watchAttachments(reopened);
		await reopened.goto('/');
		await assertHiddenAttachments(reopened, watch, ids);
		await assertUsableShell(reopened, ids[0], pid);
		expect(watch.invalidResizes).toEqual([]);
	} finally {
		await stopShells(page, ids);
		await reopened.close();
	}
});
