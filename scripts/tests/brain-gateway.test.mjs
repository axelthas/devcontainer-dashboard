/**
 * HTTP regressions for the dedicated Brain MCP listener: configuration, bearer
 * authentication, browser-origin refusal, methods, media type and body limits.
 * Run: node --experimental-strip-types --test scripts/tests/brain-gateway.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { loadBrain } from './brain-harness.mjs';

const TOKEN = 'a'.repeat(40);
let brain;
before(async () => {
	brain = await loadBrain();
});
after(() => brain.cleanup());

/** Start a listener on an ephemeral loopback port and close it after the test. */
async function listen(t, handle) {
	const server = brain.gateway.createBrainServer({ token: TOKEN, port: 0 }, handle);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	return `http://127.0.0.1:${server.address().port}`;
}

/** POST a JSON-RPC body with optional header overrides. */
function post(base, body, headers = {}, path = '/mcp') {
	return fetch(`${base}${path}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...headers
		},
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
}

test('settings are opt-in and reject weak or ambiguous credentials', async (t) => {
	const { brainSettings } = brain.gateway;
	assert.equal(brainSettings({}), null);
	assert.throws(() => brainSettings({ BRAIN_MCP_TOKEN: 'short' }), /32 to 512/);
	assert.throws(
		() => brainSettings({ BRAIN_MCP_TOKEN: TOKEN, BRAIN_MCP_TOKEN_FILE: '/x' }),
		/not both/
	);
	assert.throws(() => brainSettings({ BRAIN_MCP_TOKEN_FILE: 'relative' }), /absolute/);
	assert.throws(() => brainSettings({ BRAIN_MCP_TOKEN: TOKEN, BRAIN_MCP_PORT: '70000' }), /PORT/);
	assert.throws(
		() =>
			brainSettings({ BRAIN_MCP_TOKEN: TOKEN, BRAIN_MCP_PUBLIC_URL: 'http://example.test/mcp' }),
		/HTTPS/
	);
	assert.deepEqual(brainSettings({ BRAIN_MCP_TOKEN: TOKEN }), {
		token: TOKEN,
		port: 3100,
		publicUrl: undefined
	});
	const directory = await mkdtemp(join(tmpdir(), 'ddash-brain-token-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'token');
	await writeFile(file, `${TOKEN}\n`);
	assert.equal(brainSettings({ BRAIN_MCP_TOKEN_FILE: file, BRAIN_MCP_PORT: '3200' }).token, TOKEN);
});

test('bearer comparison accepts only the exact token', () => {
	const { bearerMatches } = brain.gateway;
	assert.equal(bearerMatches(`Bearer ${TOKEN}`, TOKEN), true);
	assert.equal(bearerMatches(`bearer ${TOKEN}`, TOKEN), true);
	assert.equal(bearerMatches(`Bearer ${TOKEN}x`, TOKEN), false);
	assert.equal(bearerMatches(TOKEN, TOKEN), false);
	assert.equal(bearerMatches(undefined, TOKEN), false);
});

test('requests without the token never reach the MCP handler', async (t) => {
	let calls = 0;
	const base = await listen(t, async () => {
		calls++;
		return null;
	});
	for (const authorization of ['', 'Bearer wrong', `Basic ${TOKEN}`]) {
		const response = await post(
			base,
			{ jsonrpc: '2.0', method: 'ping', id: 1 },
			{ Authorization: authorization }
		);
		assert.equal(response.status, 401);
		assert.match(response.headers.get('www-authenticate'), /Bearer/);
	}
	assert.equal(calls, 0);
});

test('only authenticated JSON POSTs to /mcp are handled', async (t) => {
	let calls = 0;
	const base = await listen(t, async (message) => {
		calls++;
		return message.id === undefined ? null : { jsonrpc: '2.0', id: message.id, result: {} };
	});
	assert.equal((await post(base, {}, {}, '/')).status, 404);
	assert.equal((await post(base, {}, { Origin: 'https://evil.test' })).status, 403);
	const get = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
	assert.equal(get.status, 405);
	assert.equal(get.headers.get('allow'), 'POST');
	assert.equal((await post(base, '{}', { 'Content-Type': 'text/plain' })).status, 415);
	const malformed = await post(base, '{');
	assert.equal(malformed.status, 400);
	assert.equal((await malformed.json()).error.code, -32700);
	assert.equal(calls, 0);
	const reply = await post(base, { jsonrpc: '2.0', id: 3, method: 'ping' });
	assert.equal(reply.status, 200);
	assert.deepEqual(await reply.json(), { jsonrpc: '2.0', id: 3, result: {} });
	assert.equal(
		(await post(base, { jsonrpc: '2.0', method: 'notifications/initialized' })).status,
		202
	);
	assert.equal(calls, 2);
});

test('oversized bodies are refused before parsing', async (t) => {
	let calls = 0;
	const base = await listen(t, async () => {
		calls++;
		return null;
	});
	const response = await post(base, `"${'x'.repeat(1_100_000)}"`);
	assert.equal(response.status, 413);
	assert.equal(calls, 0);
});

test('the listener marks the endpoint enabled only while it exists', async () => {
	const server = brain.gateway.createBrainServer({
		token: TOKEN,
		port: 0,
		publicUrl: 'https://n.ts.net/mcp'
	});
	assert.deepEqual(brain.access.brainStatus().enabled, true);
	assert.equal(brain.access.brainStatus().publicUrl, 'https://n.ts.net/mcp');
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	await new Promise((resolve) => server.close(resolve));
	assert.equal(brain.access.brainStatus().enabled, false);
});
