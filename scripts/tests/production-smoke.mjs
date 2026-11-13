// Exercise a compiled custom server. Use only disposable local or external fixtures.
// Optional SMOKE_* identity/bootstrap/build expectations match container-smoke.sh.
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

// Convert the browser origin to an attach-only terminal URL.
function terminalUrl(base, id) {
	const url = new URL('/api/terminal', base);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	if (id) url.searchParams.set('sessionId', id);
	return url;
}

// Require startup failure without a password before starting the disposable server.
async function checkMissingPassword() {
	const child = spawn(process.execPath, ['build/server.js'], {
		env: { ...process.env, DASHBOARD_PASSWORD: '' },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let diagnostic = '';
	child.stderr.on('data', (data) => (diagnostic += data));
	const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
	try {
		const [code] = await once(child, 'exit');
		assert.notEqual(code, 0);
		assert.match(diagnostic, /DASHBOARD_PASSWORD/);
	} finally {
		clearTimeout(timer);
	}
}

// Reserve a port and start the actual built Node entry point with isolated data.
async function startServer(state, password) {
	await checkMissingPassword();
	const reservation = createServer().listen(0, '127.0.0.1');
	await once(reservation, 'listening');
	const port = reservation.address().port;
	await new Promise((resolve) => reservation.close(resolve));
	state.base = `http://127.0.0.1:${port}`;
	state.child = spawn(process.execPath, ['build/server.js'], {
		env: {
			...process.env,
			DASHBOARD_PASSWORD: password,
			PORT: String(port),
			WORKSPACE_ROOT: state.temp,
			BUILD_LOG_DIR: join(state.temp, 'logs'),
			ORIGIN: state.base,
			SHELL: '/bin/sh'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	state.child.stdout.on('data', (data) => (state.output += data));
	state.child.stderr.on('data', (data) => (state.output += data));
}

// Bound startup probing and include server diagnostics on failure.
async function readiness(state) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (state.child?.exitCode != null) throw new Error(state.output);
		try {
			const response = await fetch(`${state.base}/healthz`, { signal: AbortSignal.timeout(1000) });
			if (response.ok) {
				assert.deepEqual(await response.json(), { status: 'ready' });
				return;
			}
		} catch {
			/* Retry startup only. */
		}
		await sleep(100);
	}
	throw new Error(`Readiness deadline exceeded: ${state.output}`);
}

// Use the real login form contract, including its trusted-origin requirement.
async function login(base, password) {
	assert.equal((await fetch(`${base}/healthz`, { method: 'HEAD' })).status, 200);
	assert.equal((await fetch(`${base}/api/containers`, { redirect: 'manual' })).status, 401);
	assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).status, 303);
	const post = (value) =>
		fetch(`${base}/login`, {
			method: 'POST',
			headers: { Origin: base, Accept: 'text/html' },
			body: new URLSearchParams({ password: value, next: '/' }),
			redirect: 'manual'
		});
	assert.equal((await post('wrong-password')).status, 400);
	const response = await post(password);
	assert.equal(response.status, 303);
	const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
	assert.ok(cookie?.startsWith('devcontainer-dashboard-session='));
	return cookie;
}

// Probe WebSocket authentication without creating a process.
function checkUpgrade(base, cookie, expected, origin = base) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(terminalUrl(base), {
			headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
			handshakeTimeout: 5000
		});
		socket.on('error', reject);
		socket.on('open', () => {
			socket.close();
			try {
				assert.equal(expected, 101);
				resolve();
			} catch (error) {
				reject(error);
			}
		});
		socket.on('unexpected-response', (_request, response) => {
			response.resume();
			try {
				assert.equal(response.statusCode, expected);
				resolve();
			} catch (error) {
				reject(error);
			}
		});
	});
}

// Explicitly create commands through HTTP; an existing build only attaches by ID.
async function waitForTerminal(base, cookie, parameters, timeoutMs = 10000) {
	if (parameters.command !== undefined) {
		const response = await fetch(`${base}/api/terminal/sessions`, {
			method: 'POST',
			headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				id: parameters.sessionId,
				name: 'Smoke',
				kind: 'shell',
				command: parameters.command,
				cwd: parameters.cwd
			})
		});
		assert.ok(response.ok, `Explicit terminal creation failed: ${response.status}`);
	}
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(terminalUrl(base, parameters.sessionId), {
			headers: { Origin: base, Cookie: cookie },
			handshakeTimeout: 5000
		});
		let text = '';
		let exitCode;
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error('Terminal deadline exceeded'));
		}, timeoutMs);
		socket.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		socket.on('message', (raw) => {
			try {
				const message = JSON.parse(raw.toString());
				if (message.type === 'ready') text = message.output ?? '';
				if (message.type === 'data') text += message.data;
				if (message.type === 'exit') exitCode = message.exitCode;
			} catch (error) {
				clearTimeout(timer);
				socket.terminate();
				reject(error);
			}
		});
		socket.on('close', () => {
			clearTimeout(timer);
			try {
				assert.equal(exitCode, 0, text);
				resolve(text);
			} catch (error) {
				reject(error);
			}
		});
	});
}

