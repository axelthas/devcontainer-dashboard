/**
 * Brain commands run through the Docker exec API inside one granted container, each in its
 * own pseudo-terminal (PTY), so the operator can watch it in a terminal tab and take control.
 * Docker has no exec kill API, so a wrapper reports the command's process ID before the
 * command starts. runc starts every exec process as a session leader, so that PID is also the
 * process group ID, and cancellation signals the whole group from a second exec as the same user.
 *
 * Input ownership: Brain writes only to interactive commands, and only while it has control.
 * The operator takes control explicitly; Brain input is then refused until the operator hands
 * control back. Brain can always read the output, which includes what the PTY echoes.
 *
 * A shell (`kind: 'shell'`) is one long-lived interactive bash that `shells.ts` types commands
 * into. It runs with a colour terminal, and job control puts each job in its own process
 * group, so stopping a shell signals its whole session instead of one process group.
 */
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type Dockerode from 'dockerode';
import type { Duplex } from 'node:stream';
import type {
	BrainController,
	BrainExecutionKind,
	BrainExecutionStatus,
	BrainExecutionView,
	BrainOutputView,
	BrainShellCommandView,
	BrainTerminalState
} from '../../brainTypes.js';
import type { BrainExecution, BrainGrant, BrainShellCommand } from './state.js';
import { brainDocker, brainState, notify } from './state.js';

export const EXECUTION_LIMITS = {
	command: 16_384,
	input: 16_384,
	output: 1_000_000,
	read: 65_536,
	running: 16,
	runningPerGrant: 4,
	retained: 64,
	retainMs: 3_600_000,
	waitMs: 60_000,
	/** Initial PTY size; the operator's terminal resizes it while the operator has control */
	columns: 120,
	rows: 32
};

export class BrainExecutionError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = 'BrainExecutionError';
		this.status = status;
	}
}

const MARKER_PREFIX = '\u001eddb-pgid:';
const MARKER_END = '\u001e';
/**
 * Report the PID, then replace the shell with a login shell, so the PID stays the same.
 * `$1` is `closed` for a command without Brain input: its stdin is /dev/null, as without a
 * terminal, but programs that open /dev/tty and Ctrl+C from the operator still reach it.
 */
const WRAPPER = `printf '\\036ddb-pgid:%s\\036' "$$"; if [ "$1" = closed ]; then exec </dev/null; fi; if command -v bash >/dev/null 2>&1; then exec bash -lc "$2"; fi; exec sh -lc "$2"`;
/** Exit 0 while any process of the group exists. Shells differ in kill syntax. */
const ALIVE_SCRIPT = 'kill -0 -"$1" 2>/dev/null || kill -0 -- -"$1" 2>/dev/null';
const SIGNAL_SCRIPT =
	'kill -"$2" -"$1" 2>/dev/null || kill -s "$2" -- -"$1" 2>/dev/null || kill -"$2" "$1" 2>/dev/null; exit 0';
/**
 * Session scripts for shells. The shell is the session leader (runc starts every exec in a
 * new session), and its jobs keep the session ID. Field 4 after the command name in
 * /proc/PID/stat is the session ID.
 */
const SESSION_EACH =
	'for f in /proc/[0-9]*/stat; do s=$(cat "$f" 2>/dev/null) || continue; s=${s##*") "}; set -- $s; [ "$4" = "$p" ] || continue; q=${f#/proc/}; q=${q%/stat};';
const SESSION_ALIVE_SCRIPT = `p=$1; ${SESSION_EACH} exit 0; done; exit 1`;
const SESSION_SIGNAL_SCRIPT = `p=$1; g=$2; ${SESSION_EACH} kill -s "$g" "$q" 2>/dev/null; done; exit 0`;
/** Non-interactive defaults for an agent: no colour, pagers or credential prompts. */
const EXEC_ENV = ['TERM=dumb', 'NO_COLOR=1', 'PAGER=cat', 'GIT_PAGER=cat', 'GIT_TERMINAL_PROMPT=0'];
/** A shell looks like a regular terminal, but still has no pagers or credential prompts. */
const SHELL_ENV = ['TERM=xterm-256color', 'PAGER=cat', 'GIT_PAGER=cat', 'GIT_TERMINAL_PROMPT=0'];
/** OSC, CSI and other escape sequences, and stray control characters except LF, CR and TAB. */
const TERMINAL_ESCAPES =
	// eslint-disable-next-line no-control-regex -- stripping terminal control sequences is the purpose
	/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** Ctrl+D: end-of-file for a reader in canonical terminal mode */
