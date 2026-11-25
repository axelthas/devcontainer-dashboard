// DevHarbour CLI and installer regressions. Docker is a per-test fake executable.
// Run with `npm run test:cli`. These tests do not establish real Docker behavior.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'scripts/devharbour.py');
const installer = join(root, 'scripts/install-devharbour.sh');
const secret = 'fixture-secret-never-print';

// Prepare private per-test configuration and a stateful, fully isolated Docker fake.
function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), 'devharbour-cli-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const config = join(dir, 'config.json');
	const password = join(dir, 'password');
	writeFileSync(password, secret + '\n', { mode: 0o600 });
	const log = join(dir, 'docker-calls');
	writeFileSync(log, '');
	const state = join(dir, 'docker-state');
	writeFileSync(
		join(bin, 'docker'),
		`#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
a=sys.argv[1:]
with open(os.environ['CLI_CALLS'],'a') as f: f.write(json.dumps(a)+'\\n')
p=Path(os.environ['CLI_STATE'])
c=json.loads(p.read_text()) if p.exists() else None
if a[:2]==['container','inspect']:
 if c: print(json.dumps([c]))
 else: print('Error: No such container',file=sys.stderr); sys.exit(1)
elif a[0]=='ps':
 if os.environ.get('VOLUME_IN_USE'): print('other-container')
elif a[:2]==['volume','inspect']:
 if os.environ.get('EXISTING_VOLUMES'): print('[]')
 else: sys.exit(1)
elif a[:2]==['image','inspect']:
 if os.environ.get('MISSING_IMAGE'): sys.exit(1)
elif a[0]=='run':
 if os.environ.get('FAIL_RUN'): sys.exit(2)
 labels={a[i+1].split('=',1)[0]:a[i+1].split('=',1)[1] for i,v in enumerate(a) if v=='--label'}
 image=a[-1] if a[-1]!='dev-bootstrap' else a[-2]
 c={'Id':'fixture-container','Config':{'Labels':labels,'Image':image},'State':{'Status':'running'},'Mounts':[{'Type':'volume','Name':a[i+1].split(':')[0],'Destination':a[i+1].split(':')[1]} for i,v in enumerate(a) if v=='--volume']}
 p.write_text(json.dumps(c)); print('fixture-container')
elif a[0]=='start':
 c['State']['Status']='running'; p.write_text(json.dumps(c))
elif a[0]=='stop':
 c['State']['Status']='exited'; p.write_text(json.dumps(c))
elif a[0]=='rm':
 p.unlink()
elif a[0]=='exec':
 if 'ssh-add' in a: sys.exit(int(os.environ.get('AGENT_STATUS','0')))
 if os.environ.get('FAIL_READY'): sys.exit(1)
elif a[0]=='info' and os.environ.get('FAIL_DOCKER'): sys.exit(1)
`,
		{ mode: 0o755 }
	);
	const env = {
		...process.env,
		PATH: bin + ':' + process.env.PATH,
		CLI_CALLS: log,
		CLI_STATE: state
	};
	const flags = ['--config', config, '--non-interactive'];
	const identity = [
		'--host-user',
		'operator',
		'--host-uid',
		'2345',
		'--host-gid',
		'3456',
		'--host-home',
		'/home/operator',
		'--ssh-agent-socket',
		'/run/user/2345/agent',
		'--password-file',
		password,
		'--no-create-workspace',
		'--workspace',
		'/home/operator/workspaces'
	];
	return {
		dir,
		bin,
		config,
		password,
		log,
		state,
		env,
		flags,
		identity,
		exec(args = [], extra = {}) {
			return spawnSync('python3', [cli, ...flags, ...args], {
				env: { ...env, ...extra },
				encoding: 'utf8',
				detached: true,
				timeout: 15000
			});
		},
		read() {
			return JSON.parse(readFileSync(config, 'utf8'));
		},
		calls() {
			return readFileSync(log, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((v) => JSON.parse(v));
		},
		save(value) {
			writeFileSync(config, JSON.stringify(value), { mode: 0o600 });
		},
		container(value) {
			writeFileSync(state, JSON.stringify(value));
		}
	};
}

// Assert command status with diagnostics only on failure.
function ok(result) {
	assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
}
function fails(result, pattern) {
	assert.notEqual(result.status, 0);
	assert.match(result.stdout + result.stderr, pattern);
}
function base(f) {
	ok(f.exec(['configure', ...f.identity]));
}