// Verify real PTY output plus optional container identity and bootstrap expectations.
async function checkTerminal(base, cookie) {
	assert.match(
		await waitForTerminal(base, cookie, {
			sessionId: `smoke-${randomUUID()}`,
			cwd: '/tmp',
			command: "printf 'production-'; printf 'terminal-ok\\n'"
		}),
		/production-terminal-ok/
	);
	if (process.env.SMOKE_EXPECT_UID) {
		const output = await waitForTerminal(base, cookie, {
			sessionId: `identity-${randomUUID()}`,
			cwd: '/tmp',
			command:
				'node -e \'console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),user:process.env.USER,logname:process.env.LOGNAME,home:process.env.HOME,bootstrap:process.env.PATH.includes(process.env.HOME+"/.local/bin")}))\''
		});
		assert.deepEqual(JSON.parse(output.match(/\{"uid":[^\r\n]+\}/)?.[0] ?? 'null'), {
			uid: Number(process.env.SMOKE_EXPECT_UID),
			gid: Number(process.env.SMOKE_EXPECT_GID),
			user: process.env.HOST_USER,
			logname: process.env.LOGNAME,
			home: process.env.HOST_HOME,
			bootstrap: true
		});
	}
	if (process.env.SMOKE_EXPECT_BOOTSTRAP === '1') {
		const response = await fetch(`${base}/api/bootstrap/providers`, {
			headers: { Cookie: cookie }
		});
		assert.equal(response.status, 200);
		assert.ok(
			(await response.json()).some(
				(provider) =>
					provider.id === 'devbootstrap' &&
					provider.repoPath === `${process.env.HOST_HOME}/.devbootstrap`
			)
		);
		await waitForTerminal(base, cookie, {
			sessionId: `bootstrap-${randomUUID()}`,
			cwd: '/tmp',
			command: 'command -v devbootstrap >/dev/null'
		});
	}
}

// Start only explicitly owned disposable sibling-container fixtures.
async function checkFixtureBuild(base, cookie) {
	if (!process.env.SMOKE_FIXTURE_WORKSPACE) return;
	assert.ok(process.env.SMOKE_BASE_URL);
	assert.equal(process.env.SMOKE_FIXTURE_CLEANUP_OWNER, 'external');
	const response = await fetch(`${base}/api/devcontainer/build`, {
		method: 'POST',
		headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			repoPath: process.env.SMOKE_FIXTURE_WORKSPACE,
			repoName: 'smoke-fixture',
			configPath: '.devcontainer/devcontainer.json'
		})
	});
	assert.equal(response.status, 200);
	const { id } = await response.json();
	assert.ok(id);
	await waitForTerminal(base, cookie, { sessionId: id }, 180000);
}

// Always stop the owned local server; external fixture cleanup remains with its owner.
async function main() {
	if (process.env.SMOKE_FIXTURE_WORKSPACE) {
		assert.ok(process.env.SMOKE_BASE_URL);
		assert.equal(process.env.SMOKE_FIXTURE_CLEANUP_OWNER, 'external');
	}
	const state = {
		temp: await mkdtemp(join(tmpdir(), 'ddash-production-')),
		base: process.env.SMOKE_BASE_URL,
		output: '',
		child: undefined
	};
	try {
		const password = process.env.SMOKE_PASSWORD ?? 'production-smoke-password';
		if (!state.base) await startServer(state, password);
		state.base = new URL(state.base).origin;
		await readiness(state);
		const cookie = await login(state.base, password);
		await checkUpgrade(state.base, undefined, 401);
		await checkUpgrade(state.base, 'devcontainer-dashboard-session=invalid', 401);
		await checkUpgrade(state.base, cookie, 401, 'https://untrusted.invalid');
		await checkUpgrade(state.base, cookie, 101);
		await checkTerminal(state.base, cookie);
		await checkFixtureBuild(state.base, cookie);
		console.log(
			'PASS: compiled-server login, upgrade auth, explicit session creation and PTY output'
		);
	} finally {
		if (state.child && state.child.exitCode === null) {
			const exit = once(state.child, 'exit');
			state.child.kill('SIGTERM');
			const timer = setTimeout(() => state.child.kill('SIGKILL'), 5000);
			try {
				await exit;
			} finally {
				clearTimeout(timer);
			}
		}
		await rm(state.temp, { recursive: true, force: true });
	}
}
await main();
