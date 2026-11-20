/**
 * Brain terminal viewer regressions with a fake Dockerode client and a fake socket: replay,
 * live output, state changes, input ownership, PTY sizes, and the end of a command.
 * Run: node --experimental-strip-types --test scripts/tests/brain-viewers.test.mjs
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { execStream, fakeDocker, loadBrain, runningContainer, target } from './brain-harness.mjs';

const ID = 'd'.repeat(64);
const MARKER = '\u001eddb-pgid:4343\u001e';
let brain;
before(async () => {
	brain = await loadBrain();
});
after(() => brain.cleanup());
beforeEach(() => brain.state.resetBrainStateForTesting());

/** Wait until a condition holds, failing after one second. */
async function eventually(check) {
	const deadline = Date.now() + 1000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('Condition not reached');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** A fake socket that records messages and its close code. */
function peer() {
	return {
		messages: [],
		closed: null,
		bufferedAmount: 0,
		send(text) {
			this.messages.push(JSON.parse(text));
		},
		close(code, reason) {
			this.closed = { code, reason };
		}
	};
}

/** Start one command in a fake container. `end()` finishes it with exit code 0. */
async function start({ interactive = false } = {}) {
	const main = execStream();
	let finished = false;
	const docker = fakeDocker(new Map([[ID, runningContainer(ID)]]), (options) => {
		if (options.Cmd[3] === 'dashboard-brain-control') {
			const stream = execStream();
			setImmediate(() => stream.push(null));
			return { stream, inspect: async () => ({ Running: false, ExitCode: 1 }) };
		}
		return {
			stream: main,
			inspect: async () => ({ Running: !finished, ExitCode: finished ? 0 : null })
		};
	});
	brain.state.resetBrainStateForTesting(docker);
	const grant = brain.access.createGrant(target(ID), 60);
	const execution = await brain.executions.startExecution(grant, {
		command: 'npm test',
		interactive
	});
	main.push(Buffer.from(`${MARKER}first\r\n`));
	await eventually(() => execution.output === 'first\n');
	return {
		docker,
		execution,
		main,
		end() {
			finished = true;
			main.push(null);
		}
	};
}

test('a viewer of an unknown command is told that it is missing', () => {
	const socket = peer();
	assert.equal(brain.viewers.connectViewer('x_missing', socket), null);
	assert.deepEqual(socket.messages, [{ type: 'missing' }]);
	assert.equal(socket.closed.code, 1008);
});

test('a viewer replays output, follows live output and state, and closes at the end', async () => {
	const run = await start();
	const socket = peer();
	const viewer = brain.viewers.connectViewer(run.execution.id, socket);
	assert.ok(viewer);
	assert.deepEqual(socket.messages[0], {
		type: 'ready',
		output: 'first\n',
		truncated: false,
		state: { status: 'running', controller: 'brain', interactive: false }
	});
	run.main.push(Buffer.from('second\r\n'));
	await eventually(() => socket.messages.some((message) => message.type === 'data'));
	assert.deepEqual(socket.messages[1], { type: 'data', data: 'second\n' });
	brain.executions.setController(run.execution.id, 'operator');
	assert.deepEqual(socket.messages.at(-1), {
		type: 'state',
		state: { status: 'running', controller: 'operator', interactive: false }
	});
	run.end();
	await eventually(() => socket.closed !== null);
	assert.equal(socket.closed.code, 1000);
	assert.deepEqual(socket.messages.at(-1).state, {
		status: 'exited',
		controller: 'operator',
		interactive: false,
		exitCode: 0
	});
	assert.equal(run.execution.listeners.size, 0);
});

test('viewer keys reach the PTY only after the operator takes control', async () => {
	const run = await start({ interactive: true });
	const socket = peer();
	const viewer = brain.viewers.connectViewer(run.execution.id, socket);
	await viewer.message(JSON.stringify({ type: 'data', data: 'y' }));
	assert.deepEqual(run.main.written, []);
	assert.equal(socket.messages.at(-1).type, 'error');
	assert.match(socket.messages.at(-1).message, /Take control/);
	await viewer.message(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }));
	assert.deepEqual(run.docker.resizes, [{ h: 32, w: 120 }]);
	brain.executions.setController(run.execution.id, 'operator');
	await viewer.message(JSON.stringify({ type: 'data', data: 'y\r' }));
	await viewer.message(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }));
	assert.deepEqual(run.main.written, ['y\r']);
	assert.deepEqual(run.docker.resizes.at(-1), { h: 20, w: 90 });
	run.end();
});

test('an invalid message closes the viewer without stopping the command', async () => {
	const run = await start();
	const socket = peer();
	const viewer = brain.viewers.connectViewer(run.execution.id, socket);
	await viewer.message('{"type":"exec","command":"rm -rf /"}');
	assert.equal(socket.closed.code, 1008);
	assert.equal(run.execution.status, 'running');
	assert.equal(run.execution.listeners.size, 0);
	run.end();
});

test('a slow viewer is disconnected, and an ended command replays then closes', async () => {
	const run = await start();
	const slow = peer();
	brain.viewers.connectViewer(run.execution.id, slow);
	slow.bufferedAmount = brain.viewers.VIEWER_LIMITS.backlog + 1;
	run.main.push(Buffer.from('more\r\n'));
	await eventually(() => slow.closed !== null);
	assert.equal(slow.closed.code, 1013);
	run.end();
	await brain.executions.waitUntilSettled(run.execution, 1000);
	const late = peer();
	assert.equal(brain.viewers.connectViewer(run.execution.id, late), null);
	assert.equal(late.messages[0].output, 'first\nmore\n');
	assert.equal(late.messages[0].state.status, 'exited');
	assert.equal(late.closed.code, 1000);
});