test('help and version require neither config nor Docker', (t) => {
	const f = fixture(t);
	ok(f.exec(['--help'], { PATH: '/usr/bin:/bin' }));
	ok(f.exec(['--version']));
	assert.equal(existsSync(f.config), false);
	assert.deepEqual(f.calls(), []);
});
test('missing unattended settings fail without a config or Docker calls', (t) => {
	const f = fixture(t);
	fails(f.exec(['configure']), /Missing required/);
	assert.equal(existsSync(f.config), false);
	assert.deepEqual(f.calls(), []);
});
test('configure persists explicit typed inputs without Docker or secret values', (t) => {
	const f = fixture(t);
	base(f);
	const c = f.read();
	assert.equal(c.schemaVersion, 1);
	assert.equal(c.instanceName, 'devharbour');
	assert.equal(c.settings['host-uid'], 2345);
	assert.equal(c.settings['password-file'], f.password);
	assert.equal(readFileSync(f.config, 'utf8').includes(secret), false);
	assert.deepEqual(f.calls(), []);
	assert.equal(statSync(f.config).mode & 0o777, 0o600);
});
test('updates retain unspecified settings and clear optional booleans', (t) => {
	const f = fixture(t);
	base(f);
	ok(f.exec(['configure', '--bootstrap', '--port', '3010']));
	assert.equal(f.read().settings.bootstrap, true);
	assert.equal(f.read().settings.port, 3010);
	ok(f.exec(['configure', '--clear', 'bootstrap']));
	assert.equal('bootstrap' in f.read().settings, false);
	assert.equal(f.read().settings.port, 3010);
});
for (const [name, change] of [
	['unknown key', (c) => (c.settings.typo = true)],
	['wrong boolean type', (c) => (c.settings.bootstrap = 'yes')],
	['boolean as integer', (c) => (c.settings.port = true)],
	['unsupported schema', (c) => (c.schemaVersion = 2)],
	['unknown top-level key', (c) => (c.extra = 1)],
	['invalid port', (c) => (c.settings.port = 70000)],
	['identity zero', (c) => (c.settings['host-uid'] = 0)],
	['invalid instance', (c) => (c.instanceName = '../bad')]
])
	test(name + ' fails without changing existing configuration', (t) => {
		const f = fixture(t);
		base(f);
		const c = f.read();
		change(c);
		f.save(c);
		const before = readFileSync(f.config, 'utf8');
		assert.notEqual(f.exec(['configure']).status, 0);
		assert.equal(readFileSync(f.config, 'utf8'), before);
		assert.deepEqual(f.calls(), []);
	});
