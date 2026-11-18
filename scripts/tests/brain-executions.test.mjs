/**
 * Docker exec regressions for Brain commands, with a fake Dockerode client: stream
 * demultiplexing, the process-group marker, output retention, stdin, and verified stops.
 * Run: node --experimental-strip-types --test scripts/tests/brain-executions.test.mjs
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import {
	execStream,
	fakeDocker,
	frame,
	loadBrain,
	runningContainer,
	target
} from './brain-harness.mjs';

const ID = 'c'.repeat(64);
const MARKER = '\u001eddb-pgid:4242\u001e';
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

/**
 * Install a fake client. The command exec returns `main`; control execs answer the
 * liveness script from `alive()` and record signals.
 */
function install({ alive = () => false, exitCode = 0 } = {}) {
	const main = execStream();
	const signals = [];
	let finished = false;
	const docker = fakeDocker(new Map([[ID, runningContainer(ID)]]), (options) => {
		if (options.Cmd[3] === 'dashboard-brain-control') {
			const stream = execStream();
			const script = options.Cmd[2];
			let code = 0;
			if (script.startsWith('kill -0')) code = alive() ? 0 : 1;
			else signals.push(options.Cmd[5]);
			setImmediate(() => stream.push(null));
			return { stream, inspect: async () => ({ Running: false, ExitCode: code }) };
		}
		return {
			stream: main,
			inspect: async () => ({ Running: !finished, ExitCode: finished ? exitCode : null })
		};
	});
	brain.state.resetBrainStateForTesting(docker);
	const grant = brain.access.createGrant(target(ID), 60);
	return {
		docker,
		grant,
		main,
		signals,
		end() {
			finished = true;
			main.push(null);
		}
	};
}

test('the demuxer reassembles frames split across chunks', () => {
	const frames = [];
	const demux = brain.executions.createDemuxer((stream, payload) =>
		frames.push([stream, payload.toString()])
	);
	const bytes = Buffer.concat([frame(1, 'hello '), frame(2, 'warn'), frame(1, 'world')]);
	for (let index = 0; index < bytes.length; index += 3) demux(bytes.subarray(index, index + 3));
	assert.deepEqual(frames, [
		[1, 'hello '],
		[2, 'warn'],
		[1, 'world']
	]);
});

test('the marker parser waits for a complete marker and rejects invalid ones', () => {
	const { parseMarker } = brain.executions;
	assert.equal(parseMarker('\u001eddb'), 'incomplete');
	assert.equal(parseMarker(MARKER.slice(0, -1)), 'incomplete');
	assert.deepEqual(parseMarker(`${MARKER}output`), { pgid: 4242, rest: 'output' });
	assert.equal(parseMarker('plain output'), null);
	assert.equal(parseMarker('\u001eddb-pgid:1\u001e'), null);
});

test('a command runs as the granted user, strips the marker and reports its exit code', async () => {
	const fake = install({ exitCode: 3 });
	const execution = await brain.executions.startExecution(fake.grant, { command: 'npm test' });
	const options = fake.docker.execs[0].options;
	assert.equal(options.User, 'developer');
	assert.equal(options.WorkingDir, '/workspaces/sample');
	assert.equal(options.Tty, false);
	assert.equal(options.AttachStdin, false);
	assert.equal(options.Cmd.at(-1), 'npm test');
	assert.ok(
		!options.Env.some((entry) => entry.startsWith('BRAIN_MCP') || entry.startsWith('DASHBOARD'))
	);
	fake.main.push(frame(1, MARKER.slice(0, 5)));
	fake.main.push(frame(1, `${MARKER.slice(5)}ok\n`));
	// A multibyte character split across frames decodes once.
	const accent = Buffer.from('é');
	fake.main.push(frame(2, accent.subarray(0, 1)));
	fake.main.push(frame(2, accent.subarray(1)));
	fake.end();
	await brain.executions.waitUntilSettled(execution, 1000);
	assert.equal(execution.pgid, 4242);
	assert.equal(execution.output, 'ok\né');
	assert.equal(execution.status, 'exited');
	assert.equal(execution.exitCode, 3);
});

