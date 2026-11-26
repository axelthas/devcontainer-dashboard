#!/usr/bin/env node
/**
 * Capture the DevHarbour screenshots used in README.md.
 *
 * The script starts the built custom server with a temporary demo workspace and
 * replaces every browser data request with fixed demo data. The screenshots
 * therefore never show containers, repositories, hostnames or agent activity from
 * the machine that runs the script. The script makes no Docker changes.
 *
 * Build both outputs first, then run the script from the repository root:
 *
 *   npm run build && npm run build:server
 *   node scripts/capture-readme-screenshots.mjs
 *
 * Set SCREENSHOT_DIR to write the PNG files somewhere other than docs/screenshots.
 * Set SCREENSHOT_FORBIDDEN_TERMS to a comma-separated list of extra private words.
 * The script refuses to save a screenshot that shows one of them.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const PORT = 4183;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUTPUT_DIR = resolve(process.env.SCREENSHOT_DIR ?? 'docs/screenshots');
const PASSWORD = randomBytes(24).toString('hex');
/** Workspace root shown in the screenshots instead of the temporary directory. */
const DISPLAY_ROOT = '/home/dev/devharbour-workspaces';
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = {
	viewport: { width: 393, height: 852 },
	deviceScaleFactor: 2,
	isMobile: true,
	hasTouch: true,
	userAgent:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
};

/** Create demo Git repositories in the workspace layout that DevHarbour scans. */
function createDemoWorkspace(root) {
	const repositories = [
		['checkout', 'checkout-api', true],
		['checkout', 'payments-sdk', false],
		['storefront', 'web-portal', false]
	];
	for (const [project, name, compose] of repositories) {
		const path = join(root, project, name);
		mkdirSync(join(path, '.devcontainer'), { recursive: true });
		writeFileSync(join(path, '.devcontainer/devcontainer.json'), '{ "name": "' + name + '" }\n');
		if (compose) writeFileSync(join(path, 'compose.yaml'), 'services:\n  api:\n    image: api\n');
		execFileSync('git', ['init', '--quiet', '--initial-branch', 'main', path]);
	}
}

/** Return the fixed demo containers, with workspace paths under the displayed root. */
function demoContainers(root = DISPLAY_ROOT) {
	const checkout = join(root, 'checkout/checkout-api');
	const portal = join(root, 'storefront/web-portal');
	const devcontainer = (id, name, path, ports, state = 'running') => ({
		id,
		name: '/' + name,
		projectName: name,
		state,
		isDevcontainer: true,
		ports,
		image: `vsc-${name}-features-uid`,
		localWorkspacePath: path,
		devcontainerConfigFile: join(path, '.devcontainer/devcontainer.json'),
		containerWorkspaceFolder: '/workspaces/' + name,
		remoteUser: 'dev',
		remoteUserSource: 'remoteUser',
		networks: [
			{ name: 'bridge', ip: state === 'running' ? '172.17.0.' + id.length : '', aliases: [] }
		]
	});
	const service = (id, name, image, ports) => ({
		id,
		name: '/checkout-sandbox-' + name + '-1',
		projectName: 'checkout-sandbox',
		state: 'running',
		isDevcontainer: false,
		ports,
		image,
		composeProject: 'checkout-sandbox',
		composeService: name,
		composeWorkingDir: checkout,
		sandboxTag: '2.3.0',
		networks: [{ name: 'checkout-sandbox_default', ip: '172.20.0.' + id.at(-1), aliases: [name] }]
	});
	return [
		devcontainer('a1b2c3d4e5f6', 'checkout-api', checkout, { 3000: '3000', 4096: '4096' }),
		devcontainer('b2c3d4e5f6a1', 'web-portal', portal, { 5173: '5173', 6904: '6904' }),
		service('c3d4e5f6a1b2', 'api', 'ghcr.io/example/checkout-api:2.3.0', { 8080: '8080' }),
		service('d4e5f6a1b2c3', 'postgres', 'postgres:16', { 5432: '5432' }),
		service('e5f6a1b2c3d4', 'redis', 'redis:7', { 6379: '6379' })
	];
}