test('malformed JSON fails without echoing contents', (t) => {
	const f = fixture(t);
	writeFileSync(f.config, '{' + secret, { mode: 0o600 });
	const r = f.exec(['configure']);
	fails(r, /Invalid JSON/);
	assert.equal((r.stdout + r.stderr).includes(secret), false);
});
test('insecure config permissions and symlinks are rejected', (t) => {
	const f = fixture(t);
	base(f);
	chmodSync(f.config, 0o644);
	fails(f.exec(['configure']), /0600/);
	rmSync(f.config);
	symlinkSync(f.password, f.config);
	fails(f.exec(['configure']), /0600/);
});
test('password files must be private, regular and nonempty', (t) => {
	const f = fixture(t);
	chmodSync(f.password, 0o644);
	fails(f.exec(['configure', ...f.identity]), /0600/);
	chmodSync(f.password, 0o600);
	writeFileSync(f.password, '');
	fails(f.exec(['configure', ...f.identity]), /empty/);
	assert.equal(existsSync(f.config), false);
});
test('relative env and secret paths resolve against config directory', (t) => {
	const f = fixture(t);
	writeFileSync(join(f.dir, 'runtime.env'), 'SAFE=value\n');
	ok(
		f.exec(['configure', ...f.identity, '--password-file', 'password', '--env-file', 'runtime.env'])
	);
	assert.equal(f.read().settings['password-file'], 'password');
	assert.equal(f.read().settings['env-file'][0], 'runtime.env');
	assert.deepEqual(f.calls(), []);
});
test('missing env file fails before changing config', (t) => {
	const f = fixture(t);
	base(f);
	const before = readFileSync(f.config, 'utf8');
	fails(f.exec(['configure', '--env-file', 'missing.env']), /readable regular file/);
	assert.equal(readFileSync(f.config, 'utf8'), before);
});
test('remote access requires explicit approval in unattended mode', (t) => {
	const f = fixture(t);
	base(f);
	fails(f.exec(['configure', '--bind-address', '0.0.0.0']), /Not approved/);
	assert.equal(f.read().settings['bind-address'], undefined);
	ok(f.exec(['configure', '--bind-address', '0.0.0.0', '--allow-exposure']));
});
test('first run creates one detached owned instance and verifies application and Docker separately', (t) => {
	const f = fixture(t);
	ok(f.exec(f.identity));
	const calls = f.calls();
	const launch = calls.find((a) => a[0] === 'run');
	assert.equal(launch[launch.indexOf('--name') + 1], 'devharbour');
	assert.ok(launch.includes('dashboard_data:/data'));
	assert.ok(launch.includes('ddash_zsh_data:/dashboard-history'));
	assert.ok(launch.includes('type=volume,source=dashboard_ai,target=/dashboard-ai'));
	assert.ok(launch.includes('--detach'));
	assert.ok(launch.includes('--restart'));
	assert.ok(launch.includes('always'));
	assert.ok(!launch.includes('--rm'));
	assert.ok(calls.some((a) => a[0] === 'exec' && a.some((v) => v.includes("path:'/_ping'"))));
	assert.ok(calls.some((a) => a.includes('ssh-add')));
	assert.ok(existsSync(f.config + '.state.json'));
	assert.equal(JSON.stringify(calls).includes(secret), false);
});
test('unchanged run reuses the same instance without pulling or recreating', (t) => {
	const f = fixture(t);
	ok(f.exec(f.identity));
	writeFileSync(f.log, '');
	ok(f.exec());
	assert.equal(
		f.calls().some((a) => ['run', 'pull', 'start', 'rm'].includes(a[0])),
		false
	);
});
test('stopped unchanged instance resumes without a new container', (t) => {
	const f = fixture(t);
	ok(f.exec(f.identity));
	ok(f.exec(['stop']));
	writeFileSync(f.log, '');
	ok(f.exec());
	assert.ok(f.calls().some((a) => a[0] === 'start'));
	assert.equal(
		f.calls().some((a) => a[0] === 'run'),
		false
	);
});
test('changed settings save desired state but require explicit replacement', (t) => {
	const f = fixture(t);
	ok(f.exec(f.identity));
	const state = readFileSync(f.config + '.state.json', 'utf8');
	writeFileSync(f.log, '');
	fails(f.exec(['--port', '3010']), /Not approved/);
	assert.equal(f.read().settings.port, 3010);
	assert.equal(readFileSync(f.config + '.state.json', 'utf8'), state);
	assert.equal(
		f.calls().some((a) => a[0] === 'rm'),
		false
	);
	ok(f.exec(['--replace']));
	assert.ok(f.calls().some((a) => a[0] === 'rm' && !a.includes('-v')));
});
test('secret changes require recreation but never print the secret', (t) => {
	const f = fixture(t);
	ok(f.exec(f.identity));
	writeFileSync(f.password, secret + '-changed\n');
	const r = f.exec();
	fails(r, /replacement/);
	assert.equal((r.stdout + r.stderr).includes(secret), false);
});
test('foreign container is not adopted, stopped or removed implicitly', (t) => {
	const f = fixture(t);
	base(f);
	f.container({
		Id: 'foreign',
		Config: { Labels: {}, Image: 'legacy' },
		State: { Status: 'running' },
		Mounts: []
	});
	fails(f.exec(), /not owned/);
	fails(f.exec(['--replace', '--adopt']), /volume mapping/);
	assert.equal(
		f.calls().some((a) => a[0] === 'rm' || a[0] === 'stop'),
		false
	);
});
test('retained volumes require an explicit adoption decision', (t) => {
	const f = fixture(t);
	fails(f.exec(f.identity, { EXISTING_VOLUMES: '1' }), /Retained volume/);
	assert.equal(
		f.calls().some((a) => a[0] === 'run'),
		false
	);
	ok(f.exec(['--adopt', '--replace'], { EXISTING_VOLUMES: '1' }));
});
test('existing image is not refreshed; missing image is pulled', (t) => {
	const f = fixture(t);
	ok(f.exec(f.identity));
	assert.equal(
		f.calls().some((a) => a[0] === 'pull'),
		false
	);
	const g = fixture(t);
	ok(g.exec(g.identity, { MISSING_IMAGE: '1' }));
	assert.ok(g.calls().some((a) => a[0] === 'pull'));
});
test('launch failure saves desired config but not last-applied state', (t) => {
	const f = fixture(t);
	fails(f.exec(f.identity, { FAIL_RUN: '1' }), /not confirmed ready/);
	assert.ok(existsSync(f.config));
	assert.equal(existsSync(f.config + '.state.json'), false);
});
test('readiness timeout never claims success or writes applied state', (t) => {
	const f = fixture(t);
	const r = f.exec([...f.identity, '--health-timeout', '1'], { FAIL_READY: '1' });
	fails(r, /Readiness timed out/);
	assert.equal(r.stdout.includes('Ready:'), false);
	assert.equal(existsSync(f.config + '.state.json'), false);
});
test('stale agent on a reused instance fails, empty agent is distinct', (t) => {
	const f = fixture(t);
	ok(f.exec(f.identity));
	fails(f.exec([], { AGENT_STATUS: '2' }), /stale or inaccessible/);
	const r = f.exec([], { AGENT_STATUS: '1' });
	ok(r);
	assert.match(r.stdout, /no loaded identities/);
});
test('Docker failure occurs before a first config save', (t) => {
	const f = fixture(t);
	fails(f.exec(f.identity, { FAIL_DOCKER: '1' }), /Command failed/);
	assert.equal(existsSync(f.config), false);
});
test('management commands never modify config and reject setting arguments', (t) => {
	const f = fixture(t);
	ok(f.exec(f.identity));
	const before = readFileSync(f.config, 'utf8');
	ok(f.exec(['status']));
	ok(f.exec(['logs']));
	fails(f.exec(['status', '--port', '3010']), /do not update/);
	assert.equal(readFileSync(f.config, 'utf8'), before);
});
test('installer supports paths with spaces, repeated installation and command independence', (t) => {
	const f = fixture(t);
	const bin = join(f.dir, 'local bin');
	const data = join(f.dir, 'runtime data');
	const args = [
		installer,
		'--source',
		root,
		'--bin-dir',
		bin,
		'--data-dir',
		data,
		'--config-dir',
		join(f.dir, 'config')
	];
	ok(spawnSync('bash', args, { env: f.env, encoding: 'utf8' }));
	ok(spawnSync('bash', args, { env: f.env, encoding: 'utf8' }));
	const command = join(bin, 'devharbour');
	ok(spawnSync(command, ['--version'], { cwd: '/', env: f.env, encoding: 'utf8' }));
	assert.equal(existsSync(f.config), false);
	assert.equal(statSync(command).mode & 0o777, 0o755);
});
test('installer refuses unrelated executables and symlinks', (t) => {
	const f = fixture(t);
	const data = join(f.dir, 'installed');
	const destination = join(f.bin, 'devharbour');
	writeFileSync(destination, '#!/bin/sh\necho unrelated\n', { mode: 0o755 });
	const args = [
		installer,
		'--source',
		root,
		'--bin-dir',
		f.bin,
		'--data-dir',
		data,
		'--config-dir',
		join(f.dir, 'config')
	];
	assert.notEqual(spawnSync('bash', args, { env: f.env }).status, 0);
	assert.match(readFileSync(destination, 'utf8'), /unrelated/);
	rmSync(destination);
	symlinkSync(f.password, destination);
	assert.notEqual(spawnSync('bash', args, { env: f.env }).status, 0);
});
test('build mode requires an explicit source checkout', (t) => {
	const f = fixture(t);
	fails(f.exec(['build', ...f.identity]), /source-checkout/);
	assert.equal(existsSync(f.config), false);
});

