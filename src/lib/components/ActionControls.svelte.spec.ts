/** Browser regressions for rebuild confirmation, errors, lifecycle, and both devcontainer views. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import ActionControls from './ActionControls.svelte';
import DevcontainerCard from './DevcontainerCard.svelte';
import DevcontainerRow from './DevcontainerRow.svelte';
import type { ContainerData } from '$lib/types';

const container: ContainerData = {
	id: 'aaaaaaaaaaaa',
	name: '/fixture',
	projectName: 'fixture',
	state: 'running',
	isDevcontainer: true,
	image: 'fixture',
	ports: {},
	localWorkspacePath: '/workspaces/task/repo',
	devcontainerConfigFile: '/workspaces/task/repo/.devcontainer/devcontainer.json'
};
const mounted: ReturnType<typeof mount>[] = [];
const targets: HTMLElement[] = [];

/** Append only a test-owned root, leaving the browser runner's DOM untouched. */
function target() {
	const element = document.createElement('div');
	document.body.append(element);
	targets.push(element);
	return element;
}

/** Tear down timers/viewers without issuing process cancellation. */
afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	for (const element of targets.splice(0)) element.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Rebuild and restart', () => {
	it.each([
		['grid', DevcontainerCard],
		['list', DevcontainerRow]
	] as const)('is available in the %s view', async (_name, Component) => {
		mounted.push(mount(Component, {
			target: target(), props: { container, onRefresh: async () => {} }
		}));
		await expect.element(page.getByRole('button', { name: 'Rebuild and restart' })).toBeEnabled();
	});

	it('cancelling confirmation starts no request and identifies the target and data-loss boundary', async () => {
		const confirm = vi.fn<(message: string) => boolean>().mockReturnValue(false);
		const fetch = vi.fn();
		vi.stubGlobal('confirm', confirm);
		vi.stubGlobal('fetch', fetch);
		mounted.push(mount(ActionControls, {
			target: target(),
			props: { id: container.id, containerState: 'running', rebuildContainer: container, onRefresh: async () => {} }
		}));
		await page.getByRole('button', { name: 'Rebuild and restart' }).click();
		expect(fetch).not.toHaveBeenCalled();
		expect(confirm).toHaveBeenCalledWith(expect.stringContaining('fixture'));
		expect(confirm.mock.calls[0][0]).toContain('writable layer');
	});

	it('accepts the server-created session, shows progress and does not cancel it on unmount', async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce(Response.json({ id: 'build-1', repoPath: container.localWorkspacePath, repoName: 'fixture' }, { status: 202 }))
			.mockResolvedValue(Response.json({ id: 'build-1', status: 'running' }));
		const onOpenBuild = vi.fn();
		vi.stubGlobal('confirm', vi.fn(() => true));
		vi.stubGlobal('fetch', fetch);
		mounted.push(mount(ActionControls, {
			target: target(),
			props: { id: container.id, containerState: 'running', rebuildContainer: container, onRefresh: async () => {}, onOpenBuild }
		}));
		await page.getByRole('button', { name: 'Rebuild and restart' }).click();
		await expect.element(page.getByRole('status')).toHaveTextContent('Rebuilding');
		expect(onOpenBuild).toHaveBeenCalledWith('build-1', '', 'Rebuild fixture', container.localWorkspacePath);
		await unmount(mounted.pop()!);
		expect(fetch.mock.calls.every((call) => call[1]?.method !== 'DELETE')).toBe(true);
	});

	it('shows request errors and permits retry instead of looking successful', async () => {
		vi.stubGlobal('confirm', vi.fn(() => true));
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ message: 'A rebuild is already running' }, { status: 409 })));
		mounted.push(mount(ActionControls, {
			target: target(),
			props: { id: container.id, containerState: 'running', rebuildContainer: container, onRefresh: async () => {} }
		}));
		await page.getByRole('button', { name: 'Rebuild and restart' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('A rebuild is already running');
		await expect.element(page.getByRole('button', { name: 'Rebuild and restart' })).toBeEnabled();
	});

	it('refreshes discovery on completion and reports a failed build', async () => {
		const onRefresh = vi.fn(async () => {});
		vi.stubGlobal('confirm', vi.fn(() => true));
		vi.stubGlobal('fetch', vi.fn()
			.mockResolvedValueOnce(Response.json({ id: 'build-failed', repoName: 'fixture', repoPath: container.localWorkspacePath }, { status: 202 }))
			.mockResolvedValueOnce(Response.json({ id: 'build-failed', status: 'failed' })));
		mounted.push(mount(ActionControls, {
			target: target(),
			props: { id: container.id, containerState: 'exited', rebuildContainer: container, onRefresh }
		}));
		await page.getByRole('button', { name: 'Rebuild and restart' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('Rebuild failed');
		expect(onRefresh).toHaveBeenCalledOnce();
	});

	it('disables rebuilding when the exact configuration label is absent', async () => {
		mounted.push(mount(ActionControls, {
			target: target(),
			props: { id: container.id, containerState: 'running', rebuildContainer: { ...container, devcontainerConfigFile: undefined }, onRefresh: async () => {} }
		}));
		await expect.element(page.getByRole('button', { name: 'Rebuild and restart' })).toBeDisabled();
	});

	it('does not add rebuilding to unrelated Docker service controls', async () => {
		mounted.push(mount(ActionControls, {
			target: target(), props: { id: container.id, containerState: 'running', onRefresh: async () => {} }
		}));
		await expect.element(page.getByRole('button', { name: 'Rebuild and restart' })).not.toBeInTheDocument();
	});
});
