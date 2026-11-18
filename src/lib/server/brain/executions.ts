/**
 * Brain commands run through the Docker exec API inside one granted container. Docker has no
 * exec kill API, so a wrapper reports the command's process ID before the command starts. runc
 * starts every exec process as a session leader, so that PID is also the process group ID,
 * and cancellation signals the whole group from a second exec as the same user.
 */
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type Dockerode from 'dockerode';
import type { Duplex } from 'node:stream';
import type {
	BrainExecutionStatus,
	BrainExecutionView,
	BrainOutputView
} from '../../brainTypes.js';
import type { BrainExecution, BrainGrant } from './state.js';
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
	waitMs: 60_000
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
/** Report the PID, then replace the shell with a login shell, so the PID stays the same. */
const WRAPPER = `printf '\\036ddb-pgid:%s\\036' "$$"; if command -v bash >/dev/null 2>&1; then exec bash -lc "$1"; fi; exec sh -lc "$1"`;
/** Exit 0 while any process of the group exists. Shells differ in kill syntax. */
const ALIVE_SCRIPT = 'kill -0 -"$1" 2>/dev/null || kill -0 -- -"$1" 2>/dev/null';
const SIGNAL_SCRIPT =
	'kill -"$2" -"$1" 2>/dev/null || kill -s "$2" -- -"$1" 2>/dev/null || kill -"$2" "$1" 2>/dev/null; exit 0';
/** Non-interactive defaults for an agent: no colour, pagers or credential prompts. */
const EXEC_ENV = ['TERM=dumb', 'NO_COLOR=1', 'PAGER=cat', 'GIT_PAGER=cat', 'GIT_TERMINAL_PROMPT=0'];
const MAX_FRAME = 16 * 1024 * 1024;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True until the execution has a final status. */
export function isActive(execution: BrainExecution): boolean {
	return execution.status === 'running' || execution.status === 'stopping';
}

/**
 * Split Docker's multiplexed stream: an 8-byte header (stream type, three zero bytes, and a
 * big-endian payload length) precedes every payload.
 */
