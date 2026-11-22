/**
 * Phone container/network regressions against the built server. Network and lifecycle
 * writes are intercepted and simulated: these tests never change the Docker host.
 * SSR reads the host; hydration replaces the container list with isolated fixture data.
 */
import { expect, test, type Page } from '@playwright/test';
import type { ContainerData, LocalWorkspaceData, NetworkData, ContainerNetwork } from '$lib/types';
import type { ConnectRequest } from '$lib/networkRules';

test.use({
	viewport: { width: 393, height: 852 },
	isMobile: true,
	hasTouch: true,
	userAgent:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
});

const NETWORK = 'phone-sandbox_default';
const IP = '172.30.0.21';
const CONFIG = '/fixture/.devcontainer/devcontainer.json';
const networks: NetworkData[] = [
	{
		name: NETWORK,
		driver: 'bridge',
		subnet: '172.30.0.0/24',
		gateway: '172.30.0.1',
		projects: ['phone-sandbox'],
		endpoints: [
			{
				containerId: 'fdfdfdfdfdfd',
				containerName: 'fixture-fdp',
				state: 'exited',
				isDevcontainer: false,
				hostname: 'fdp-a',
				ip: IP,
				aliases: ['fdp-a']
			},
			{
				containerId: 'abababababab',
				containerName: 'fixture-sdp',
				state: 'running',
				isDevcontainer: false,
				hostname: 'sdp-a',
				ip: '172.30.0.22',
				aliases: ['sdp-a']
			}
		]
	},
	{ name: 'phone-shared', driver: 'bridge', subnet: '172.28.0.0/16', projects: [], endpoints: [] }
];

/** Authenticate, stub all relevant writes, and expose test-controlled fixture state. */
async function setup(page: Page, options: { stopped?: boolean; saved?: boolean } = {}) {
	await page.request.post('/login', {
		form: { password: 'playwright-test-password' },
		headers: { Origin: 'http://127.0.0.1:4173', 'x-sveltekit-action': 'true' }
	});
	const workspaces = (await (
		await page.request.get('/api/workspaces')
	).json()) as LocalWorkspaceData[];
	const workspace = workspaces.find((entry) => entry.repos.length);
	const path = workspace?.repos[0]?.path ?? '/fixture/task-workspace/phone-project';
	const container: ContainerData = {
		id: 'cccccccccccc',
		name: '/fixture-phone-container',
		projectName: 'phone-project',
		state: options.stopped ? 'exited' : 'running',
		isDevcontainer: true,
		ports: {},
		image: 'fixture-image',
		localWorkspacePath: path,
		containerWorkspaceFolder: '/workspaces/phone-project',
		devcontainerConfigFile: CONFIG,
		networks: [{ name: 'bridge', ip: '172.17.0.5', aliases: [] }],
		networkPresets: [{ network: NETWORK, seats: [{ hostname: 'fdp-a', ip: IP }] }]
	};
	const writes: { method: string; body?: ConnectRequest; url: string }[] = [];
	const state = {
		fail: 0,
		failMessage: 'The address is now occupied',
		hostnameFails: false,
		listFails: false,
		delay: 0
	};
	await page.route('**/api/networks', (route) =>
		state.listFails
			? route.fulfill({ status: 503, json: { message: 'Network discovery failed' } })
			: route.fulfill({ json: networks })
	);
	await page.route('**/api/containers', (route) => route.fulfill({ json: [container] }));
	await page.route('**/api/containers/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		if (req.method() === 'POST' && url.pathname.endsWith('/networks')) {
			const body = req.postDataJSON() as ConnectRequest;
			writes.push({ method: 'POST', body, url: url.pathname });
			if (state.delay) await new Promise((done) => setTimeout(done, state.delay));
			if (state.fail) {
				await route.fulfill({ status: state.fail, json: { message: state.failMessage } });
				return;
			}
			const next: ContainerNetwork = {
				name: body.network,
				ip: body.ip ?? '172.30.0.57',
				configuredIp: body.ip,
				aliases: body.alias ? [body.alias] : []
			};
			container.networks = [
				...(body.onlyNetwork
					? []
					: container.networks!.filter((entry) => entry.name !== body.network)),
				next
			];
			await route.fulfill({
				json: {
					steps: [],
					networks: container.networks,
					...(state.hostnameFails
						? { hostname: { status: 'failed', message: 'Hostname permission denied' } }
						: {})
				}
			});
		} else if (req.method() === 'DELETE' && url.pathname.includes('/networks/')) {
			writes.push({ method: 'DELETE', url: url.pathname });
			container.networks = [{ name: 'bridge', ip: '172.17.0.5', aliases: [] }];
			await route.fulfill({ json: { steps: [], networks: container.networks } });
		} else {
			throw new Error(`Unmocked container operation: ${req.method()} ${url.pathname}`);
		}
	});
	if (options.saved)
		await page.addInitScript(
			({ path, config, network, ip }) => {
				localStorage.setItem(
					'devcontainer-dashboard-network-memory',
					JSON.stringify({
						[`${path}\n${config}`]: [
							{ network, ip, alias: 'fdp-a', setHostname: true, containerId: 'dddddddddddd' }
						]
					})
				);
			},
			{ path, config: CONFIG, network: NETWORK, ip: IP }
		);
	await page.goto('/mobile/containers');
	if (options.stopped) await page.getByRole('radio', { name: 'All', exact: true }).click();
	await expect(
		page.getByTestId('container-row').filter({ hasText: 'phone-project' })
	).toBeVisible();
	await page.getByTestId('container-row').filter({ hasText: 'phone-project' }).click();
	return { container, workspace, writes, state };
}

