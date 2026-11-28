/** Browser checks for the Compose group using simulated API responses. */
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import '../../routes/layout.css';
import ComposeGroupRow from './ComposeGroupRow.svelte';
import type { ContainerData } from '$lib/types';
import type { StackView } from './stack/types';

const project = 'polaris-ice';
const network = 'polaris-ice_polaris-net';
const mode = {
	id: 'mode',
	label: 'Mode',
	options: ['mode-training', 'mode-playback', 'mode-testing', 'mode-operational'],
	confirm: ['mode-operational']
};
let root: HTMLElement | undefined;
let component: ReturnType<typeof mount> | undefined;

/** Mount one stack with both an explicit family and an image fallback. */
function fixture(profile = true) {
	const view: StackView = {
		project,
		kind: profile
			? {
					kind: 'polaris-sandbox',
					title: 'Polaris Sandbox',
					presenter: 'profile',
					source: 'compose',
					groups: { FDP: ['fdp-a', 'fdp-b'] },
					panels: ['addresses'],
					actions: [mode]
				}
			: { kind: 'generic', presenter: 'generic', source: 'default' },
		actionState: {},
		request: { repoPath: 'solution', files: ['compose.yaml'], profiles: [] }
	};
	const post = vi.fn();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url.startsWith('/api/compose/stack?')) return Response.json(view);
			if (url === '/api/compose/action') {
				post(JSON.parse(String(init?.body)));
				return Response.json({
					value: 'mode-operational',
					at: new Date().toISOString(),
					result: 'partial',
					services: [
						{ service: 'fdp-a', result: 'ok' },
						{ service: 'fdp-b', result: 'failed' }
					]
				});
			}
			throw new Error(`Unexpected fixture request: ${url}`);
		})
	);
	const containers: ContainerData[] = ['fdp-b', 'fdp-a', 'orion'].map((service, index) => ({
		id: `container-${index}`,
		name: `/${project}-${service}`,
		projectName: `${project}-${service}`,
		composeService: service,
		state: 'running',
		isDevcontainer: false,
		ports: {},
		image: `registry.example/polaris/${service === 'orion' ? service : 'fdp'}:26.0.63`,
		networks: [{ name: network, ip: `10.231.3.${11 + index}`, aliases: [] }]
	}));
	root = document.createElement('div');
	root.style.width = '360px';
	document.body.append(root);
	component = mount(ComposeGroupRow, {
		target: root,
		props: {
			projectName: project,
			containers,
			vscodeSshHost: '',
			onRefresh: async () => {},
			networks: [{ name: network, driver: 'bridge', projects: [project], endpoints: [] }],
			onConnectNetwork: vi.fn()
		}
	});
	return { root, post };
}

/** Dispose the fixture without leaving mocked network or clipboard access behind. */
afterEach(async () => {
	if (component) await unmount(component);
	root?.remove();
	component = undefined;
	root = undefined;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it('fits mode controls at narrow and desktop widths and confirms without relabeling', async () => {
	const { root, post } = fixture();
	const operational = page.getByRole('button', { name: 'Operational', exact: true });
	await expect.element(operational).toBeVisible();
	for (const width of [360, 1440]) {
		root.style.width = `${width}px`;
		const group = page.getByRole('group', { name: 'Mode', exact: true }).element();
		const restart = root.querySelector('[title="Restart all"]');
		expect(root.scrollWidth).toBeLessThanOrEqual(width);
		expect(group.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			restart!.getBoundingClientRect().bottom
		);
	}
	root.style.width = '360px';
	await operational.click();
	const dialog = page.getByRole('dialog', { name: 'Confirm action' });
	await expect.element(dialog).toBeVisible();
	expect(post).not.toHaveBeenCalled();
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect.element(operational).toBeVisible();
	await operational.click();
	await dialog.getByRole('button', { name: 'Confirm' }).click();
	await expect.element(page.getByText(/Last request: Operational/)).toBeVisible();
	expect(post).toHaveBeenCalledWith(
		expect.objectContaining({ option: 'mode-operational', confirmed: true })
	);
	expect(operational.element().getAttribute('aria-pressed')).toBeNull();
	await page.getByText('1/2 services succeeded', { exact: true }).click();
	expect(root.querySelector('details')?.open).toBe(true);
	await expect.element(page.getByText('fdp-b: failed')).toBeVisible();
});

it('groups profile nodes and lets an operator open networks and copy a node address', async () => {
	fixture();
	const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
	await expect.element(page.getByRole('button', { name: 'Testing', exact: true })).toBeVisible();
	await page.getByRole('button', { name: /^polaris-ice/ }).click();
	await expect.element(page.getByText('FDP', { exact: true })).toBeVisible();
	const members = page.getByText('FDP', { exact: true }).element().closest('summary');
	expect(members?.textContent).toMatch(/fdp-a.*fdp-b/s);
	expect(members?.parentElement?.hasAttribute('open')).toBe(false);
	await page.getByText('FDP', { exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: 'Details: polaris-ice-fdp-a' }))
		.toBeVisible();
	await page.getByText(/^Addresses/).click();
	await page.getByRole('button', { name: 'Copy fdp-a address 10.231.3.12' }).click();
	expect(clipboard).toHaveBeenCalledWith('10.231.3.12');
	await page.getByRole('button', { name: '1 network', exact: true }).click();
	await expect.element(page.getByRole('group', { name: 'Networks of polaris-ice' })).toBeVisible();
});

it('leaves generic stacks with the existing flat container rows', async () => {
	fixture(false);
	await page.getByRole('button', { name: /^polaris-ice/ }).click();
	await expect
		.element(page.getByRole('button', { name: 'Details: polaris-ice-fdp-a' }))
		.toBeVisible();
	await expect
		.element(page.getByRole('group', { name: 'Mode', exact: true }))
		.not.toBeInTheDocument();
});
