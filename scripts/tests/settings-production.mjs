/** Disposable Settings acceptance against the built custom HTTP server.
 * No real Docker actions, existing configurations or operator credentials are used.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

/** Reserve a free port without assuming the operator has stopped another service. */
async function freePort() {
	const probe = createServer();
	probe.listen(0, '127.0.0.1');
	await once(probe, 'listening');
	const port = probe.address().port;
	await new Promise((resolve) => probe.close(resolve));
	return port;
}
/** Run one self-contained acceptance sequence and clean up only its fixtures. */
async function main() {
	const dir = await mkdtemp(join(tmpdir(), 'devharbour-settings-browser-'));
	const configPath = join(dir, 'config.json');
	const password = 'settings-fixture-password-123';
	const config = {
		schemaVersion: 1,
		instanceName: 'devharbour',
		restartPolicy: 'always',
		settings: {
			'host-user': 'operator',
			'host-uid': process.getuid(),
			'host-gid': process.getgid(),
			'host-home': '/home/operator',
			'ssh-agent-socket': '/run/user/1000/gcr/ssh',
			'password-file': 'password',
			port: 3000,
			'env-file': ['devcontainer.env']
		}
	};
	await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
	await writeFile(join(dir, 'password'), password, { mode: 0o600 });
	await writeFile(
		join(dir, 'devcontainer.env'),
		'# fixture\nTERN_USE_CCACHE=1\nOPENCODE_PASSWORD=redaction-fixture-12345\n',
		{ mode: 0o600 }
	);
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const server = spawn('node', ['build/server.js'], {
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			PORT: String(port),
			ORIGIN: origin,
			DASHBOARD_PASSWORD: password,
			DEVHARBOUR_CONFIG: configPath,
			WORKSPACE_ROOT: dir,
			AI_ENABLED: '0',
			BRAIN_MCP_ENABLED: '0'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let log = '';
	server.stdout.on('data', (b) => (log += b));
	server.stderr.on('data', (b) => (log += b));
	let browser;
	try {
		let ready = false;
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(origin + '/healthz')).ok) {
					ready = true;
					break;
				}
			} catch {
				/* Wait for the child listener. */
			}
			if (server.exitCode !== null) throw new Error('Fixture server exited: ' + log);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(ready, 'production server did not become ready');
		assert.equal((await fetch(origin + '/api/settings')).status, 401);
		assert.equal(
			(
				await fetch(origin + '/api/settings', {
					method: 'POST',
					headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' },
					body: '{}'
				})
			).status,
			403
		);
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		const page = await context.newPage();
		const problems = [];
		page.on('pageerror', (error) => problems.push(error.message));
		await page.goto(origin + '/settings');
		await page.getByLabel('Password', { exact: true }).fill(password);
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await page.waitForURL(origin + '/settings');
		await page.getByLabel('DevHarbour web port', { exact: true }).waitFor();
		assert.ok(!(await page.content()).includes('redaction-fixture-12345'));
		const stale = await context.newPage();
		await stale.goto(origin + '/settings');
		await page.getByLabel('DevHarbour web port', { exact: true }).fill('3010');
		await page.getByRole('button', { name: 'Review and save' }).click();
		await page.getByRole('dialog').getByRole('button', { name: 'Save only' }).click();
		await page.getByText('Saved on the host.', { exact: false }).waitFor();
		assert.equal(JSON.parse(await readFile(configPath, 'utf8')).settings.port, 3010);
		await page.locator('#access-mode').selectOption('custom');
		await page.getByRole('button', { name: 'Review and save' }).click();
		assert.equal(
			await page.getByRole('dialog').getByRole('button', { name: 'Save only' }).isDisabled(),
			true
		);
		await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
		await page.getByRole('button', { name: 'Discard', exact: true }).click();
		assert.equal(
			JSON.parse(await readFile(configPath, 'utf8')).settings['bind-address'],
			undefined
		);
		await stale.getByLabel('DevHarbour web port', { exact: true }).fill('3011');
		await stale.getByRole('button', { name: 'Review and save' }).click();
		await stale.getByRole('dialog').getByRole('button', { name: 'Save only' }).click();
		await stale
			.getByRole('dialog')
			.getByText('Settings changed on the host.', { exact: false })
			.waitFor();
		assert.equal(JSON.parse(await readFile(configPath, 'utf8')).settings.port, 3010);
		await stale.close();
		await page
			.getByRole('navigation', { name: 'Settings sections' })
			.getByRole('button', { name: 'Devcontainers' })
			.click();
		await page.locator('#env-TERN_USE_CCACHE').fill('0');
		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().endsWith('/api/settings') &&
					response.request().method() === 'POST' &&
					response.status() === 200
			),
			page.getByRole('button', { name: 'Save environment' }).click()
		]);
		await page.locator('#env-TERN_USE_CCACHE').waitFor();
		await page.waitForFunction(() => document.querySelector('#env-TERN_USE_CCACHE')?.value === '0');
		let saved = JSON.parse(await readFile(configPath, 'utf8'));
		assert.match(await readFile(saved.settings['env-file'][0], 'utf8'), /TERN_USE_CCACHE=0/);
		await page
			.getByRole('navigation', { name: 'Settings sections' })
			.getByRole('button', { name: 'Access', exact: true })
			.click();
		await page.getByLabel('New password', { exact: true }).fill('new-fixture-password-12345');
		await page.getByLabel('Repeat password', { exact: true }).fill('new-fixture-password-12345');
		await page.getByRole('button', { name: 'Save new password' }).click();
		await page.waitForFunction(() => document.querySelector('#password')?.value === '');
		saved = JSON.parse(await readFile(configPath, 'utf8'));
		assert.equal(
			(await readFile(saved.settings['password-file'], 'utf8')).trim(),
			'new-fixture-password-12345'
		);
		assert.equal((await readFile(join(dir, 'password'), 'utf8')).trim(), password);
		await page.getByRole('button', { name: 'Reload Settings', exact: true }).click();
		await page.getByLabel('DevHarbour web port', { exact: true }).waitFor();
		assert.equal(
			await page.getByLabel('DevHarbour web port', { exact: true }).inputValue(),
			'3010'
		);
		await page.setViewportSize({ width: 390, height: 844 });
		assert.ok(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			'mobile page overflows horizontally'
		);
		await page.getByRole('button', { name: 'Toggle theme' }).click();
		assert.ok(
			await page.locator('.settings-app').evaluate((element) => element.classList.contains('light'))
		);
		assert.deepEqual(problems, []);
		console.log(
			'PASS: production auth/origin checks, desktop save, stale-editor rejection, env/password rotation, secret redaction, mobile width and theme.'
		);
	} finally {
		await browser?.close();
		server.kill('SIGTERM');
		if (server.exitCode === null)
			await Promise.race([
				once(server, 'exit'),
				new Promise((resolve) =>
					setTimeout(() => {
						server.kill('SIGKILL');
						resolve();
					}, 3000)
				)
			]);
		await rm(dir, { recursive: true, force: true });
	}
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