/** Return demo agent activity: one grant, one running command and one result. */
function demoAgentStatus(withGrant) {
	if (!withGrant) return { enabled: true, grants: [], executions: [], audit: [] };
	const now = Date.now();
	const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
	const grant = {
		id: 'g_demo',
		containerId: 'a1b2c3d4e5f6',
		containerName: '/checkout-api',
		kind: 'devcontainer',
		startedAt: at(90),
		user: 'dev',
		userSource: 'container',
		exposure: [],
		createdAt: at(12),
		expiresAt: new Date(now + 48 * 60_000).toISOString(),
		runningExecutions: 1,
		intent: 'Fix the failing checkout tests'
	};
	const command = (id, text, goal, status, minutes) => ({
		id,
		grantId: grant.id,
		containerName: grant.containerName,
		kind: 'command',
		command: text,
		goal,
		user: 'dev',
		workdir: '/workspaces/checkout-api',
		interactive: false,
		controller: 'brain',
		status,
		startedAt: at(minutes),
		...(status === 'exited' ? { exitCode: 0, endedAt: at(minutes - 0.2) } : {})
	});
	return {
		enabled: true,
		grants: [grant],
		executions: [
			command(
				'x_tests',
				'npm test -- --run checkout',
				'Run the checkout tests after the fix.',
				'running',
				1
			),
			command(
				'x_status',
				'git status --short',
				'Confirm that only checkout files changed.',
				'exited',
				3
			)
		],
		audit: []
	};
}

/** Return demo output for one agent command. */
function demoOutput(id) {
	const done = id === 'x_status';
	const text = done
		? ' M src/checkout/total.ts\n M src/checkout/total.spec.ts\n'
		: ' RUN  v4.1.3 /workspaces/checkout-api\n\n ✓ src/checkout/total.spec.ts (12 tests) 41ms\n ✓ src/checkout/tax.spec.ts (8 tests) 18ms\n';
	return {
		executionId: id,
		text,
		cursor: 0,
		nextCursor: text.length,
		truncatedBefore: false,
		more: false,
		status: done ? 'exited' : 'running',
		...(done ? { exitCode: 0 } : {})
	};
}

/** Start the compiled server with demo-only settings and wait until it is ready. */
async function startServer(root) {
	const server = spawn('node', ['build/server.js'], {
		env: {
			PATH: process.env.PATH,
			HOME: root,
			PORT: String(PORT),
			DASHBOARD_PASSWORD: PASSWORD,
			WORKSPACE_ROOT: join(root, 'devharbour-workspaces'),
			HOST_HOSTNAME: 'harbour',
			PRESETS_FILE: join(root, 'presets.json'),
			BOOTSTRAP_PROVIDERS_FILE: join(root, 'bootstrap-providers.json')
		},
		stdio: ['ignore', 'ignore', 'inherit']
	});
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			if ((await fetch(BASE_URL + '/healthz')).ok) return server;
		} catch {
			// The server is still starting.
		}
		await new Promise((done) => setTimeout(done, 200));
	}
	server.kill();
	throw new Error('The server did not become ready. Build both outputs first.');
}

