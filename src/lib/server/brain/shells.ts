/**
 * Persistent Brain shells. A shell is one interactive bash in a Docker exec PTY: an
 * execution of kind `shell`. Brain types each command into it, so the working directory,
 * variables and history carry over, and the operator watches one ordinary terminal.
 *
 * Command boundaries come from shell integration that the start script installs after the
 * user's ~/.bashrc. PROMPT_COMMAND prints a prompt marker with the exit code and working
 * directory; PS0 (bash 4.4 and later) prints a start marker after the echoed command line.
 * Both are OSC sequences, which terminals do not display, and both carry a per-shell nonce.
 * Without PS0, the echoed command ends at the first line feed.
 */
import { randomBytes } from 'node:crypto';
import type { BrainShellView } from '../../brainTypes.js';
import type { BrainExecution, BrainGrant, BrainShell, BrainShellCommand } from './state.js';
import { brainState, notify } from './state.js';
import {
	assertBrainControl,
	BrainExecutionError,
	cleanTerminalText,
	EXECUTION_LIMITS,
	isActive,
	readOutput,
	runControl,
	startExecution,
	waitForChange,
	writeInput
} from './executions.js';

export const SHELL_LIMITS = {
	/** Longest command that Brain types directly; longer commands run from a script file */
	typed: 200,
	/** Characters of the first command line shown in the comment of a script command */
	summary: 60,
	/** Carried characters of an incomplete marker between output chunks */
	carry: 4096
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const MARKER_INTRO = '\u001b]6973;';
/** Exit 0 when the shell owns the terminal foreground, 1 when a job does, 2 when unknown. */
const FOREGROUND_SCRIPT =
	'p=$1; s=$(cat "/proc/$p/stat" 2>/dev/null) || exit 2; s=${s##*") "}; set -- $s; [ "$#" -ge 6 ] || exit 2; [ "$6" = "$p" ]';
/** Create a private script file; refuse to follow an existing file or link. */
const WRITE_SCRIPT = 'umask 077; set -C; printf "%s" "$1" > "$2"';

/** One marker in the output, at absolute offsets. */
export type ShellMarker =
	| { type: 'start'; at: number; end: number }
	| { type: 'prompt'; at: number; end: number; exitCode: number; cwd: string };

/**
 * Bash start-up file. It deletes itself, loads the user's ~/.bashrc, then adds the markers.
 * History expansion is off, so Brain commands with `!` run as typed, and history is not
 * written to the user's history file.
 */
function shellRc(nonce: string): string {
	return [
		'rm -f -- "$DDB_BRAIN_RC"; unset DDB_BRAIN_RC',
		'if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
		'set +H',
		'unset HISTFILE',
		'__ddb_brain_prompt() {',
		'\tlocal status=$?',
		`\tprintf '\\033]6973;${nonce};P;%s;%s\\007' "$status" "$PWD"`,
		'\treturn "$status"',
		'}',
		'if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then',
		'\tPROMPT_COMMAND=(__ddb_brain_prompt "${PROMPT_COMMAND[@]}")',
		'else',
		'\tPROMPT_COMMAND="__ddb_brain_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
		'fi',
		`PS0="\${PS0-}"$'\\033]6973;${nonce};C\\007'`
	].join('\n');
}

/**
 * Start script, run by the execution wrapper with `bash -lc`: a login environment, then
 * one interactive bash with the start-up file.
 */
export function shellStartScript(nonce: string): string {
	return [
		"command -v bash >/dev/null 2>&1 || { echo 'Brain shells need bash in the container.' >&2; exit 127; }",
		'rc=$(mktemp "${TMPDIR:-/tmp}/.ddb-brain-rc.XXXXXX") || exit 1',
		"cat > \"$rc\" <<'DDB_BRAIN_RC'",
		shellRc(nonce),
		'DDB_BRAIN_RC',
		'DDB_BRAIN_RC="$rc" exec bash --rcfile "$rc" -i'
	].join('\n');
}

/**
 * Find the markers of one shell in its output. Call with each output chunk and the absolute
 * offset where the chunk ends. A marker split across chunks is found once it is complete.
 */
export function createMarkerScanner(nonce: string): (text: string, end: number) => ShellMarker[] {
	const pattern = new RegExp(
		`\\u001b\\]6973;${nonce};(?:P;(\\d{1,3});([^\\u0007\\u001b]*)|C)(?:\\u0007|\\u001b\\\\)`,
		'g'
	);
	let carry = '';
	return (text, end) => {
		const value = carry + text;
		const base = end - value.length;
		const markers: ShellMarker[] = [];
		let consumed = 0;
		pattern.lastIndex = 0;
		for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
			const at = base + match.index;
			const markerEnd = at + match[0].length;
			if (match[1] === undefined) markers.push({ type: 'start', at, end: markerEnd });
			else
				markers.push({
					type: 'prompt',
					at,
					end: markerEnd,
					exitCode: Number(match[1]),
					cwd: match[2]
				});
			consumed = match.index + match[0].length;
		}
		carry = incompleteMarker(value.slice(consumed));
		return markers;
	};
}

