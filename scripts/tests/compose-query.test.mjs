/**
 * Source regression for the browser query string of GET /api/compose.
 * Run with Node 22.13+: node --experimental-strip-types --test scripts/tests/compose-query.test.mjs
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
let temporary;
let commands;

/** Load the client-safe contract from its TypeScript source. */
before(async () => {
	temporary = await mkdtemp(join(tmpdir(), 'ddash-compose-query-'));
	const path = join(repository, 'src/lib/composeCommands.ts');
	const source = stripTypeScriptTypes(await readFile(path, 'utf8'));
	await writeFile(join(temporary, 'commands.mjs'), source);
	commands = await import(pathToFileURL(join(temporary, 'commands.mjs')).href);
});

/** Remove only this test's files. */
after(async () => {
	await rm(temporary, { recursive: true, force: true });
});

test('query string round-trips through URLSearchParams in order', () => {
	const repoPath = "/workspaces/task/solution ' $HOME; $(x) & a+b=c#d?e%";
	const selection = {
		files: ['docker-compose.yml', 'docker-compose.override.yml'],
		envFile: '.env sandbox',
		profiles: ['sim', 'atc']
	};
	const params = new URLSearchParams(commands.composeQuery(repoPath, selection));
	assert.equal(params.get('repoPath'), repoPath);
	assert.deepEqual(params.getAll('file'), selection.files);
	assert.equal(params.get('envFile'), '.env sandbox');
	assert.deepEqual(params.getAll('profile'), ['sim', 'atc']);
});

test('query string omits an absent environment file and empty profiles', () => {
	const selection = { files: ['compose.yaml'], profiles: [] };
	const params = new URLSearchParams(commands.composeQuery('/w/t/r', selection));
	assert.deepEqual([...params.keys()], ['repoPath', 'file']);
});