test('replacement refuses a volume used by another container before stopping anything', (t) => {
	const f = fixture(t);
	ok(f.exec(f.identity));
	writeFileSync(f.log, '');
	fails(f.exec(['--port', '3010', '--replace'], { VOLUME_IN_USE: '1' }), /another container/);
	assert.equal(
		f.calls().some((a) => a[0] === 'stop' || a[0] === 'rm'),
		false
	);
});
test('null config is rejected, not silently replaced', (t) => {
	const f = fixture(t);
	f.save(null);
	fails(f.exec(['configure', ...f.identity]), /null/);
	assert.equal(f.read(), null);
});
test('argument errors do not echo credential values', (t) => {
	const f = fixture(t);
	const r = f.exec(['configure', '--password', secret]);
	fails(r, /Invalid command arguments/);
	assert.equal((r.stdout + r.stderr).includes(secret), false);
});
test('a held configuration lock refuses a concurrent update', async (t) => {
	const f = fixture(t);
	base(f);
	const child = spawn(
		'python3',
		[
			'-c',
			`import fcntl,sys,time\nf=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); time.sleep(15)`,
			f.config + '.lock'
		],
		{ env: f.env }
	);
	t.after(() => child.kill());
	await new Promise((resolve, reject) => {
		child.stdout.once('data', resolve);
		child.once('error', reject);
	});
	fails(f.exec(['configure', '--port', '3010']), /Another devharbour/);
	assert.equal(f.read().settings.port, undefined);
	child.kill();
});

