/** Focused AI contracts with real files/Bash and mocked AI/process boundaries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { aiDirectory, aiFolders } from '../../src/lib/server/aiPaths.ts';
import { validAiId } from '../../src/lib/server/aiSessions.ts';
import {
	dashboardDraftDirectory,
	initializeDashboardDraft
} from '../../integrations/openchamber/dashboard-launch.ts';
import { patchSource } from '../patch-openchamber.mjs';

/** Allocate an isolated filesystem fixture and clean it even after assertion failures. */
async function temporary(work) {
	const root = await mkdtemp(join(tmpdir(), 'dashboard-ai-'));
	try {
		await work(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('directories include ordinary folders, spaces, Unicode and safe links; escapes fail', async () => {
	await temporary(async (root) => {
		const workspace = join(root, 'workspace');
		const folder = join(workspace, 'plain Ísland folder');
		await mkdir(folder, { recursive: true });
		await mkdir(join(root, 'workspace-other'));
		await symlink(folder, join(workspace, 'safe'));
		await symlink(root, join(workspace, 'escape'));
		await writeFile(join(workspace, 'file'), 'not a folder');
		assert.equal(await aiDirectory(workspace, join(workspace, 'safe')), folder);
		for (const path of [
			root,
			join(workspace, 'escape'),
			join(root, 'workspace-other'),
			join(workspace, 'file'),
			'../workspace'
		])
			await assert.rejects(aiDirectory(workspace, path));
		assert.deepEqual(
			(await aiFolders(workspace)).children.map((entry) => entry.name),
			['plain Ísland folder', 'safe']
		);
		assert.equal((await aiFolders(workspace)).parent, null);
	});
});

test('window identities are bounded and cannot contain paths or shell syntax', () => {
	assert.equal(validAiId('window_1-test'), true);
	for (const value of ['', '../window', 'a'.repeat(49), 'window; touch nope', null])
		assert.equal(validAiId(value), false);
});

test('OpenChamber starts a route-scoped unsent draft and decodes folder paths only once', () => {
	const path = '/workspace/space here/percent%2F/Ísland ';
	const params = new URLSearchParams({ directory: path, new: '1' });
	const calls = [];
	assert.equal(dashboardDraftDirectory(params), path);
	assert.equal(
		initializeDashboardDraft(params, (options) => calls.push(options)),
		true
	);
	assert.deepEqual(calls, [
		{
			automatic: true,
			target: 'project',
			directoryOverride: path,
			preserveDirectoryOverride: true,
			routeScoped: true
		}
	]);
	for (const query of [
		'directory=%2Fworkspace',
		'new=1',
		'new=1&directory=relative',
		'new=1&directory=%2Fbad%00path'
	]) {
		assert.equal(
			initializeDashboardDraft(new URLSearchParams(query), () =>
				assert.fail('Invalid launch initialized a draft')
			),
			false
		);
	}
});

test('OpenChamber source integration refuses unreviewed upstream files', () => {
	assert.throws(
		() => patchSource('packages/ui/src/App.tsx', 'changed upstream code'),
		/Unsupported/
	);
	assert.throws(() => patchSource('../unexpected.ts', ''), /Unsupported/);
});

test('state script retains data and credentials across home recreation and normalizes versions', async () => {
	await temporary(async (root) => {
		const state = join(root, 'state');
		const home = join(root, 'home');
		const bin = join(root, 'bin');
		const seed = join(root, 'seed');
		for (const path of [state, home, bin]) await mkdir(path);
		await writeFile(seed, '#!/bin/sh\nprintf "OpenCode v2.3.0\\n"\n', { mode: 0o700 });
		await writeFile(join(bin, 'findmnt'), '#!/bin/sh\nprintf "%s\\n" "$TEST_STATE"\n', {
			mode: 0o700
		});
		const script = join(root, 'state.sh');
		const source = await readFile(new URL('../ai-state.sh', import.meta.url), 'utf8');
		await writeFile(
			script,
			source
				.replaceAll('/opt/dashboard-ai/opencode', '__SEED__')
				.replaceAll('/dashboard-ai', state)
				.replaceAll('__SEED__', seed)
		);
		const env = {
			...process.env,
			HOME: home,
			TEST_STATE: state,
			PATH: `${bin}:${process.env.PATH}`
		};
		const run = (command) =>
			spawnSync('bash', [script, 'sh', '-c', command], { env, encoding: 'utf8' });
		const first = run('printf conversation > "$OPENCODE_DB"');
		assert.equal(first.status, 0, first.stderr);
		await rm(home, { recursive: true });
		await mkdir(home);
		const second = run('cat "$OPENCODE_DB"');
		assert.equal(second.status, 0, second.stderr);
		assert.equal(second.stdout, 'conversation');
		// Use a real Node child to verify descriptor 9 remains locked across exec.
		const child = spawn(
			'bash',
			[script, 'node', '-e', 'console.log("ready");process.stdin.resume()'],
			{ env }
		);
		try {
			await new Promise((resolve, reject) => {
				child.stdout.once('data', resolve);
				child.once('error', reject);
				child.once('exit', (code) => reject(new Error(`early exit: ${code}`)));
			});
			const blocked = run('true');
			assert.notEqual(blocked.status, 0);
			assert.match(blocked.stderr, /Another dashboard/);
		} finally {
			child.stdin.end();
			await new Promise((resolve) => child.once('exit', resolve));
		}
		assert.equal(run('true').status, 0);
	});
});

test('wrapper always passes an explicit endpoint and preserves literal arguments', async () => {
	await temporary(async (root) => {
		await mkdir(join(root, '.opencode/bin'), { recursive: true });
		await writeFile(join(root, 'server-url'), 'http://127.0.0.1:4097');
		await writeFile(join(root, 'server-password'), 'secret');
		await writeFile(
			join(root, '.opencode/bin/opencode'),
			'#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),password:process.env.OPENCODE_PASSWORD}));\n',
			{ mode: 0o700 }
		);
		const source = await readFile(new URL('../opencode.sh', import.meta.url), 'utf8');
		const script = join(root, 'wrapper.sh');
		await writeFile(script, source.replaceAll('/dashboard-ai', root));
		const result = spawnSync('bash', [script, '/workspace/path with spaces'], {
			env: { ...process.env, HOME: root },
			encoding: 'utf8'
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {
			args: ['--server', 'http://127.0.0.1:4097', '/workspace/path with spaces'],
			password: 'secret'
		});
	});
});

test('runtime has one server, shared credentials, attach-only PTYs and failure without replacement', async () => {
	await temporary(async (root) => {
		const mock = join(root, 'boundaries.mjs');
		await writeFile(
			mock,
			`
			import { EventEmitter } from 'node:events';
			export const calls = { spawns: [], terminals: [], stops: [] };
			export function spawn(file, args, options) {
				const child = Object.assign(new EventEmitter(), { pid: 90000 + calls.spawns.length, exitCode: null, signalCode: null });
				calls.spawns.push({file, args, options, child}); return child;
			}
			export async function terminateTerminalTree(pid) { calls.stops.push(pid); }
			export function createPersistentSession(id, command, cwd, options) { calls.terminals.push({ id, command, cwd, options }); }
		`
		);
		let source = await readFile(
			new URL('../../src/lib/server/aiRuntime.ts', import.meta.url),
			'utf8'
		);
		const boundary = pathToFileURL(mock).href;
		for (const name of ['node:child_process', './terminalProcesses.js', './terminal.js'])
			source = source.replaceAll(`'${name}'`, JSON.stringify(boundary));
		for (const name of ['aiPaths', 'aiSessions'])
			source = source.replaceAll(
				`'./${name}.js'`,
				JSON.stringify(new URL(`../../src/lib/server/${name}.ts`, import.meta.url).href)
			);
		source = source.replace(
			"const storage = '/dashboard-ai'",
			`const storage = ${JSON.stringify(root)}`
		);
		const file = join(root, 'runtime.ts');
		await writeFile(file, source);
		const runtime = await import(pathToFileURL(file).href);
		const { calls } = await import(boundary);
		const previous = {
			enabled: process.env.AI_ENABLED,
			workspace: process.env.WORKSPACE_ROOT,
			codePassword: process.env.OPENCODE_PASSWORD,
			chamberPassword: process.env.OPENCHAMBER_UI_PASSWORD,
			fetch: globalThis.fetch
		};
		process.env.AI_ENABLED = '1';
		process.env.WORKSPACE_ROOT = root;
		process.env.OPENCODE_PASSWORD = 'fixture-operator-password';
		process.env.OPENCHAMBER_UI_PASSWORD = 'fixture-legacy-password';
		await writeFile(join(root, 'ui-password'), 'fixture-previous-password');
		const requests = [];
		globalThis.fetch = async (url, options) => {
			requests.push({ url, options });
			assert.notEqual(options?.method, 'POST', 'Opening a window must not create a conversation');
			return new Response('{}');
		};
		let handle;
		try {
			handle = runtime.startAi();
			assert.equal(runtime.startAi(), null);
			const deadline = Date.now() + 5000;
			while (runtime.aiStatus().state === 'starting' && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(runtime.aiStatus().state, 'ready');
			assert.equal(calls.spawns.length, 2);
			const [code, chamber] = calls.spawns;
			assert.equal(code.args[0], 'serve');
			assert.ok(!code.args.includes('--service'));
			assert.equal(chamber.options.env.OPENCODE_HOST, `http://127.0.0.1:${code.args.at(-1)}`);
			assert.equal(chamber.options.env.OPENCODE_SKIP_START, 'true');
			assert.equal(
				code.options.env.OPENCODE_PASSWORD,
				chamber.options.env.OPENCODE_SERVER_PASSWORD
			);
			assert.equal(code.options.env.DASHBOARD_PASSWORD, undefined);
			assert.equal(chamber.options.env.OPENCHAMBER_UI_PASSWORD, 'fixture-operator-password');
			assert.equal(await readFile(join(root, 'ui-password'), 'utf8'), 'fixture-operator-password');
			assert.notEqual(code.options.env.OPENCODE_PASSWORD, 'fixture-operator-password');
			const request = { launch: 'runtime-window', path: root, tool: 'opencode' };
			assert.deepEqual(await runtime.openAi(request), await runtime.openAi(request));
			assert.equal(calls.terminals.length, 1);
			assert.deepEqual(calls.terminals[0].options.executable.args, [root]);
			assert.equal(calls.terminals[0].cwd, root);
			assert.equal(calls.terminals[0].command, undefined);
			assert.deepEqual(
				await runtime.openAi({ ...request, launch: 'chamber-window', tool: 'openchamber' }),
				{ path: root }
			);
			await assert.rejects(runtime.openAi({ ...request, tool: 'openchamber' }), /already used/);
			await assert.rejects(readFile(join(root, 'windows/runtime-window.json')), { code: 'ENOENT' });
			assert.equal(
				requests.some((request) => request.url.includes('/api/session')),
				false
			);
			await assert.rejects(
				runtime.waitForAi(
					{ pid: 1, exitCode: 1, signalCode: null },
					'http://unused',
					{},
					() => false
				),
				/stopped/
			);
			code.child.emit('exit', 1);
			await new Promise((resolve) => setTimeout(resolve, 10));
			await assert.rejects(runtime.openAi({ ...request, launch: 'after-failure' }), /not ready/);
			assert.equal(calls.spawns.length, 2);
		} finally {
			await handle?.close();
			delete globalThis.__dashboardAi;
			globalThis.fetch = previous.fetch;
			if (previous.enabled === undefined) delete process.env.AI_ENABLED;
			else process.env.AI_ENABLED = previous.enabled;
			if (previous.workspace === undefined) delete process.env.WORKSPACE_ROOT;
			else process.env.WORKSPACE_ROOT = previous.workspace;
			if (previous.codePassword === undefined) delete process.env.OPENCODE_PASSWORD;
			else process.env.OPENCODE_PASSWORD = previous.codePassword;
			if (previous.chamberPassword === undefined) delete process.env.OPENCHAMBER_UI_PASSWORD;
			else process.env.OPENCHAMBER_UI_PASSWORD = previous.chamberPassword;
		}
	});
});