/** Create a signed-in browser context whose data requests return demo data. */
async function demoContext(browser, options, workspaceRoot, withGrant) {
	const context = await browser.newContext({ ...options, baseURL: BASE_URL, colorScheme: 'dark' });
	await context.addInitScript(() => {
		localStorage.setItem('devcontainer-dashboard-theme', 'dark');
		localStorage.setItem('devcontainer-dashboard-view', 'list');
	});
	const containers = demoContainers();
	const running = new Set(
		containers.filter((c) => c.state === 'running').map((c) => c.localWorkspacePath)
	);
	// Registered first, so the specific demo routes below take precedence over it.
	await context.route(BASE_URL + '/**', async (route) => {
		const request = route.request();
		if (request.resourceType() !== 'document' && !request.url().includes('__data.json'))
			return route.continue();
		const response = await route.fetch();
		const body = (await response.text()).replaceAll(workspaceRoot, DISPLAY_ROOT);
		await route.fulfill({ response, body });
	});
	await context.route('**/api/containers', (route) => route.fulfill({ json: containers }));
	await context.route('**/api/networks', (route) => route.fulfill({ json: [] }));
	await context.route('**/api/terminal/sessions', (route) => route.fulfill({ json: [] }));
	await context.route('**/api/brain', (route) =>
		route.fulfill({ json: demoAgentStatus(withGrant) })
	);
	await context.route('**/api/brain/executions/*', (route) =>
		route.fulfill({ json: demoOutput(new URL(route.request().url()).pathname.split('/').at(-1)) })
	);
	await context.route('**/api/workspaces', async (route) => {
		// Mark repositories as running from the demo containers, not from the real Docker host.
		const text = await (await route.fetch()).text();
		const workspaces = JSON.parse(text.replaceAll(workspaceRoot, DISPLAY_ROOT));
		for (const workspace of workspaces)
			for (const repo of workspace.repos) repo.isRunning = running.has(repo.path);
		await route.fulfill({ json: workspaces });
	});
	const login = await context.request.post('/login', {
		form: { password: PASSWORD },
		headers: { Origin: BASE_URL, 'x-sveltekit-action': 'true' }
	});
	if (!login.ok()) throw new Error('Demo login failed');
	return context;
}

/** Return visible host details that must never appear in a published screenshot. */
function privateTerms() {
	const terms = [hostname().split('.')[0], homedir(), userInfo().username, tmpdir() + '/'];
	const extra = process.env.SCREENSHOT_FORBIDDEN_TERMS ?? '';
	return [...terms, ...extra.split(',')]
		.map((term) => term.trim())
		.filter((term) => term.length >= 3);
}

/** Stop before saving a PNG when the page shows a private host detail. */
async function assertNoPrivateTerms(page) {
	const text = await page.evaluate(() =>
		[
			document.body.innerText,
			...[...document.querySelectorAll('input')].map((input) => input.value)
		].join('\n')
	);
	const found = privateTerms().filter((term) => text.toLowerCase().includes(term.toLowerCase()));
	if (found.length)
		throw new Error('A screenshot would show private host details. Nothing was saved.');
}

/** Open a page, wait for demo data to replace the first render, and save a PNG. */
async function capture(context, path, file, ready) {
	const page = await context.newPage();
	await page.goto(path);
	await page.getByText(ready, { exact: false }).first().waitFor();
	await page.evaluate(() => document.fonts.ready);
	// Polling never goes idle, so let the last demo response and transitions settle.
	await page.waitForTimeout(1500);
	await assertNoPrivateTerms(page);
	await page.screenshot({ path: join(OUTPUT_DIR, file) });
	await page.close();
	console.log('Saved ' + join(OUTPUT_DIR, file));
}

/** Capture every README screenshot and clean up the demo server and files. */
async function main() {
	const root = mkdtempSync(join(tmpdir(), 'devharbour-screenshots-'));
	const workspaceRoot = join(root, 'devharbour-workspaces');
	createDemoWorkspace(workspaceRoot);
	mkdirSync(OUTPUT_DIR, { recursive: true });
	const server = await startServer(root);
	const browser = await chromium.launch();
	try {
		const desktop = await demoContext(browser, DESKTOP, workspaceRoot, false);
		await capture(desktop, '/', 'desktop-dashboard.png', 'checkout-sandbox');
		const agent = await demoContext(browser, DESKTOP, workspaceRoot, true);
		await capture(agent, '/', 'desktop-agent.png', 'Run the checkout tests after the fix.');
		const phone = await demoContext(browser, PHONE, workspaceRoot, true);
		await capture(phone, '/mobile/containers', 'mobile-containers.png', 'web-portal');
		await capture(phone, '/mobile/services', 'mobile-services.png', 'checkout-sandbox');
		await capture(
			phone,
			'/mobile/brain',
			'mobile-agent.png',
			'Run the checkout tests after the fix.'
		);
	} finally {
		await browser.close();
		server.kill();
		rmSync(root, { recursive: true, force: true });
	}
}

await main();
