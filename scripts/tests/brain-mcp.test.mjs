/**
 * MCP protocol regressions for the Brain endpoint.
 * Run: node --experimental-strip-types --test scripts/tests/brain-mcp.test.mjs
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { loadBrain } from './brain-harness.mjs';

let brain;
before(async () => {
	brain = await loadBrain();
});
after(() => brain.cleanup());

const request = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('initialize negotiates a supported protocol version and announces tools only', async () => {
	const { handleMcpMessage } = brain.mcp;
	const known = await handleMcpMessage(request('initialize', { protocolVersion: '2025-06-18' }));
	assert.equal(known.result.protocolVersion, '2025-06-18');
	assert.deepEqual(known.result.capabilities, { tools: { listChanged: false } });
	assert.match(known.result.instructions, /list_targets/);
	const future = await handleMcpMessage(request('initialize', { protocolVersion: '2099-01-01' }));
	assert.equal(future.result.protocolVersion, brain.mcp.SUPPORTED_PROTOCOL_VERSIONS[0]);
});

test('the tool set is fixed and offers no grant, Docker or host tools', async () => {
	const reply = await brain.mcp.handleMcpMessage(request('tools/list'));
	assert.deepEqual(
		reply.result.tools.map((tool) => tool.name),
		[
			'list_targets',
			'open_shell',
			'execute',
			'read_output',
			'write_stdin',
			'cancel_execution',
			'request_more_time'
		]
	);
	for (const tool of reply.result.tools) assert.equal(tool.inputSchema.type, 'object');
	// The dashboard shows each command under the goal that Brain gives for it.
	const execute = reply.result.tools.find((tool) => tool.name === 'execute');
	assert.ok(execute.inputSchema.required.includes('goal'));
});

test('notifications and client responses are acknowledged without a reply', async () => {
	const { handleMcpMessage } = brain.mcp;
	assert.equal(
		await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }),
		null
	);
	assert.equal(await handleMcpMessage({ jsonrpc: '2.0', id: 7, result: {} }), null);
});

test('malformed messages, batches and unknown methods are JSON-RPC errors', async () => {
	const { handleMcpMessage } = brain.mcp;
	assert.equal((await handleMcpMessage([request('ping')])).error.code, -32600);
	assert.equal(
		(await handleMcpMessage({ jsonrpc: '1.0', id: 1, method: 'ping' })).error.code,
		-32600
	);
	assert.equal(
		(await handleMcpMessage({ jsonrpc: '2.0', id: {}, method: 'ping' })).error.code,
		-32600
	);
	assert.equal((await handleMcpMessage(request('resources/list'))).error.code, -32601);
	assert.equal((await handleMcpMessage(request('ping', []))).error.code, -32602);
	assert.deepEqual((await handleMcpMessage(request('ping', undefined, 'a'))).result, {});
});

test('tools/call rejects unknown tools before calling anything', async () => {
	let called = false;
	const reply = await brain.mcp.handleMcpMessage(
		request('tools/call', { name: 'docker_run' }),
		() => {
			called = true;
		}
	);
	assert.equal(reply.error.code, -32602);
	assert.equal(called, false);
});

test('tool failures become tool errors, and unexpected failures stay internal', async () => {
	const failing = async () => {
		throw new Error('secret detail');
	};
	const reply = await brain.mcp.handleMcpMessage(
		request('tools/call', { name: 'list_targets', arguments: {} }),
		failing
	);
	assert.equal(reply.error.code, -32603);
	assert.doesNotMatch(JSON.stringify(reply), /secret detail/);
	const input = await brain.mcp.handleMcpMessage(
		request('tools/call', { name: 'list_targets', arguments: { extra: 1 } })
	);
	assert.equal(input.result.isError, true);
	assert.match(input.result.content[0].text, /Unknown arguments: extra/);
});
