/**
 * Persistent Brain shell regressions. Unit tests use the fake Docker client. The real-shell
 * tests run each Docker exec as a local process: bash in a PTY from Python's pty module,
 * and control scripts with /bin/sh, so markers, job control and session stops are real.
 * Run: node --experimental-strip-types --test scripts/tests/brain-shells.test.mjs
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { after, before, beforeEach, test } from 'node:test';
import { execStream, fakeDocker, loadBrain, runningContainer, target } from './brain-harness.mjs';

const ID = 'd'.repeat(64);
const PGID = '\u001eddb-pgid:5151\u001e';
const PTY_PROGRAM =
	'import os, pty, sys\nsys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))';
const realShells =
	spawnSync('bash', ['-c', 'exit 0']).status === 0 &&
	spawnSync('python3', ['-c', 'import pty']).status === 0;

let brain;
let home;
before(async () => {
	brain = await loadBrain();
	home = await mkdtemp(join(tmpdir(), 'ddash-shell-home-'));
	// A user prompt hook that reads $?, as starship and similar prompts do.
	await writeFile(join(home, '.bashrc'), "PS1='user$ '\nPROMPT_COMMAND='__user_status=$?'\n");
});
after(async () => {
	await brain.cleanup();
	await rm(home, { recursive: true, force: true });
});
beforeEach(() => brain.state.resetBrainStateForTesting());

/** Wait until a condition holds, failing after `ms`. */
async function eventually(check, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('Condition not reached');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Prompt and start markers as the start-up file prints them. */
const prompt = (nonce, status, cwd) => `\u001b]6973;${nonce};P;${status};${cwd}\u0007`;
const start = (nonce) => `\u001b]6973;${nonce};C\u0007`;

test('the marker scanner finds split markers at absolute offsets and ignores other nonces', () => {
	const scan = brain.shells.createMarkerScanner('abc123');
	const marker = prompt('abc123', 2, '/work dir;x');
	const first = `out${marker.slice(0, 4)}`;
	assert.deepEqual(scan(first, 100 + first.length), []);
	const rest = `${marker.slice(4)}${start('abc123')}${prompt('other', 0, '/')}`;
	const end = 100 + first.length + rest.length;
	const found = scan(rest, end);
	assert.equal(found.length, 2);
	assert.deepEqual(found[0], {
		type: 'prompt',
		at: 103,
		end: 103 + marker.length,
		exitCode: 2,
		cwd: '/work dir;x'
	});
	assert.equal(found[1].type, 'start');
});

test('only short printable single-line commands are typed directly', () => {
	const { typeable, SHELL_LIMITS } = brain.shells;
	assert.equal(typeable('cd /tmp && ls -l "a b" | grep x!'), true);
	assert.equal(typeable('echo é'), true);
	assert.equal(typeable('a\tb'), false);
	assert.equal(typeable('one\ntwo'), false);
	assert.equal(typeable('continued \\'), false);
	assert.equal(typeable('x'.repeat(SHELL_LIMITS.typed + 1)), false);
});

test('the start script keeps the user hooks, adds the markers and removes its file', () => {
	const script = brain.shells.shellStartScript('feed01');
	assert.match(script, /\. "\$HOME\/\.bashrc"/);
	assert.match(script, /rm -f -- "\$DDB_BRAIN_RC"/);
	assert.match(
		script,
		/PROMPT_COMMAND="__ddb_brain_prompt\$\{PROMPT_COMMAND:\+;\$PROMPT_COMMAND\}"/
	);
	assert.match(script, /\\033\]6973;feed01;P;%s;%s\\007/);
	assert.match(script, /PS0="\$\{PS0-\}"\$'\\033\]6973;feed01;C\\007'/);
	assert.match(script, /exec bash --rcfile "\$rc" -i/);
});

