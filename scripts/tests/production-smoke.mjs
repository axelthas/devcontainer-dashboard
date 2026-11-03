// Run against a disposable built server only. See ../README.md.
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

function terminalUrl(base, parameters = {}) {
  const url = new URL('/api/terminal', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url;
}

async function checkMissingPassword() {
  const child = spawn(process.execPath, ['build/server.js'], {
    env: { ...process.env, DASHBOARD_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let diagnostic = '';
  child.stderr.on('data', (data) => (diagnostic += data));
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
    assert.match(diagnostic, /DASHBOARD_PASSWORD/);
  } finally { clearTimeout(timeout); }
}

async function startServer(state, password) {
  await checkMissingPassword();
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  state.base = `http://127.0.0.1:${port}`;
  state.child = spawn(process.execPath, ['build/server.js'], {
    env: { ...process.env, DASHBOARD_PASSWORD: password, PORT: String(port),
      WORKSPACE_ROOT: state.temp, BUILD_LOG_DIR: join(state.temp, 'logs'), ORIGIN: state.base, SHELL: '/bin/sh' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  state.child.stdout.on('data', (data) => (state.output += data));
  state.child.stderr.on('data', (data) => (state.output += data));
}

async function waitForReadiness(state) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (state.child && state.child.exitCode !== null) throw new Error(`Server exited: ${state.output}`);
    try {
      const response = await fetch(`${state.base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) {
        assert.deepEqual(await response.json(), { status: 'ready' });
        return;
      }
    } catch { /* Retry while the compiled handler initializes. */ }
    await sleep(100);
  }
  throw new Error(`Server did not become ready: ${state.output}`);
}

async function login(base, password) {
  assert.equal((await fetch(`${base}/healthz`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${base}/api/containers`, { redirect: 'manual' })).status, 401);
  assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).status, 303);
  const post = (value) => fetch(`${base}/login`, { method: 'POST', headers: { Origin: base },
    body: new URLSearchParams({ password: value, next: '/' }), redirect: 'manual' });
  assert.equal((await post('wrong-password')).status, 400);
  const response = await post(password);
  assert.equal(response.status, 303);
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  assert.ok(cookie?.startsWith('devcontainer-dashboard-session='));
  return cookie;
}

function checkUpgrade(base, cookie, expectedStatus, origin = base) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(terminalUrl(base), {
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, handshakeTimeout: 5000
    });
    socket.on('error', reject);
    socket.on('open', () => {
      socket.close();
      try { assert.equal(expectedStatus, 101); resolve(); } catch (error) { reject(error); }
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      try { assert.equal(response.statusCode, expectedStatus); resolve(); } catch (error) { reject(error); }
    });
  });
}

function waitForTerminal(base, cookie, parameters, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(terminalUrl(base, parameters), {
      headers: { Origin: base, Cookie: cookie }, handshakeTimeout: 5000
    });
    let text = '';
    let exitCode;
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('Terminal/build timeout'));
    }, timeoutMs);
    socket.on('error', (error) => { clearTimeout(timeout); reject(error); });
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'data') text += message.data;
        if (message.type === 'exit') exitCode = message.exitCode;
      } catch (error) { clearTimeout(timeout); socket.terminate(); reject(error); }
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      try { assert.equal(exitCode, 0, `Terminal/build failed: ${text}`); resolve(text); }
      catch (error) { reject(error); }
    });
  });
}

