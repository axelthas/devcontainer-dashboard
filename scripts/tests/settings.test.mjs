/** Settings bridge regressions with private disposable files and no Docker access. */
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	existsSync,
	statSync,
	symlinkSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bridge = join(root, 'scripts/devharbour_settings.py');
const sentinel = 'fixture-secret-do-not-expose-123';
/** Prepare a private realistic config directory with a managed environment input. */
function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), 'devharbour-settings-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, 'config.json');
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
			'env-file': ['devcontainer.env']
		}
	};
	writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
	writeFileSync(join(dir, 'password'), sentinel, { mode: 0o600 });
	writeFileSync(
		join(dir, 'devcontainer.env'),
		'# keep this comment\nTERN_USE_CCACHE=1\nOPENCODE_PORT=4096\nOPENCODE_PASSWORD=' +
			sentinel +
			'\nCUSTOM_TOKEN=' +
			sentinel +
			'\n',
		{ mode: 0o600 }
	);
	return { dir, path, config };
}
/** Send one JSON request without putting secret values into process arguments. */
function request(f, body = {}) {
	const result = spawnSync('python3', [bridge, '--config', f.path], {
		cwd: root,
		input: JSON.stringify(body),
		encoding: 'utf8'
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, '');
	assert.ok(!result.stdout.includes(sentinel), 'secret leaked in response');
	return JSON.parse(result.stdout);
}
/** Read a new revision before an operation. */
function read(f) {
	const result = request(f);
	assert.equal(result.ok, true);
	return result.data;
}

test('reads one shared schema, defaults and redacted inputs', (t) => {
	const f = fixture(t);
	const data = read(f);
	assert.equal(data.schema.properties.settings.properties.port.default, 3000);
	assert.equal(
		data.schema.properties.settings.properties.workspace.default,
		'/home/operator/devharbour-workspaces'
	);
	assert.equal(data.pending, true);
	assert.equal(data.environment.find((v) => v.name === 'OPENCODE_PASSWORD').value, undefined);
	assert.equal(data.environment.find((v) => v.name === 'CUSTOM_TOKEN').value, undefined);
	assert.equal(data.environment.find((v) => v.name === 'OPENCODE_PORT').value, '4096');
});
test('saves valid typed configuration without touching applied state', (t) => {
	const f = fixture(t);
	const before = read(f);
	f.config.settings.port = 3010;
	const result = request(f, { operation: 'save', revision: before.revision, config: f.config });
	assert.equal(result.ok, true);
	assert.equal(result.data.config.settings.port, 3010);
	assert.equal(statSync(f.path).mode & 0o777, 0o600);
	assert.equal(existsSync(f.path + '.state.json'), false);
	assert.notEqual(result.data.revision, before.revision);
});
test('rejects stale saves and preserves newer host edits', (t) => {
	const f = fixture(t);
	const old = read(f);
	f.config.settings.port = 3011;
	writeFileSync(f.path, JSON.stringify(f.config));
	const result = request(f, { operation: 'save', revision: old.revision, config: old.config });
	assert.equal(result.status, 409);
	assert.equal(JSON.parse(readFileSync(f.path)).settings.port, 3011);
});
test('invalid types, unknown fields and invalid port combinations preserve config', (t) => {
	const f = fixture(t);
	const before = read(f);
	const bytes = readFileSync(f.path, 'utf8');
	for (const settings of [
		{ port: '3000' },
		{ surprise: 'value' },
		{ port: 3002 },
		{ port: 0 },
		{ port: true }
	]) {
		const config = structuredClone(f.config);
		Object.assign(config.settings, settings);
		assert.equal(request(f, { operation: 'save', revision: before.revision, config }).ok, false);
		assert.equal(readFileSync(f.path, 'utf8'), bytes);
	}
});
test('remote exposure requires explicit approval', (t) => {
	const f = fixture(t);
	const before = read(f);
	f.config.settings['bind-address'] = '0.0.0.0';
	assert.equal(
		request(f, { operation: 'save', revision: before.revision, config: f.config }).status,
		409
	);
	assert.equal(
		request(f, {
			operation: 'save',
			revision: before.revision,
			config: f.config,
			allowExposure: true
		}).ok,
		true
	);
});
test('password rotation uses a private new file, never changes the running input', (t) => {
	const f = fixture(t);
	const before = read(f);
	const result = request(f, {
		operation: 'password',
		revision: before.revision,
		password: sentinel
	});
	assert.equal(result.ok, true);
	const path = result.data.config.settings['password-file'];
	assert.notEqual(path, join(f.dir, 'password'));
	assert.equal(readFileSync(path, 'utf8').trim(), sentinel);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(readFileSync(join(f.dir, 'password'), 'utf8'), sentinel);
});
test('env updates preserve comments and existing secrets through copy-on-write', (t) => {
	const f = fixture(t);
	const before = read(f);
	const result = request(f, {
		operation: 'environment',
		revision: before.revision,
		updates: { TERN_USE_CCACHE: '0', NEW_TOKEN: sentinel }
	});
	assert.equal(result.ok, true);
	const path = result.data.config.settings['env-file'][0];
	assert.match(readFileSync(path, 'utf8'), /# keep this comment/);
	assert.match(readFileSync(path, 'utf8'), /TERN_USE_CCACHE=0/);
	assert.match(readFileSync(join(f.dir, 'devcontainer.env'), 'utf8'), /TERN_USE_CCACHE=1/);
	assert.equal(statSync(path).mode & 0o777, 0o600);
});
test('refuses unsafe config permissions and symlinks', (t) => {
	const f = fixture(t);
	chmodSync(f.path, 0o644);
	assert.equal(request(f).ok, false);
	chmodSync(f.path, 0o600);
	const link = join(f.dir, 'link.json');
	symlinkSync(f.path, link);
	assert.equal(request({ ...f, path: link }).ok, false);
});
test('rejects password reference and immutable instance edits', (t) => {
	const f = fixture(t);
	const before = read(f);
	for (const change of [
		(c) => (c.settings['password-file'] = '/etc/passwd'),
		(c) => (c.instanceName = 'other')
	]) {
		const config = structuredClone(f.config);
		change(config);
		assert.equal(request(f, { operation: 'save', config, revision: before.revision }).ok, false);
	}
});
test('refuses the host CLI lock without losing data', async (t) => {
	const f = fixture(t);
	const locker = spawn('python3', [
		'-c',
		'import fcntl,sys,time; f=open(sys.argv[1],"w");fcntl.flock(f,fcntl.LOCK_EX);print("locked",flush=True);time.sleep(30)',
		f.path + '.lock'
	]);
	t.after(() => locker.kill());
	await new Promise((resolve) => locker.stdout.once('data', resolve));
	chmodSync(f.path + '.lock', 0o600);
	assert.equal(request(f).status, 409);
	locker.kill();
});
test('new CLI lifecycle verbs parse and use the shared setting definitions', () => {
	const code =
		"import sys;sys.path.insert(0,'scripts');import devharbour as d;from devharbour_schema import PROPERTIES;assert set(PROPERTIES)==d.STRINGS|d.NUMBERS|d.BOOLEANS|{'env-file'};[d.parser().parse_args([c]) for c in ['start','restart','open','setup','apply']];print('ok')";
	const result = spawnSync('python3', ['-c', code], { cwd: root, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), 'ok');
});

test('minimal setup asks only for the password twice and keeps integrations off', () => {
	const code = `import sys,os,pwd
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0,'scripts')
import devharbour as d
import devharbour_quickstart as q
args=d.parser().parse_args([])
config={'schemaVersion':1,'instanceName':'devharbour','restartPolicy':'always','settings':{}}
questions=[]
def password(prompt):
 questions.append(prompt);return 'fixture-password-12345'
original=Path.exists
def exists(path):
 return False if str(path)=='/.dockerenv' else original(path)
with patch.object(Path,'exists',exists),patch.object(d,'discover_host_agents',return_value=([{'path':'/run/user/1000/gcr/ssh'}],None)),patch.object(q.getpass,'getpass',side_effect=password),patch.object(sys.stdin,'isatty',return_value=True):
 result=q.quickstart(d,config,args)
assert result=='fixture-password-12345' and len(questions)==2
assert config['settings']['port']==3000 and config['settings']['bind-address']=='127.0.0.1'
assert not any(config['settings'].get(k) for k in ['brain','brain-funnel','bootstrap','tailscale-socket'])
print('ok')`;
	const result = spawnSync('python3', ['-c', code], { cwd: root, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), 'ok');
});
test('ambiguous agent discovery never prompts for or writes a password', () => {
	const code = `import sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,'scripts')
import devharbour as d
import devharbour_quickstart as q
args=d.parser().parse_args([])
config={'schemaVersion':1,'instanceName':'devharbour','restartPolicy':'always','settings':{}}
with patch.object(Path,'exists',return_value=False),patch.object(d,'discover_host_agents',return_value=([],None)),patch.object(q.getpass,'getpass',side_effect=AssertionError('must not prompt')):
 try:q.quickstart(d,config,args)
 except d.CliError:pass
 else:raise AssertionError('ambiguous host agent was accepted')
assert 'password-file' not in config['settings']
print('ok')`;
	const result = spawnSync('python3', ['-c', code], { cwd: root, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), 'ok');
});
test('the managed CLI launcher passes the canonical config path as literal data', (t) => {
	const f = fixture(t);
	const code = `import sys
from pathlib import Path
sys.path.insert(0,'scripts')
import devharbour as d
config=d.read_json(Path(sys.argv[1]))
a=d.launch_argv(config,d.normalized(config,Path(sys.argv[1]).parent),'0'*64,'0'*64,config_path=sys.argv[1])
assert a[a.index('--managed-config')+1]==sys.argv[1]
print('ok')`;
	const result = spawnSync('python3', ['-c', code, f.path], { cwd: root, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), 'ok');
});

test('environment edits replace every duplicate assignment of the updated key', (t) => {
	const f = fixture(t);
	writeFileSync(
		join(f.dir, 'devcontainer.env'),
		'TERN_USE_CCACHE=1\n# retained\nTERN_USE_CCACHE=1\n',
		{ mode: 0o600 }
	);
	const before = read(f);
	const result = request(f, {
		operation: 'environment',
		revision: before.revision,
		updates: { TERN_USE_CCACHE: '0' }
	});
	assert.equal(result.ok, true);
	const content = readFileSync(result.data.config.settings['env-file'][0], 'utf8');
	assert.equal(content.match(/TERN_USE_CCACHE=/g).length, 1);
	assert.match(content, /TERN_USE_CCACHE=0/);
	assert.match(content, /# retained/);
});
