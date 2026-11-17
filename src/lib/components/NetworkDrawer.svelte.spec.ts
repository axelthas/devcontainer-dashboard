/** Browser regressions for the network drawer: choices, preview, and the connect request. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import NetworkDrawer from './NetworkDrawer.svelte';
import type { ContainerData, NetworkData } from '$lib/types';

const container: ContainerData = {
	id: 'bbbbbbbbbbbb',
	name: '/brave_hopper',
	projectName: 'tas-keflavik',
	state: 'running',
	isDevcontainer: true,
	image: 'vsc-tas-keflavik',
	ports: {},
	localWorkspacePath: '/workspaces/tas/tas-keflavik',
	devcontainerConfigFile: '/workspaces/tas/tas-keflavik/.devcontainer/devcontainer.json',
	networks: [{ name: 'bridge', ip: '172.17.0.4', aliases: [] }]
};

const sandbox: NetworkData = {
	name: 'keflavik_oplan',
	driver: 'bridge',
	subnet: '192.168.103.0/24',
	gateway: '192.168.103.1',
	projects: ['keflavik'],
	endpoints: [
		{
			containerId: '111111111111',
			containerName: 'keflavik-app-fdd-2-1',
			state: 'running',
			isDevcontainer: false,
			ip: '192.168.103.124',
			aliases: [],
			hostname: 'app-fdd-2'
		},
		{
			containerId: '222222222222',
			containerName: 'keflavik-twr-fdd-1-sup-1',
			state: 'exited',
			isDevcontainer: false,
			ip: '192.168.103.101',
			aliases: [],
			hostname: 'twr-fdd-1-sup'
		}
	]
};

const mounted: ReturnType<typeof mount>[] = [];
const targets: HTMLElement[] = [];

/** Mount the drawer open on the test container. */
function drawer(props: { network?: string; seatIp?: string; networks?: NetworkData[] } = {}) {
	const target = document.createElement('div');
	document.body.append(target);
	targets.push(target);
	const onClose = vi.fn();
	const onConnected = vi.fn(async () => {});
	mounted.push(
		mount(NetworkDrawer, {
			target,
			props: { container, networks: [sandbox], onClose, onConnected, ...props }
		})
	);
	return { onClose, onConnected };
}

afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	for (const target of targets.splice(0)) target.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Network drawer', () => {
	it('offers free seats only and previews the exact Docker calls', async () => {
		drawer({ network: 'keflavik_oplan', seatIp: '192.168.103.101' });
		await expect.element(page.getByRole('radio', { name: /twr-fdd-1-sup/ })).toBeChecked();
		await expect.element(page.getByRole('radio', { name: /app-fdd-2/ })).toBeDisabled();
		await expect
			.element(page.getByRole('list', { name: 'Docker calls' }))
			.toHaveTextContent(
				'docker network connect --ip 192.168.103.101 --alias twr-fdd-1-sup keflavik_oplan brave_hopper'
			);
		await expect
			.element(page.getByRole('list', { name: 'Docker calls' }))
			.toHaveTextContent('docker exec -u 0 brave_hopper hostname twr-fdd-1-sup');
	});

	it('keeps other networks unless asked, then disconnects them after the connect', async () => {
		drawer({ network: 'keflavik_oplan' });
		const calls = page.getByRole('list', { name: 'Docker calls' });
		await expect.element(calls).not.toHaveTextContent('disconnect');
		await page.getByRole('checkbox', { name: /Make it the only network/ }).click();
		await expect.element(calls).toHaveTextContent('docker network disconnect bridge brave_hopper');
	});

	it('validates a custom address before anything runs', async () => {
		drawer({ network: 'keflavik_oplan' });
		await page.getByText('Custom', { exact: true }).click();
		await page.getByRole('textbox', { name: 'IP address' }).fill('192.168.103.124');
		await expect.element(page.getByText('Held by keflavik-app-fdd-2-1 (running)')).toBeVisible();
		await expect.element(page.getByRole('button', { name: /^Connect/ })).toBeDisabled();
	});

	it('sends the connect request and reports success to the page', async () => {
		const fetch = vi.fn(async () =>
			Response.json({ steps: [], networks: [], hostname: { status: 'set' } })
		);
		vi.stubGlobal('fetch', fetch);
		const { onClose, onConnected } = drawer({
			network: 'keflavik_oplan',
			seatIp: '192.168.103.101'
		});
		await page.getByRole('button', { name: 'Connect as twr-fdd-1-sup' }).click();
		await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/containers/bbbbbbbbbbbb/networks');
		expect(JSON.parse(String(init.body))).toEqual({
			network: 'keflavik_oplan',
			ip: '192.168.103.101',
			alias: 'twr-fdd-1-sup',
			onlyNetwork: false,
			setHostname: true
		});
		expect(onConnected).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'bbbbbbbbbbbb' }),
			expect.objectContaining({ network: 'keflavik_oplan' }),
			true
		);
	});

	it('says so when no user-defined network exists', async () => {
		drawer({ networks: [] });
		await expect.element(page.getByText(/No user-defined networks found/).first()).toBeVisible();
	});
});
