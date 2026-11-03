// Test standalone launchers without a Docker daemon or real deployment.
//
// Usage: node --test scripts/tests/run-production.test.mjs (Node 22).
// Mock Git, passwd lookup and Docker calls in temporary directories; preserve argv
// and exported identity in a call log. Tests cover identity validation, sudo capture,
// bootstrap selection, same-path mounts, origin input and retained failure resources.
// Interactive curl-piped cases require util-linux script for a disposable PTY.
// No real image is built or pulled. Do not infer Docker/privilege behavior from these
// mocks. node:test owns discovery and execution; fixture cleanup is registered per test.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Create mock Git/passwd/Docker commands and an isolated environment for launcher tests.
// Record exact argv and exported identity; register deletion of temporary resources with the test.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ddash-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$*" in
*--show-toplevel*) echo "$FIXTURE_ROOT" ;;
*--porcelain*) printf '%s' "\${DIRTY_OUTPUT:-}" ;;
*symbolic-ref*) test "\${DETACHED:-}" != 1 || exit 1; echo feature/test ;;
*) echo abcdef1234567890 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'getent'), '#!/bin/sh\necho "$2:x:4567:5678::/home/original:/bin/bash"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args, user:process.env.HOST_USER, uid:process.env.HOST_UID, gid:process.env.HOST_GID, home:process.env.HOST_HOME, origin:process.env.ORIGIN})+'\\n');
if(args[0]==='container') process.exit(process.env.EXISTING==='1'?0:1);
if(args[0]==='buildx' && args[1]==='build' && process.env.FAIL_BUILD==='1') process.exit(2);
if(args[0]==='run' && process.env.FAIL_RUN==='1') process.exit(2);
if(args[0]==='exec' && process.env.FAIL_HTTP==='1') process.exit(3);
if(args.includes('config') && process.env.FAIL_CONFIG==='1') process.exit(2);
if(args[0]==='inspect') console.log(args[2].includes('Health') ? (process.env.HEALTH||'healthy') : (process.env.STATE||'running'));
`, { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ROOT: dir,
    CALL_LOG: log, DASHBOARD_PASSWORD: 'never-log-this', DASHBOARD_TEST_NAME: 'ddash-test',
    DASHBOARD_HEALTH_TIMEOUT: '1', DASHBOARD_TEST_PORT: '3001', DOCKER_DEFAULT_PLATFORM: '',
    HOST_USER: 'operator', HOST_UID: '2345', HOST_GID: '3456', HOST_HOME: '/home/operator',
    WORKSPACE_ROOT: join(dir, 'workspace with spaces'), DOCKER_SOCKET: '/host/docker.sock',
    SSH_AUTH_SOCK: '', ORIGIN: '', DDASH_ORIGIN: '', DDASH_NONINTERACTIVE: '1',
    DDASH_CREATE_WORKSPACE: '0', DDASH_DEV_BOOTSTRAP: '0', DDASH_SSH_DIRECTORY: '0',
    DDASH_CONFIG_DIR: join(dir, 'config')
  };
  return {
    dir, env,
    // Execute the fixture copy with per-test overrides; return captured output/status (and recorded calls).
    run(script = 'run-production.sh', args = [], overrides = {}, interactive = false, input = '\n') {
      const path = join(root, 'scripts', script);
      const result = spawnSync(interactive ? 'script' : 'bash', interactive
        ? ['-q', '-e', '-c', `cat '${path}' | bash`, '/dev/null'] : [path, ...args], {
        encoding: 'utf8', timeout: 10000, input, env: { ...env, ...overrides }
      });
      const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      return { ...result, calls };
    }
  };
}

for (const script of ['run-production.sh', 'run-dashboard.sh', 'run-dashboard-compose.sh']) {
  test(`${script}: explicit identity, bootstrap selection, no secrets`, (t) => {
    const f = fixture(t);
    const r = f.run(script, [], { DDASH_DEV_BOOTSTRAP: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dev-bootstrap: 1/);
    assert.doesNotMatch(r.stdout + r.stderr + JSON.stringify(r.calls), /never-log-this/);
    const call = r.calls.find(c => c.args[0] === 'run' || c.args.includes('up'));
    assert.deepEqual([call.user, call.uid, call.gid, call.home], ['operator', '2345', '3456', '/home/operator']);
    if (script.includes('compose')) {
      const yaml = readFileSync(join(f.dir, 'config/docker-compose.yml'), 'utf8');
      assert.match(yaml, /command: \["dev-bootstrap"\]/);
      assert.match(yaml, /source: '\/host\/docker.sock'/);
      assert.match(yaml, /create_host_path: false/);
      assert.doesNotMatch(yaml, /never-log-this/);
    } else {
      assert.equal(call.args.at(-1), 'dev-bootstrap');
    }
  });
  test(`${script}: captures the original sudo operator`, (t) => {
    const r = fixture(t).run(script, [], { HOST_USER: '', HOST_UID: '', HOST_GID: '', HOST_HOME: '', SUDO_USER: 'original' });
    assert.equal(r.status, 0, r.stderr);
    const call = r.calls.at(-1);
    assert.deepEqual([call.user, call.uid, call.gid, call.home], ['original', '4567', '5678', '/home/original']);
  });
  for (const overrides of [
    { HOST_UID: '0' }, { HOST_GID: '0' }, { HOST_UID: '01' }, { HOST_UID: '2147483648' },
    { HOST_HOME: '' }, { HOST_HOME: '/home/../etc' }, { HOST_HOME: '/home//operator' },
    { HOST_HOME: '/dashboard-history/operator' }, { HOST_HOME: '/etc/operator' },
    { DDASH_DEV_BOOTSTRAP: 'yes' }, { DOCKER_SOCKET: 'relative' }
  ]) {
    test(`${script}: rejects ${JSON.stringify(overrides)}`, (t) => {
      const r = fixture(t).run(script, [], overrides);
      assert.notEqual(r.status, 0);
      assert.ok(!r.calls.some(c => c.args[0] === 'run' || c.args.includes('up')));
    });
  }
  test(`${script}: help needs no identity, password or daemon`, (t) => {
    const r = fixture(t).run(script, ['--help'], { HOST_UID: '', DASHBOARD_PASSWORD: '' });
    assert.equal(r.status, 0);
    assert.equal(r.calls.length, 0);
  });
}

test('production: current checkout, platform, port, origin fallback, same-path SSH and history', (t) => {
  const f = fixture(t);
  const r = f.run('run-production.sh', ['--port', '4317', '--platform', 'linux/amd64'], {
    DIRTY_OUTPUT: ' M file', DDASH_ORIGIN: 'https://dashboard.example',
    DDASH_SSH_DIRECTORY: '1', SSH_AUTH_SOCK: '/run/user/2345/agent'
  });
  assert.equal(r.status, 0, r.stderr);
  const build = r.calls.find(c => c.args[0] === 'buildx' && c.args[1] === 'build');
  assert.ok(build.args.includes('--load') && !build.args.includes('--push'));
  assert.equal(build.args.at(-1), '.');
  const run = r.calls.find(c => c.args[0] === 'run');
  assert.equal(run.origin, 'https://dashboard.example');
  assert.ok(run.args.includes('127.0.0.1:4317:3000'));
  assert.ok(run.args.includes('linux/amd64') && build.args.includes('linux/amd64'));
  assert.ok(run.args.includes('type=bind,source=/run/user/2345/agent,target=/run/user/2345/agent,readonly'));
  assert.ok(run.args.includes('type=bind,source=/home/operator/.ssh,target=/home/operator/.ssh,readonly'));
  assert.ok(run.args.includes('ddash-test-zsh:/dashboard-history'));
  assert.match(r.stdout, /local changes: true/);
});

for (const env of [{ STATE: 'exited' }, { HEALTH: 'none' }, { HEALTH: 'unhealthy' }, { HEALTH: 'starting' }, { FAIL_HTTP: '1' }, { FAIL_RUN: '1' }]) {
  test(`production: failure keeps test resources: ${JSON.stringify(env)}`, (t) => {
    const r = fixture(t).run('run-production.sh', [], env);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /Ready:/);
    assert.ok(!r.calls.some(c => ['rm', 'stop', 'kill'].includes(c.args[0])));
  });
}
for (const [args, env] of [[['--port', '65536'], {}], [['--socket'], {}], [['--replace'], {}], [[], { EXISTING: '1' }], [[], { FAIL_BUILD: '1' }], [[], { DASHBOARD_PASSWORD: '' }]]) {
  test(`production: does not start on invalid input/build failure ${JSON.stringify([args, env])}`, (t) => {
    const r = fixture(t).run('run-production.sh', args, env);
    assert.notEqual(r.status, 0);
    assert.ok(!r.calls.some(c => c.args[0] === 'run'));
  });
}

for (const [answer, expected] of [
  ['', ''], ['https://dashboard.example/', 'https://dashboard.example'],
  ['http://[::1]:3000', 'http://[::1]:3000'],
  ['https://example.com/path\nhttps://example.com', 'https://example.com'],
  ['https://example.com:65536\nhttps://example.com', 'https://example.com'],
  ['https://${SECRET}\nhttps://example.com', 'https://example.com']
]) {
  test(`curl-piped Compose origin: ${JSON.stringify(answer)}`, (t) => {
    const f = fixture(t);
    const r = f.run('run-dashboard-compose.sh', [], { DDASH_NONINTERACTIVE: '0' }, true, answer + '\n');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(readFileSync(join(f.dir, 'config/docker-compose.yml'), 'utf8').includes(`ORIGIN: '${expected}'`));
  });
}

test('production: help after another option does not require a daemon', (t) => {
  const r = fixture(t).run('run-production.sh', ['--port', '3001', '--help'], { HOST_UID: '' });
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 0);
});

test('Compose: non-interactive SSH resource rendering and invalid-config preservation', (t) => {
  const f = fixture(t);
  let r = f.run('run-dashboard-compose.sh', [], { SSH_AUTH_SOCK: '/run/agent socket', DDASH_SSH_DIRECTORY: '1' });
  assert.equal(r.status, 0, r.stderr);
  const file = join(f.dir, 'config/docker-compose.yml');
  const before = readFileSync(file, 'utf8');
  assert.match(before, /SSH_AUTH_SOCK: '\/run\/agent socket'/);
  assert.match(before, /read_only: true/);
  assert.doesNotMatch(before, /env_file:/);
  r = f.run('run-dashboard-compose.sh', [], { FAIL_CONFIG: '1' });
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(file, 'utf8'), before);
});

for (const origin of ['https://example.com/path', 'https://example.com:0', 'https://${SECRET}']) {
  test(`Compose: invalid unattended origin ${origin}`, (t) => {
    const r = fixture(t).run('run-dashboard-compose.sh', [], { ORIGIN: origin });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Invalid ORIGIN/);
  });
}