test('clearing Brain removes options that would implicitly enable it again', (t) => {
	const f = fixture(t);
	base(f);
	ok(f.exec(['configure', '--brain-port', '3111']));
	ok(f.exec(['configure', '--clear', 'brain']));
	assert.equal(f.read().settings['brain-port'], undefined);
});
test('explicit false does not silently enable a feature through a dependent option', (t) => {
	const f = fixture(t);
	base(f);
	const c = f.read();
	c.settings.brain = false;
	c.settings['brain-port'] = 3111;
	f.save(c);
	fails(f.exec(['configure']), /brain=false conflicts/);
});
test('atomic write failure preserves the previous configuration and removes temporary files', (t) => {
	const f = fixture(t);
	base(f);
	const before = readFileSync(f.config, 'utf8');
	const program = `import importlib.util,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('cli',sys.argv[1]); cli=importlib.util.module_from_spec(spec);spec.loader.exec_module(cli)\np=Path(sys.argv[2]); previous=p.read_bytes()\ndef fail(*args): raise OSError('simulated publication failure')\ncli.os.replace=fail\ntry: cli.atomic_json(p,{'new':'value'})\nexcept OSError: pass\nassert p.read_bytes()==previous\nassert not list(p.parent.glob('.config.json*'))\n`;
	ok(spawnSync('python3', ['-c', program, cli, f.config], { env: f.env, encoding: 'utf8' }));
	assert.equal(readFileSync(f.config, 'utf8'), before);
});
test('download installation resolves one immutable revision and reads only allowlisted archive members', (t) => {
	const f = fixture(t);
	const bin = join(f.dir, 'download-bin');
	const data = join(f.dir, 'download-data');
	const program = `import io,json,sys,tarfile,urllib.request\nfrom pathlib import Path\nroot=Path(sys.argv[1]); revision='a'*40; archive=io.BytesIO()\nwith tarfile.open(fileobj=archive,mode='w:gz') as t:\n for name in ['devharbour.py','devharbour_ui.py','devharbour_source.py','devharbour_env.py','devharbour_banner.py','requirements-cli.txt','run-dashboard.sh']:\n  body=(root/'scripts'/name).read_bytes();info=tarfile.TarInfo('devcontainer-dashboard-'+revision+'/scripts/'+name); info.size=len(body);t.addfile(info,io.BytesIO(body))\n defbody=b'not extracted'; info=tarfile.TarInfo('../../escape');info.size=len(defbody);t.addfile(info,io.BytesIO(defbody))\ncalls=[]\ndef fetch(request,**kwargs):\n url=request.full_url if hasattr(request,'full_url') else request;calls.append(url)\n return io.BytesIO(json.dumps({'sha':revision}).encode() if '/commits/' in url else archive.getvalue())\nurllib.request.urlopen=fetch\nsource=(root/'scripts/install-devharbour.sh').read_text().split("<<'PY'\\n",1)[1].rsplit('\\nPY',1)[0]\nsys.argv=['installer','--no-checkout','--no-env-file','--bin-dir',sys.argv[2],'--data-dir',sys.argv[3],'--ref','feature/test']\nexec(compile(source,'installer','exec'),{'__name__':'__main__'})\nassert len(calls)==2 and calls[0].endswith('feature%2Ftest') and calls[1].endswith(revision)\n`;
	ok(spawnSync('python3', ['-c', program, root, bin, data], { env: f.env, encoding: 'utf8' }));
	const r = spawnSync(join(bin, 'devharbour'), ['--version'], { env: f.env, encoding: 'utf8' });
	ok(r);
	assert.match(r.stdout, /aaaaaaaa/);
});

test('managed launch explicitly pins the application port after env files', (t) => {
	const f = fixture(t);
	writeFileSync(join(f.dir, 'override.env'), 'PORT=9999\n');
	ok(f.exec([...f.identity, '--env-file', 'override.env']));
	const launch = f.calls().find((a) => a[0] === 'run');
	assert.ok(launch.includes('PORT=3000'));
	assert.ok(launch.indexOf('PORT=3000') > launch.indexOf('--env-file'));
});