/** The mobile network form must never widen the page, even with command previews. */
async function fit(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(1);
}

test('context leads, controls stay visible, and technical details start collapsed', async ({
	page
}) => {
	const { workspace } = await setup(page);
	await expect(page.getByTestId('container-context')).toContainText(
		workspace?.name ?? 'Workspace unknown'
	);
	for (const name of ['restart', 'stop', 'rebuild', 'delete'])
		await expect(page.getByTestId(`container-${name}`)).toBeVisible();
	await expect(page.getByTestId('container-details')).not.toHaveAttribute('open');
	await page.getByTestId('container-details').locator('summary').click();
	await expect(page.getByTestId('container-details')).toContainText('fixture-image');
	await fit(page);
});

test('connects as a free node, previews commands, remembers, and confirms disconnect', async ({
	page
}) => {
	const { writes, state } = await setup(page);
	await page.getByTestId('network-join').click();
	const sheet = page.getByTestId('network-connect-sheet');
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole('radio', { name: /sdp-a/ })).toBeDisabled();
	await expect(sheet.getByRole('radio', { name: /fdp-a/ })).toBeChecked();
	await sheet.locator('summary').click();
	await expect(sheet.getByRole('list', { name: 'Docker calls' })).toContainText(
		'--ip 172.30.0.21 --alias fdp-a'
	);
	await fit(page);
	state.delay = 900;
	await sheet.getByTestId('network-submit').click();
	await expect(sheet.getByRole('button', { name: 'Done' })).toBeDisabled();
	await page.keyboard.press('Escape');
	await expect(sheet).toBeVisible();
	await expect(sheet).toBeHidden();
	expect(writes).toHaveLength(1);
	expect(writes[0].body).toEqual({
		network: NETWORK,
		ip: IP,
		alias: 'fdp-a',
		setHostname: true,
		onlyNetwork: false
	});
	await expect(page.getByTestId('attached-network')).toContainText(IP);
	expect(
		await page.evaluate(() => localStorage.getItem('devcontainer-dashboard-network-memory'))
	).toContain('fdp-a');
	await page.getByTestId('attached-network').click();
	await page.getByRole('button', { name: 'Change address or alias…' }).click();
	await expect(sheet.getByRole('radio', { name: /fdp-a/ })).toBeChecked();
	await sheet.getByRole('button', { name: 'Done' }).click();
	await page.getByTestId('attached-network').click();
	await page.getByRole('button', { name: 'Disconnect…', exact: true }).click();
	expect(writes).toHaveLength(1);
	await expect(page.getByTestId('network-actions-sheet')).toContainText('docker network');
	await page.getByTestId('confirm-action').click();
	await expect(page.getByTestId('attached-network')).toHaveCount(0);
	expect(writes.at(-1)?.method).toBe('DELETE');
});

