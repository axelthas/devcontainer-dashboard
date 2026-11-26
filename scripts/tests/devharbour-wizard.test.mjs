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
	// Paragraphs wrap at the setup width; compare words, not line breaks.
	result.stdout = result.stdout.replace(/\s+/g, ' ');
	return result;
}

test('saved settings go straight to grouped review and save-only never applies', (t) => {
	const r = probe(
		t,
		`terminal.overrides['What do you want to do with this setup?']='save'\nupdated,pending=setup.run()\nassert args.command=='configure' and args.plan_approved\nassert 'Where does Docker run?' not in terminal.events\nassert not (directory/'config.json').exists()\nassert config==setup.original\n`
	);
	assert.match(r.stdout, /Review your setup/);
	assert.match(r.stdout, /Nothing has been saved or started yet/);
});
test('new setup is a five-step menu flow with a final apply boundary', (t) => {
	const r = probe(
		t,
		`setup.settings.pop('password-file')\nupdated,pending=setup.run()\nassert pending=='hidden-password' and args.plan_approved\nassert updated['source']['mode']=='published'\nassert updated['settings']['brain'] is False\nassert not (directory/'config.json').exists()\n`
	);
	for (const text of [
		'How DevHarbour runs',
		'Host, workspace',
		'Access and login',
		'Devcontainer environment',
		'Optional features',
		'Review your setup'
	])
		assert.ok(r.stdout.includes(text));
});
test('Escape/back returns to the previous step and retains accepted choices', (t) => {
	probe(
		t,
		`terminal.overrides['You have a saved setup. What do you want to do?']='edit'\ndef back_once(count,choices):\n if count==1: raise ui.Back()\n return 'local'\nterminal.overrides['Who should be able to open DevHarbour?']=back_once\nterminal.overrides['What do you want to do with this setup?']='save'\nsetup.run()\nassert terminal.visits['Where does Docker run?']==2\nassert terminal.visits['Who should be able to open DevHarbour?']==2\n`
	);
});
test('review can jump directly to a specific step instead of rerunning every prompt', (t) => {
	probe(
		t,
		`terminal.overrides['What do you want to do with this setup?']=lambda count,choices: 4 if count==1 else 'save'\nsetup.run()\nassert 'Which optional features should DevHarbour enable?' in terminal.events\nassert 'Where does Docker run?' not in terminal.events\nassert terminal.visits['What do you want to do with this setup?']==2\n`
	);
});
test('cancellation leaves the supplied configuration unchanged and writes nothing', (t) => {
	probe(
		t,
		`terminal.overrides['What do you want to do with this setup?']='cancel'\ntry: setup.run();raise AssertionError('cancel expected')\nexcept KeyboardInterrupt: pass\nassert config==setup.original and not (directory/'config.json').exists()\n`
	);
});
test('selecting local build prepares a plan but does not clone or build', (t) => {
	probe(
		t,
		`terminal.overrides['Where should the DevHarbour image come from?']='build'\nterminal.overrides['You have a saved setup. What do you want to do?']='edit'\nterminal.overrides['What do you want to do with this setup?']='save'\nupdated,pending=setup.run()\nassert updated['source']['mode']=='build' and updated['source']['ref']\nassert not (directory/'source').exists() and args.command=='configure'\n`
	);
});
test('Brain/Funnel stay disabled with no emitted enablement ports by default', (t) => {
	probe(
		t,
		`setup.features()\nassert setup.settings['brain'] is False and setup.settings['brain-funnel'] is False\nassert 'Which local port should the MCP server use?' not in terminal.events\nassert 'brain-port' not in setup.settings and 'brain-funnel-port' not in setup.settings\n`
	);
});
test('selected Brain capability explains grants and defaults its private port to 3100', (t) => {
	const r = probe(
		t,
		`terminal.overrides['Which optional features should DevHarbour enable?']=['brain']\nassert setup.features() is True\nassert setup.settings['brain-port']==3100\nassert setup.settings['brain'] is True\n`
	);
	assert.match(r.stdout, /only the containers you grant/);
});
test('Funnel selection without Tailscale requires correcting access or deselecting Funnel', (t) => {
	const r = probe(
		t,
		`terminal.overrides['Which optional features should DevHarbour enable?']=['brain-funnel']\nassert setup.features() is False\nassert 'brain-funnel-port' not in setup.settings\n`
	);
	assert.match(r.stdout, /Go back to step 3/);
});
test('local host is the highlighted default and multiple agents need explicit selection', (t) => {
	probe(
		t,
		`c.discover_host_agents=lambda *a: ([{'path':'/run/user/2345/gcr/ssh','provider':'gcr-ssh-agent','identities':0},{'path':'/run/user/2345/ssh-agent.socket','provider':'ssh-agent','identities':1}],None)\nsetup.settings.pop('ssh-agent-socket')\nterminal.overrides['Which SSH agent should DevHarbour use?']='/run/user/2345/ssh-agent.socket'\nsetup.host()\nassert setup.local is True\nassert setup.settings['ssh-agent-socket']=='/run/user/2345/ssh-agent.socket'\n`
	);
});
test('secret is never printed in the grouped review', (t) => {
	const r = probe(
		t,
		`setup.pending='hidden-password'\nterminal.overrides['What do you want to do with this setup?']='save'\nsetup.run()\n`
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
		if (stage === 0 && output.includes('You have a saved setup. What do you want to do?')) {
			stage = 1;
			child.stdin.write(cancel === true ? '\x03' : '\r');
		} else if (
			cancel !== true &&
			stage === 1 &&
			output.includes('What do you want to do with this setup?')
		) {
			stage = 2;
			child.stdin.write(cancel === 'navigate' ? '\x1b[B\x1b[B\r' : '\r');
		} else if (cancel === 'navigate' && stage === 2 && output.includes('Step 2 of 7')) {
			stage = 3;
			child.stdin.write('\x1b');
		} else if (cancel === 'navigate' && stage === 3 && output.includes('Step 1 of 7')) {
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
		`setup.settings['port']=70000\ndef choose(title,choices,default=None,back=True):\n if title=='What do you want to do with this setup?':\n  assert not any(c[1] in ('save','apply') for c in choices);return 'cancel'\n return choices[0][1]\nterminal.select=choose\nassert setup.review()=='cancel'\n`
	);
	assert.match(r.stdout, /Needs attention before saving/);
});

test('real arrow keys jump to a review edit and Escape returns to the previous step', async (t) => {
	const result = await terminalRun(t, 'navigate');
	assert.notEqual(result.status, 0, result.output);
	assert.match(result.output, /Step 2 of 7/);
	assert.match(result.output, /Step 1 of 7/);
	assert.deepEqual(result.config, result.original);
});

test('older saved config without AI/source metadata opens review safely', (t) => {
	probe(
		t,
		`config['settings'].pop('ai-state-volume');setup=ui.Setup(c,config,args,terminal)\nterminal.overrides['What do you want to do with this setup?']='save'\nupdated,_=setup.run()\nassert updated['settings']['ai-state-volume']=='dashboard_ai'\nassert 'ai-state-volume' not in config['settings']\n`
	);
});
test('configure offers no start action even when a complete config is available', (t) => {
	probe(
		t,
		`args.command='configure'\ndef choose(title,choices,default=None,back=True):\n if title=='What do you want to do with this setup?':\n  assert not any(c[1]=='apply' for c in choices);return 'save'\n return choices[0][1]\nterminal.select=choose\nsetup.run()\nassert args.command=='configure'\n`
	);
});
test('selected public Funnel uses 10000 and Brain uses 3100 only after opt-in', (t) => {
	probe(
		t,
		`setup.settings.update({'tailscale-socket':'/var/run/tailscale/tailscaled.sock','origin':'https://node.example.ts.net'})\nterminal.overrides['Which optional features should DevHarbour enable?']=['brain-funnel']\nassert setup.features() is True\nassert setup.settings['brain'] is True and setup.settings['brain-port']==3100\nassert setup.settings['brain-funnel'] is True and setup.settings['brain-funnel-port']==10000\n`
	);
});

test('whoami derives the node HTTPS origin and removes the final DNS dot', (t) => {
	probe(
		t,
		`document={'Node':{'Name':'workstation.example-tailnet.ts.net.','MachineAuthorized':True},'UserProfile':{'LoginName':'not-the-device-name@example.test'},'CurrentTailnet':{'MagicDNSEnabled':True,'MagicDNSSuffix':'example-tailnet.ts.net'}}\norigin,error=ui.tailscale_origin_from_json(document,'whoami')\nassert origin=='https://workstation.example-tailnet.ts.net' and error is None\n`
	);
});
test('status fallback uses only Self DNSName, not a user, peer or tailnet name', (t) => {
	probe(
		t,
		`document={'BackendState':'Running','Self':{'DNSName':'workstation.example.ts.net.','Online':True},'Peer':{'other':{'DNSName':'wrong.example.ts.net.'}},'CurrentTailnet':{'Name':'owner@example.test','MagicDNSEnabled':True}}\nassert ui.tailscale_origin_from_json(document,'status')==('https://workstation.example.ts.net',None)\n`
	);
});
test('discovery sends read-only commands to the selected socket and falls back for older clients', (t) => {
	probe(
		t,
		`calls=[]\nclass Result:\n def __init__(self,code,output):self.returncode=code;self.stdout=output;self.stderr='private-node-key-never-print'\ndef query(argv,**kwargs):\n calls.append((argv,kwargs))\n return Result(1,'unsupported command') if argv[2]=='whoami' else Result(0,json.dumps({'BackendState':'Running','Self':{'DNSName':'host.example.ts.net.'}}))\nui.subprocess.run=query\nassert ui.discover_tailscale_origin('/custom/tailscaled.sock')==('https://host.example.ts.net',None)\nassert calls[0][0]==['tailscale','--socket=/custom/tailscaled.sock','whoami','--json']\nassert calls[1][0]==['tailscale','--socket=/custom/tailscaled.sock','status','--json','--peers=false']\nassert all(options['timeout']==5 and options['capture_output'] for _,options in calls)\n`
	);
});
test('invalid names, missing local identity and disabled MagicDNS are not guessed', (t) => {
	probe(
		t,
		`for name in ['https://host.example.ts.net','host.example.ts.net/path','host.example.ts.net:7443','host.example.ts.net.evil.test','host..example.ts.net','-host.example.ts.net','host.example.ts.net..',123,None]:\n assert ui.tailscale_origin_from_json({'Node':{'Name':name}},'whoami')[0] is None\nassert ui.tailscale_origin_from_json({'Node':{'Name':'host.example.ts.net.'},'CurrentTailnet':{'MagicDNSEnabled':False}},'whoami')[0] is None\nassert ui.tailscale_origin_from_json({'Node':{'Name':'host.other.ts.net.'},'CurrentTailnet':{'MagicDNSSuffix':'expected.ts.net'}},'whoami')[0] is None\nassert ui.tailscale_origin_from_json({'Node':{'Name':'host.example.ts.net.','MachineAuthorized':False}},'whoami')[0] is None\n`
	);
});
test('logged-out, stopped and offline status cannot produce an automatic origin', (t) => {
	probe(
		t,
		`for state in ['NeedsLogin','NeedsMachineAuth','Stopped','Starting',None]:\n assert ui.tailscale_origin_from_json({'BackendState':state,'Self':{'DNSName':'host.example.ts.net.'}},'status')[0] is None\nassert ui.tailscale_origin_from_json({'BackendState':'Running','Self':{'DNSName':'host.example.ts.net.','Online':False}},'status')[0] is None\n`
	);
});
test('missing CLI, timeout, malformed JSON and access failures give manual-entry guidance', (t) => {
	const r = probe(
		t,
		`def missing(*a,**k):raise FileNotFoundError()\nui.subprocess.run=missing\nassert 'missing' in ui.discover_tailscale_origin('/socket')[1]\ndef timeout(*a,**k):raise ui.subprocess.TimeoutExpired('tailscale',5,output='secret-node-key')\nui.subprocess.run=timeout\nassert 'timed out' in ui.discover_tailscale_origin('/socket')[1]\nclass Result:returncode=0;stdout='invalid-json-secret-node-key';stderr='private-key'\nui.subprocess.run=lambda *a,**k:Result()\nassert 'invalid JSON' in ui.discover_tailscale_origin('/socket')[1]\nResult.returncode=1\nassert 'permissions' in ui.discover_tailscale_origin('/socket')[1]\n`
	);
	assert.equal(r.stdout.includes('secret-node-key'), false);
});
test('new local Tailscale setup offers the detected origin as its default', (t) => {
	const r = probe(
		t,
		`setup.local=True;setup.settings['tailscale-socket']='/selected/socket'\nui.discover_tailscale_origin=lambda path: ('https://host.example.ts.net',None) if path=='/selected/socket' else (_ for _ in ()).throw(AssertionError('wrong socket'))\nsetup.tailscale_origin()\nassert setup.settings['origin']=='https://host.example.ts.net'\nassert 'Which address will you use to open DevHarbour?' in terminal.events\n`
	);
	assert.match(r.stdout, /standard HTTPS port 443/);
});
test('saved custom-port origin stays the default even when another host name is detected', (t) => {
	probe(
		t,
		`setup.local=True;setup.settings.update({'tailscale-socket':'/socket','origin':'https://saved.example.ts.net:7443'})\nui.discover_tailscale_origin=lambda path:('https://detected.example.ts.net',None)\nsetup.tailscale_origin()\nassert setup.settings['origin']=='https://saved.example.ts.net:7443'\n`
	);
});
test('explicit origin and remote-host settings never invoke local discovery', (t) => {
	probe(
		t,
		`def forbidden(*a):raise AssertionError('must not query local Tailscale')\nui.discover_tailscale_origin=forbidden\nsetup.settings.update({'tailscale-socket':'/socket','origin':'https://remote.example.ts.net:7443'})\nsetup.local=False;setup.tailscale_origin()\nassert setup.settings['origin']=='https://remote.example.ts.net:7443'\nargs.origin=setup.settings['origin'];setup.local=True;setup.tailscale_origin()\n`
	);
});
test('jumping directly from saved review to access requires host confirmation before querying', (t) => {
	probe(
		t,
		`def forbidden(*a):raise AssertionError('another host must not be queried')\nui.discover_tailscale_origin=forbidden\nsetup.settings.update({'tailscale-socket':'/socket','origin':'https://remote.example.ts.net'})\nassert setup.local is None\nsetup.tailscale_origin()\nassert 'Does this setup run on the Docker host itself?' in terminal.events and setup.local is False\n`
	);
});

test('settings with a default show it as a named answer and never offer an ambiguous unset', (t) => {
	probe(
		t,
		`seen=[]\ndef choose(title,choices,default=None,back=True):\n seen.append([c[0] for c in choices]);return default\nterminal.select=choose\nsetup.settings.pop('ai-port',None)\nassert setup.field('ai-port')==3002\nassert seen[-1]==['Use the default: 3002','Enter a different value'],seen\nassert not any('not set' in a or 'Leave unset' in a for a in seen[-1])\n`
	);
});
test('settings without a default offer None with its concrete meaning', (t) => {
	probe(
		t,
		`seen=[]\ndef choose(title,choices,default=None,back=True):\n seen.append(([c[0] for c in choices],default));return default\nterminal.select=choose\nassert setup.field('host-name') is None and 'host-name' not in setup.settings\nanswers,default=seen[-1]\nassert answers[0].startswith('None: show') and default=='none'\n`
	);
});
test('a saved value is kept by default and the default is offered separately', (t) => {
	probe(
		t,
		`seen=[]\ndef choose(title,choices,default=None,back=True):\n seen.append(([c[0] for c in choices],default));return default\nterminal.select=choose\nsetup.settings['port']=3010\nassert setup.field('port')==3010\nassert seen[-1]==(['Keep 3010','Use the default: 3000','Enter a different value'],'saved')\n`
	);
});
test('known_hosts is set automatically from the usual path when it exists on this host', (t) => {
	const r = probe(
		t,
		`home=directory/'home';(home/'.ssh').mkdir(parents=True);(home/'.ssh/known_hosts').write_text('host ssh-ed25519 AAAA\\n')\nsetup.settings['host-home']=str(home)\nc.discover_host_agents=lambda *a:([],None)\nterminal.overrides['Which SSH agent should DevHarbour use?']='/run/user/2345/gcr/ssh'\nsetup.host()\nassert setup.settings['ssh-known-hosts']==str(home/'.ssh/known_hosts')\nassert not any('known_hosts' in e for e in terminal.events)\n`
	);
	assert.match(r.stdout, /found, mounted read-only/);
});
test('a missing known_hosts file is reported, not mounted', (t) => {
	probe(
		t,
		`setup.settings['host-home']=str(directory/'nohome')\nc.discover_host_agents=lambda *a:([],None)\nterminal.overrides['Which SSH agent should DevHarbour use?']='/run/user/2345/gcr/ssh'\nsetup.host()\nassert 'ssh-known-hosts' not in setup.settings\n`
	);
});
test('devcontainer environment step plans defaults once and adds the file to the setup', (t) => {
	const r = probe(
		t,
		`setup.devenv()\nplan=setup.env_plan;updates=plan['updates']\nassert set(updates)=={'TERN_USE_CCACHE','OPENCODE_PASSWORD','OPENCODE_SKIP_START','OPENCODE_PORT'}\nassert updates['TERN_USE_CCACHE']=='1' and updates['OPENCODE_SKIP_START']=='true' and updates['OPENCODE_PORT']=='4096'\nassert len(updates['OPENCODE_PASSWORD'])>=24\nassert setup.settings['env-file']==[plan['path']]\nfirst=updates['OPENCODE_PASSWORD'];setup.devenv();assert setup.env_plan['updates']['OPENCODE_PASSWORD']==first\nassert not Path(plan['path']).exists()\nprint('PASSWORD='+first)\n`
	);
	const password = r.stdout.match(/PASSWORD=(\S+)/)[1];
	assert.equal(r.stdout.split('PASSWORD=')[0].includes(password), false);
});
test('existing env file values are shown, kept, and extra variables are preserved on write', (t) => {
	probe(
		t,
		`import devharbour_env as env\npath=env.default_path(args.config);env.write(path,{'TERN_USE_CCACHE':'0','OPENCODE_PASSWORD':'existing-password-123'},['# mine','SONARQUBE_URL=https://sonar.example.test'])\nsetup.devenv()\nassert setup.env_plan['updates']=={'OPENCODE_SKIP_START':'true','OPENCODE_PORT':'4096'}\nenv.write(path,setup.env_plan['updates'],setup.env_plan['lines'])\ntext=path.read_text()\nassert 'SONARQUBE_URL=https://sonar.example.test' in text and '# mine' in text and 'TERN_USE_CCACHE=0' in text and 'OPENCODE_PASSWORD=existing-password-123' in text\nassert (path.stat().st_mode & 0o777)==0o600\n`
	);
});
test('editing env values validates each answer and can opt out entirely', (t) => {
	probe(
		t,
		`answers={'Should DevHarbour pass this environment to your devcontainers?':'edit','Should Tern builds in devcontainers use ccache?':'0','Which OpenCode password should devcontainers use?':'own','How should OpenChamber reach OpenCode in a devcontainer?':'false'}\nterminal.select=lambda title,choices,default=None,back=True: answers.get(title,default)\ntexts=iter(['short','long-enough-password','99999','4097'])\nterminal.text=lambda *a,**k: next(texts)\nsetup.devenv()\nu=setup.env_plan['updates']\nassert u['TERN_USE_CCACHE']=='0' and u['OPENCODE_PASSWORD']=='long-enough-password' and u['OPENCODE_SKIP_START']=='false' and u['OPENCODE_PORT']=='4097'\nanswers['Should DevHarbour pass this environment to your devcontainers?']='skip'\nsetup.devenv()\nassert 'env-file' not in setup.settings and setup.env_plan is None\n`
	);
});
test('setup text names DevHarbour and the MCP server, never a specific AI product', (t) => {
	probe(
		t,
		`import inspect\nsource=inspect.getsource(ui)\nassert 'ClickUp' not in source and 'Brain' not in source.replace('brain','')\nassert 'the dashboard' not in source.lower()\n`
	);
});
test('the Funnel explanation states that DevHarbour adds and removes the route', (t) => {
	const r = probe(
		t,
		`terminal.overrides['Which optional features should DevHarbour enable?']=[]\nsetup.features()\n`
	);
	assert.match(r.stdout, /When DevHarbour starts, it adds a Tailscale Funnel route/);
	assert.match(r.stdout, /removes the route it added/);
});
test('banner renders the puffin in color and falls back to plain text', (t) => {
	probe(
		t,
		`import devharbour_banner as b\ncolored=b.render('truecolor',140,'v1')\nassert '\\033[38;2;' in colored and '\\u2580' in colored and 'Your harbour for devcontainers' in colored\nassert '\\033[' not in b.render(None,140,'v1')\nassert '\\033[38;5;' in b.render('256',90)\nassert 'DevHarbour' in b.render('256',20)\nclass Pipe:\n def isatty(self):return False\nassert b.color_mode(Pipe(),{})is None and b.color_mode(type('T',(),{'isatty':lambda s:True})(),{'NO_COLOR':''}) is None\n`
	);
});