/** Fake client for unit tests: the shell exec returns `main`; control scripts answer 0. */
function installFake({ foreground = 0 } = {}) {
	const main = execStream();
	const controls = [];
	const docker = fakeDocker(new Map([[ID, runningContainer(ID)]]), (options) => {
		if (options.Cmd[3] === 'dashboard-brain-control') {
			const stream = execStream();
			controls.push(options.Cmd);
			const code = options.Cmd[2].includes('/proc/$p/stat') ? foreground : 0;
			setImmediate(() => stream.push(null));
			return { stream, inspect: async () => ({ Running: false, ExitCode: code }) };
		}
		return { stream: main, inspect: async () => ({ Running: true, ExitCode: null }) };
	});
	brain.state.resetBrainStateForTesting(docker);
	const grant = brain.access.createGrant(target(ID), 60);
	return { docker, grant, main, controls };
}

test('without a start marker, the echoed command line is not part of the output', async () => {
	const fake = installFake();
	const shell = await brain.shells.openShell(fake.grant);
	const options = fake.docker.execs[0].options;
	assert.ok(options.Env.includes('TERM=xterm-256color'));
	assert.ok(!options.Env.includes('NO_COLOR=1'));
	assert.equal(options.Cmd.at(-2), 'open');
	const { nonce } = shell.shell;
	fake.main.push(Buffer.from(`${PGID}user$ ${prompt(nonce, 0, '/w')}`));
	await eventually(() => shell.shell.ready);
	const command = await brain.shells.runInShell(shell, 'ls --color');
	assert.deepEqual(fake.main.written, ['ls --color\r']);
	// bash 4.2 has no PS0: echo, coloured output, then the next prompt.
	fake.main.push(
		Buffer.from(`ls --color\r\n\u001b[34mdir\u001b[0m\r\n${prompt(nonce, 0, '/w')}user$ `)
	);
	await brain.shells.waitForCommand(shell, command, 1000);
	assert.equal(command.status, 'exited');
	assert.equal(command.exitCode, 0);
	assert.equal(brain.shells.commandOutput(shell, command).text, 'dir\n');
	assert.equal(brain.executions.executionView(shell).command, 'shell main');
	assert.equal(brain.executions.executionView(shell).shell.busy, false);
});

test('a shell refuses commands before its prompt, in the foreground and under operator control', async () => {
	const fake = installFake({ foreground: 1 });
	const shell = await brain.shells.openShell(fake.grant, { name: 'build' });
	await assert.rejects(brain.shells.runInShell(shell, 'make'), /not shown its prompt/);
	fake.main.push(Buffer.from(`${PGID}${prompt(shell.shell.nonce, 0, '/w')}`));
	await eventually(() => shell.shell.ready && shell.pgid === 5151);
	await assert.rejects(brain.shells.runInShell(shell, 'make'), /foreground/);
	brain.executions.setController(shell.id, 'operator');
	await assert.rejects(brain.shells.runInShell(shell, 'make'), /operator has taken control/);
	await assert.rejects(
		brain.shells.openShell(fake.grant, { name: 'build' }),
		/named build is open/
	);
	await assert.rejects(brain.shells.openShell(fake.grant, { name: '../x' }), /name must be/);
	assert.equal(fake.main.written.length, 0);
});

/** Duplex over a child process: writes go to its stdin, its stdout becomes readable. */
function processStream(child) {
	const stream = new Duplex({
		read() {},
		write(chunk, _encoding, callback) {
			child.stdin.write(chunk, callback);
		}
	});
	child.stdout.on('data', (chunk) => stream.push(chunk));
	child.on('close', () => stream.push(null));
	return stream;
}

/** Run every exec as a local process: TTY execs in a Python PTY, control scripts directly. */
function installReal() {
	const children = [];
	const docker = fakeDocker(new Map([[ID, runningContainer(ID)]]), (options) => {
		const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8' };
		for (const entry of options.Env ?? []) {
			const split = entry.indexOf('=');
			env[entry.slice(0, split)] = entry.slice(split + 1);
		}
		const [program, ...args] = options.Cmd;
		const child = options.Tty
			? spawn('python3', ['-c', PTY_PROGRAM, program, ...args], {
					cwd: options.WorkingDir,
					env
				})
			: spawn(program, args, { cwd: options.WorkingDir ?? home, env });
		children.push(child);
		let code = null;
		const exited = new Promise((resolve) => child.on('exit', (value) => resolve((code = value))));
		if (!options.Tty) {
			child.stdin.end();
			return {
				stream: child.stdout,
				inspect: async () => ({ Running: false, ExitCode: await exited })
			};
		}
		return {
			stream: processStream(child),
			inspect: async () => ({ Running: code === null, ExitCode: code })
		};
	});
	brain.state.resetBrainStateForTesting(docker);
	const grant = brain.access.createGrant(target(ID, { execUser: undefined, workdir: home }), 60);
	return {
		grant,
		children,
		kill: () => children.forEach((child) => child.kill('SIGKILL'))
	};
}

