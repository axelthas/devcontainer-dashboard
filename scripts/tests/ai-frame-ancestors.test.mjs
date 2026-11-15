/**
 * Verify the actual supervisor's OpenChamber environment with mocked process boundaries.
 * These tests use real files and port allocation, not Docker or a running OpenChamber.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** Load an isolated supervisor while replacing only its process and storage boundaries. */
async function supervisorFixture(root) {
	const boundaryFile = join(root, 'boundaries.mjs');
	await writeFile(
		boundaryFile,
		`
		import { EventEmitter } from 'node:events';
		export const spawns = [];
		export function spawn(file, args, options) {
			const child = Object.assign(new EventEmitter(), {
				pid: 90000 + spawns.length, exitCode: null, signalCode: null
			});
			spawns.push({ file, args, options });
			return child;
		}
		export async function terminateTerminalTree() {}
	`
	);
	const boundary = pathToFileURL(boundaryFile).href;
	let source = await readFile(
		new URL('../../src/lib/server/aiRuntime.ts', import.meta.url),
		'utf8'
	);
	for (const name of ['node:child_process', './terminalProcesses.js'])
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
	return { runtime: await import(pathToFileURL(file).href), ...(await import(boundary)) };
}

/** Restore absent keys as absent, not as the string "undefined". */
function restoreEnvironment(previous) {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

for (const origin of ['https://dashboard.example:7443', 'http://127.0.0.1:3101', '', undefined]) {
	test(`OpenChamber frame ancestors equal ORIGIN (${origin === undefined ? 'unset' : JSON.stringify(origin)})`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'dashboard-ai-framing-'));
		const keys = [
			'AI_ENABLED',
			'WORKSPACE_ROOT',
			'ORIGIN',
			'OPENCHAMBER_FRAME_ANCESTORS',
			'DDAS_OPENCHAMBER_FRAME_ANCESTORS'
		];
		const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
		const previousFetch = globalThis.fetch;
		let handle;
		try {
			assert.equal(globalThis.__dashboardAi, undefined);
			process.env.AI_ENABLED = '1';
			process.env.WORKSPACE_ROOT = root;
			if (origin === undefined) delete process.env.ORIGIN;
			else process.env.ORIGIN = origin;
			process.env.OPENCHAMBER_FRAME_ANCESTORS = 'https://ignored-override.example';
			process.env.DDAS_OPENCHAMBER_FRAME_ANCESTORS = 'https://ignored-ddas.example';
			globalThis.fetch = async () => new Response('{}');
			const { runtime, spawns } = await supervisorFixture(root);
			handle = runtime.startAi();
			const deadline = Date.now() + 5000;
			while (runtime.aiStatus().state === 'starting' && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(runtime.aiStatus().state, 'ready');
			assert.equal(spawns.length, 2);
			const chamber = spawns.find((call) => call.file === 'openchamber');
			assert.ok(chamber);
			assert.equal(chamber.options.env.OPENCHAMBER_FRAME_ANCESTORS, origin ?? '');
			assert.equal(chamber.options.env.ORIGIN, origin);
		} finally {
			try {
				await handle?.close();
			} finally {
				delete globalThis.__dashboardAi;
				globalThis.fetch = previousFetch;
				restoreEnvironment(previous);
				await rm(root, { recursive: true, force: true });
			}
		}
	});
}
