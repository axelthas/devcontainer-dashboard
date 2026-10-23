// Run after npm run build && npm run build:server, or point SMOKE_BASE_URL
// at a disposable built container. Never use a shared production instance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const password = process.env.SMOKE_PASSWORD ?? 'production-smoke-password';
const temp = await mkdtemp(join(tmpdir(), 'ddash-production-'));
let child;
let base = process.env.SMOKE_BASE_URL;
let output = '';

function upgrade(cookie, expectedStatus, origin = base) {
	return new Promise((resolve, reject) => {
		const url = new URL('/api/terminal', base);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		// Omit sessionId: test the real upgrade without creating a persistent PTY.
		const socket = new WebSocket(url, {
			headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
			handshakeTimeout: 5000
		});
		socket.on('error', reject);
		socket.on('open', () => {
			socket.close();
			try {
				assert.equal(expectedStatus, 101);
				resolve();
			} catch (error) {
				reject(error);
			}
		});
		socket.on('unexpected-response', (_request, response) => {
			response.resume();
			socket.terminate();
			try {
				assert.equal(response.statusCode, expectedStatus);
				resolve();
			} catch (error) {
				reject(error);
			}
		});
	});
}

async function terminal(cookie) {
	const url = new URL('/api/terminal', base);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.searchParams.set('sessionId', `smoke-${randomUUID()}`);
	url.searchParams.set('cwd', '/tmp');
	// Output the marker in two writes to avoid matching a command echo.
	url.searchParams.set('command', "printf 'production-'; printf 'terminal-ok\\n'");
	await new Promise((resolve, reject) => {
		const socket = new WebSocket(url, { headers: { Origin: base, Cookie: cookie } });
		let text = '';
		let exited = false;
		const timeout = setTimeout(() => {
			socket.terminate();
			reject(new Error('Terminal output/exit timeout'));
		}, 10000);
		socket.on('error', (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		socket.on('message', (raw) => {
			const message = JSON.parse(raw.toString());
			if (message.type === 'data') text += message.data;
			if (message.type === 'exit') {
				exited = message.exitCode === 0;
			}
		});
		socket.on('close', () => {
			clearTimeout(timeout);
			try {
				assert.ok(exited, 'terminal must exit successfully');
				assert.match(text, /production-terminal-ok/);
				resolve();
			} catch (error) {
				reject(error);
			}
		});
	});
}

try {
	if (!base) {
		// Check that the built server cannot listen without the required password.
		const unconfigured = spawn(process.execPath, ['build/server.js'], {
			env: { ...process.env, DASHBOARD_PASSWORD: '' },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let diagnostic = '';
		unconfigured.stderr.on('data', (data) => (diagnostic += data));
		const timeout = setTimeout(() => unconfigured.kill('SIGKILL'), 5000);
		const [code] = await once(unconfigured, 'exit');
		clearTimeout(timeout);
		assert.notEqual(code, 0);
		assert.match(diagnostic, /DASHBOARD_PASSWORD/);

		const reservation = createServer();
		reservation.listen(0, '127.0.0.1');
		await once(reservation, 'listening');
		const port = reservation.address().port;
		await new Promise((resolve) => reservation.close(resolve));
		base = `http://127.0.0.1:${port}`;
		child = spawn(process.execPath, ['build/server.js'], {
			env: {
				...process.env,
				DASHBOARD_PASSWORD: password,
				PORT: String(port),
				WORKSPACE_ROOT: temp,
				BUILD_LOG_DIR: join(temp, 'logs'),
				ORIGIN: base,
				SHELL: '/bin/sh'
			},
			stdio: ['ignore', 'pipe', 'pipe']
		});
		child.stdout.on('data', (data) => (output += data));
		child.stderr.on('data', (data) => (output += data));
	}
	base = new URL(base).origin;
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child && child.exitCode !== null) throw new Error(`Server exited: ${output}`);
		try {
			const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
			if (response.status === 200) {
				assert.deepEqual(await response.json(), { status: 'ready' });
				ready = true;
				break;
			}
		} catch {
			// Retry while the compiled handler initializes.
		}
		await sleep(100);
	}
	assert.ok(ready, `Server did not become ready: ${output}`);
	assert.equal((await fetch(`${base}/healthz`, { method: 'HEAD' })).status, 200);
	assert.equal((await fetch(`${base}/api/containers`, { redirect: 'manual' })).status, 401);
	assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).status, 303);
	const invalid = await fetch(`${base}/login`, {
		method: 'POST',
		headers: { Origin: base },
		body: new URLSearchParams({ password: 'wrong-password' }),
		redirect: 'manual'
	});
	assert.equal(invalid.status, 400);
	const login = await fetch(`${base}/login`, {
		method: 'POST',
		headers: { Origin: base },
		body: new URLSearchParams({ password, next: '/' }),
		redirect: 'manual'
	});
	assert.equal(login.status, 303);
	const cookie = login.headers.getSetCookie()[0]?.split(';')[0];
	assert.ok(cookie?.startsWith('devcontainer-dashboard-session='));
	await upgrade(undefined, 401);
	await upgrade('devcontainer-dashboard-session=invalid', 401);
	await upgrade(cookie, 401, 'https://untrusted.invalid');
	await upgrade(cookie, 101);
	await terminal(cookie);
	console.log('PASS: built-server readiness, HTTP login, WebSocket authorization, and PTY output');
} finally {
	if (child && child.exitCode === null) {
		const exit = once(child, 'exit');
		child.kill('SIGTERM');
		const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
		await exit;
		clearTimeout(timeout);
	}
	await rm(temp, { recursive: true, force: true });
}