/** Call one MCP tool and return its structured result, or throw its error text. */
async function call(name, input) {
	const result = await brain.tools.callTool(name, input);
	if (result.isError) throw new Error(result.content[0].text);
	return result.structuredContent;
}

test(
	'a real shell keeps directory and variables, reports exit codes and keeps the user prompt hook',
	{ skip: !realShells && 'bash and python3 are required' },
	async () => {
		const real = installReal();
		try {
			const opened = await call('open_shell', { target_id: real.grant.id, wait_seconds: 10 });
			assert.equal(opened.ready, true);
			assert.equal(opened.name, 'main');
			assert.equal(opened.cwd, home);
			const shell_id = opened.shell_id;
			const run = (command) =>
				call('execute', { target_id: real.grant.id, shell_id, command, wait_seconds: 10 });

			const moved = await run('cd /tmp && export DDB_TEST=kept');
			assert.equal(moved.status, 'exited');
			assert.equal(moved.exit_code, 0);
			assert.equal(moved.cwd, '/tmp');
			const kept = await run('echo "$DDB_TEST!" && pwd');
			// No echoed command line, no prompt: only the command's output.
			assert.equal(kept.output, 'kept!\n/tmp\n');

			const failed = await run('false');
			assert.equal(failed.exit_code, 1);
			// The user's PROMPT_COMMAND still sees the command's status.
			assert.equal((await run('echo "$__user_status"')).output, '1\n');

			const colours = await run("printf '\\033[31mred\\033[0m\\n'");
			assert.equal(colours.output, 'red\n');

			const script = await run('for i in 1 2 3; do\n  echo "n$i"\ndone\ncd /');
			assert.equal(script.output, 'n1\nn2\nn3\n');
			assert.equal(script.cwd, '/');
			const leftovers = (await readdir('/tmp')).filter((name) => name.startsWith('.ddb-brain-'));
			assert.deepEqual(leftovers, []);

			const targets = await call('list_targets', {});
			assert.deepEqual(
				targets.targets[0].shells.map((shell) => [shell.name, shell.busy, shell.cwd]),
				[['main', false, '/']]
			);
		} finally {
			real.kill();
		}
	}
);

test(
	'a busy real shell refuses a second command, Ctrl+C interrupts it, and a stop ends every job',
	{ skip: !realShells && 'bash and python3 are required' },
	async () => {
		const real = installReal();
		try {
			const { shell_id } = await call('open_shell', { target_id: real.grant.id, wait_seconds: 10 });
			const run = (command, wait_seconds = 10) =>
				call('execute', { target_id: real.grant.id, shell_id, command, wait_seconds });
			const background = await run('sleep 300 & echo "pid=$!"');
			const pid = Number(/pid=(\d+)/.exec(background.output)[1]);

			const slow = await run('sleep 30', 0);
			assert.equal(slow.status, 'running');
			await assert.rejects(run('echo no'), /busy with command/);
			await call('write_stdin', { execution_id: shell_id, input: '\u0003' });
			const read = await call('read_output', {
				execution_id: shell_id,
				cursor: slow.next_cursor,
				wait_seconds: 5
			});
			const interrupted = brain.state.brainState.executions.get(shell_id).shell.current;
			await eventually(() => interrupted.status === 'exited');
			assert.equal(interrupted.exitCode, 130);
			assert.equal(read.status, 'running');
			assert.equal((await run('echo again')).output, 'again\n');

			const stop = await call('cancel_execution', { execution_id: shell_id });
			assert.equal(stop.confirmed, true);
			// The background job had its own process group; the session stop still ended it.
			assert.throws(() => process.kill(pid, 0));
		} finally {
			real.kill();
		}
	}
);