const END_OF_FILE = '\u0004';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Shell output as plain text for Brain: no colours, cursor movement, window titles or
 * prompt markers. The operator's terminal receives the raw output.
 */
export function cleanTerminalText(text: string): string {
	return text.replace(TERMINAL_ESCAPES, '');
}

/** True until the execution has a final status. */
export function isActive(execution: BrainExecution): boolean {
	return execution.status === 'running' || execution.status === 'stopping';
}

/**
 * Convert the PTY's CRLF line endings back to LF, so Brain reads output as without a
 * terminal. A trailing CR waits for the next chunk, because its LF can arrive separately.
 * Lone CRs (progress lines) stay. Call with `end` to flush.
 */
export function createNewlineNormalizer(): (text: string, end?: boolean) => string {
	let carry = false;
	return (text, end = false) => {
		let value = carry ? `\r${text}` : text;
		carry = !end && value.endsWith('\r');
		if (carry) value = value.slice(0, -1);
		return value.replace(/\r\n/g, '\n');
	};
}

/**
 * Read the start marker. `incomplete`: wait for more output. `null`: no marker, so the text
 * is ordinary output and the process group is unknown.
 */
export function parseMarker(text: string): { pgid: number; rest: string } | 'incomplete' | null {
	if (text.length < MARKER_PREFIX.length)
		return MARKER_PREFIX.startsWith(text) ? 'incomplete' : null;
	if (!text.startsWith(MARKER_PREFIX)) return null;
	const end = text.indexOf(MARKER_END, MARKER_PREFIX.length);
	if (end === -1) return text.length > MARKER_PREFIX.length + 12 ? null : 'incomplete';
	const pgid = Number(text.slice(MARKER_PREFIX.length, end));
	if (!Number.isSafeInteger(pgid) || pgid <= 1) return null;
	return { pgid, rest: text.slice(end + 1) };
}

/** Append output and drop the oldest characters beyond the retention limit. */
export function appendOutput(execution: BrainExecution, text: string): void {
	if (!text) return;
	execution.output += text;
	// Trim in batches, so a long run does not copy the whole buffer for every chunk.
	if (execution.output.length > EXECUTION_LIMITS.output + 65_536) {
		const excess = execution.output.length - EXECUTION_LIMITS.output;
		execution.output = execution.output.slice(excess);
		execution.outputStart += excess;
	}
	notify(execution, text);
}

/** One bounded page of output from `cursor`, or from the oldest retained character. */
export function readOutput(execution: BrainExecution, cursor?: number): BrainOutputView {
	const end = execution.outputStart + execution.output.length;
	const start = Math.min(Math.max(cursor ?? execution.outputStart, execution.outputStart), end);
	const offset = start - execution.outputStart;
	const raw = execution.output.slice(offset, offset + EXECUTION_LIMITS.read);
	// Cursors count raw characters, so cleaning shell output never shifts them.
	const text = execution.kind === 'shell' ? cleanTerminalText(raw) : raw;
	return {
		executionId: execution.id,
		text,
		cursor: start,
		nextCursor: start + raw.length,
		truncatedBefore: (cursor ?? 0) < execution.outputStart,
		more: start + raw.length < end,
		status: execution.status,
		...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode })
	};
}

/** Resolve after the next output or status change, or after the timeout. */
export function waitForChange(execution: BrainExecution, timeoutMs: number): Promise<void> {
	if (timeoutMs <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			execution.waiters.delete(done);
			resolve();
		};
		const timer = setTimeout(done, timeoutMs);
		execution.waiters.add(done);
	});
}

/** Wait until the execution has a final status, or until the timeout. */
export async function waitUntilSettled(
	execution: BrainExecution,
	timeoutMs: number
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (isActive(execution) && Date.now() < deadline)
		await waitForChange(execution, deadline - Date.now());
}

