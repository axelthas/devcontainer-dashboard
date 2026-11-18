/** Browser regressions for the networks panel of a Compose group. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import ComposeNetworks from './ComposeNetworks.svelte';
import type { ContainerData, NetworkData } from '$lib/types';

const devcontainer: ContainerData = {
	id: 'bbbbbbbbbbbb',
	name: '/brave_hopper',
	projectName: 'tas-keflavik',
	state: 'running',
	isDevcontainer: true,
	image: 'vsc-tas-keflavik',
	ports: {}
};

/** Two networks of one project; the data network is shared with a second project. */
const networks: NetworkData[] = [
	{
		name: 'polaris-qkt_ops',
		driver: 'bridge',
		subnet: '172.26.0.0/24',
		projects: ['polaris-qkt'],
		endpoints: [
			{
				containerId: '111111111111',
				containerName: 'polaris-qkt-fdp-a',
				state: 'running',
				isDevcontainer: false,
				ip: '172.26.0.11',
				aliases: [],
				hostname: 'polaris-qkt-fdp-a'
			},
			{
				containerId: '222222222222',
				containerName: 'polaris-qkt-smc',
				state: 'exited',
				isDevcontainer: false,
				ip: '172.26.0.21',
				aliases: [],
				hostname: 'polaris-qkt-smc'
			}
		]
	},
	{
		name: 'polaris-qkt_data',
		driver: 'bridge',
		subnet: '172.27.0.0/24',
		projects: ['polaris-qkt', 'polaris-ice'],
		endpoints: []
	}
];

const mounted: ReturnType<typeof mount>[] = [];
const targets: HTMLElement[] = [];

/** Mount the panel with one running devcontainer. */
function panel() {
	const target = document.createElement('div');
	document.body.append(target);
	targets.push(target);
	const onConnectNetwork = vi.fn();
	mounted.push(
		mount(ComposeNetworks, {
			target,
			props: {
				projectName: 'polaris-qkt',
				networks,
				devcontainers: [devcontainer],
				onConnectNetwork
			}
		})
	);
	return { onConnectNetwork };
}

afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	for (const target of targets.splice(0)) target.remove();
	vi.restoreAllMocks();
});

describe('Compose networks', () => {
	it('lists every network of the project and shows a shared network', async () => {
		panel();
		await expect.element(page.getByRole('button', { name: /polaris-qkt_ops/ })).toBeVisible();
		await page.getByRole('button', { name: /polaris-qkt_data/ }).click();
		await expect.element(page.getByText('Also used by polaris-ice')).toBeVisible();
		await expect
			.element(page.getByText('No devcontainers connected to this network.'))
			.toBeVisible();
	});

	it('stands in for a stopped node with a running devcontainer', async () => {
		const { onConnectNetwork } = panel();
		await page.getByRole('button', { name: /polaris-qkt_ops/ }).click();
		const seats = page.getByRole('list', { name: 'Seats on polaris-qkt_ops' });
		await expect
			.element(seats)
			.toHaveTextContent(/polaris-qkt-fdp-a\s*172\.26\.0\.11\s*node running/);
		await page.getByRole('button', { name: 'Stand in for polaris-qkt-smc' }).click();
		await page.getByRole('menuitem', { name: /tas-keflavik/ }).click();
		expect(onConnectNetwork).toHaveBeenCalledWith(devcontainer, 'polaris-qkt_ops', '172.26.0.21');
	});
});