test('custom address validation, any-address mode, and network discovery errors', async ({
	page
}) => {
	const { writes, state } = await setup(page);
	await page.getByTestId('network-connect').click();
	const sheet = page.getByTestId('network-connect-sheet');
	await sheet.getByText('Custom', { exact: true }).click();
	await sheet.getByLabel('IP address', { exact: true }).fill('192.168.1.9');
	await expect(sheet.getByTestId('network-submit')).toBeDisabled();
	await sheet.getByLabel('IP address', { exact: true }).fill(IP);
	await sheet.getByLabel('Alias and hostname', { exact: true }).fill('Bad_Name');
	await expect(sheet.getByTestId('network-submit')).toBeDisabled();
	await sheet.getByLabel('Alias and hostname', { exact: true }).fill('phone-dev');
	await expect(sheet.getByTestId('network-submit')).toBeEnabled();
	await sheet.getByText('Any address', { exact: true }).click();
	await sheet.getByTestId('network-submit').click();
	await expect(sheet).toBeHidden();
	expect(writes[0].body).toEqual({ network: NETWORK, onlyNetwork: false, setHostname: false });
	state.listFails = true;
	await page.getByTestId('network-connect').click();
	await expect(sheet.getByRole('alert')).toContainText('Network discovery failed');
	await fit(page);
});

test('reconnect conflict opens choices; hostname failures remain visible', async ({ page }) => {
	const { writes, state } = await setup(page, { saved: true });
	state.fail = 409;
	await page.getByTestId('network-reconnect').click();
	const sheet = page.getByTestId('network-connect-sheet');
	await expect(sheet).toBeVisible();
	expect(writes).toHaveLength(1);
	state.fail = 0;
	state.hostnameFails = true;
	await sheet.getByTestId('network-submit').click();
	await expect(sheet.getByRole('status')).toContainText('Hostname permission denied');
	await expect(sheet).toBeVisible();
	await sheet.getByRole('button', { name: 'Done' }).click();
	await expect(page.getByTestId('attached-network')).toContainText(IP);
});

test('stopped containers cannot connect or launch shells', async ({ page }) => {
	await setup(page, { stopped: true });
	await expect(page.getByTestId('network-connect')).toBeDisabled();
	await expect(page.getByTestId('container-terminal')).toBeDisabled();
	await expect(page.getByTestId('container-start')).toBeEnabled();
	await expect(page.getByText('Start the container to connect it to a network.')).toBeVisible();
});

test('reconnect succeeds once and shows partial hostname failures', async ({ page }) => {
	const { writes, state } = await setup(page, { saved: true });
	state.hostnameFails = true;
	await page.getByTestId('network-reconnect').click();
	await expect(page.getByTestId('attached-network')).toContainText(IP);
	await expect(page.getByRole('status').filter({ hasText: 'Connected.' })).toContainText(
		'Hostname permission denied'
	);
	expect(writes).toHaveLength(1);
	await expect(page.getByTestId('network-reconnect')).toHaveCount(0);
});

test('a refused connect stays open without retrying or saving', async ({ page }) => {
	const { writes, state } = await setup(page);
	state.fail = 503;
	state.failMessage = 'Docker could not connect';
	await page.getByTestId('network-connect').click();
	const sheet = page.getByTestId('network-connect-sheet');
	await sheet.getByTestId('network-submit').click();
	await expect(sheet.getByRole('alert')).toContainText('Docker could not connect');
	await expect(sheet).toBeVisible();
	expect(writes).toHaveLength(1);
	expect(
		await page.evaluate(() => localStorage.getItem('devcontainer-dashboard-network-memory'))
	).toBeNull();
});
