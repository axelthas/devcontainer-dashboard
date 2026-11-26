/** Exercise independent apply with private fixtures and a fake Docker boundary.
 * No real container, image, socket, operator credential or ownership is changed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
const setup = `
import sys, os, json, tempfile, hashlib, copy, subprocess
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, 'scripts')
import devharbour as cli
import devharbour_settings as settings
import devharbour_apply as apply
root = tempfile.TemporaryDirectory()
path = Path(root.name) / 'config.json'
config = {'schemaVersion':1, 'instanceName':'devharbour', 'restartPolicy':'always', 'settings': {
'host-user':'operator', 'host-uid':os.getuid(), 'host-gid':os.getgid(), 'host-home':'/home/operator',
'ssh-agent-socket':'/run/user/1000/ssh', 'password-file':'password', 'env-file':['devcontainer.env']}}
cli.atomic_json(path, config)
(path.parent / 'password').write_text('fixture-sensitive-password-123')
(path.parent / 'password').chmod(0o600)
(path.parent / 'devcontainer.env').write_text('TERN_USE_CCACHE=1\\nOPENCODE_PASSWORD=fixture-sensitive-password-123\\n')
(path.parent / 'devcontainer.env').chmod(0o600)
current = {'Id':'c'*64,'Image':'sha256:'+'a'*64,'Config':{'Labels':{cli.LABEL_OWNER:hashlib.sha256(str(path).encode()).hexdigest()}},
'HostConfig':{},'Mounts':[{'Type':'bind','Source':'/var/run/docker.sock','Destination':'/var/run/docker.sock'}], 'State':{'Status':'running'}}
patch('devharbour_apply.cli.inspect', return_value=current).start()
patch('devharbour_apply.verify_self').start()
`;
/** Run only a small deterministic Python integration scenario. */
function scenario(code) {
	const result = spawnSync('python3', ['-c', setup + '\n' + code], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(!result.stdout.includes('fixture-sensitive-password-123'));
}
test('review does not save candidate config and exposes no credential values', () =>
	scenario(`
changed=copy.deepcopy(config);changed['settings']['port']=3010
before=path.read_bytes()
review=settings.apply_review(path,config,{'config':changed})
assert path.read_bytes()==before
assert any(item['key']=='port' for item in review['changes'])
assert 'fixture-sensitive' not in json.dumps(review)
`));
test('queue requires explicit replacement confirmation', () =>
	scenario(`
review=settings.apply_review(path,config,{})
try: settings.apply_queue(path,config,{'token':review['token']})
except settings.SettingsError: pass
else: raise AssertionError('unapproved apply queued')
assert not apply.ledger(path).exists()
`));
test('queue refuses changed private inputs after review', () =>
	scenario(`
review=settings.apply_review(path,config,{})
(path.parent/'password').write_text('changed-secret')
try: settings.apply_queue(path,config,{'token':review['token'],'confirmRecreate':True})
except settings.SettingsError: pass
else: raise AssertionError('stale inputs accepted')
`));
test('queue refuses another current instance', () =>
	scenario(`
review=settings.apply_review(path,config,{})
current['Id']='d'*64
with patch('devharbour_apply.verify_self'):
 try: settings.apply_queue(path,config,{'token':review['token'],'confirmRecreate':True})
 except settings.SettingsError: pass
 else: raise AssertionError('changed instance accepted')
`));
test('queue enforces increased exposure independently of browser controls', () =>
	scenario(`
changed=copy.deepcopy(config);changed['settings']['bind-address']='0.0.0.0'
review=settings.apply_review(path,config,{'config':changed})
assert review['requiresExposure']
try: settings.apply_queue(path,config,{'token':review['token'],'confirmRecreate':True})
except settings.SettingsError: pass
else: raise AssertionError('exposure not approved')
assert json.loads(path.read_text())==config
`));
test('one approved revision queues one read-only-root helper and refuses double submission', () =>
	scenario(`
review=settings.apply_review(path,config,{})
with patch('devharbour_settings.cli.run',return_value=subprocess.CompletedProcess([],0,stdout='',stderr='')) as run:
 queued=settings.apply_queue(path,config,{'token':review['token'],'confirmRecreate':True})
 argv=run.call_args.args[0]
 assert '--read-only' in argv and '--cap-drop' in argv
 assert current['Image'] in argv
 assert '--entrypoint' in argv and 'python3' in argv
 assert not any('source=/home/operator,target=/home/operator' == value for value in argv)
 assert any(value.endswith('target=/home/operator/devharbour-workspaces,readonly') for value in argv)
 assert queued['operation']['phase']=='queued'
 try: settings.apply_queue(path,config,{'token':review['token'],'confirmRecreate':True})
 except settings.SettingsError: pass
 else: raise AssertionError('double queue accepted')
`));
test('worker launch failure preserves desired state and records failure', () =>
	scenario(`
changed=copy.deepcopy(config);changed['settings']['port']=3010
review=settings.apply_review(path,config,{'config':changed})
with patch('devharbour_settings.cli.run',return_value=subprocess.CompletedProcess([],1,stdout='',stderr='private diagnostic')):
 try: settings.apply_queue(path,config,{'token':review['token'],'confirmRecreate':True})
 except settings.SettingsError as error: assert 'private diagnostic' not in str(error)
 else: raise AssertionError('failure not reported')
assert json.loads(path.read_text())['settings']['port']==3010
assert apply.status(path,reconcile=False)['phase']=='failed'
`));
test('worker takes the guarded CLI path and records only real phases', () =>
	scenario(`
review=settings.apply_review(path,config,{})
with patch('devharbour_settings.cli.run',return_value=subprocess.CompletedProcess([],0,stdout='',stderr='')):
 queued=settings.apply_queue(path,config,{'token':review['token'],'confirmRecreate':True})
phases=[]
original=apply.advance
def advance(path,identifier,phase):
 phases.append(phase);return original(path,identifier,phase)
def main(**kwargs):
 assert kwargs['apply_guard'](config)==current['Id']
 assert kwargs['source_cache']==path.parent/'.apply-source'
 for phase in ['image','recreate','health']:kwargs['progress'](phase)
with patch('devharbour_apply.cli.main',side_effect=main),patch('devharbour_apply.time.sleep'),patch('devharbour_apply.advance',side_effect=advance):
 apply.run_worker(path,queued['operation']['id'])
assert phases==['validate','image','recreate','health','succeeded']
assert apply.status(path,reconcile=False)['phase']=='succeeded'
`));
test('worker rejects an edit between queueing and acquiring the CLI lock', () =>
	scenario(`
review=settings.apply_review(path,config,{})
with patch('devharbour_settings.cli.run',return_value=subprocess.CompletedProcess([],0,stdout='',stderr='')):
 queued=settings.apply_queue(path,config,{'token':review['token'],'confirmRecreate':True})
changed=copy.deepcopy(config);changed['settings']['port']=3011;cli.atomic_json(path,changed)
def main(**kwargs): kwargs['apply_guard'](changed)
with patch('devharbour_apply.cli.main',side_effect=main),patch('devharbour_apply.time.sleep'):
 try: apply.run_worker(path,queued['operation']['id'])
 except cli.CliError: pass
 else: raise AssertionError('stale queued revision deployed')
assert apply.status(path,reconcile=False)['phase']=='failed'
`));
test('reconcile does not treat a Docker outage as worker death', () =>
	scenario(`
cli.atomic_json(apply.ledger(path),{'id':'a'*32,'phase':'health','helperName':'helper','updatedAt':0})
with patch('devharbour_apply.cli.inspect',side_effect=cli.CliError('unavailable')):
 try: apply.status(path)
 except cli.CliError:pass
 else:raise AssertionError('outage silently accepted')
assert apply.status(path,reconcile=False)['phase']=='health'
`));

test('real CLI worker checks readiness before publishing applied state', () =>
	scenario(`
current['Mounts'] += [{'Type':'volume','Name':name,'Destination':target} for name,target in [('dashboard_data','/data'),('ddash_zsh_data','/dashboard-history'),('dashboard_ai','/dashboard-ai')]]
review=settings.apply_review(path,config,{})
with patch('devharbour_settings.cli.run',return_value=subprocess.CompletedProcess([],0,stdout='',stderr='')):
 queued=settings.apply_queue(path,config,{'token':review['token'],'confirmRecreate':True})
calls=[]
def run(argv, **kwargs):
 calls.append(argv)
 if argv[:3]==['docker','ps','--all']:return subprocess.CompletedProcess(argv,0,stdout='',stderr='')
 if argv[0]=='bash' and '--validate-only' not in argv:
  current['Id']='d'*64
  current['Config']['Labels'][cli.LABEL_FINGERPRINT]=argv[argv.index('--managed-fingerprint')+1]
 return subprocess.CompletedProcess(argv,0,stdout='',stderr='')
with patch('devharbour_apply.cli.run',side_effect=run), patch('devharbour_apply.time.sleep'):
 apply.run_worker(path,queued['operation']['id'])
state=cli.read_json(path.with_name(path.name+'.state.json'))
assert state['containerId']=='d'*64
assert state['fingerprint']==cli.desired_fingerprint(cli.read_json(path),cli.normalized(cli.read_json(path),path.parent))
assert any(argv[:2]==['docker','stop'] and argv[2]=='c'*64 for argv in calls)
assert any(argv[:2]==['docker','exec'] for argv in calls)
assert apply.status(path,reconcile=False)['phase']=='succeeded'
`));

test('image preparation failure leaves the original instance and applied ledger untouched', () =>
	scenario(`
review=settings.apply_review(path,config,{})
with patch('devharbour_settings.cli.run',return_value=subprocess.CompletedProcess([],0,stdout='',stderr='')):
 queued=settings.apply_queue(path,config,{'token':review['token'],'confirmRecreate':True})
calls=[]
def run(argv, **kwargs):
 calls.append(argv)
 if argv[:3]==['docker','image','inspect']:return subprocess.CompletedProcess(argv,1,stdout='',stderr='')
 if argv[:2]==['docker','pull']:raise cli.CliError('fixture image preparation failure')
 return subprocess.CompletedProcess(argv,0,stdout='',stderr='')
with patch('devharbour_apply.cli.run',side_effect=run), patch('devharbour_apply.time.sleep'):
 try:apply.run_worker(path,queued['operation']['id'])
 except cli.CliError:pass
 else:raise AssertionError('image failure accepted')
assert not any(argv[:2] in [['docker','stop'],['docker','rm']] for argv in calls)
assert not path.with_name(path.name+'.state.json').exists()
assert apply.status(path,reconcile=False)['phase']=='failed'
`));

test('expired reviews cannot save or queue replacement', () =>
	scenario(`
review=settings.apply_review(path,config,{})
review_path=path.with_name(path.name+'.review.json');stored=cli.read_json(review_path);stored['expiresAt']=0;cli.atomic_json(review_path,stored)
try:settings.apply_queue(path,config,{'token':review['token'],'confirmRecreate':True})
except settings.SettingsError:pass
else:raise AssertionError('expired review accepted')
assert not apply.ledger(path).exists()
`));

test('an instance replaced during image preparation is never stopped by the worker', () =>
	scenario(`
review=settings.apply_review(path,config,{})
with patch('devharbour_settings.cli.run',return_value=subprocess.CompletedProcess([],0,stdout='',stderr='')):
 queued=settings.apply_queue(path,config,{'token':review['token'],'confirmRecreate':True})
calls=[]
def run(argv, **kwargs):
 calls.append(argv)
 if argv[:3]==['docker','image','inspect']:current['Id']='d'*64
 return subprocess.CompletedProcess(argv,0,stdout='',stderr='')
with patch('devharbour_apply.cli.run',side_effect=run), patch('devharbour_apply.time.sleep'):
 try:apply.run_worker(path,queued['operation']['id'])
 except cli.CliError:pass
 else:raise AssertionError('replacement race accepted')
assert not any(argv[:2] in [['docker','stop'],['docker','rm']] for argv in calls)
assert apply.status(path,reconcile=False)['phase']=='failed'
`));

test('identity checks accept custom hostnames and reject other containers', () => {
	const result = spawnSync('python3', ['scripts/tests/identity.test.py'], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
});