test('output beyond the retention limit drops the oldest text and keeps cursors absolute', () => {
	const { appendOutput, readOutput, EXECUTION_LIMITS } = brain.executions;
	const execution = {
		id: 'x',
		output: '',
		outputStart: 0,
		version: 0,
		waiters: new Set(),
		status: 'running'
	};
	appendOutput(execution, 'a'.repeat(EXECUTION_LIMITS.output + 70_000));
	appendOutput(execution, 'END');
	assert.equal(execution.output.length, EXECUTION_LIMITS.output + 3);
	const first = readOutput(execution, 0);
	assert.equal(first.truncatedBefore, true);
	assert.equal(first.cursor, execution.outputStart);
	assert.equal(first.text.length, EXECUTION_LIMITS.read);
	assert.equal(first.more, true);
	const last = readOutput(execution, execution.outputStart + execution.output.length - 3);
	assert.equal(last.text, 'END');
	assert.equal(last.more, false);
	assert.equal(readOutput(execution, 10 ** 12).text, '');
});

test('stdin is refused for non-interactive commands and after a stop begins', async () => {
	const fake = install({ alive: () => true });
	const closed = await brain.executions.startExecution(fake.grant, { command: 'cat' });
	assert.throws(() => brain.executions.writeInput(closed, 'x'), /without stdin/);
	const open = await brain.executions.startExecution(fake.grant, {
		command: 'cat',
		interactive: true
	});
	brain.executions.writeInput(open, 'line\n');
	assert.deepEqual(fake.main.written, ['line\n']);
	const stopping = brain.executions.stopExecution(open.id, 'test');
	assert.throws(() => brain.executions.writeInput(open, 'late\n'), /not accepting input/);
	assert.deepEqual(fake.main.written, ['line\n']);
	fake.end();
	await stopping.catch(() => undefined);
});

test('a stop signals the process group and confirms that it is gone', async () => {
	let alive = true;
	const fake = install({ alive: () => alive });
	const execution = await brain.executions.startExecution(fake.grant, { command: 'sleep 300' });
	fake.main.push(frame(1, MARKER));
	await eventually(() => execution.pgid === 4242);
	const stop = brain.executions.stopExecution(execution.id, 'Cancelled by test');
	assert.equal(execution.status, 'stopping');
	await eventually(() => fake.signals.length === 1);
	assert.deepEqual(fake.signals, ['TERM']);
	alive = false;
	fake.end();
	assert.equal(await stop, 'stopped');
	assert.equal(execution.status, 'stopped');
	assert.equal(execution.stopReason, 'Cancelled by test');
	// A second stop returns the final status without signalling again.
	assert.equal(await brain.executions.stopExecution(execution.id, 'again'), 'stopped');
	assert.deepEqual(fake.signals, ['TERM']);
});

test('limits reject oversized commands, relative directories and too many running commands', async () => {
	const fake = install();
	const { startExecution, EXECUTION_LIMITS } = brain.executions;
	await assert.rejects(startExecution(fake.grant, { command: ' ' }), /1 to/);
	await assert.rejects(
		startExecution(fake.grant, { command: 'x'.repeat(EXECUTION_LIMITS.command + 1) }),
		/1 to/
	);
	await assert.rejects(
		startExecution(fake.grant, { command: 'ls', workdir: 'relative' }),
		/absolute/
	);
	for (let index = 0; index < EXECUTION_LIMITS.runningPerGrant; index++)
		await startExecution(fake.grant, { command: 'sleep 300' });
	await assert.rejects(startExecution(fake.grant, { command: 'sleep 300' }), /At most/);
});

test('a failed exec start is kept as a failed execution', async () => {
	const docker = fakeDocker(new Map([[ID, runningContainer(ID)]]), () => ({
		startError: new Error('OCI runtime exec failed: chdir'),
		inspect: async () => ({ Running: false, ExitCode: 126 })
	}));
	brain.state.resetBrainStateForTesting(docker);
	const grant = brain.access.createGrant(target(ID), 15);
	const execution = await brain.executions.startExecution(grant, { command: 'ls' });
	assert.equal(execution.status, 'failed');
	assert.match(execution.error, /chdir/);
});
