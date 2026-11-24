// Menu/controller tests use semantic values, not a brittle sequence of raw prompts.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.DEVHARBOUR_TEST_PYTHON || 'python3';

function probe(t, body) {
	const dir = mkdtempSync(join(tmpdir(), 'dh-menu-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const setup = `import copy,importlib.util,json,sys\nfrom pathlib import Path\nroot=Path(sys.argv[1]); directory=Path(sys.argv[2]);sys.path.insert(0,str(root/'scripts'))\nspec=importlib.util.spec_from_file_location('cli',root/'scripts/devharbour.py');c=importlib.util.module_from_spec(spec);sys.modules['cli']=c;spec.loader.exec_module(c)\nimport devharbour_ui as ui\nconfig={'schemaVersion':1,'instanceName':'devcontainer-dashboard','restartPolicy':'always','settings':{'host-user':'operator','host-uid':2345,'host-gid':3456,'host-home':'/home/operator','ssh-agent-socket':'/run/user/2345/gcr/ssh','workspace':'/workspaces','password-file':str(directory/'password'),'ai-state-volume':'dashboard_ai'}}\n(directory/'password').write_text('private-fixture');(directory/'password').chmod(0o600)\nargs=c.parser().parse_args(['--config',str(directory/'config.json')])\nclass FakeTerminal:\n def __init__(self): self.events=[];self.overrides={};self.visits={}\n def select(self,title,choices,default=None,back=True):\n  self.events.append(title);self.visits[title]=self.visits.get(title,0)+1\n  override=self.overrides.get(title)\n  if callable(override): return override(self.visits[title],choices)\n  if override is not None: return override\n  return default if default is not None else choices[0][1]\n def text(self,title,default='',secret=False):\n  self.events.append(title);return 'hidden-password' if secret else str(default)\n def check(self,title,choices,selected):\n  self.events.append(title);return self.overrides.get(title,list(selected))\nterminal=FakeTerminal();setup=ui.Setup(c,config,args,terminal)\n`;
	const result = spawnSync(python, ['-c', setup + body, root, dir], {
		encoding: 'utf8',
		timeout: 10000
	});
	assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
	return result;
}

test('saved settings go straight to grouped review and save-only never applies', (t) => {
	const r = probe(
		t,
		`terminal.overrides['What would you like to do?']='save'\nupdated,pending=setup.run()\nassert args.command=='configure' and args.plan_approved\nassert 'Where is Docker running?' not in terminal.events\nassert not (directory/'config.json').exists()\nassert config==setup.original\n`
	);
	assert.match(r.stdout, /Review your setup/);
	assert.match(r.stdout, /Nothing below has been applied/);
});
test('new setup is a five-step menu flow with a final apply boundary', (t) => {
	const r = probe(
		t,
		`setup.settings.pop('password-file')\nupdated,pending=setup.run()\nassert pending=='hidden-password' and args.plan_approved\nassert updated['source']['mode']=='published'\nassert updated['settings']['brain'] is False\nassert not (directory/'config.json').exists()\n`
	);
	for (const text of [
		'Choose how to run',
		'Host, workspace',
		'Access and login',
		'Optional capabilities',
		'Review your setup'
	])
		assert.ok(r.stdout.includes(text));
});
test('Escape/back returns to the previous step and retains accepted choices', (t) => {
	probe(
		t,
		`terminal.overrides['Existing configuration']='edit'\ndef back_once(count,choices):\n if count==1: raise ui.Back()\n return 'local'\nterminal.overrides['Dashboard access']=back_once\nterminal.overrides['What would you like to do?']='save'\nsetup.run()\nassert terminal.visits['Where is Docker running?']==2\nassert terminal.visits['Dashboard access']==2\n`
	);
});
test('review can jump directly to a specific step instead of rerunning every prompt', (t) => {
	probe(
		t,
		`terminal.overrides['What would you like to do?']=lambda count,choices: 3 if count==1 else 'save'\nsetup.run()\nassert 'Enable optional capabilities' in terminal.events\nassert 'Where is Docker running?' not in terminal.events\nassert terminal.visits['What would you like to do?']==2\n`
	);
});
test('cancellation leaves the supplied configuration unchanged and writes nothing', (t) => {
	probe(
		t,
		`terminal.overrides['What would you like to do?']='cancel'\ntry: setup.run();raise AssertionError('cancel expected')\nexcept KeyboardInterrupt: pass\nassert config==setup.original and not (directory/'config.json').exists()\n`
	);
});
test('selecting local build prepares a plan but does not clone or build', (t) => {
	probe(
		t,
		`terminal.overrides['Image source']='build'\nterminal.overrides['Existing configuration']='edit'\nterminal.overrides['What would you like to do?']='save'\nupdated,pending=setup.run()\nassert updated['source']['mode']=='build' and updated['source']['ref']\nassert not (directory/'source').exists() and args.command=='configure'\n`
	);
});
test('Brain/Funnel stay disabled with no emitted enablement ports by default', (t) => {
	probe(
		t,
		`setup.features()\nassert setup.settings['brain'] is False and setup.settings['brain-funnel'] is False\nassert 'Brain MCP local port' not in terminal.events\nassert 'brain-port' not in setup.settings and 'brain-funnel-port' not in setup.settings\n`
	);
});
test('selected Brain capability explains grants and defaults its private port to 3100', (t) => {
	const r = probe(
		t,
		`terminal.overrides['Enable optional capabilities']=['brain']\nassert setup.features() is True\nassert setup.settings['brain-port']==3100\nassert setup.settings['brain'] is True\n`
	);
	assert.match(r.stdout, /grant individual containers separately/);
});
test('Funnel selection without Tailscale requires correcting access or deselecting Funnel', (t) => {
	const r = probe(
		t,
		`terminal.overrides['Enable optional capabilities']=['brain-funnel']\nassert setup.features() is False\nassert 'brain-funnel-port' not in setup.settings\n`
	);
	assert.match(r.stdout, /Go back to Access/);
});
test('local host is the highlighted default and multiple agents need explicit selection', (t) => {
	probe(
		t,
		`c.discover_host_agents=lambda *a: ([{'path':'/run/user/2345/gcr/ssh','provider':'gcr-ssh-agent','identities':0},{'path':'/run/user/2345/ssh-agent.socket','provider':'ssh-agent','identities':1}],None)\nsetup.settings.pop('ssh-agent-socket')\nterminal.overrides['Host SSH agent']='/run/user/2345/ssh-agent.socket'\nsetup.host()\nassert setup.local is True\nassert setup.settings['ssh-agent-socket']=='/run/user/2345/ssh-agent.socket'\n`
	);
});
test('secret is never printed in the grouped review', (t) => {
	const r = probe(
		t,
		`setup.pending='hidden-password'\nterminal.overrides['What would you like to do?']='save'\nsetup.run()\n`
	);
	assert.equal(r.stdout.includes('hidden-password'), false);
});

// Exercise Questionary itself in a PTY, not just a mocked UI boundary.
async function terminalRun(t, cancel = false) {
	const dir = mkdtempSync(join(tmpdir(), 'dh-real-menu-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	chmodSync(dir, 0o700);
	const config = join(dir, 'config.json');
	const password = join(dir, 'password');
	writeFileSync(password, 'private-test-password\n', { mode: 0o600 });
	const original = {
		schemaVersion: 1,
		instanceName: 'devcontainer-dashboard',
		restartPolicy: 'always',
		settings: {
			'host-user': 'operator',
			'host-uid': 2345,
			'host-gid': 3456,
			'host-home': '/home/operator',
			'ssh-agent-socket': '/run/user/2345/gcr/ssh',
			workspace: '/workspaces',
			'password-file': password,
			'ai-state-volume': 'dashboard_ai'
		}
	};
	writeFileSync(config, JSON.stringify(original), { mode: 0o600 });
	const quote = (v) => "'" + v.replaceAll("'", "'\\''") + "'";
	const command = [python, join(root, 'scripts/devharbour.py'), 'configure', '--config', config]
		.map(quote)
		.join(' ');
	const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
		env: { ...process.env, TERM: 'xterm-256color', PROMPT_TOOLKIT_NO_CPR: '1' }
	});
	let output = '';
	let stage = 0;
	const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
	child.stdout.on('data', (chunk) => {
		output += chunk.toString();
		if (stage === 0 && output.includes('Existing configuration')) {
			stage = 1;
			child.stdin.write(cancel === true ? '\x03' : '\r');
		} else if (cancel !== true && stage === 1 && output.includes('What would you like to do?')) {
			stage = 2;
			child.stdin.write(cancel === 'navigate' ? '\x1b[B\x1b[B\r' : '\r');
		} else if (cancel === 'navigate' && stage === 2 && output.includes('[Step 2/6] Host')) {
			stage = 3;
			child.stdin.write('\x1b');
		} else if (cancel === 'navigate' && stage === 3 && output.includes('[Step 1/6] Choose')) {
			stage = 4;
			child.stdin.write('\x03');
		}
	});
	child.stderr.on('data', (chunk) => {
		output += chunk.toString();
	});
	const status = await new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	clearTimeout(timer);
	return { status, output, config: JSON.parse(readFileSync(config, 'utf8')), original };
}
test('real Questionary menus save only after Enter on review and never echo the password', async (t) => {
	const result = await terminalRun(t);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /Configuration saved/);
	assert.match(result.output, /Review your setup/);
	assert.equal(result.output.includes('private-test-password'), false);
});
test('Ctrl+C in a real menu cancels without changing the saved JSON', async (t) => {
	const result = await terminalRun(t, true);
	assert.notEqual(result.status, 0, result.output);
	assert.deepEqual(result.config, result.original);
});
test('invalid plans show edit choices instead of save/apply actions', (t) => {
	const r = probe(
		t,
		`setup.settings['port']=70000\ndef choose(title,choices,default=None,back=True):\n if title=='What would you like to do?':\n  assert not any(value in ('save','apply') for _,value in choices);return 'cancel'\n return choices[0][1]\nterminal.select=choose\nassert setup.review()=='cancel'\n`
	);
	assert.match(r.stdout, /needs attention/);
});

test('real arrow keys jump to a review edit and Escape returns to the previous step', async (t) => {
	const result = await terminalRun(t, 'navigate');
	assert.notEqual(result.status, 0, result.output);
	assert.match(result.output, /\[Step 2\/6\] Host/);
	assert.match(result.output, /\[Step 1\/6\] Choose/);
	assert.deepEqual(result.config, result.original);
});

test('older saved config without AI/source metadata opens review safely', (t) => {
	probe(
		t,
		`config['settings'].pop('ai-state-volume');setup=ui.Setup(c,config,args,terminal)\nterminal.overrides['What would you like to do?']='save'\nupdated,_=setup.run()\nassert updated['settings']['ai-state-volume']=='dashboard_ai'\nassert 'ai-state-volume' not in config['settings']\n`
	);
});
test('configure offers no start action even when a complete config is available', (t) => {
	probe(
		t,
		`args.command='configure'\ndef choose(title,choices,default=None,back=True):\n if title=='What would you like to do?':\n  assert not any(value=='apply' for _,value in choices);return 'save'\n return choices[0][1]\nterminal.select=choose\nsetup.run()\nassert args.command=='configure'\n`
	);
});
test('selected public Funnel uses 10000 and Brain uses 3100 only after opt-in', (t) => {
	probe(
		t,
		`setup.settings.update({'tailscale-socket':'/var/run/tailscale/tailscaled.sock','origin':'https://node.example.ts.net'})\nterminal.overrides['Enable optional capabilities']=['brain-funnel']\nassert setup.features() is True\nassert setup.settings['brain'] is True and setup.settings['brain-port']==3100\nassert setup.settings['brain-funnel'] is True and setup.settings['brain-funnel-port']==10000\n`
	);
});