test('advanced Tailscale and Brain settings validate without enabling services in configure mode', (t) => {
	const f = fixture(t);
	ok(
		f.exec([
			'configure',
			...f.identity,
			'--tailscale-socket',
			'/var/run/tailscale/tailscaled.sock',
			'--origin',
			'https://node.example.ts.net',
			'--brain-funnel',
			'--allow-exposure'
		])
	);
	assert.equal(f.read().settings['brain-funnel'], true);
	assert.deepEqual(f.calls(), []);
	ok(f.exec(['configure', '--clear', 'tailscale-socket']));
	assert.equal(f.read().settings['brain-funnel'], undefined);
});
test('checkout builds delegate to the explicit source launcher without managed arguments', (t) => {
	const f = fixture(t);
	const program = `import importlib.util,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('cli',sys.argv[1]); c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)\nconfig={'schemaVersion':1,'instanceName':'fixture','restartPolicy':'always','settings':{'source-checkout':sys.argv[2]}}\ns=c.normalized(config,Path(sys.argv[2]),True);a=c.launch_argv(config,s,'0'*64,'0'*64,True)\nassert a[1]==str(Path(sys.argv[2])/'scripts/run-dashboard.sh')\nassert '--build' in a and '--image' not in a and '--managed-name' not in a\nassert s['port']==3001\n`;
	ok(spawnSync('python3', ['-c', program, cli, root], { env: f.env, encoding: 'utf8' }));
	assert.deepEqual(f.calls(), []);
});
test('configuration paths are literal data, not shell expressions', (t) => {
	const f = fixture(t);
	const workspace = join(f.dir, '$(touch never-execute)');
	ok(f.exec([...f.identity, '--workspace', workspace]));
	const launch = f.calls().find((a) => a[0] === 'run');
	assert.ok(launch.some((v) => v.includes('source=' + workspace)));
	assert.equal(existsSync(join(root, 'never-execute')), false);
});

// Run the Python wizard in isolation, replacing only its terminal input boundary.
function wizardProbe(f, body) {
	const setup = `import importlib.util,json,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('cli',sys.argv[1]); c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)\npath=Path(sys.argv[2]); config=c.read_json(path); args=c.parser().parse_args(['configure','--config',str(path)])\nprompts=[]\ndef defaults(message,default=None,secret=False):\n prompts.append((message,default));return default\nc.ask=defaults\n`;
	return spawnSync('python3', ['-c', setup + body, cli, f.config], {
		env: f.env,
		encoding: 'utf8',
		timeout: 10000
	});
}

test('host discovery ignores forwarded SSH_AUTH_SOCK and deduplicates /var/run-style aliases', (t) => {
	const f = fixture(t);
	base(f);
	ok(
		wizardProbe(
			f,
			`import os,socket,struct,threading\nroot=path.parent/'runtime';(root/'gcr').mkdir(parents=True); alias=path.parent/'runtime-alias';alias.symlink_to(root)\nagent=root/'gcr/ssh'; listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(str(agent));listener.listen(1)\nrequests=[]\ndef respond():\n with listener.accept()[0] as connection:\n  requests.append(c.receive_exact(connection,5)); reply=bytes([12])+struct.pack('>I',0);connection.sendall(struct.pack('>I',len(reply))+reply)\nworker=threading.Thread(target=respond,daemon=True);worker.start()\nc.agent_process=lambda pid: 'gcr-ssh-agent'\nos.environ['SSH_AUTH_SOCK']='/tmp/ssh-forwarded/agent.123'\nfound,reason=c.discover_host_agents(os.getuid(),str(path.parent/'home'),[root,alias])\nworker.join(2);listener.close()\nassert reason is None and len(found)==1\nassert found[0]['path']==str(agent.resolve()) and found[0]['identities']==0\nassert requests==[struct.pack('>I',1)+bytes([11])]\nassert all('ssh-forwarded' not in item['path'] for item in found)\n`
		)
	);
});
test('a socket served by sshd is never autodiscovered as the host agent', (t) => {
	const f = fixture(t);
	base(f);
	ok(
		wizardProbe(
			f,
			`import os,socket,threading\nroot=path.parent/'runtime';(root/'gcr').mkdir(parents=True);agent=root/'gcr/ssh'\nlistener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(str(agent));listener.listen(1)\nreceived=[]\ndef respond():\n with listener.accept()[0] as connection: received.append(connection.recv(5))\nworker=threading.Thread(target=respond,daemon=True);worker.start()\nc.agent_process=lambda pid: 'sshd-session'\nfound,reason=c.discover_host_agents(os.getuid(),str(path.parent/'home'),[root])\nworker.join(2);listener.close()\nassert not found and received==[b'']\n`
		)
	);
});
test('agent discovery rejects missing, stale, non-socket and wrong-owner paths', (t) => {
	const f = fixture(t);
	base(f);
	ok(
		wizardProbe(
			f,
			`import os,socket\nroot=path.parent/'runtime';root.mkdir(); candidate=root/'agent'\nassert c.probe_host_agent(candidate,os.getuid(),[root])[0] is None\ncandidate.write_text('not a socket');assert c.probe_host_agent(candidate,os.getuid(),[root])[0] is None;candidate.unlink()\nlistener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(str(candidate));listener.close()\nassert c.probe_host_agent(candidate,os.getuid()+1,[root])[0] is None\nassert c.probe_host_agent(candidate,os.getuid(),[root])[0] is None\n`
		)
	);
});
test('known host-agent path cannot redirect discovery into a forwarded temporary socket', (t) => {
	const f = fixture(t);
	base(f);
	ok(
		wizardProbe(
			f,
			`import os,socket\nroot=path.parent/'runtime';(root/'gcr').mkdir(parents=True);outside=path.parent/'forwarded-agent'\nlistener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(str(outside));listener.listen(1)\n(root/'gcr/ssh').symlink_to(outside)\nfound,reason=c.discover_host_agents(os.getuid(),str(path.parent/'home'),[root]);listener.close()\nassert not found\n`
		)
	);
});
test('malformed agent protocol is rejected even for a recognized peer', (t) => {
	const f = fixture(t);
	base(f);
	ok(
		wizardProbe(
			f,
			`import os,socket,struct,threading\nroot=path.parent/'runtime';root.mkdir();agent=root/'ssh-agent.socket'\nlistener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(str(agent));listener.listen(1)\ndef respond():\n with listener.accept()[0] as connection:\n  c.receive_exact(connection,5);connection.sendall(struct.pack('>I',999999))\nworker=threading.Thread(target=respond,daemon=True);worker.start();c.agent_process=lambda pid: 'ssh-agent'\nassert c.probe_host_agent(agent,os.getuid(),[root])[0] is None\nworker.join(2);listener.close()\n`
		)
	);
});

