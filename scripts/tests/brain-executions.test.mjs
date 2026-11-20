/**
 * Docker exec regressions for Brain commands, with a fake Dockerode client: PTY output and
 * line endings, the process-group marker, output retention, stdin, operator control, and
 * verified stops.
 * Run: node --experimental-strip-types --test scripts/tests/brain-executions.test.mjs
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { execStream, fakeDocker, loadBrain, runningContainer, target } from './brain-harness.mjs';

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

test('PTY line endings become LF, also when CR and LF arrive in separate chunks', () => {
	const normalize = brain.executions.createNewlineNormalizer();
	assert.equal(normalize('one\r\ntwo\r'), 'one\ntwo');
	assert.equal(normalize('\nthree'), '\nthree');
	// A lone CR (a progress line) stays, and the final flush keeps a trailing CR.
	assert.equal(normalize('50%\r100%\r'), '50%\r100%');
	assert.equal(normalize('', true), '\r');
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
	// Every command gets a PTY; a command without Brain input reads /dev/null.
	assert.equal(options.Tty, true);
	assert.equal(options.AttachStdin, true);
	assert.equal(options.Cmd.at(-2), 'closed');
	assert.equal(options.Cmd.at(-1), 'npm test');
	assert.ok(
		!options.Env.some((entry) => entry.startsWith('BRAIN_MCP') || entry.startsWith('DASHBOARD'))
	);
	assert.deepEqual(fake.docker.resizes, [{ h: 32, w: 120 }]);
	fake.main.push(Buffer.from(MARKER.slice(0, 5)));
	fake.main.push(Buffer.from(`${MARKER.slice(5)}ok\r`));
	// A multibyte character split across chunks decodes once.
	const accent = Buffer.from('\né');
	fake.main.push(accent.subarray(0, 2));
	fake.main.push(accent.subarray(2));
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
	assert.equal(fake.docker.execs.at(-1).options.Cmd.at(-2), 'open');
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
	fake.main.push(Buffer.from(MARKER));
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

test('end-of-file is Ctrl+D, submits an unfinished line first, and closes Brain input', async () => {
	const fake = install({ alive: () => true });
	const execution = await brain.executions.startExecution(fake.grant, {
		command: 'cat',
		interactive: true
	});
	brain.executions.writeInput(execution, 'partial', true);
	assert.deepEqual(fake.main.written, ['partial', '\u0004\u0004']);
	assert.throws(() => brain.executions.writeInput(execution, 'more\n'), /stdin was closed/);
	fake.end();
});

test('operator control refuses Brain input and cancel, and accepts operator keys', async () => {
	const fake = install({ alive: () => true });
	const { setController, startExecution, stopExecutionForBrain, writeInput, writeOperatorInput } =
		brain.executions;
	const execution = await startExecution(fake.grant, { command: 'python3', interactive: true });
	assert.equal(execution.controller, 'brain');
	// The operator cannot type before taking control.
	assert.throws(() => writeOperatorInput(execution, 'x'), /Take control/);
	assert.deepEqual(setController(execution.id, 'operator'), {
		status: 'running',
		controller: 'operator',
		interactive: true
	});
	writeOperatorInput(execution, 'print(1)\r');
	assert.throws(() => writeInput(execution, 'import os\n'), /operator has taken control/);
	await assert.rejects(stopExecutionForBrain(execution), /operator has taken control/);
	assert.equal(execution.status, 'running');
	assert.deepEqual(fake.main.written, ['print(1)\r']);
	// After the hand-back, Brain writes again.
	setController(execution.id, 'brain');
	writeInput(execution, 'exit()\n');
	assert.deepEqual(fake.main.written, ['print(1)\r', 'exit()\n']);
	fake.end();
	await brain.executions.waitUntilSettled(execution, 1000);
	assert.throws(() => setController(execution.id, 'operator'), /not running/);
});

test('the PTY follows the operator terminal size only while the operator has control', async () => {
	const fake = install({ alive: () => true });
	const { resizeTerminal, setController, startExecution } = brain.executions;
	const execution = await startExecution(fake.grant, { command: 'top' });
	await resizeTerminal(execution, 80, 24);
	assert.deepEqual(fake.docker.resizes, [{ h: 32, w: 120 }]);
	setController(execution.id, 'operator');
	await resizeTerminal(execution, 80, 24);
	assert.deepEqual(fake.docker.resizes.at(-1), { h: 24, w: 80 });
	await assert.rejects(resizeTerminal(execution, 0, 24), /Invalid terminal size/);
	fake.end();
});