/** Wait until output exists beyond `cursor`, the execution settles, or the timeout passes. */
export async function waitForOutput(
	execution: BrainExecution,
	cursor: number,
	timeoutMs: number
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (
		isActive(execution) &&
		execution.outputStart + execution.output.length <= cursor &&
		Date.now() < deadline
	)
		await waitForChange(execution, deadline - Date.now());
}

/** Remove settled executions beyond the age and count limits, oldest first. */
function pruneRetained(now: number): void {
	const settled = [...brainState.executions.values()]
		.filter((execution) => !isActive(execution))
		.sort((a, b) => a.startedAt - b.startedAt);
	let excess = brainState.executions.size - EXECUTION_LIMITS.retained;
	for (const execution of settled) {
		if (excess <= 0 && now - (execution.endedAt ?? execution.startedAt) < EXECUTION_LIMITS.retainMs)
			continue;
		brainState.executions.delete(execution.id);
		excess--;
	}
}

/** Bounded, display-safe text for a failure. */
function failureText(cause: unknown): string {
	return (cause instanceof Error ? cause.message : 'Docker exec failed').slice(0, 500);
}

/** Record the exit status after Docker closes the output stream. */
async function finish(execution: BrainExecution, exec: Dockerode.Exec, cause?: unknown) {
	if (execution.streamEnded) return;
	execution.streamEnded = true;
	execution.stdin = undefined;
	let exitCode: number | undefined;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			const info = await exec.inspect();
			if (!info.Running) {
				exitCode = typeof info.ExitCode === 'number' ? info.ExitCode : undefined;
				break;
			}
		} catch {
			break;
		}
		await delay(100);
	}
	execution.exitCode = exitCode;
	if (execution.status === 'running') {
		execution.status = exitCode === undefined ? 'failed' : 'exited';
		execution.endedAt = Date.now();
		if (exitCode === undefined)
			execution.error = cause ? failureText(cause) : 'The exit status is unknown';
	}
	// A stopping execution receives its final status from the stop sequence.
	notify(execution);
}

/** Route PTY output into the execution, strip the start marker, and track the stream end. */
function attach(execution: BrainExecution, exec: Dockerode.Exec, stream: Duplex): void {
	const decoder = new StringDecoder('utf8');
	const normalize = createNewlineNormalizer();
	let marker = '';
	let markerPending = true;
	const take = (text: string) => {
		if (markerPending) {
			marker += text;
			const parsed = parseMarker(marker);
			if (parsed === 'incomplete') return;
			markerPending = false;
			if (parsed) execution.pgid = parsed.pgid;
			text = parsed ? parsed.rest : marker;
			marker = '';
		}
		appendOutput(execution, text);
	};
	// A TTY exec has one raw stream: no multiplexing headers and no separate stderr.
	stream.on('data', (chunk: Buffer) => take(normalize(decoder.write(chunk))));
	let ended = false;
	const end = (cause?: unknown) => {
		if (ended) return;
		ended = true;
		take(normalize(decoder.end(), true));
		if (markerPending && marker) {
			markerPending = false;
			appendOutput(execution, marker);
		}
		void finish(execution, exec, cause);
	};
	stream.once('end', () => end());
	stream.once('close', () => end());
	stream.once('error', (cause) => end(cause));
	execution.stdin = stream;
	execution.terminal = exec;
}

/** Set the initial PTY size. A command that already ended cannot be resized. */
async function sizeTerminal(execution: BrainExecution): Promise<void> {
	try {
		await execution.terminal?.resize({ h: EXECUTION_LIMITS.rows, w: EXECUTION_LIMITS.columns });
	} catch {
		// Docker keeps its default size; output is still complete.
	}
}

/** Validate an absolute in-container directory. */
function validWorkdir(value: string): boolean {
	return value.startsWith('/') && value.length <= 4096 && !value.includes('\0');
}

/**
 * Start one command or shell in the granted container. Failures are kept as `failed`
 * executions. `setup` runs before Docker starts the process, so it sees all output.
 */