/** The unfinished marker at the end of `rest`, if any, to scan again with the next chunk. */
function incompleteMarker(rest: string): string {
	const start = rest.lastIndexOf(MARKER_INTRO);
	if (start !== -1) {
		const tail = rest.slice(start);
		const finished = tail.includes('\u0007') || tail.includes('\u001b\\');
		return finished || tail.length > SHELL_LIMITS.carry ? '' : tail;
	}
	// The chunk can end inside the marker introducer itself.
	for (let length = Math.min(MARKER_INTRO.length - 1, rest.length); length > 0; length--)
		if (MARKER_INTRO.startsWith(rest.slice(-length))) return rest.slice(-length);
	return '';
}

/** Apply markers and the shell's end to the shell state. */
function watchShell(execution: BrainExecution, shell: BrainShell): (text?: string) => void {
	const scan = createMarkerScanner(shell.nonce);
	return (text) => {
		if (text) {
			const end = execution.outputStart + execution.output.length;
			for (const marker of scan(text, end)) applyMarker(shell, marker);
		}
		if (!isActive(execution)) {
			shell.ready = false;
			const current = shell.current;
			if (current?.status === 'running') {
				// `exit` ends the shell: the command's result is the shell's exit status.
				current.status = 'exited';
				current.exitCode = execution.exitCode;
				current.endCursor = execution.outputStart + execution.output.length;
				current.endedAt = Date.now();
			}
		}
	};
}

/** Record one marker. Markers before Brain's command belong to earlier prompts. */
function applyMarker(shell: BrainShell, marker: ShellMarker): void {
	const current = shell.current;
	const mine = current?.status === 'running' && marker.at >= current.startCursor;
	if (marker.type === 'start') {
		if (mine && current.outputCursor === undefined) current.outputCursor = marker.end;
		return;
	}
	shell.ready = true;
	shell.cwd = marker.cwd;
	shell.exitCode = marker.exitCode;
	if (!mine) return;
	current.status = 'exited';
	current.exitCode = marker.exitCode;
	current.cwd = marker.cwd;
	current.endCursor = marker.at;
	current.endedAt = Date.now();
}

/** Open shells of one grant. */
export function shellsOf(grantId: string): BrainExecution[] {
	return [...brainState.executions.values()].filter(
		(execution) =>
			execution.grantId === grantId && execution.kind === 'shell' && isActive(execution)
	);
}

/** Display state of one shell. */
export function shellView(shell: BrainShell): BrainShellView {
	return {
		name: shell.name,
		ready: shell.ready,
		busy: shell.current?.status === 'running',
		cwd: shell.cwd,
		command: shell.current?.command,
		exitCode: shell.exitCode
	};
}

