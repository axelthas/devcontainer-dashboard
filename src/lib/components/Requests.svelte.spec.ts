/** Browser regressions for request errors, delayed callbacks, and cancellation visibility. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import ComposeGroupRow from './ComposeGroupRow.svelte';
import LocalWorkspaces from './LocalWorkspaces.svelte';
import BootstrapStatus from './BootstrapStatus.svelte';
import BootstrapModal from './BootstrapModal.svelte';
import LogViewer from './LogViewer.svelte';
import type { ContainerData, LocalWorkspaceData } from '$lib/types';

vi.mock('./TerminalTab.svelte', async () => ({
	default: (await import('./RequestTerminalFixture.svelte')).default
}));

const mounted: ReturnType<typeof mount>[] = [];
const targets: HTMLElement[] = [];

/** Add a root owned by this test, not by the browser runner. */
function target() {
	const node = document.createElement('div');
	document.body.append(node);
	targets.push(node);
	return node;
}

/** Control request completion without timing-dependent sleeps. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

/** Serve the bootstrap reads used by LocalWorkspaces, and dispatch operation requests. */
function stubRequests(operation: (url: string, init?: RequestInit) => Promise<Response>) {
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === '/api/bootstrap') return Response.json({ installed: false, repoPath: '' });
		if (url === '/api/bootstrap/providers') return Response.json([]);
		return operation(url, init);
	});
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

/** Mount a workspace with a predictable name and optional existing build metadata. */
function workspace(data?: Partial<LocalWorkspaceData>, onRefreshWorkspaces = async () => {}) {
	const ws: LocalWorkspaceData = {
		id: 'workspace',
		name: 'Fixture workspace',
		path: '/workspaces/task',
		repos: [
			{
				name: 'repo',
				path: '/workspaces/task/repo',
				hasDevcontainer: true,
				devcontainerConfigs: [],
				isRunning: false
			}
		],
		...data
	};
	mounted.push(
		mount(LocalWorkspaces, {
			target: target(),
			props: {
				workspaceRoot: '/workspaces',
				workspaces: [ws],
				containers: [],
				vscodeSshHost: '',
				onOpenTerminal: () => {},
				onRefreshWorkspaces
			}
		})
	);
	return ws;
}

afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	for (const node of targets.splice(0)) node.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('request feedback', () => {
	it('identifies group partial failures instead of reporting blanket success', async () => {
		const containers = ['good', 'bad'].map((id) => ({
			id,
			name: `/${id}`,
			projectName: id,
			state: 'running',
			isDevcontainer: false,
			image: 'fixture',
			ports: {}
		})) satisfies ContainerData[];
		const refresh = vi.fn(async () => {});
		stubRequests(async (url) =>
			url.includes('/bad/')
				? Response.json({ message: 'Docker refused stop' }, { status: 500 })
				: Response.json({ success: true })
		);
		mounted.push(
			mount(ComposeGroupRow, {
				target: target(),
				props: { projectName: 'stack', containers, vscodeSshHost: '', onRefresh: refresh }
			})
		);
		await page.getByRole('button', { name: 'Stop all', exact: true }).click();
		await expect.element(page.getByRole('status')).toHaveTextContent('1 of 2 succeeded');
		await expect.element(page.getByRole('alert')).toHaveTextContent('bad: Docker refused stop');
		expect(refresh).toHaveBeenCalledOnce();
	});

	it('keeps workspace refresh disabled until its async callback settles', async () => {
		const pending = deferred<void>();
		stubRequests(async () => Response.json({}));
		workspace(undefined, () => pending.promise);
		const button = page.getByRole('button', { name: 'Refresh workspaces' });
		await button.click();
		await expect.element(button).toBeDisabled();
		pending.resolve();
		await expect.element(button).toBeEnabled();
	});

	it('shows a failed build request and clears its loading state', async () => {
		stubRequests(async () => Response.json({ message: 'Build capacity reached' }, { status: 409 }));
		workspace();
		await page.getByRole('button', { name: 'Fixture workspace', exact: false }).first().click();
		await page.getByRole('button', { name: 'Build & Start', exact: true }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('Build capacity reached');
		await expect
			.element(page.getByRole('button', { name: 'Build & Start', exact: true }))
			.toBeEnabled();
	});

	it('does not hide a rerun while cancellation is pending or failed', async () => {
		const pending = deferred<Response>();
		stubRequests(async () => pending.promise);
		workspace({
			solutionMetadata: {
				solution: 'fixture',
				config_repo: '',
				projects: [],
				tag: '',
				shellconf: false,
				nobackup: false,
				bootstrap_version: '1'
			}
		});
		await page.getByRole('button', { name: 'More actions: Fixture workspace' }).click();
		await page.getByRole('menuitem', { name: 'Rerun bootstrap' }).click();
		await expect.element(page.getByText('Rerunning bootstrap…')).toBeVisible();
		const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
		await cancel.click();
		await expect.element(cancel).toBeDisabled();
		pending.resolve(Response.json({ message: 'Could not stop process' }, { status: 500 }));
		await expect.element(page.getByRole('alert')).toHaveTextContent('Could not stop process');
		await expect.element(page.getByText('Rerunning bootstrap…')).toBeVisible();
		await expect.element(cancel).toBeEnabled();
	});

	it('does not call a failed bootstrap read an uninstalled tool and allows retry', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(Response.json({ message: 'Unavailable' }, { status: 500 }));
		vi.stubGlobal('fetch', fetch);
		mounted.push(mount(BootstrapStatus, { target: target(), props: { onBootstrap: () => {} } }));
		await expect.element(page.getByRole('alert')).toHaveTextContent('Bootstrap status unavailable');
		await expect.element(page.getByText('No bootstrap tool installed')).not.toBeInTheDocument();
		fetch.mockImplementation(async (url: string) =>
			Response.json(url.endsWith('/providers') ? [] : { installed: false, repoPath: '' })
		);
		await page.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect.element(page.getByText('No bootstrap tool installed')).toBeVisible();
	});

	it('gives expired preset loading a sign-in path, not an empty-preset message', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(Response.json({ message: 'Authentication required' }, { status: 401 }))
		);
		mounted.push(
			mount(BootstrapModal, {
				target: target(),
				props: { onClose: () => {}, onRunBackground: () => {} }
			})
		);
		await expect.element(page.getByRole('alert')).toHaveTextContent('Your session expired');
		await expect.element(page.getByRole('link', { name: 'Sign in again' })).toBeVisible();
		await expect.element(page.getByText('No presets', { exact: false })).not.toBeInTheDocument();
	});

	it('shows a log network failure and lets the user retry the read', async () => {
		const fetch = vi.fn().mockRejectedValue(new TypeError('network'));
		vi.stubGlobal('fetch', fetch);
		mounted.push(
			mount(LogViewer, {
				target: target(),
				props: { logId: 'fixture', title: 'Fixture log', onClose: () => {} }
			})
		);
		await expect.element(page.getByRole('alert')).toHaveTextContent('Connection failed');
		await page.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect.poll(() => fetch.mock.calls.length).toBe(2);
	});
});