export async function startExecution(
	grant: BrainGrant,
	request: {
		command: string;
		/** What Brain said the command should accomplish */
		goal?: string;
		workdir?: string;
		interactive?: boolean;
		kind?: BrainExecutionKind;
		setup?: (execution: BrainExecution) => void;
	},
	now = Date.now()
): Promise<BrainExecution> {
	const { command } = request;
	if (!command.trim() || command.length > EXECUTION_LIMITS.command || command.includes('\0'))
		throw new BrainExecutionError(
			`The command must be 1 to ${EXECUTION_LIMITS.command} characters without NUL`,
			400
		);
	if (request.workdir !== undefined && !validWorkdir(request.workdir))
		throw new BrainExecutionError('workdir must be an absolute path inside the container', 400);
	const active = [...brainState.executions.values()].filter(isActive);
	if (active.length >= EXECUTION_LIMITS.running)
		throw new BrainExecutionError('Too many running commands. Wait or cancel one.', 429);
	if (
		active.filter((execution) => execution.grantId === grant.id).length >=
		EXECUTION_LIMITS.runningPerGrant
	)
		throw new BrainExecutionError(
			`At most ${EXECUTION_LIMITS.runningPerGrant} commands can run in one target. Wait or cancel one.`,
			429
		);
	pruneRetained(now);
	const kind = request.kind ?? 'command';
	const execution: BrainExecution = {
		id: `x_${randomBytes(16).toString('base64url')}`,
		grantId: grant.id,
		containerId: grant.containerId,
		containerName: grant.containerName,
		kind,
		command,
		...(request.goal === undefined ? {} : { goal: request.goal }),
		execUser: grant.execUser,
		user: grant.user,
		workdir: request.workdir ?? grant.workdir,
		// Brain types every shell command, so a shell always accepts Brain input.
		interactive: kind === 'shell' || Boolean(request.interactive),
		controller: 'brain',
		stdinClosed: false,
		status: 'running',
		startedAt: now,
		streamEnded: false,
		output: '',
		outputStart: 0,
		version: 0,
		waiters: new Set(),
		listeners: new Set()
	};
	brainState.executions.set(execution.id, execution);
	request.setup?.(execution);
	try {
		const exec = await brainDocker()
			.getContainer(grant.containerId)
			.exec({
				Cmd: [
					'/bin/sh',
					'-c',
					WRAPPER,
					'dashboard-brain',
					execution.interactive ? 'open' : 'closed',
					command
				],
				User: grant.execUser,
				WorkingDir: execution.workdir,
				Env: kind === 'shell' ? SHELL_ENV : EXEC_ENV,
				// Every command gets a PTY, so the operator can watch it and take control.
				AttachStdin: true,
				AttachStdout: true,
				AttachStderr: true,
				Tty: true
			});
		const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
		attach(execution, exec, stream);
		await sizeTerminal(execution);
	} catch (cause) {
		execution.status = 'failed';
		execution.error = failureText(cause);
		execution.endedAt = Date.now();
		execution.streamEnded = true;
		notify(execution);
	}
	return execution;
}

/** The PTY stream, when the command still accepts input. */
function openTerminal(execution: BrainExecution): Duplex | undefined {
	const stdin = execution.stdin;
	if (execution.status !== 'running' || execution.stopping || !stdin || stdin.destroyed) return;
	return stdin;
}

/** Refuse a Brain action while the operator has control. */
export function assertBrainControl(execution: BrainExecution): void {
	if (execution.controller === 'operator')
		throw new BrainExecutionError(
			'The operator has taken control of this command. Read its output, or wait until the operator hands control back.',
			409
		);
}

/**
 * Write Brain input to an interactive execution. Checks run immediately before the write.
 * End-of-file is Ctrl+D on a terminal: a second Ctrl+D first submits an unfinished line.
 */
