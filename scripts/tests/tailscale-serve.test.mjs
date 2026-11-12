/** Dependency-free regressions for issue #27. Run with Node 22's TypeScript stripping flag. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	allocateServePort,
	createServeConfigClient
} from '../../src/lib/server/tailscaleServe.ts';

/** Supply a disposable Unix LocalAPI fixture and always release its socket. */
async function fixture(t, handler) {
	const directory = await mkdtemp(join(tmpdir(), 'ddash-serve-'));
	const socket = join(directory, 'tailscaled.sock');
	const server = createServer(handler);
	t.after(async () => {
		await new Promise((resolve) => server.close(resolve));
		await rm(directory, { recursive: true, force: true });
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(socket, resolve);
	});
	return createServeConfigClient(socket);
}

test('disabled without an explicit socket; reject relative socket paths', () => {
	assert.equal(createServeConfigClient(), null);
	assert.equal(createServeConfigClient(''), null);
	assert.throws(() => createServeConfigClient('tailscaled.sock'), /absolute/);
});

test('allocation reserves all known scopes and preserves the input', () => {
	const config = {
		TCP: { 8400: { HTTPS: true } },
		Web: { 'node.ts.net:8401': {} },
		AllowFunnel: { 'node.ts.net:8402': false },
		Foreground: { session: { TCP: { 8403: {} } } },
		Services: { 'svc:example': { TCP: { 8404: {} } } },
		FutureField: { untouched: true }
	};
	const before = structuredClone(config);
	assert.equal(allocateServePort(config, 8400, 8410), 8405);
	assert.deepEqual(config, before);
	assert.throws(() => allocateServePort(config, 8400, 8404), /No free/);
});

test('allocation validates ranges and fails closed on malformed maps', () => {
	for (const [first, last] of [[0, 10], [10, 9], [1, 65536], [1.5, 2], [NaN, 5]]) {
		assert.throws(() => allocateServePort({}, first, last), /range/);
	}
	for (const config of [{ TCP: [] }, { TCP: { oops: {} } }, { Foreground: { bad: null } }]) {
		assert.throws(() => allocateServePort(config, 8400, 8410), /Invalid/);
	}
	assert.equal(allocateServePort({}, 65535, 65535), 65535);
});

test('GET accepts an empty config and retains the exact ETag', async (t) => {
	const client = await fixture(t, (req, res) => {
		assert.equal(req.url, '/localapi/v0/serve-config');
		assert.equal(req.headers.host, 'local-tailscaled.sock');
		res.writeHead(200, { ETag: '"version-1"' }).end('null');
	});
	assert.deepEqual(await client.get(), { config: {}, etag: '"version-1"' });
});

test('missing ETag, malformed JSON, arrays and HTTP failures prevent writes', async (t) => {
	for (const [status, etag, body] of [
		[200, '', '{}'],
		[200, '"v1"', '{'],
		[200, '"v1"', '[]'],
		[403, '"v1"', '{}']
	]) {
		const client = await fixture(t, (req, res) => {
			assert.equal(req.method, 'GET');
			res.writeHead(status, etag ? { ETag: etag } : {}).end(body);
		});
		await assert.rejects(client.update(() => ({})));
	}
});

test('412 retries the merge against fresh operator changes and ETag', async (t) => {
	let reads = 0;
	let writes = 0;
	const client = await fixture(t, (req, res) => {
		if (req.method === 'GET') {
			reads++;
			res.writeHead(200, { ETag: `"v${reads}"` }).end(
				JSON.stringify({ TCP: { [reads === 1 ? 443 : 8443]: { HTTPS: true } }, Future: 7 })
			);
			return;
		}
		writes++;
		assert.equal(req.headers['if-match'], `"v${writes}"`);
		let body = '';
		req.on('data', (chunk) => { body += chunk; });
		req.on('end', () => {
			const config = JSON.parse(body);
			assert.equal(config.Future, 7);
			assert.ok(config.TCP[writes === 1 ? 443 : 8443]);
			res.writeHead(writes === 1 ? 412 : 200).end('{}');
		});
	});
	const config = await client.update((current) => ({
		...current,
		TCP: { ...current.TCP, [allocateServePort(current, 8443, 8445)]: { HTTPS: true } }
	}));
	assert.deepEqual(config.TCP, { 8443: { HTTPS: true }, 8444: { HTTPS: true } });
	assert.equal(reads, 2);
	assert.equal(writes, 2);
});

test('no-op merge does not POST', async (t) => {
	const client = await fixture(t, (req, res) => {
		assert.equal(req.method, 'GET');
		res.writeHead(200, { ETag: '"v1"' }).end('{"Unknown":true}');
	});
	assert.deepEqual(await client.update(() => null), { Unknown: true });
});

test('repeated conflicts stop after three attempts', async (t) => {
	let reads = 0;
	let writes = 0;
	const client = await fixture(t, (req, res) => {
		if (req.method === 'GET') {
			reads++;
			res.writeHead(200, { ETag: `"v${reads}"` }).end('{}');
		} else {
			writes++;
			res.writeHead(412).end('{}');
		}
	});
	await assert.rejects(client.update((config) => config), /three update attempts/);
	assert.equal(reads, 3);
	assert.equal(writes, 3);
});

test('non-conflict write failures are not retried', async (t) => {
	let writes = 0;
	const client = await fixture(t, (req, res) => {
		if (req.method === 'GET') res.writeHead(200, { ETag: '"v1"' }).end('{}');
		else { writes++; res.writeHead(500).end('{}'); }
	});
	await assert.rejects(client.update((config) => config), /HTTP 500/);
	assert.equal(writes, 1);
});

test('oversized responses fail closed', async (t) => {
	const client = await fixture(t, (_req, res) => {
		res.writeHead(200, { ETag: '"v1"' }).end(' '.repeat(1024 * 1024 + 1));
	});
	await assert.rejects(client.get(), /exceeds 1 MiB/);
});