/** The given name, or `main`, then `shell-2`, `shell-3` and so on. */
function shellName(grantId: string, requested?: string): string {
	const taken = new Set(shellsOf(grantId).map((execution) => execution.shell?.name));
	if (requested !== undefined) {
		if (!NAME.test(requested))
			throw new BrainExecutionError(
				'name must be 1 to 32 letters, digits, dots, dashes or underscores',
				400
			);
		if (taken.has(requested))
			throw new BrainExecutionError(
				`A shell named ${requested} is open in this target. Use its shell_id from list_targets, or choose another name.`,
				409
			);
		return requested;
	}
	if (!taken.has('main')) return 'main';
	for (let index = 2; ; index++) if (!taken.has(`shell-${index}`)) return `shell-${index}`;
}

/** Start a shell. It is ready after its first prompt marker. */
export async function openShell(
	grant: BrainGrant,
	request: { name?: string; workdir?: string } = {}
): Promise<BrainExecution> {
	const shell: BrainShell = {
		name: shellName(grant.id, request.name),
		nonce: randomBytes(9).toString('hex'),
		ready: false,
		commands: 0
	};
	return startExecution(grant, {
		command: shellStartScript(shell.nonce),
		workdir: request.workdir,
		kind: 'shell',
		setup(execution) {
			execution.shell = shell;
			execution.listeners.add(watchShell(execution, shell));
		}
	});
}

/** The shell state of an execution, or a refusal for a one-off command. */
export function shellOf(execution: BrainExecution): BrainShell {
	if (execution.kind !== 'shell' || !execution.shell)
		throw new BrainExecutionError(
			'This execution is not a shell. Use a shell_id from open_shell.',
			400
		);
	return execution.shell;
}

/** True when a job holds the terminal foreground. Unknown counts as idle. */
async function foregroundBusy(execution: BrainExecution): Promise<boolean> {
	if (!execution.pgid) return false;
	try {
		return (await runControl(execution, FOREGROUND_SCRIPT, [String(execution.pgid)])) === 1;
	} catch {
		return false;
	}
}

/** True when bash's line editor can take the command as typed keys. */
export function typeable(command: string): boolean {
	return (
		command.length <= SHELL_LIMITS.typed &&
		// Printable characters only: TAB would complete, control keys would edit the line.
		/^[^\u0000-\u001f\u007f]*$/.test(command) &&
		// A final backslash continues the line, and bash would wait at its PS2 prompt.
		!command.endsWith('\\')
	);
}

