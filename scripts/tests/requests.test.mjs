/**
 * Dependency-free regressions for the production request and latest-read helpers.
 * Run with Node 22.13+: node --experimental-strip-types --test scripts/tests/requests.test.mjs
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
	requestJson,
	requestText,
	latestRequest,
	RequestError,
	SESSION_EXPIRED
} from '../../src/lib/requests.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** Let a test decide when a simulated network request finishes. */
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

test('JSON and text reads check status and disable cached status responses', async () => {
	const calls = [];
	globalThis.fetch = async (url, options) => {
		calls.push({ url, options });
		return url === '/log' ? new Response('output') : Response.json({ ok: true });
	};
	assert.deepEqual(await requestJson('/data'), { ok: true });
	assert.equal(await requestText('/log'), 'output');
	assert.equal(calls[0].options.cache, 'no-store');
	assert.ok(calls[0].options.signal instanceof AbortSignal);
});

for (const status of [401, 403, 409, 500]) {
	test(`HTTP ${status} rejects with bounded display text`, async () => {
		globalThis.fetch = async () => Response.json({ message: 'x'.repeat(800) }, { status });
		await assert.rejects(requestJson('/data'), (cause) => {
			assert.ok(cause instanceof RequestError);
			assert.equal(cause.status, status);
			assert.equal(cause.message, status === 401 ? SESSION_EXPIRED : 'x'.repeat(500));
			return true;
		});
	});
}

test('HTML and malformed error bodies use a status fallback', async () => {
	for (const response of [
		new Response('<html>proxy failure</html>', { status: 500 }),
		new Response('{bad', { status: 500, headers: { 'Content-Type': 'application/json' } })
	]) {
		globalThis.fetch = async () => response;
		await assert.rejects(requestJson('/data'), /Request failed \(500\)/);
	}
});

test('malformed successful JSON is not treated as success', async () => {
	globalThis.fetch = async () => new Response('not JSON');
	await assert.rejects(requestJson('/data'), /unreadable response/);
});

test('network read failures are actionable and writes are explicitly uncertain, never retried', async () => {
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		throw new TypeError('network');
	};
	await assert.rejects(requestJson('/data'), /Check your connection and retry/);
	await assert.rejects(requestJson('/write', { method: 'POST' }), /may have completed/);
	assert.equal(calls, 2);
});

test('caller cancellation is preserved', async () => {
	const controller = new AbortController();
	controller.abort();
	globalThis.fetch = async (_url, options) => {
		throw options.signal.reason;
	};
	await assert.rejects(requestJson('/data', { signal: controller.signal }), { name: 'AbortError' });
});

test('a reversed old response cannot overwrite newer state even if it ignores abort', async () => {
	const reads = latestRequest();
	const old = deferred();
	const next = deferred();
	let oldSignal;
	const applied = [];
	const first = reads.run(
		(signal) => {
			oldSignal = signal;
			return old.promise;
		},
		(v) => applied.push(v)
	);
	const second = reads.run(() => next.promise, (v) => applied.push(v));
	assert.equal(oldSignal.aborted, true);
	next.resolve('new');
	assert.equal(await second, true);
	old.resolve('old');
	assert.equal(await first, false);
	assert.deepEqual(applied, ['new']);
});

test('obsolete rejection cannot replace a newer success with an error', async () => {
	const reads = latestRequest();
	const old = deferred();
	const first = reads.run(() => old.promise, () => assert.fail('obsolete apply'));
	await reads.run(async () => 'new', (value) => assert.equal(value, 'new'));
	old.reject(new Error('old failure'));
	assert.equal(await first, false);
});

test('current failures propagate and a later retry can succeed', async () => {
	const reads = latestRequest();
	await assert.rejects(
		reads.run(async () => {
			throw new Error('failed');
		}, () => {}),
		/failed/
	);
	assert.equal(await reads.run(async () => 42, (value) => assert.equal(value, 42)), true);
});

test('cleanup prevents late application or unhandled failure after unmount', async () => {
	for (const reject of [false, true]) {
		const reads = latestRequest();
		const pending = deferred();
		const result = reads.run(() => pending.promise, () => assert.fail('applied after cleanup'));
		reads.cancel();
		if (reject) pending.reject(new Error('late failure'));
		else pending.resolve('late result');
		assert.equal(await result, false);
	}
});
