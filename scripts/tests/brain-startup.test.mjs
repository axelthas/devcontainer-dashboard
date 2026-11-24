/**
 * Brain startup regressions: launcher argv (no Docker), private persistent tokens, and
 * Funnel ownership/recovery against both an in-memory client and a Unix LocalAPI fixture.
 * Run: node --experimental-strip-types --test scripts/tests/brain-startup.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { loadBrain } from './brain-harness.mjs';

let brain;
before(async () => {
	brain = await loadBrain();
});
after(() => brain.cleanup());
const TOKEN = 'a'.repeat(64);
const HOST = 'test.tailnet.ts.net';
const root = fileURLToPath(new URL('../../', import.meta.url));

/** Valid status without peer data; capabilities can be advertised in either supported shape. */
function funnelStatus(capMap = false) {
	const capabilities = [
		'https',
		'funnel',
		'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000'
	];
	return {
		BackendState: 'Running',
		Self: {
			DNSName: `${HOST}.`,
			...(capMap
				? { CapMap: Object.fromEntries(capabilities.map((cap) => [cap, []])) }
				: { Capabilities: capabilities })
		}
	};
}

test('preflight accepts legacy capabilities, CapMap keys and allowed port ranges', () => {
	const target = { hostname: HOST, port: 10000 };
	for (const map of [false, true])
		assert.doesNotThrow(() => brain.startup.validateBrainFunnelStatus(funnelStatus(map), target));
	const status = funnelStatus();
	status.Self.Capabilities[2] = 'https://tailscale.com/cap/funnel-ports?ports=443,9999-10001';
	assert.doesNotThrow(() => brain.startup.validateBrainFunnelStatus(status, target));
});

test('preflight gives actionable errors for missing Funnel or HTTPS without changing policy', () => {
	for (const [cap, message] of [
		['funnel', /Funnel permission is missing.*"funnel".*Tagged devices/],
		['https', /HTTPS is not enabled/]
	]) {
		for (const map of [false, true]) {
			const status = funnelStatus(map);
			if (map) delete status.Self.CapMap[cap];
			else status.Self.Capabilities = status.Self.Capabilities.filter((item) => item !== cap);
			const before = structuredClone(status);
			assert.throws(
				() => brain.startup.validateBrainFunnelStatus(status, { hostname: HOST, port: 10000 }),
				message
			);
			assert.deepEqual(status, before);
		}
	}
});

test('preflight rejects stopped nodes, wrong hostnames, malformed status and disallowed ports', () => {
	const target = { hostname: HOST, port: 10000 };
	for (const value of [
		null,
		[],
		{},
		{ BackendState: 'NeedsLogin' },
		{ BackendState: 'Running', Self: [] }
	])
		assert.throws(() => brain.startup.validateBrainFunnelStatus(value, target), /preflight failed/);
	const wrong = funnelStatus();
	wrong.Self.DNSName = 'different.tailnet.ts.net.';
	assert.throws(() => brain.startup.validateBrainFunnelStatus(wrong, target), /Self.DNSName/);
	for (const cap of [
		'https://tailscale.com/cap/funnel-ports?ports=443,8443',
		'https://tailscale.com/cap/funnel-ports?ports=10001-9999',
		'https://tailscale.com/cap/funnel-ports-extra?ports=10000',
		'https://tailscale.com/cap/funnel-ports?ports=0-99999',
		'https://tailscale.com/cap/funnel-ports?ports=bad'
	]) {
		const status = funnelStatus();
		status.Self.Capabilities[2] = cap;
		assert.throws(
			() => brain.startup.validateBrainFunnelStatus(status, target),
			/10000 is not allowed/
		);
	}
	for (const self of [{ Capabilities: 'funnel' }, { CapMap: [] }]) {
		assert.throws(
			() =>
				brain.startup.validateBrainFunnelStatus({ BackendState: 'Running', Self: self }, target),
			/invalid node capability/
		);
	}
});

