/** Browser regressions for the Docker Services row: one row, Services menu, and details. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import SandboxRow from './SandboxRow.svelte';
import type { ContainerData, PublishedPortBinding } from '$lib/types';

/** Docker reports each wildcard port twice: once for IPv4 and once for IPv6. */
function wildcard(containerPort: string, hostPort: string): PublishedPortBinding[] {
	return [
		{ containerPort, hostPort, hostIp: '0.0.0.0', protocol: 'tcp' },
		{ containerPort, hostPort, hostIp: '::', protocol: 'tcp' }
	];
}

const sandbox: ContainerData = {
	id: 'cccccccccccc',
	name: '/polaris-qkt-fdp-b',
	projectName: 'polaris-qkt-fdp-b',
	state: 'running',
	isDevcontainer: false,
	image: 'registry.tern.is/polaris/fdp:qkt-4.2',
	ports: { '5904': '32000', '6904': '32001' },
	portBindings: [...wildcard('5904', '32000'), ...wildcard('6904', '32001')],
	networks: [{ name: 'polaris-qkt_polaris-net', ip: '172.26.0.12', aliases: ['fdp-b'] }]
};
/** 6904 is a web port by default; 5904 (raw VNC) is not. */
const servicePorts = { '6904': 'http' } as const;
const mounted: ReturnType<typeof mount>[] = [];
const targets: HTMLElement[] = [];

/** Mount one row in a test-owned root. */
function row(container: ContainerData, extra: Record<string, unknown> = {}) {
	const target = document.createElement('div');
	document.body.append(target);
	targets.push(target);
	const onOpenTerminal = vi.fn();
	const onRefresh = vi.fn(async () => {});
	mounted.push(
		mount(SandboxRow, {
			target,
			props: {
				container,
				vscodeSshHost: '',
				servicePorts,
				serviceAccess: 'https',
				onRefresh,
				onOpenTerminal,
				...extra
			}
		})
	);
	return { onOpenTerminal, onRefresh };
}

/** Tear down timers without issuing container actions. */
afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	for (const target of targets.splice(0)) target.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Docker Services row', () => {
	it('keeps the published ports out of the row until the details open', async () => {
		row(sandbox);
		expect(document.querySelector('[aria-label="Published ports"]')).toBeNull();
		await page.getByRole('button', { name: 'Details: polaris-qkt-fdp-b' }).click();
		const ports = page.getByRole('list', { name: 'Published ports' });
		await expect.element(ports).toBeVisible();
		// The IPv4 and IPv6 bindings of one port fold into one line.
		expect(ports.element().querySelectorAll('li')).toHaveLength(2);
		await expect.element(ports).toHaveTextContent('HTTPS in dashboard');
		await expect.element(ports).toHaveTextContent('TCP · copy address');
	});

	it('opens a web port in the dashboard and copies the address of a TCP-only port', async () => {
		const open = vi.spyOn(window, 'open').mockReturnValue(null);
		const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
		row(sandbox);
		await page.getByRole('button', { name: 'Services: polaris-qkt-fdp-b' }).click();
		await page.getByRole('menuitem', { name: /NoVNC/ }).click();
		expect(open).toHaveBeenCalledOnce();
		expect(new URL(String(open.mock.calls[0][0]), window.location.origin).pathname).toBe(
			'/service'
		);

		await page.getByRole('button', { name: 'Services: polaris-qkt-fdp-b' }).click();
		await page.getByRole('menuitem', { name: /Port 5904/ }).click();
		expect(writeText).toHaveBeenCalledWith(`${window.location.hostname}:32000`);
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent(`Copied ${window.location.hostname}:32000`);
	});

	it('opens a shell from Open with and offers no rebuild', async () => {
		const { onOpenTerminal } = row(sandbox);
		await page.getByRole('button', { name: 'Open with: polaris-qkt-fdp-b' }).click();
		await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
		expect(onOpenTerminal).toHaveBeenCalledWith(
			expect.any(String),
			'docker exec -it polaris-qkt-fdp-b bash || docker exec -it polaris-qkt-fdp-b sh',
			'polaris-qkt-fdp-b',
			''
		);
		await page.getByRole('button', { name: 'Container actions: polaris-qkt-fdp-b' }).click();
		await expect.element(page.getByRole('menuitem', { name: /Restart/ })).toBeVisible();
		expect(document.body.textContent).not.toContain('Rebuild and restart');
	});

	it('labels all-interface exposure on a standalone row', async () => {
		row(sandbox, { standalone: true });
		await expect.element(page.getByText('All interfaces', { exact: true })).toBeVisible();
	});

	it('offers Start instead of Services when the container is stopped', async () => {
		row({ ...sandbox, state: 'exited' });
		await expect.element(page.getByRole('button', { name: 'Start' })).toBeVisible();
		expect(document.querySelector('[aria-label="Services: polaris-qkt-fdp-b"]')).toBeNull();
	});
});