export function writeInput(execution: BrainExecution, input: string, close = false): void {
	if (!execution.interactive)
		throw new BrainExecutionError(
			'This command was started without stdin. Start it with interactive set to true.',
			409
		);
	if (input.length > EXECUTION_LIMITS.input)
		throw new BrainExecutionError(`Input is limited to ${EXECUTION_LIMITS.input} characters`, 413);
	assertBrainControl(execution);
	if (execution.stdinClosed)
		throw new BrainExecutionError('stdin was closed. Start a new command to send more input.', 409);
	const stdin = openTerminal(execution);
	if (!stdin) throw new BrainExecutionError('The command is not accepting input', 409);
	if (input) stdin.write(input);
	if (close) {
		execution.stdinClosed = true;
		stdin.write(input && !input.endsWith('\n') ? END_OF_FILE.repeat(2) : END_OF_FILE);
	}
}

/** Cancel on behalf of Brain. The operator's control also covers stopping. */
export async function stopExecutionForBrain(
	execution: BrainExecution
): Promise<BrainExecutionStatus> {
	if (isActive(execution)) assertBrainControl(execution);
	return stopExecution(execution.id, 'Cancelled by Brain');
}

/** Give terminal input to the operator or back to Brain. Returns the new state. */
export function setController(id: string, controller: BrainController): BrainTerminalState {
	const execution = brainState.executions.get(id);
	if (!execution) throw new BrainExecutionError('The command is no longer retained.', 404);
	if (execution.status !== 'running' || execution.stopping)
		throw new BrainExecutionError('The command is not running.', 409);
	if (execution.controller !== controller) {
		execution.controller = controller;
		notify(execution);
	}
	return terminalState(execution);
}

/** Write operator keystrokes. Only accepted while the operator has control. */
export function writeOperatorInput(execution: BrainExecution, data: string): void {
	if (execution.controller !== 'operator')
		throw new BrainExecutionError(
			'Take control before typing. Brain is driving this terminal.',
			409
		);
	if (data.length > EXECUTION_LIMITS.input)
		throw new BrainExecutionError(`Input is limited to ${EXECUTION_LIMITS.input} characters`, 413);
	const stdin = openTerminal(execution);
	if (!stdin) throw new BrainExecutionError('The command is not accepting input', 409);
	stdin.write(data);
}

/** Resize the PTY to the operator's terminal. Only while the operator has control. */
export async function resizeTerminal(
	execution: BrainExecution,
	columns: number,
	rows: number
): Promise<void> {
	const valid = (value: number) => Number.isInteger(value) && value > 0 && value <= 1000;
	if (!valid(columns) || !valid(rows)) throw new BrainExecutionError('Invalid terminal size', 400);
	if (execution.controller !== 'operator' || !openTerminal(execution)) return;
	try {
		await execution.terminal?.resize({ h: rows, w: columns });
	} catch {
		// The command can end between the check and the resize.
	}
}

/** Live state for a terminal viewer. */
export function terminalState(execution: BrainExecution): BrainTerminalState {
	return {
		status: execution.status,
		controller: execution.controller,
		interactive: execution.interactive,
		...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode })
	};
}

/** Run a short control script in the container as the execution user. Returns its exit code. */
export async function runControl(
	execution: BrainExecution,
	script: string,
	args: string[],
	timeoutMs = 5000
): Promise<number | undefined> {
	const exec = await brainDocker()
		.getContainer(execution.containerId)
		.exec({
			Cmd: ['/bin/sh', '-c', script, 'dashboard-brain-control', ...args],
			User: execution.execUser,
			AttachStdout: true,
			AttachStderr: true
		});
	const stream = await exec.start({ hijack: true, stdin: false });
	await new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			stream.destroy();
			done();
		}, timeoutMs);
		stream.on('data', () => {});
		stream.once('end', done);
		stream.once('close', done);
		stream.once('error', done);
	});
	const info = await exec.inspect();
	return info.Running || typeof info.ExitCode !== 'number' ? undefined : info.ExitCode;
}

/** True while any process of the group (a shell: the session) exists, or that is unknown. */
async function groupAlive(execution: BrainExecution, pgid: number): Promise<boolean> {
	const script = execution.kind === 'shell' ? SESSION_ALIVE_SCRIPT : ALIVE_SCRIPT;
	try {
		return (await runControl(execution, script, [String(pgid)])) !== 1;
	} catch {
		// A stopped or removed container has no processes left.
		try {
			const info = await brainDocker().getContainer(execution.containerId).inspect();
			return Boolean(info.State?.Running);
		} catch {
			return false;
		}
	}
}