export function createDemuxer(
	onFrame: (stream: number, payload: Buffer) => void
): (chunk: Buffer) => void {
	let pending: Buffer = Buffer.alloc(0);
	return (chunk) => {
		pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
		while (pending.length >= 8) {
			const size = pending.readUInt32BE(4);
			if (size > MAX_FRAME) throw new Error('Docker stream frame exceeds 16 MiB');
			if (pending.length < 8 + size) break;
			onFrame(pending[0], pending.subarray(8, 8 + size));
			pending = pending.subarray(8 + size);
		}
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
	notify(execution);
}

/** One bounded page of output from `cursor`, or from the oldest retained character. */
export function readOutput(execution: BrainExecution, cursor?: number): BrainOutputView {
	const end = execution.outputStart + execution.output.length;
	const start = Math.min(Math.max(cursor ?? execution.outputStart, execution.outputStart), end);
	const offset = start - execution.outputStart;
	const text = execution.output.slice(offset, offset + EXECUTION_LIMITS.read);
	return {
		executionId: execution.id,
		text,
		cursor: start,
		nextCursor: start + text.length,
		truncatedBefore: (cursor ?? 0) < execution.outputStart,
		more: start + text.length < end,
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

/** Route output into the execution, strip the start marker, and track the stream end. */
function attach(execution: BrainExecution, exec: Dockerode.Exec, stream: Duplex): void {
	const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
	let marker = '';
	let markerPending = true;
	const take = (kind: number, text: string) => {
		if (kind === 1 && markerPending) {
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
	const demux = createDemuxer((kind, payload) =>
		take(kind, decoders[kind === 2 ? 1 : 0].write(payload))
	);
	stream.on('data', (chunk: Buffer) => {
		try {
			demux(chunk);
		} catch (cause) {
			stream.destroy(cause instanceof Error ? cause : undefined);
		}
	});
	const end = (cause?: unknown) => {
		take(1, decoders[0].end());
		take(2, decoders[1].end());
		if (markerPending && marker) {
			markerPending = false;
			appendOutput(execution, marker);
		}
		void finish(execution, exec, cause);
	};
	stream.once('end', () => end());
	stream.once('close', () => end());
	stream.once('error', (cause) => end(cause));
	if (execution.interactive) execution.stdin = stream;
}

/** Validate an absolute in-container directory. */
function validWorkdir(value: string): boolean {
	return value.startsWith('/') && value.length <= 4096 && !value.includes('\0');
}

/** Start one command in the granted container. Failures are kept as `failed` executions. */
export async function startExecution(
	grant: BrainGrant,
	request: { command: string; workdir?: string; interactive?: boolean },
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
	const execution: BrainExecution = {
		id: `x_${randomBytes(16).toString('base64url')}`,
		grantId: grant.id,
		containerId: grant.containerId,
		containerName: grant.containerName,
		command,
		execUser: grant.execUser,
		user: grant.user,
		workdir: request.workdir ?? grant.workdir,
		interactive: Boolean(request.interactive),
		status: 'running',
		startedAt: now,
		streamEnded: false,
		output: '',
		outputStart: 0,
		version: 0,
		waiters: new Set()
	};
	brainState.executions.set(execution.id, execution);
	try {
		const exec = await brainDocker()
			.getContainer(grant.containerId)
			.exec({
				Cmd: ['/bin/sh', '-c', WRAPPER, 'dashboard-brain', command],
				User: grant.execUser,
				WorkingDir: execution.workdir,
				Env: EXEC_ENV,
				AttachStdin: execution.interactive,
				AttachStdout: true,
				AttachStderr: true,
				Tty: false
			});
		const stream = await exec.start({ hijack: true, stdin: execution.interactive });
		attach(execution, exec, stream);
	} catch (cause) {
		execution.status = 'failed';
		execution.error = failureText(cause);
		execution.endedAt = Date.now();
		execution.streamEnded = true;
		notify(execution);
	}
	return execution;
}

/** Write to an interactive execution. Checks run immediately before the write. */
export function writeInput(execution: BrainExecution, input: string, close = false): void {
	if (!execution.interactive)
		throw new BrainExecutionError(
			'This command was started without stdin. Start it with interactive set to true.',
			409
		);
	if (input.length > EXECUTION_LIMITS.input)
		throw new BrainExecutionError(`Input is limited to ${EXECUTION_LIMITS.input} characters`, 413);
	const stdin = execution.stdin;
	if (execution.status !== 'running' || execution.stopping || !stdin || stdin.destroyed)
		throw new BrainExecutionError('The command is not accepting input', 409);
	if (input) stdin.write(input);
	if (close) {
		execution.stdin = undefined;
		stdin.end();
	}
}

/** Run a short control script in the container as the execution user. Returns its exit code. */
async function runControl(
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

/** True while any process of the group exists, or while that cannot be ruled out. */
async function groupAlive(execution: BrainExecution, pgid: number): Promise<boolean> {
	try {
		return (await runControl(execution, ALIVE_SCRIPT, [String(pgid)])) !== 1;
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
			await runControl(execution, SIGNAL_SCRIPT, [String(pgid), signal]);
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

/** Operator view of one execution. */
export function executionView(execution: BrainExecution): BrainExecutionView {
	return {
		id: execution.id,
		grantId: execution.grantId,
		containerName: execution.containerName,
		command: execution.command.slice(0, 500),
		user: execution.user,
		workdir: execution.workdir,
		interactive: execution.interactive,
		status: execution.status,
		exitCode: execution.exitCode,
		error: execution.error,
		stopReason: execution.stopReason,
		startedAt: new Date(execution.startedAt).toISOString(),
		endedAt: execution.endedAt === undefined ? undefined : new Date(execution.endedAt).toISOString()
	};
}