test('a disposable real OpenSSH agent is discoverable even with protected process metadata', (t) => {
	const f = fixture(t);
	base(f);
	ok(
		wizardProbe(
			f,
			`import os,socket,subprocess,tempfile,time\nwith tempfile.TemporaryDirectory(prefix='dh-agent-fixture-') as directory:\n root=Path(directory); agent=root/'ssh-agent.socket'\n process=subprocess.Popen(['ssh-agent','-D','-a',str(agent)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n try:\n  for _ in range(100):\n   if agent.exists(): break\n   time.sleep(0.02)\n  found,reason=c.probe_host_agent(agent,os.getuid(),[root])\n  assert found is not None,reason\n  assert found['provider']=='ssh-agent' and found['identities']==0\n finally:\n  process.terminate();process.wait(timeout=5)\n`
		)
	);
});

test('schema 1 accepts additive source metadata and preserves existing settings', (t) => {
	const f = fixture(t);
	base(f);
	ok(f.exec(['configure', '--image-source', 'build', '--source-ref', 'main']));
	assert.equal(f.read().source.mode, 'build');
	assert.equal(f.read().source.ref, 'main');
	assert.equal(f.read().settings['host-user'], 'operator');
	assert.deepEqual(f.calls(), []);
});
test('managed build options cannot silently override an explicit image argument', (t) => {
	const f = fixture(t);
	fails(
		f.exec(['configure', ...f.identity, '--image-source', 'build', '--image', 'custom:tag']),
		/cannot be combined/
	);
	assert.equal(existsSync(f.config), false);
});
test('save-only managed build never clones source or touches Docker', (t) => {
	const f = fixture(t);
	ok(f.exec(['configure', ...f.identity, '--image-source', 'build', '--source-ref', 'main']));
	assert.equal(f.read().source.ref, 'main');
	assert.deepEqual(f.calls(), []);
});
test('source image preparation occurs before instance replacement', (t) => {
	const f = fixture(t);
	base(f);
	const program = `import importlib.util,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('cli',sys.argv[1]);c=importlib.util.module_from_spec(spec);sys.modules['cli']=c;spec.loader.exec_module(c)\nimport devharbour_source as source\ncalls=[]\ndef build(*args,**kwargs):\n calls.append('build');raise source.SourceError('fixture build failed')\nsource.prepare_image=build\nc.ensure_instance=lambda *a: calls.append('container-lifecycle')\nsys.argv=['devharbour','--config',sys.argv[2],'--non-interactive','--image-source','build','--source-ref','main']\ntry:c.main();raise AssertionError('failure expected')\nexcept source.SourceError:pass\nassert calls==['build']\n`;
	ok(spawnSync('python3', ['-c', program, cli, f.config], { env: f.env, encoding: 'utf8' }));
	assert.equal(
		f.calls().some((a) => a[0] === 'stop' || a[0] === 'rm'),
		false
	);
});