test('preflight uses read-only LocalAPI, rejects HTTP errors and bounds response size', async (t) => {
	const path = await directory(t);
	const socket = join(path, 'preflight.sock');
	let code = 200;
	let body = JSON.stringify(funnelStatus(true));
	let requests = 0;
	const server = createServer((request, response) => {
		requests++;
		assert.equal(request.method, 'GET');
		assert.equal(request.url, '/localapi/v0/status?peers=false');
		response.writeHead(code).end(body);
	});
	await new Promise((resolve) => server.listen(socket, resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const target = { hostname: HOST, port: 10000 };
	await brain.startup.preflightBrainFunnel(socket, target);
	code = 403;
	body = 'private daemon diagnostic must not be reflected';
	await assert.rejects(
		brain.startup.preflightBrainFunnel(socket, target),
		(error) => /HTTP 403.*permissions/.test(error.message) && !error.message.includes(body)
	);
	code = 200;
	body = '{';
	await assert.rejects(brain.startup.preflightBrainFunnel(socket, target), /invalid status JSON/);
	body = 'x'.repeat(1_100_000);
	await assert.rejects(brain.startup.preflightBrainFunnel(socket, target), /exceeds 1 MiB/);
	assert.equal(requests, 4);
});

test('production preflight runs before service route changes or public readiness', async () => {
	const source = await readFile(join(root, 'src/server.ts'), 'utf8');
	const preflight = source.indexOf('await preflightBrainFunnel(');
	assert.ok(preflight > 0);
	for (const marker of [
		'await startTailscaleServices(',
		'const ai = startAi()',
		'createBrainServer(brain)',
		'await startBrainFunnel(',
		'server.listen(PORT'
	])
		assert.ok(preflight < source.indexOf(marker), marker);
	assert.match(source, /if \(tailscale && funnelSettings\) await preflightBrainFunnel/);
});

/** Per-test private state, never real deployment storage. */
async function directory(t) {
	const path = await mkdtemp(join(tmpdir(), 'brain-startup-'));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

/** Execute the real launcher's pure phases, with explicit identity/socket and no daemon calls. */
function launcher(args = []) {
	const script = `
source <(sed '$d' "$1")
shift
parse_arguments --workspace /workspaces --no-create-workspace --host-user developer --host-uid 2345 --host-gid 3456 --host-home /home/developer --ssh-agent-socket /run/user/2345/agent "$@"
validate_env_files
resolve_identity
validate_options
validate_ssh_agent
TEST_NAME=brain-test REVISION=test DIRTY=false
prepare_arguments
printf '%s\\0' "\${ARGS[@]}" __PUBLICATION__ "\${PUBLICATION[@]}"
`;
	const result = spawnSync(
		'bash',
		['-c', script, 'test', join(root, 'scripts/run-dashboard.sh'), ...args],
		{
			encoding: 'utf8',
			env: {
				...process.env,
				SSH_AUTH_SOCK: '/ignored/agent',
				SUDO_USER: 'ignored',
				HOSTNAME: 'ignored'
			}
		}
	);
	return { ...result, args: result.stdout.split('\0') };
}

/** Memory client preserves update semantics; test callbacks can simulate operator edits. */
function memory(config = {}) {
	return {
		config,
		async update(merge) {
			const next = await merge(structuredClone(this.config));
			if (next !== null) this.config = next;
			return this.config;
		}
	};
}

/** One explicit public listener, separated from dashboard and service listeners. */
function settings(path) {
	return { hostname: HOST, port: 10000, upstream: 3100, stateFile: join(path, 'funnel.json') };
}

test('launcher publishes MCP only on loopback in both bridge modes', () => {
	for (const mode of [[], ['--build']]) {
		if (mode.length) {
			const built = launcher([...mode, '--brain', '--brain-port', '3200']);
			assert.equal(built.status, 0, built.stderr);
			assert.ok(built.args.includes('127.0.0.1:3200:3200'));
		} else {
			const result = launcher(['--brain', '--bind-address', '0.0.0.0']);
			assert.equal(result.status, 0, result.stderr);
			assert.ok(result.args.includes('BRAIN_MCP_ENABLED=1'));
			assert.ok(result.args.includes('127.0.0.1:3100:3100'));
			assert.ok(!result.args.includes('0.0.0.0:3100:3100'));
			assert.ok(result.args.includes('BRAIN_MCP_FUNNEL=0'));
		}
	}
});

test('launcher mounts supplied token read-only and never puts token contents in argv', () => {
	const result = launcher(['--brain-token-file', '/secrets/token with spaces']);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(
		result.args.includes(
			'type=bind,source=/secrets/token with spaces,target=/run/brain-mcp-token,readonly'
		)
	);
	assert.ok(result.args.includes('BRAIN_MCP_TOKEN_FILE=/run/brain-mcp-token'));
	assert.ok(result.args.includes('BRAIN_MCP_TOKEN='));
	assert.ok(!result.args.includes(TOKEN));
});

test('launcher Funnel needs explicit socket, defaults to 10000 and does not publish Docker ports', () => {
	const result = launcher([
		'--brain-funnel',
		'--tailscale-socket',
		'/run/tailscale.sock',
		'--origin',
		`https://${HOST}`
	]);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.args.includes('BRAIN_MCP_FUNNEL=1'));
	assert.ok(result.args.includes('BRAIN_MCP_FUNNEL_PORT=10000'));
	assert.ok(result.args.includes('host'));
	assert.ok(!result.args.includes('--publish'));
	assert.ok(!launcher().args.some((arg) => arg.startsWith('BRAIN_MCP_')));
});

test('launcher rejects missing opt-ins, invalid ports and overlapping listener/service ports', () => {
	const tail = ['--tailscale-socket', '/run/tailscale.sock', '--origin', `https://${HOST}`];
	for (const args of [
		['--brain-funnel'],
		['--brain-funnel-port', '10000'],
		['--brain-port', '0'],
		['--brain-port', '65536'],
		['--brain-port', '3000'],
		['--brain-port', '3002'],
		['--brain-token-file', 'relative'],
		['--brain-funnel', ...tail, '--brain-funnel-port', '9443'],
		['--brain-funnel', ...tail, '--brain-funnel-port', '443'],
		['--brain-funnel', ...tail, '--brain-funnel-port', '8443'],
		['--brain-funnel', ...tail, '--brain-port', '10000'],
		['--brain', ...tail, '--brain-port', '8401']
	]) {
		const result = launcher(args);
		assert.notEqual(result.status, 0, JSON.stringify(args));
		assert.ok(!result.args.includes('__PUBLICATION__'));
	}
	const valid = launcher([
		'--brain-funnel',
		...tail,
		'--brain-funnel-port',
		'8443',
		'--tailscale-ports',
		'8500-8599'
	]);
	assert.equal(valid.status, 0, valid.stderr);
});

test('automatic token is private, stable across starts, opt-in, and never overwrites invalid state', async (t) => {
	const path = join(await directory(t), 'token');
	assert.equal(await brain.startup.prepareBrain({}, path), null);
	const first = await brain.startup.prepareBrain({ BRAIN_MCP_ENABLED: '1' }, path);
	assert.match(first.token, /^[a-f0-9]{64}$/);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal(
		(await brain.startup.prepareBrain({ BRAIN_MCP_ENABLED: '1' }, path)).token,
		first.token
	);
	await writeFile(path, 'invalid');
	await assert.rejects(brain.startup.prepareBrain({ BRAIN_MCP_ENABLED: '1' }, path), /32 to 512/);
	assert.equal(await readFile(path, 'utf8'), 'invalid');
	await chmod(path, 0o644);
	await assert.rejects(brain.startup.prepareBrain({ BRAIN_MCP_ENABLED: '1' }, path), /mode 600/);
	assert.equal(
		(await brain.startup.prepareBrain({ BRAIN_MCP_ENABLED: '1', BRAIN_MCP_TOKEN: TOKEN }, path))
			.token,
		TOKEN
	);
});

test('runtime requires explicit Funnel and rejects unsupported public ports and collisions', () => {
	const env = {
		TAILSCALE_SOCKET: '/run/tailscale.sock',
		ORIGIN: `https://${HOST}`,
		BRAIN_MCP_FUNNEL: '1'
	};
	const local = { token: TOKEN, port: 3100 };
	assert.equal(brain.startup.brainFunnelSettings({}, local), null);
	assert.equal(brain.startup.brainFunnelSettings(env, local).port, 10000);
	for (const override of [
		{ TAILSCALE_SOCKET: '' },
		{ BRAIN_MCP_FUNNEL_PORT: '9443' },
		{ BRAIN_MCP_FUNNEL_PORT: '443' },
		{ BRAIN_MCP_FUNNEL_PORT: '8443' },
		{ ORIGIN: 'https://other.example' },
		{ PORT: '10000' },
		{ AI_PUBLIC_PORT: '10000' }
	])
		assert.throws(() => brain.startup.brainFunnelSettings({ ...env, ...override }, local));
	assert.throws(() => brain.startup.brainFunnelSettings(env, null));
});

test('Funnel owns only its exact MCP listener, cleans up, and preserves unrelated state', async (t) => {
	const opts = settings(await directory(t));
	const initial = {
		TCP: { 443: { HTTPS: true } },
		Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
		FutureField: { untouched: true }
	};
	const client = memory(structuredClone(initial));
	const runtime = await brain.startup.startBrainFunnel(client, opts);
	assert.equal(runtime.publicUrl, `https://${HOST}:10000/mcp`);
	assert.equal(client.config.AllowFunnel[`${HOST}:10000`], true);
	assert.equal(client.config.AllowFunnel[`${HOST}:443`], undefined);
	assert.equal(client.config.Web[`${HOST}:10000`].Handlers['/'].Proxy, 'http://127.0.0.1:3100');
	await assert.rejects(brain.startup.startBrainFunnel(client, opts), /already in use/);
	await runtime.close();
	await runtime.close();
	assert.deepEqual(client.config.TCP, initial.TCP);
	assert.deepEqual(client.config.Web, initial.Web);
	assert.deepEqual(client.config.FutureField, initial.FutureField);
	assert.deepEqual(client.config.AllowFunnel, {});
});

test('Funnel refuses occupied ports in all scopes, including disabled Funnel reservations', async (t) => {
	for (const config of [
		{
			TCP: { 10000: { HTTPS: true } },
			Web: { [`${HOST}:10000`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3100' } } } },
			AllowFunnel: { [`${HOST}:10000`]: true }
		},
		{ TCP: { 10000: { HTTPS: true } } },
		{ Web: { [`${HOST}:10000`]: { Handlers: {} } } },
		{ AllowFunnel: { [`${HOST}:10000`]: false } },
		{ Foreground: { session: { TCP: { 10000: {} } } } },
		{ Services: { 'svc:other': { TCP: { 10000: {} } } } }
	]) {
		const opts = settings(await directory(t));
		const client = memory(structuredClone(config));
		await assert.rejects(brain.startup.startBrainFunnel(client, opts), /No free/);
		assert.deepEqual(client.config, config);
	}
});

test('operator edits transfer ownership; shutdown does not overwrite them', async (t) => {
	const opts = settings(await directory(t));
	const client = memory();
	const runtime = await brain.startup.startBrainFunnel(client, opts);
	client.config.Web[`${HOST}:10000`].Handlers['/'].Proxy = 'http://127.0.0.1:9999';
	const edited = structuredClone(client.config);
	await runtime.close();
	assert.deepEqual(client.config, edited);
});

test('retained intent is recovered with Funnel disabled, and corrupt journals fail closed', async (t) => {
	const opts = settings(await directory(t));
	const client = memory();
	await writeFile(
		opts.stateFile,
		JSON.stringify({ version: 1, hostname: HOST, port: 10000, upstream: 3100 })
	);
	client.config = {
		TCP: { 10000: { HTTPS: true } },
		Web: { [`${HOST}:10000`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3100' } } } },
		AllowFunnel: { [`${HOST}:10000`]: true }
	};
	const runtime = await brain.startup.startBrainFunnel(client, null, opts.stateFile);
	assert.equal(client.config.AllowFunnel[`${HOST}:10000`], undefined);
	await runtime.close();
	await writeFile(opts.stateFile, '{}');
	await assert.rejects(
		brain.startup.startBrainFunnel(client, opts),
		/Invalid Brain Funnel journal/
	);
});

test('real LocalAPI client retries ETag conflicts and rolls back a POST with a lost response', async (t) => {
	const path = await directory(t);
	const opts = settings(path);
	let config = {};
	let revision = 1;
	let conflict = true;
	let lose = false;
	const socket = join(path, 'api.sock');
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		assert.equal(request.url, '/localapi/v0/serve-config');
		if (request.method === 'GET') {
			response.writeHead(200, { ETag: `"${revision}"` });
			response.end(JSON.stringify(config));
		} else if (conflict) {
			conflict = false;
			config.Unrelated = { kept: true };
			revision++;
			response.writeHead(412).end();
		} else {
			assert.equal(request.headers['if-match'], `"${revision}"`);
			config = JSON.parse(Buffer.concat(chunks).toString());
			revision++;
			if (lose) {
				lose = false;
				request.socket.destroy();
			} else response.writeHead(200).end();
		}
	});
	await new Promise((resolve) => server.listen(socket, resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const client = brain.serve.createServeConfigClient(socket);
	const runtime = await brain.startup.startBrainFunnel(client, opts);
	assert.deepEqual(config.Unrelated, { kept: true });
	await runtime.close();
	lose = true;
	await assert.rejects(brain.startup.startBrainFunnel(client, opts), /socket hang up/);
	assert.equal(config.AllowFunnel[`${HOST}:10000`], undefined);
	assert.deepEqual(config.Unrelated, { kept: true });
});