async function checkTerminal(base, cookie) {
  const text = await waitForTerminal(base, cookie, { sessionId: `smoke-${randomUUID()}`, cwd: '/tmp',
    command: "printf 'production-'; printf 'terminal-ok\\n'" });
  assert.match(text, /production-terminal-ok/);
  if (!process.env.SMOKE_EXPECT_UID) return;
  const identity = await waitForTerminal(base, cookie, { sessionId: `identity-${randomUUID()}`, cwd: '/tmp',
    command: 'node -e \'console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),user:process.env.USER,logname:process.env.LOGNAME,home:process.env.HOME,bootstrap:process.env.PATH.includes(process.env.HOME+"/.local/bin")}))\'' });
  const record = JSON.parse(identity.match(/\{"uid":[^\r\n]+\}/)?.[0] ?? 'null');
  assert.deepEqual(record, { uid: Number(process.env.SMOKE_EXPECT_UID), gid: Number(process.env.SMOKE_EXPECT_GID),
    user: process.env.HOST_USER, logname: process.env.HOST_USER, home: process.env.HOST_HOME, bootstrap: true });
}

async function checkFixtureBuild(base, cookie) {
  const repoPath = process.env.SMOKE_FIXTURE_WORKSPACE;
  if (!repoPath) return;
  assert.equal(process.env.SMOKE_FIXTURE_CLEANUP_OWNER, 'external',
    'Fixture builds require an external cleanup owner; use container-smoke.sh');
  // Exercise the same authenticated route and persistent build PTY as the UI.
  const response = await fetch(`${base}/api/devcontainer/build`, { method: 'POST',
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath, repoName: 'smoke-fixture', configPath: '.devcontainer/devcontainer.json' }) });
  assert.equal(response.status, 200, 'fixture build API must accept the request');
  const { id } = await response.json();
  assert.ok(id);
  await waitForTerminal(base, cookie, { sessionId: id }, 180000);
}

async function checkBootstrapDiscovery(base, cookie) {
  if (process.env.SMOKE_EXPECT_BOOTSTRAP !== '1') return;
  const response = await fetch(`${base}/api/bootstrap/providers`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const providers = await response.json();
  assert.ok(providers.some((provider) => provider.id === 'devbootstrap' &&
    provider.repoPath === `${process.env.HOST_HOME}/.devbootstrap`));
  await waitForTerminal(base, cookie, { sessionId: `bootstrap-${randomUUID()}`, cwd: '/tmp',
    command: 'command -v devbootstrap >/dev/null' });
}

async function cleanup(state) {
  if (state.child && state.child.exitCode === null) {
    const exit = once(state.child, 'exit');
    state.child.kill('SIGTERM');
    const timeout = setTimeout(() => state.child.kill('SIGKILL'), 5000);
    try { await exit; } finally { clearTimeout(timeout); }
  }
  await rm(state.temp, { recursive: true, force: true });
}

async function main() {
  if (process.env.SMOKE_FIXTURE_WORKSPACE) {
    assert.ok(process.env.SMOKE_BASE_URL, 'Fixture builds require a disposable external server');
    assert.equal(process.env.SMOKE_FIXTURE_CLEANUP_OWNER, 'external',
      'Use container-smoke.sh or explicitly own sibling-container cleanup');
  }
  const state = { temp: await mkdtemp(join(tmpdir(), 'ddash-production-')), base: process.env.SMOKE_BASE_URL, output: '', child: undefined };
  const password = process.env.SMOKE_PASSWORD ?? 'production-smoke-password';
  try {
    if (!state.base) await startServer(state, password);
    state.base = new URL(state.base).origin;
    await waitForReadiness(state);
    const cookie = await login(state.base, password);
    await checkUpgrade(state.base, undefined, 401);
    await checkUpgrade(state.base, 'devcontainer-dashboard-session=invalid', 401);
    await checkUpgrade(state.base, cookie, 401, 'https://untrusted.invalid');
    await checkUpgrade(state.base, cookie, 101);
    await checkTerminal(state.base, cookie);
    await checkBootstrapDiscovery(state.base, cookie);
    await checkFixtureBuild(state.base, cookie);
    console.log('PASS: built-server readiness, HTTP login, WebSocket authorization and PTY output');
    if (process.env.SMOKE_FIXTURE_WORKSPACE) console.log('PASS: dashboard build API and sibling devcontainer startup');
  } finally { await cleanup(state); }
}

await main();
