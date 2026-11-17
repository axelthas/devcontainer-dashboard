/** Browser regressions for the devcontainer row: Open with, Services, and container actions. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import DevcontainerRow from './DevcontainerRow.svelte';
import type { ContainerData } from '$lib/types';

const running: ContainerData = {
	id: 'bbbbbbbbbbbb',
	name: '/relaxed_fixture',
	projectName: 'fixture',
	state: 'running',
	isDevcontainer: true,
	image: 'fixture',
	ports: { '3000': '43000', '6904': '46904' },
	localWorkspacePath: '/workspaces/task/fixture',
	devcontainerConfigFile: '/workspaces/task/fixture/.devcontainer/devcontainer.json',
	containerWorkspaceFolder: '/workspaces/fixture',
	remoteUser: 'vscode',
	remoteUserSource: 'remoteUser'
};
/** Prefix of every container command: the remote user, the workspace folder, the name. */
const EXEC_PREFIX = "docker exec -it -u 'vscode' -w '/workspaces/fixture' 'relaxed_fixture'";
const mounted: ReturnType<typeof mount>[] = [];
const targets: HTMLElement[] = [];

/** Mount one row in a test-owned root. */
function row(container: ContainerData) {
	const target = document.createElement('div');
	document.body.append(target);
	targets.push(target);
	const onOpenTerminal = vi.fn();
	const onRefresh = vi.fn(async () => {});
	mounted.push(
		mount(DevcontainerRow, { target, props: { container, onRefresh, onOpenTerminal } })
	);
	return { onOpenTerminal, onRefresh };
}

/** Tear down viewers and timers without issuing container actions. */
afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	for (const target of targets.splice(0)) target.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Devcontainer row', () => {
	it('lists every published service and opens one through the service viewer', async () => {
		const open = vi.spyOn(window, 'open').mockReturnValue(null);
		row(running);
		await page.getByRole('button', { name: 'Services: fixture' }).click();
		await expect.element(page.getByRole('menuitem', { name: 'OpenChamber' })).toBeVisible();
		await page.getByRole('menuitem', { name: 'NoVNC' }).click();
		expect(open).toHaveBeenCalledOnce();
		const url = new URL(String(open.mock.calls[0][0]), window.location.origin);
		expect(url.pathname).toBe('/service');
		expect(url.searchParams.get('label')).toBe('NoVNC');
	});

	it('offers the same four Open with actions as a local folder', async () => {
		row(running);
		await page.getByRole('button', { name: 'Open with: fixture' }).click();
		for (const name of ['VS Code', 'Terminal', 'OpenCode TUI', 'OpenChamber'])
			await expect.element(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
	});

	it('runs the OpenCode TUI as the remote user in the container workspace folder', async () => {
		const { onOpenTerminal } = row(running);
		await page.getByRole('button', { name: 'Open with: fixture' }).click();
		await page.getByRole('menuitem', { name: 'OpenCode TUI', exact: true }).click();
		expect(onOpenTerminal).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining(`${EXEC_PREFIX} sh -lc`),
			'fixture · OpenCode',
			'/workspaces/task/fixture'
		);
	});

	it('opens the terminal as the remote user in the container workspace folder', async () => {
		const { onOpenTerminal } = row(running);
		await page.getByRole('button', { name: 'Open with: fixture' }).click();
		await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
		expect(onOpenTerminal).toHaveBeenCalledWith(
			expect.any(String),
			`${EXEC_PREFIX} zsh -l`,
			'fixture',
			'/workspaces/task/fixture'
		);
	});

	it('shows the remote user, the port mapping, and the commands in the details', async () => {
		row(running);
		await page.getByRole('button', { name: 'Details: fixture' }).click();
		await expect.element(page.getByText('vscode', { exact: true })).toBeVisible();
		const ports = page.getByRole('list', { name: 'Port mapping' });
		await expect.element(ports).toHaveTextContent('3000 → host 43000');
		await expect.element(ports).toHaveTextContent('6904 → host 46904');
		await expect.element(page.getByText(`${EXEC_PREFIX} zsh -l`)).toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Copy OpenCode TUI command' }))
			.toBeVisible();
	});

	it('copies the terminal command from the details', async () => {
		const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
		row(running);
		await page.getByRole('button', { name: 'Details: fixture' }).click();
		await page.getByRole('button', { name: 'Copy Terminal command' }).click();
		expect(writeText).toHaveBeenCalledWith(`${EXEC_PREFIX} zsh -l`);
	});

	it('disables container commands when the remote user cannot be used', async () => {
		const remoteUserError =
			'remoteUser "${localEnv:USER}" in the devcontainer metadata is not a plain user name';
		const { onOpenTerminal } = row({
			...running,
			remoteUser: undefined,
			remoteUserSource: undefined,
			remoteUserError
		});
		await page.getByRole('button', { name: 'Open with: fixture' }).click();
		for (const name of ['Terminal', 'OpenCode TUI'])
			await expect.element(page.getByRole('menuitem', { name, exact: true })).toBeDisabled();
		expect(onOpenTerminal).not.toHaveBeenCalled();
	});

	it('disables container actions that the container cannot provide', async () => {
		row({ ...running, ports: {}, containerWorkspaceFolder: undefined });
		await page.getByRole('button', { name: 'Open with: fixture' }).click();
		await expect
			.element(page.getByRole('menuitem', { name: 'OpenCode TUI', exact: true }))
			.toBeDisabled();
		await expect
			.element(page.getByRole('menuitem', { name: 'OpenChamber', exact: true }))
			.toBeDisabled();
		await expect
			.element(page.getByRole('menuitem', { name: 'Terminal', exact: true }))
			.toBeEnabled();
	});

	it('offers Start and opens the host folder when the container is stopped', async () => {
		const { onOpenTerminal } = row({ ...running, state: 'exited' });
		await expect.element(page.getByRole('button', { name: 'Start' })).toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Services: fixture' }))
			.not.toBeInTheDocument();
		await page.getByRole('button', { name: 'Open with: fixture' }).click();
		await expect.element(page.getByText('Container stopped: host folder')).toBeVisible();
		await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
		expect(onOpenTerminal).toHaveBeenCalledWith(
			expect.any(String),
			'',
			'fixture',
			'/workspaces/task/fixture'
		);
	});

	it('asks before deleting and sends no request when cancelled', async () => {
		const confirm = vi.fn(() => false);
		const fetch = vi.fn();
		vi.stubGlobal('confirm', confirm);
		vi.stubGlobal('fetch', fetch);
		row(running);
		await page.getByRole('button', { name: 'Container actions: fixture' }).click();
		await page.getByRole('menuitem', { name: 'Delete container…' }).click();
		expect(confirm).toHaveBeenCalledOnce();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('shows progress while a lifecycle action runs', async () => {
		let finish: (response: Response) => void = () => {};
		vi.stubGlobal(
			'fetch',
			vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)))
		);
		row(running);
		await page.getByRole('button', { name: 'Container actions: fixture' }).click();
		await page.getByRole('menuitem', { name: 'Stop', exact: true }).click();
		await expect.element(page.getByRole('status')).toHaveTextContent('Stopping');
		finish(Response.json({ success: true }));
		await expect.element(page.getByRole('status')).not.toBeInTheDocument();
	});
});