/** First command line, printable and short, for the comment after a script command. */
function summary(command: string): string {
	const line = (command.trim().split('\n')[0] ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
	return line.length > SHELL_LIMITS.summary ? `${line.slice(0, SHELL_LIMITS.summary)}…` : line;
}

/**
 * Write a long or multi-line command to a private file and return the line that sources it.
 * Sourcing keeps directory and variable changes; the file deletes itself first.
 */
async function scriptLine(execution: BrainExecution, command: string): Promise<string> {
	const path = `/tmp/.ddb-brain-${randomBytes(9).toString('hex')}.sh`;
	const content = `rm -f -- '${path}'\n${command}\n`;
	const code = await runControl(execution, WRITE_SCRIPT, [content, path]);
	if (code !== 0)
		throw new BrainExecutionError('Could not stage the command in the container', 502);
	return `. '${path}' # ${summary(command)}`;
}

/** Refuse a command when the shell cannot take one now. */
function assertReady(execution: BrainExecution, shell: BrainShell): void {
	if (!isActive(execution) || execution.stopping)
		throw new BrainExecutionError('The shell has ended. Open a new shell with open_shell.', 409);
	assertBrainControl(execution);
	if (!shell.ready)
		throw new BrainExecutionError(
			'The shell has not shown its prompt yet. Read its output with read_output, then retry.',
			409
		);
	if (shell.current?.status === 'running')
		throw new BrainExecutionError(
			`The shell is busy with command ${shell.current.id}. Read its output, interrupt it with write_stdin and "\\u0003", or open another shell.`,
			409
		);
}

/** Type one command into a shell. Returns immediately; the prompt marker ends the command. */
export async function runInShell(
	execution: BrainExecution,
	command: string
): Promise<BrainShellCommand> {
	const shell = shellOf(execution);
	if (!command.trim() || command.length > EXECUTION_LIMITS.command || command.includes('\0'))
		throw new BrainExecutionError(
			`The command must be 1 to ${EXECUTION_LIMITS.command} characters without NUL`,
			400
		);
	assertReady(execution, shell);
	if (await foregroundBusy(execution))
		throw new BrainExecutionError(
			'A program runs in the foreground of this shell. Read its output, send input with write_stdin, or open another shell.',
			409
		);
	const line = typeable(command) ? command : await scriptLine(execution, command);
	// The operator can take control, or the shell can end, while the checks above run.
	assertReady(execution, shell);
	const current: BrainShellCommand = {
		id: `c_${randomBytes(9).toString('base64url')}`,
		command,
		status: 'running',
		startCursor: execution.outputStart + execution.output.length,
		startedAt: Date.now()
	};
	shell.current = current;
	try {
		writeInput(execution, `${line}\r`);
	} catch (cause) {
		shell.current = undefined;
		throw cause;
	}
	shell.commands++;
	notify(execution);
	return current;
}

/** Wait until the command ends, the shell ends, or the timeout passes. */
export async function waitForCommand(
	execution: BrainExecution,
	command: BrainShellCommand,
	timeoutMs: number
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (command.status === 'running' && isActive(execution) && Date.now() < deadline)
		await waitForChange(execution, deadline - Date.now());
}

/** Absolute offset where the command's own output begins, after the echoed line. */
function outputStartOf(execution: BrainExecution, command: BrainShellCommand, end: number): number {
	if (command.outputCursor !== undefined) return command.outputCursor;
	const from = Math.max(command.startCursor - execution.outputStart, 0);
	const newline = execution.output.indexOf('\n', from);
	const limit = end - execution.outputStart;
	return newline === -1 || newline >= limit ? end : execution.outputStart + newline + 1;
}

/**
 * One page of a command's output as plain text, from `cursor` or from its start, and never
 * past the prompt that ended it. Cursors are raw output offsets, as in read_output.
 */
export function commandOutput(
	execution: BrainExecution,
	command: BrainShellCommand,
	cursor?: number
) {
	const end = command.endCursor ?? execution.outputStart + execution.output.length;
	const first = outputStartOf(execution, command, end);
	const requested = Math.min(Math.max(cursor ?? first, first), end);
	const start = Math.max(requested, execution.outputStart);
	const offset = start - execution.outputStart;
	const limit = Math.min(offset + EXECUTION_LIMITS.read, end - execution.outputStart);
	const raw = execution.output.slice(offset, limit);
	return {
		text: cleanTerminalText(raw),
		cursor: start,
		nextCursor: start + raw.length,
		truncatedBefore: requested < execution.outputStart,
		more: start + raw.length < end
	};
}

/**
 * read_output for a shell: the current command's output while the cursor is inside it, then
 * everything that follows, such as the next prompt, as plain text.
 */
export function readShellOutput(execution: BrainExecution, cursor?: number) {
	const current = execution.shell?.current;
	if (current && cursor !== undefined && cursor >= current.startCursor) {
		const end = current.endCursor;
		if (end === undefined || cursor < end) return commandOutput(execution, current, cursor);
	}
	const view = readOutput(execution, cursor);
	return {
		text: view.text,
		cursor: view.cursor,
		nextCursor: view.nextCursor,
		truncatedBefore: view.truncatedBefore,
		more: view.more
	};
}

/** Wait until the first prompt, the shell's end, or the timeout. */
export async function waitForPrompt(execution: BrainExecution, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!execution.shell?.ready && isActive(execution) && Date.now() < deadline)
		await waitForChange(execution, deadline - Date.now());
}
