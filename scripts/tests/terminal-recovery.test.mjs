/**
 * Exercise explicit-start recovery without application dependencies or a real PTY.
 * Run with Node 22: node --experimental-strip-types --test scripts/tests/terminal-recovery.test.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

/** Isolate the module ledger and restore the global fetch implementation after each case. */
async function fixture(context, handler) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, options = {}) => {
		calls.push({ url, options });
		return handler(url, options);
	};
	context.after(() => {
		globalThis.fetch = original;
	});
	const source = new URL('../../src/lib/terminalCreation.ts', import.meta.url);
	source.searchParams.set('test', randomUUID());
	const { ensureTerminal } = await import(source.href);
	return { ensureTerminal, calls };
}

/** Build a minimal HTTP response without tying tests to serialized error bodies. */
function response(status) {
	return new Response(null, { status });
}

/** Count process-creation attempts separately from read-only existence checks. */
function posts(calls) {
	return calls.filter(({ options }) => options.method === 'POST');
}

test('retries a failed initial probe instead of caching its rejection', async (context) => {
	let probes = 0;
	const { ensureTerminal, calls } = await fixture(context, (_url, options) => {
		if (options.method === 'POST') return response(201);
		if (++probes === 1) throw new TypeError('network unavailable');
		return response(404);
	});
	const start = { id: 'probe-retry', name: 'Shell' };
	await assert.rejects(ensureTerminal(start), /network unavailable/);
	await ensureTerminal(start);
	assert.equal(posts(calls).length, 1);
	assert.equal(probes, 2);
	assert.equal(calls[0].options.cache, 'no-store');
	assert.ok(calls.every(({ options }) => options.signal instanceof AbortSignal));
});

test('retries an unauthorized probe after sign-in', async (context) => {
	let authorized = false;
	const { ensureTerminal, calls } = await fixture(context, (_url, options) =>
		response(options.method === 'POST' ? 201 : authorized ? 404 : 401)
	);
	const start = { id: 'probe-auth', name: 'Shell' };
	await assert.rejects(ensureTerminal(start), /Sign in/);
	assert.equal(posts(calls).length, 0);
	authorized = true;
	await ensureTerminal(start);
	assert.equal(posts(calls).length, 1);
});

test('retries explicit authentication rejection before process creation', async (context) => {
	let authorized = false;
	const { ensureTerminal, calls } = await fixture(context, (_url, options) =>
		response(options.method === 'POST' ? (authorized ? 201 : 401) : 404)
	);
	const start = { id: 'start-auth', name: 'Shell' };
	await assert.rejects(ensureTerminal(start), /Sign in/);
	authorized = true;
	await ensureTerminal(start);
	assert.equal(posts(calls).length, 2);
	assert.deepEqual(JSON.parse(posts(calls)[1].options.body), start);
});

test('deduplicates simultaneous viewers and ignores one disposed viewer', async (context) => {
	let release;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	const { ensureTerminal, calls } = await fixture(context, (_url, options) =>
		options.method === 'POST' ? pending : response(404)
	);
	const controller = new AbortController();
	const start = { id: 'shared-start', name: 'Shell' };
	const disposed = assert.rejects(ensureTerminal(start, controller.signal), { name: 'AbortError' });
	const survivor = ensureTerminal(start);
	controller.abort();
	release(response(201));
	await Promise.all([disposed, survivor]);
	assert.equal(posts(calls).length, 1);
	assert.equal(posts(calls)[0].options.signal.aborted, false);
});

test('an already disposed viewer cannot initiate a start', async (context) => {
	const { ensureTerminal, calls } = await fixture(context, () => response(404));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(ensureTerminal({ id: 'disposed', name: 'Shell' }, controller.signal), {
		name: 'AbortError'
	});
	assert.equal(calls.length, 0);
});

test('a lost start response can recover an existing process without another POST', async (context) => {
	let exists = false;
	const { ensureTerminal, calls } = await fixture(context, (_url, options) => {
		if (options.method === 'POST') {
			exists = true;
			throw new TypeError('response lost');
		}
		return response(exists ? 200 : 404);
	});
	const start = { id: 'lost-response', command: 'run-once', name: 'Command' };
	await assert.rejects(ensureTerminal(start), /response lost/);
	await ensureTerminal(start);
	assert.equal(posts(calls).length, 1);
});

