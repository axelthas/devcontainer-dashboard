/**
 * The MCP tools that Brain sees. The tool set is fixed: grants change which targets
 * `list_targets` returns, never which tools exist. There are no tools for grants, Docker,
 * networks or the host, so Brain cannot widen its own access.
 *
 * `open_shell` starts a persistent shell; `execute` with its `shell_id` types a command into
 * it. Without `shell_id`, `execute` starts one process per call, as before.
 */
import type { BrainExecution } from './state.js';
import { GOAL_LIMIT, brainState, recordAudit } from './state.js';
import { BrainAccessError, grantView, liveGrant, pruneExpiredGrants } from './access.js';
import {
	BrainExecutionError,
	EXECUTION_LIMITS,
	readOutput,
	startExecution,
	stopExecutionForBrain,
	waitForOutput,
	waitUntilSettled,
	writeInput
} from './executions.js';
import {
	commandOutput,
	openShell,
	readShellOutput,
	runInShell,
	shellOf,
	shellsOf,
	shellView,
	waitForCommand,
	waitForPrompt
} from './shells.js';

export interface ToolDefinition {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: Record<string, boolean>;
}

export interface ToolResult {
	content: { type: 'text'; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

const MAX_WAIT_SECONDS = EXECUTION_LIMITS.waitMs / 1000;
const id = { type: 'string', minLength: 1, maxLength: 64 };
const waitSeconds = (fallback: number) => ({
	type: 'integer',
	minimum: 0,
	maximum: MAX_WAIT_SECONDS,
	default: fallback,
	description: `Seconds to wait for output or completion (0 to ${MAX_WAIT_SECONDS})`
});

export const BRAIN_TOOLS: ToolDefinition[] = [
	{
		name: 'list_targets',
		title: 'List granted containers',
		description:
			'List the containers that the operator granted to you. Only these targets accept commands. Grants expire, and they end when a container stops, restarts or is rebuilt; call this tool again when a target_id is rejected. Choose the target that matches the task. If more than one target could match, ask the user which one to use.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { readOnlyHint: true, openWorldHint: false }
	},
	{
		name: 'open_shell',
		title: 'Open a persistent shell',
		description:
			"Start a persistent interactive shell in one granted container, in a terminal that the operator watches. It prefers zsh, then bash, then sh, and loads the user's shell startup files. Prefer a shell for multi-step work: pass its shell_id to execute, and the working directory, variables and history carry over between commands. Output can contain the user's prompt. Open a second shell, with a name such as build, only for work that must run in parallel. Open shells count toward the running-command limit of the target; close a shell with cancel_execution. Waits for the first prompt and returns shell_id and ready.",
		inputSchema: {
			type: 'object',
			properties: {
				target_id: { ...id, description: 'target_id from list_targets' },
				name: {
					type: 'string',
					pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$',
					description: 'Short shell name, unique in the target. Default: main, then shell-2.'
				},
				workdir: {
					type: 'string',
					description: 'Absolute start directory. Defaults to the target workdir.'
				},
				wait_seconds: waitSeconds(15)
			},
			required: ['target_id'],
			additionalProperties: false
		},
		annotations: { destructiveHint: false, openWorldHint: true }
	},
	{
		name: 'execute',
		title: 'Run a command',
		description:
			"Run a shell command in one granted container as the granted user. The operator follows your work in the dashboard: give every command a goal, one short sentence that says what the command should accomplish. With shell_id from open_shell, the command is typed into that persistent shell: the working directory and variables carry over, the result has command_id, exit_code and cwd, and status is the command's status. A shell runs one command at a time; a busy shell refuses another command. Without shell_id, every call starts a new process with bash -lc (or sh -lc when bash is missing), and nothing carries over; stdin is /dev/null unless interactive is true. The operator can take control of the terminal at any time; execute in that shell, write_stdin and cancel_execution are then refused until the operator hands control back. When the status is still running, call read_output with execution_id and next_cursor.",
		inputSchema: {
			type: 'object',
			properties: {
				target_id: { ...id, description: 'target_id from list_targets' },
				command: { type: 'string', minLength: 1, maxLength: EXECUTION_LIMITS.command },
				goal: {
					type: 'string',
					minLength: 1,
					maxLength: GOAL_LIMIT,
					description:
						'One short sentence for the operator: what this command should accomplish, not how. Example: "Confirm the branch is clean before the refactor."'
				},
				shell_id: {
					...id,
					description: 'shell_id from open_shell. Not combined with workdir or interactive.'
				},
				workdir: {
					type: 'string',
					description: 'Absolute working directory. Defaults to the target workdir.'
				},
				interactive: {
					type: 'boolean',
					default: false,
					description: 'Connect stdin to the terminal for write_stdin'
				},
				wait_seconds: waitSeconds(20)
			},
			required: ['target_id', 'command', 'goal'],
			additionalProperties: false
		},
		annotations: { destructiveHint: true, openWorldHint: true }
	},
	{
		name: 'read_output',
		title: 'Read command output',
		description:
			"Read output of an execution or shell from a cursor. Use next_cursor from the previous result. With wait_seconds, wait for new output or completion first. For a shell, output is plain text without colours, status is the shell's status, and command reports the current or last command with its status, exit_code and cwd; output stops at the end of that command until the cursor passes it.",
		inputSchema: {
			type: 'object',
			properties: {
				execution_id: id,
				cursor: { type: 'integer', minimum: 0 },
				wait_seconds: waitSeconds(0)
			},
			required: ['execution_id'],
			additionalProperties: false
		},
		annotations: { readOnlyHint: true, openWorldHint: false }
	},
	{
		name: 'write_stdin',
		title: 'Write to stdin',
		description:
			'Type text into the terminal of an execution that was started with interactive set to true, or of a shell. Include a trailing newline to submit a line. The terminal echoes input into the output. Send "\\u0003" (Ctrl+C) to interrupt the command that runs in a shell. Set close_stdin to send end-of-file (Ctrl+D); after that, the execution accepts no more input. Refused while the operator has control.',
		inputSchema: {
			type: 'object',
			properties: {
				execution_id: id,
				input: { type: 'string', maxLength: EXECUTION_LIMITS.input },
				close_stdin: { type: 'boolean', default: false }
			},
			required: ['execution_id', 'input'],
			additionalProperties: false
		},
		annotations: { destructiveHint: true, openWorldHint: true }
	},
	{
		name: 'cancel_execution',
		title: 'Cancel a command',
		description:
			'Stop an execution: send TERM to its process group, then KILL. For a shell_id, this closes the whole shell and every job in it; to interrupt only its current command, use write_stdin with "\\u0003". The result says whether the stop was confirmed. Refused while the operator has control.',
		inputSchema: {
			type: 'object',
			properties: { execution_id: id },
			required: ['execution_id'],
			additionalProperties: false
		},
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
	}
];

/** Invalid tool input; reported to Brain as a tool error, not a protocol error. */
class ToolInputError extends Error {}

type Arguments = Record<string, unknown>;

/** Accept only a plain object with known keys. */
function argumentsOf(value: unknown, allowed: string[]): Arguments {
	if (value === undefined || value === null) return {};
	if (typeof value !== 'object' || Array.isArray(value))
		throw new ToolInputError('Arguments must be an object');
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) throw new ToolInputError(`Unknown arguments: ${unknown.join(', ')}`);
	return value as Arguments;
}

function text(args: Arguments, key: string, required: true, max?: number): string;
function text(args: Arguments, key: string, required: false, max?: number): string | undefined;
/** Read a string argument. */
function text(args: Arguments, key: string, required: boolean, max = 4096): string | undefined {
	const value = args[key];
	if (value === undefined && !required) return undefined;
	if (typeof value !== 'string' || value.length > max)
		throw new ToolInputError(`${key} must be a string of at most ${max} characters`);
	return value;
}

/** Read an optional non-negative integer argument. */
function integer(args: Arguments, key: string, maximum: number): number | undefined {
	const value = args[key];
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
		throw new ToolInputError(`${key} must be an integer from 0 to ${maximum}`);
	return value;
}

/** Read an optional boolean argument. */
function flag(args: Arguments, key: string): boolean | undefined {
	const value = args[key];
	if (value === undefined) return undefined;
	if (typeof value !== 'boolean') throw new ToolInputError(`${key} must be true or false`);
	return value;
}

/** Find an execution whose grant still applies. */
async function ownedExecution(executionId: string): Promise<BrainExecution> {
	const execution = brainState.executions.get(executionId);
	if (!execution) throw new BrainExecutionError('Unknown execution_id', 404);
	await liveGrant(execution.grantId);
	return execution;
}

/** Current or last command of a shell, in the tool result shape. */
function commandResult(execution: BrainExecution) {
	const current = execution.shell?.current;
	if (!current) return {};
	return {
		command: {
			command_id: current.id,
			status: current.status,
			...(current.exitCode === undefined ? {} : { exit_code: current.exitCode }),
			...(current.cwd === undefined ? {} : { cwd: current.cwd })
		}
	};
}

/** Output page in the tool result shape. */
function outputResult(execution: BrainExecution, cursor?: number) {
	if (execution.kind === 'shell') {
		const page = readShellOutput(execution, cursor);
		return {
			execution_id: execution.id,
			shell_id: execution.id,
			target_id: execution.grantId,
			status: execution.status,
			controller: execution.controller,
			...(execution.exitCode === undefined ? {} : { exit_code: execution.exitCode }),
			...(execution.error ? { error: execution.error } : {}),
			ready: execution.shell?.ready ?? false,
			...(execution.shell?.cwd === undefined ? {} : { cwd: execution.shell.cwd }),
			...commandResult(execution),
			output: page.text,
			cursor: page.cursor,
			next_cursor: page.nextCursor,
			truncated_before: page.truncatedBefore,
			more_output: page.more
		};
	}
	const view = readOutput(execution, cursor);
	return {
		execution_id: execution.id,
		target_id: execution.grantId,
		status: view.status,
		// `operator`: the operator is typing; Brain input and cancel are refused.
		controller: execution.controller,
		...(view.exitCode === undefined ? {} : { exit_code: view.exitCode }),
		...(execution.error ? { error: execution.error } : {}),
		output: view.text,
		cursor: view.cursor,
		next_cursor: view.nextCursor,
		truncated_before: view.truncatedBefore,
		more_output: view.more
	};
}

/**
 * Link a call to a known execution, and for a shell to the command that runs or ran last,
 * which is the command that the call reads from, types into or interrupts.
 */
function linkExecution(links: AuditLinks, executionId: string): void {
	const execution = brainState.executions.get(executionId);
	if (!execution) return;
	links.executionId = execution.id;
	const current = execution.shell?.current;
	if (current) links.commandId = current.id;
}

/** Wrap structured data in an MCP tool result. */
function success(data: Record<string, unknown>): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

/** Explain a refusal or failure to Brain without internal details. */
function failure(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run one tool. Every call, including refusals, is recorded in the audit log. */
export async function callTool(name: string, input: unknown): Promise<ToolResult> {
	let target: string | undefined;
	let detail = '';
	const links: AuditLinks = {};
	try {
		const result = await runTool(
			name,
			input,
			(value, description) => {
				target = value;
				detail = description;
			},
			links
		);
		recordAudit({ tool: name, target, detail, outcome: 'ok', ...links });
		return result;
	} catch (cause) {
		const known =
			cause instanceof ToolInputError ||
			cause instanceof BrainAccessError ||
			cause instanceof BrainExecutionError;
		const message = known ? (cause as Error).message : 'The tool failed unexpectedly';
		const denied =
			(cause instanceof BrainAccessError && [404, 410].includes(cause.status)) ||
			(cause instanceof BrainExecutionError && cause.status === 404);
		recordAudit({
			tool: name,
			target,
			detail: detail || message,
			outcome: denied ? 'denied' : 'error',
			...links
		});
		if (!known) console.error('[brain] tool failed', cause);
		return failure(message);
	}
}

/**
 * What one call used, so the dashboard shows the call with its command instead of in a
 * separate activity list. Set as soon as known; a refused call keeps what was set.
 */
interface AuditLinks {
	executionId?: string;
	commandId?: string;
	goal?: string;
}

/** Read the required goal of an `execute` call. */
function goalOf(args: Arguments): string {
	const goal = text(args, 'goal', false, GOAL_LIMIT)?.trim();
	if (!goal)
		throw new ToolInputError(
			'goal is required: one short sentence that tells the operator what the command should accomplish'
		);
	return goal;
}

async function runTool(
	name: string,
	input: unknown,
	describe: (target: string | undefined, detail: string) => void,
	links: AuditLinks
): Promise<ToolResult> {
	if (name === 'list_targets') {
		argumentsOf(input, []);
		pruneExpiredGrants();
		const targets = [...brainState.grants.values()].map((grant) => {
			const view = grantView(grant);
			return {
				target_id: view.id,
				name: view.containerName,
				kind: view.kind,
				...(view.composeProject ? { compose_project: view.composeProject } : {}),
				...(view.composeService ? { compose_service: view.composeService } : {}),
				...(view.localFolder ? { workspace: view.localFolder } : {}),
				user: view.user,
				...(view.workdir ? { workdir: view.workdir } : {}),
				expires_at: view.expiresAt,
				running_executions: view.runningExecutions,
				shells: shellsOf(grant.id).map((execution) => {
					const shell = shellView(shellOf(execution));
					return {
						shell_id: execution.id,
						name: shell.name,
						ready: shell.ready,
						busy: shell.busy,
						controller: execution.controller,
						...(shell.cwd === undefined ? {} : { cwd: shell.cwd })
					};
				})
			};
		});
		describe(undefined, `${targets.length} targets`);
		return success({ targets });
	}
	if (name === 'open_shell') {
		const args = argumentsOf(input, ['target_id', 'name', 'workdir', 'wait_seconds']);
		const targetId = text(args, 'target_id', true, 64);
		const shellName = text(args, 'name', false, 32);
		const workdir = text(args, 'workdir', false);
		const wait = integer(args, 'wait_seconds', MAX_WAIT_SECONDS) ?? 15;
		describe(
			brainState.grants.get(targetId)?.containerName ?? targetId,
			`open shell ${shellName ?? '(default name)'}`
		);
		const grant = await liveGrant(targetId);
		const execution = await openShell(grant, { name: shellName, workdir });
		links.executionId = execution.id;
		await waitForPrompt(execution, wait * 1000);
		return success({ ...outputResult(execution, 0), name: execution.shell?.name });
	}
	if (name === 'execute') {
		const args = argumentsOf(input, [
			'target_id',
			'command',
			'goal',
			'shell_id',
			'workdir',
			'interactive',
			'wait_seconds'
		]);
		const targetId = text(args, 'target_id', true, 64);
		const command = text(args, 'command', true, EXECUTION_LIMITS.command);
		if (typeof args.goal === 'string') links.goal = args.goal.trim().slice(0, GOAL_LIMIT);
		const shellId = text(args, 'shell_id', false, 64);
		const workdir = text(args, 'workdir', false);
		const interactive = flag(args, 'interactive');
		const wait = integer(args, 'wait_seconds', MAX_WAIT_SECONDS) ?? 20;
		if (shellId !== undefined) {
			const shellExecution = brainState.executions.get(shellId);
			describe(
				shellExecution?.containerName ?? brainState.grants.get(targetId)?.containerName ?? targetId,
				`${shellExecution?.shell?.name ?? shellId}: ${command}`
			);
			if (workdir !== undefined || interactive !== undefined)
				throw new ToolInputError(
					'workdir and interactive do not apply to a shell. Use cd in the shell instead.'
				);
			const goal = goalOf(args);
			const execution = await ownedExecution(shellId);
			if (execution.grantId !== targetId)
				throw new ToolInputError('shell_id belongs to another target_id');
			links.executionId = execution.id;
			const current = await runInShell(execution, command, goal);
			links.commandId = current.id;
			await waitForCommand(execution, current, wait * 1000);
			const page = commandOutput(execution, current);
			return success({
				execution_id: execution.id,
				shell_id: execution.id,
				target_id: execution.grantId,
				command_id: current.id,
				status: current.status,
				shell_status: execution.status,
				controller: execution.controller,
				...(current.exitCode === undefined ? {} : { exit_code: current.exitCode }),
				...(current.cwd === undefined ? {} : { cwd: current.cwd }),
				output: page.text,
				cursor: page.cursor,
				next_cursor: page.nextCursor,
				truncated_before: page.truncatedBefore,
				more_output: page.more
			});
		}
		describe(brainState.grants.get(targetId)?.containerName ?? targetId, command);
		const goal = goalOf(args);
		const grant = await liveGrant(targetId);
		const execution = await startExecution(grant, {
			command,
			goal,
			workdir,
			interactive: interactive ?? false
		});
		links.executionId = execution.id;
		await waitUntilSettled(execution, wait * 1000);
		return success(outputResult(execution, 0));
	}
	if (name === 'read_output') {
		const args = argumentsOf(input, ['execution_id', 'cursor', 'wait_seconds']);
		const executionId = text(args, 'execution_id', true, 64);
		const cursor = integer(args, 'cursor', Number.MAX_SAFE_INTEGER);
		const wait = integer(args, 'wait_seconds', MAX_WAIT_SECONDS) ?? 0;
		describe(brainState.executions.get(executionId)?.containerName, executionId);
		linkExecution(links, executionId);
		const execution = await ownedExecution(executionId);
		await waitForOutput(execution, cursor ?? 0, wait * 1000);
		return success(outputResult(execution, cursor));
	}
	if (name === 'write_stdin') {
		const args = argumentsOf(input, ['execution_id', 'input', 'close_stdin']);
		const executionId = text(args, 'execution_id', true, 64);
		const value = text(args, 'input', true, EXECUTION_LIMITS.input);
		const close = flag(args, 'close_stdin') ?? false;
		// Record the length only: stdin can carry secrets.
		describe(
			brainState.executions.get(executionId)?.containerName,
			`${executionId}: ${value.length} characters${close ? ', then end-of-file' : ''}`
		);
		linkExecution(links, executionId);
		const execution = await ownedExecution(executionId);
		writeInput(execution, value, close);
		return success({ execution_id: execution.id, written: value.length, stdin_closed: close });
	}
	if (name === 'cancel_execution') {
		const args = argumentsOf(input, ['execution_id']);
		const executionId = text(args, 'execution_id', true, 64);
		describe(brainState.executions.get(executionId)?.containerName, executionId);
		linkExecution(links, executionId);
		const execution = await ownedExecution(executionId);
		const status = await stopExecutionForBrain(execution);
		return success({ execution_id: execution.id, status, confirmed: status === 'stopped' });
	}
	throw new ToolInputError(`Unknown tool: ${name}`);
}