/** TERM the group, escalate to KILL, and confirm that no member remains. */
async function terminate(execution: BrainExecution): Promise<BrainExecutionStatus> {
	const pgid = execution.pgid;
	if (!pgid) {
		// Without the marker, no process can be addressed. Report what Docker shows.
		await waitUntilSettled(execution, 1000);
		return execution.streamEnded ? 'stopped' : 'stop_unconfirmed';
	}
	for (const [signal, graceMs] of [
		['TERM', 3000],
		['KILL', 2000]
	] as const) {
		if (!(await groupAlive(execution, pgid))) return 'stopped';
		try {
			const script = execution.kind === 'shell' ? SESSION_SIGNAL_SCRIPT : SIGNAL_SCRIPT;
			await runControl(execution, script, [String(pgid), signal]);
		} catch {
			// The liveness check below decides the result.
		}
		const deadline = Date.now() + graceMs;
		while (Date.now() < deadline) {
			await delay(250);
			if (!(await groupAlive(execution, pgid))) return 'stopped';
		}
	}
	return 'stop_unconfirmed';
}

/** Stop a running execution once; concurrent callers share the same result. */
export function stopExecution(id: string, reason: string): Promise<BrainExecutionStatus> {
	const execution = brainState.executions.get(id);
	if (!execution) return Promise.reject(new BrainExecutionError('Unknown execution', 404));
	if (execution.stopping) return execution.stopping;
	if (execution.status !== 'running') return Promise.resolve(execution.status);
	execution.status = 'stopping';
	execution.stopReason = reason.slice(0, 200);
	execution.stdin = undefined;
	notify(execution);
	execution.stopping = terminate(execution).then(
		(status) => {
			execution.status = status;
			execution.endedAt ??= Date.now();
			notify(execution);
			return status;
		},
		() => {
			execution.status = 'stop_unconfirmed';
			execution.endedAt ??= Date.now();
			notify(execution);
			return execution.status;
		}
	);
	return execution.stopping;
}

/** Stop every running execution within a deadline, for shutdown. */
export async function stopAllExecutions(reason: string, deadlineMs = 8000): Promise<void> {
	const stops = [...brainState.executions.values()]
		.filter(isActive)
		.map((execution) => stopExecution(execution.id, reason).catch(() => undefined));
	await Promise.race([Promise.allSettled(stops), delay(deadlineMs)]);
}

/** Operator view of one shell command: bounded command text, ISO times. */
export function shellCommandView(command: BrainShellCommand): BrainShellCommandView {
	return {
		id: command.id,
		command: command.command.slice(0, 500),
		goal: command.goal,
		status: command.status,
		exitCode: command.exitCode,
		cwd: command.cwd,
		startedAt: new Date(command.startedAt).toISOString(),
		endedAt: command.endedAt === undefined ? undefined : new Date(command.endedAt).toISOString()
	};
}

/** Operator view of one execution. A shell shows its name, not its start script. */
export function executionView(execution: BrainExecution): BrainExecutionView {
	const shell = execution.shell;
	return {
		id: execution.id,
		grantId: execution.grantId,
		containerName: execution.containerName,
		kind: execution.kind,
		command: shell ? `shell ${shell.name}` : execution.command.slice(0, 500),
		goal: shell ? undefined : execution.goal,
		...(shell
			? {
					shell: {
						name: shell.name,
						ready: shell.ready,
						busy: shell.current?.status === 'running',
						cwd: shell.cwd,
						command: shell.current?.command.slice(0, 500),
						exitCode: shell.exitCode,
						commands: (shell.history ?? []).map(shellCommandView)
					}
				}
			: {}),
		user: execution.user,
		workdir: execution.workdir,
		interactive: execution.interactive,
		controller: execution.controller,
		status: execution.status,
		exitCode: execution.exitCode,
		error: execution.error,
		stopReason: execution.stopReason,
		startedAt: new Date(execution.startedAt).toISOString(),
		endedAt: execution.endedAt === undefined ? undefined : new Date(execution.endedAt).toISOString()
	};
}
