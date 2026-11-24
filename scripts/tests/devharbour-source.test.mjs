// Source/build tests use temporary repositories and mocked Docker command boundaries.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root = fileURLToPath(new URL('../../', import.meta.url));
function probe(t, body) {
	const dir = mkdtempSync(join(tmpdir(), 'dh-source-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const setup = `import os,sys,subprocess\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1])/'scripts'));import devharbour_source as s\ndirectory=Path(sys.argv[2])\ndef repository():\n p=directory/'repo';p.mkdir()\n def git(*args): return subprocess.run(['git','-C',str(p),*args],text=True,capture_output=True,check=True).stdout.strip()\n git('init');git('remote','add','origin',s.REPOSITORY)\n (p/'Dockerfile').write_text('FROM scratch\\n');git('add','Dockerfile');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture')\n return p,git('rev-parse','HEAD')\n`;
	const r = spawnSync('python3', ['-c', setup + body, root, dir], {
		encoding: 'utf8',
		timeout: 10000
	});
	assert.equal(r.status, 0, r.stdout + '\n' + r.stderr);
	return r;
}
test('clean pinned source is reused without changing its branch or files', (t) =>
	probe(
		t,
		`path,revision=repository()\ncheckout,found=s.acquire({'mode':'build','ref':revision,'revision':revision,'checkout':str(path)},directory/'cache')\nassert checkout==path and found==revision\nassert not (directory/'cache').exists()\n`
	));
test('dirty source is refused and its local edit remains untouched', (t) =>
	probe(
		t,
		`path,revision=repository();(path/'Dockerfile').write_text('do not overwrite')\ntry: s.clean_checkout(path,revision);raise AssertionError('dirty source accepted')\nexcept s.SourceError as e: assert 'local changes' in str(e)\nassert (path/'Dockerfile').read_text()=='do not overwrite'\n`
	));
test('untracked source files are also protected', (t) =>
	probe(
		t,
		`path,revision=repository();(path/'local.txt').write_text('keep')\ntry:s.clean_checkout(path);raise AssertionError('untracked source accepted')\nexcept s.SourceError:pass\nassert (path/'local.txt').read_text()=='keep'\n`
	));
test('wrong repository and mismatched revisions are rejected', (t) =>
	probe(
		t,
		`path,revision=repository()\ntry:s.clean_checkout(path,'f'*40);raise AssertionError('wrong revision accepted')\nexcept s.SourceError:pass\nsubprocess.run(['git','-C',str(path),'remote','set-url','origin','https://example.test/other.git'],check=True)\ntry:s.clean_checkout(path);raise AssertionError('wrong remote accepted')\nexcept s.SourceError:pass\n`
	));
test('unsafe refs and unsupported source schemas fail before invoking Git', (t) =>
	probe(
		t,
		`for value in [{'mode':'other'},{'mode':'build','ref':'--upload-pack=bad'},{'mode':'build','ref':'main..other'},{'mode':'build','revision':'main'},{'mode':'build','unknown':True}]:\n try:s.validate_source(value);raise AssertionError('invalid source accepted')\n except s.SourceError:pass\n`
	));
test('cached immutable revision is reused without cloning or fetching', (t) =>
	probe(
		t,
		`path,revision=repository();cache=directory/'cache';cache.mkdir(mode=0o700);path.rename(cache/revision)\ncheckout,found=s.acquire({'mode':'build','ref':revision},cache)\nassert found==revision and checkout==cache/revision\n`
	));
test('local build returns an immutable Docker image ID and never handles containers', (t) =>
	probe(
		t,
		`path,revision=repository();s.acquire=lambda *a:(path,revision)\ncalls=[]\nclass Result: returncode=1\ns.subprocess.run=lambda *a,**k:Result()\ndef command(argv,capture=True):\n calls.append(argv);return 'sha256:'+'a'*64 if argv[:3]==['docker','image','inspect'] else ''\ns.command=command\nimage,checkout,found=s.prepare_image({'mode':'build','ref':revision},directory/'cache')\nassert image=='sha256:'+'a'*64 and found==revision\nassert calls[0][:4]==['docker','buildx','build','--load']\nassert not any('stop' in call or 'rm' in call for call in calls)\n`
	));
test('failed image build cannot stop, remove or replace an existing container', (t) =>
	probe(
		t,
		`path,revision=repository();s.acquire=lambda *a:(path,revision)\nclass Result: returncode=1\ns.subprocess.run=lambda *a,**k:Result()\ncalls=[]\ndef fail(argv,capture=True):\n calls.append(argv);raise s.SourceError('fixture build failure')\ns.command=fail\ntry:s.prepare_image({'mode':'build'},directory/'cache');raise AssertionError('build should fail')\nexcept s.SourceError:pass\nassert len(calls)==1 and calls[0][:3]==['docker','buildx','build']\n`
	));
test('existing local image is reused unless an explicit rebuild is requested', (t) =>
	probe(
		t,
		`path,revision=repository();s.acquire=lambda *a:(path,revision)\nclass Result: returncode=0\ns.subprocess.run=lambda *a,**k:Result()\ncalls=[]\ndef command(argv,capture=True):\n calls.append(argv);return revision if 'org.opencontainers.image.revision' in ' '.join(argv) else 'sha256:'+'b'*64 if argv[:3]==['docker','image','inspect'] else ''\ns.command=command\ns.prepare_image({'mode':'build'},directory/'cache');assert not any('buildx' in a for a in calls)\ns.prepare_image({'mode':'build'},directory/'cache',rebuild=True);assert any('buildx' in a for a in calls)\n`
	));

test('cached local image with the wrong revision cannot be reused implicitly', (t) =>
	probe(
		t,
		`path,revision=repository();s.acquire=lambda *a:(path,revision)\nclass Result: returncode=0\ns.subprocess.run=lambda *a,**k:Result()\ns.command=lambda *a,**k:'f'*40\ntry:s.prepare_image({'mode':'build'},directory/'cache');raise AssertionError('wrong image accepted')\nexcept s.SourceError as e:assert 'provenance differs' in str(e)\n`
	));