test('an uncertain start never reruns a command when the process is missing', async (context) => {
	const { ensureTerminal, calls } = await fixture(context, (_url, options) => {
		if (options.method === 'POST') throw new TypeError('response lost');
		return response(404);
	});
	const start = { id: 'uncertain', command: 'run-once', name: 'Command' };
	await assert.rejects(ensureTerminal(start), /response lost/);
	await assert.rejects(ensureTerminal(start), /outcome is unknown/);
	await assert.rejects(ensureTerminal(start), /will not be rerun/);
	assert.equal(posts(calls).length, 1);
});

for (const status of [500, 502, 503, 504]) {
	test(`HTTP ${status} cannot authorize automatic command replay`, async (context) => {
		const { ensureTerminal, calls } = await fixture(context, (_url, options) =>
			response(options.method === 'POST' ? status : 404)
		);
		const start = { id: `error-${status}`, command: 'run-once' };
		await assert.rejects(ensureTerminal(start), /Could not confirm/);
		await assert.rejects(ensureTerminal(start), /outcome is unknown/);
		assert.equal(posts(calls).length, 1);
	});
}

test('an uncertain start remains probe-only across a later authentication failure', async (context) => {
	let status = 404;
	const { ensureTerminal, calls } = await fixture(context, (_url, options) => {
		if (options.method === 'POST') throw new DOMException('Start timed out', 'TimeoutError');
		return response(status);
	});
	const start = { id: 'uncertain-auth', name: 'Shell' };
	await assert.rejects(ensureTerminal(start), { name: 'TimeoutError' });
	status = 401;
	await assert.rejects(ensureTerminal(start), /Sign in/);
	status = 404;
	await assert.rejects(ensureTerminal(start), /outcome is unknown/);
	assert.equal(posts(calls).length, 1);
});

test('a probe timeout is retryable because no command was dispatched', async (context) => {
	let timeout = true;
	const { ensureTerminal, calls } = await fixture(context, (_url, options) => {
		if (options.method === 'POST') return response(201);
		if (timeout) throw new DOMException('Probe timed out', 'TimeoutError');
		return response(404);
	});
	const start = { id: 'probe-timeout', name: 'Shell' };
	await assert.rejects(ensureTerminal(start), { name: 'TimeoutError' });
	assert.equal(posts(calls).length, 0);
	timeout = false;
	await ensureTerminal(start);
	assert.equal(posts(calls).length, 1);
});

test('a confirmed process never restarts after exit or server restart', async (context) => {
	let exists = false;
	const { ensureTerminal, calls } = await fixture(context, (_url, options) => {
		if (options.method === 'POST') {
			exists = true;
			return response(201);
		}
		return response(exists ? 200 : 404);
	});
	const start = { id: 'confirmed', command: 'run-once', name: 'Command' };
	await ensureTerminal(start);
	await ensureTerminal(start);
	exists = false;
	await assert.rejects(ensureTerminal(start), /no longer exists/);
	assert.equal(posts(calls).length, 1);
});

test('an existing server-created run is attach-only even after it disappears', async (context) => {
	let exists = true;
	const { ensureTerminal, calls } = await fixture(context, () => response(exists ? 200 : 404));
	await ensureTerminal({ id: 'existing-build' });
	exists = false;
	await assert.rejects(ensureTerminal({ id: 'existing-build' }), /no longer exists/);
	await assert.rejects(ensureTerminal({ id: 'missing-build' }), /no longer exists/);
	assert.equal(posts(calls).length, 0);
});

test('a full ledger fails closed instead of forgetting an old command outcome', async (context) => {
	let exists = true;
	const { ensureTerminal, calls } = await fixture(context, () => response(exists ? 200 : 404));
	for (let index = 0; index < 1000; index++)
		await ensureTerminal({ id: `ledger-${index}`, name: 'Shell' });
	await assert.rejects(ensureTerminal({ id: 'overflow', name: 'Shell' }), /history is full/);
	exists = false;
	await assert.rejects(ensureTerminal({ id: 'ledger-0', name: 'Shell' }), /no longer exists/);
	assert.equal(posts(calls).length, 0);
});