test('rebuild requires local build mode instead of silently doing nothing', (t) => {
	const f = fixture(t);
	base(f);
	fails(f.exec(['configure', '--rebuild']), /requires managed local build/);
});
test('switching local build back to published mode restores the registry image default', (t) => {
	const f = fixture(t);
	base(f);
	const c = f.read();
	c.source = { mode: 'build', ref: 'main' };
	c.settings.image = 'sha256:' + 'a'.repeat(64);
	f.save(c);
	ok(f.exec(['configure', '--image-source', 'published']));
	assert.equal(f.read().settings.image, 'ghcr.io/axelthas/devcontainer-dashboard:latest');
});

test('installer creates a private devcontainer env file once and never overwrites it', (t) => {
	const f = fixture(t);
	const config = join(f.dir, 'config');
	const args = [
		installer,
		'--source',
		root,
		'--bin-dir',
		join(f.dir, 'bin2'),
		'--data-dir',
		join(f.dir, 'data2'),
		'--config-dir',
		config
	];
	const first = spawnSync('bash', args, { env: f.env, encoding: 'utf8' });
	ok(first);
	assert.match(first.stdout, /created with defaults/);
	const path = join(config, 'devcontainer.env');
	const text = readFileSync(path, 'utf8');
	for (const line of ['TERN_USE_CCACHE=1', 'OPENCODE_SKIP_START=true', 'OPENCODE_PORT=4096'])
		assert.ok(text.includes(line), line);
	assert.match(text, /OPENCODE_PASSWORD=\S{24,}/);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(first.stdout.includes(text.match(/OPENCODE_PASSWORD=(\S+)/)[1]), false);
	writeFileSync(path, 'CUSTOM=1\n', { mode: 0o600 });
	const again = spawnSync('bash', args, { env: f.env, encoding: 'utf8' });
	ok(again);
	assert.equal(readFileSync(path, 'utf8'), 'CUSTOM=1\n');
	assert.match(again.stdout, /existing file kept/);
});
test('new unattended setups pass the default env file when it exists next to the config', (t) => {
	const f = fixture(t);
	writeFileSync(join(f.dir, 'devcontainer.env'), 'TERN_USE_CCACHE=1\n', { mode: 0o600 });
	ok(f.exec(['configure', ...f.identity]));
	assert.deepEqual(f.read().settings['env-file'], [join(f.dir, 'devcontainer.env')]);
});

test('legacy default is retained until explicit save-only migration', (t) => {
	const f = fixture(t);
	base(f);
	const legacy = f.read();
	legacy.instanceName = 'devcontainer-dashboard';
	f.save(legacy);
	ok(f.exec(['configure']));
	assert.equal(f.read().instanceName, 'devcontainer-dashboard');
	ok(f.exec(['configure', '--instance-name', 'devharbour']));
	assert.deepEqual(f.read(), { ...legacy, instanceName: 'devharbour' });
	assert.deepEqual(f.calls(), []);
});

test('legacy migration cannot be combined with run or management commands', (t) => {
	const f = fixture(t);
	base(f);
	const legacy = f.read();
	legacy.instanceName = 'devcontainer-dashboard';
	f.save(legacy);
	const before = readFileSync(f.config, 'utf8');
	for (const command of ['run', 'status', 'logs', 'stop', 'build'])
		fails(f.exec([command, '--instance-name', 'devharbour']), /instanceName is immutable/);
	assert.equal(readFileSync(f.config, 'utf8'), before);
	assert.deepEqual(f.calls(), []);
});

test('custom names are immutable and legacy volume mappings stay compatible', (t) => {
	const f = fixture(t);
	base(f);
	fails(f.exec(['configure', '--instance-name', 'other']), /instanceName is immutable/);
	ok(
		wizardProbe(
			f,
			`expected=('dashboard_data','ddash_zsh_data','dashboard_ai')\nfor name in ('devharbour','devcontainer-dashboard'):\n config['instanceName']=name\n assert c.resource_names(config)==expected\nconfig['instanceName']='separate'\nassert c.resource_names(config)==('separate-data','separate-history','separate-ai')\n`
		)
	);
	const custom = f.read();
	custom.instanceName = 'separate';
	f.save(custom);
	fails(f.exec(['configure', '--instance-name', 'devharbour']), /instanceName is immutable/);
	assert.equal(f.read().instanceName, 'separate');
});
