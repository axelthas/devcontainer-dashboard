/**
 * The MCP tools that Brain sees. The tool set is fixed: grants change which targets
 * `list_targets` returns, never which tools exist. There are no tools for grants, Docker,
 * networks or the host, so Brain cannot widen its own access.
 */
import type { BrainExecution } from './state.js';
import { brainState, recordAudit } from './state.js';
import { BrainAccessError, grantView, liveGrant, pruneExpiredGrants } from './access.js';
import {
	BrainExecutionError,
	EXECUTION_LIMITS,
	readOutput,
	startExecution,
	stopExecution,
	waitForOutput,
	waitUntilSettled,
	writeInput
} from './executions.js';

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
		name: 'execute',
		title: 'Run a command',
		description:
			'Run a shell command in one granted container as the granted user. The command runs with bash -lc, or sh -lc when bash is missing. Every call starts a new process: the working directory and variables do not carry over between calls. stdin is closed unless interactive is true. Returns the output so far and an execution_id; when the status is still running, call read_output with next_cursor.',
		inputSchema: {
			type: 'object',
			properties: {
				target_id: { ...id, description: 'target_id from list_targets' },
				command: { type: 'string', minLength: 1, maxLength: EXECUTION_LIMITS.command },
				workdir: {
					type: 'string',
					description: 'Absolute working directory. Defaults to the target workdir.'
				},
				interactive: {
					type: 'boolean',
					default: false,
					description: 'Keep stdin open for write_stdin'
				},
				wait_seconds: waitSeconds(20)
			},
			required: ['target_id', 'command'],
			additionalProperties: false
		},
		annotations: { destructiveHint: true, openWorldHint: true }
	},
	{
		name: 'read_output',
		title: 'Read command output',
		description:
			'Read output of an execution from a cursor. Use next_cursor from the previous result. With wait_seconds, wait for new output or completion first.',
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
			'Write text to the stdin of an execution that was started with interactive set to true. Include a trailing newline to submit a line. Set close_stdin to send end-of-file.',
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
			'Stop an execution: send TERM to its process group, then KILL. The result says whether the stop was confirmed.',
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

/** Output page in the tool result shape. */
function outputResult(execution: BrainExecution, cursor?: number) {
	const view = readOutput(execution, cursor);
	return {
		execution_id: execution.id,
		target_id: execution.grantId,
		status: view.status,
		...(view.exitCode === undefined ? {} : { exit_code: view.exitCode }),
		...(execution.error ? { error: execution.error } : {}),
		output: view.text,
		cursor: view.cursor,
		next_cursor: view.nextCursor,
		truncated_before: view.truncatedBefore,
		more_output: view.more
	};
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
	try {
		const result = await runTool(name, input, (value, description) => {
			target = value;
			detail = description;
		});
		recordAudit({ tool: name, target, detail, outcome: 'ok' });
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
			outcome: denied ? 'denied' : 'error'
		});
		if (!known) console.error('[brain] tool failed', cause);
		return failure(message);
	}
}

async function runTool(
	name: string,
	input: unknown,
	describe: (target: string | undefined, detail: string) => void
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
				running_executions: view.runningExecutions
			};
		});
		describe(undefined, `${targets.length} targets`);
		return success({ targets });
	}
	if (name === 'execute') {
		const args = argumentsOf(input, [
			'target_id',
			'command',
			'workdir',
			'interactive',
			'wait_seconds'
		]);
		const targetId = text(args, 'target_id', true, 64);
		const command = text(args, 'command', true, EXECUTION_LIMITS.command);
		const workdir = text(args, 'workdir', false);
		const interactive = flag(args, 'interactive') ?? false;
		const wait = integer(args, 'wait_seconds', MAX_WAIT_SECONDS) ?? 20;
		describe(brainState.grants.get(targetId)?.containerName ?? targetId, command);
		const grant = await liveGrant(targetId);
		const execution = await startExecution(grant, { command, workdir, interactive });
		await waitUntilSettled(execution, wait * 1000);
		return success(outputResult(execution, 0));
	}
	if (name === 'read_output') {
		const args = argumentsOf(input, ['execution_id', 'cursor', 'wait_seconds']);
		const executionId = text(args, 'execution_id', true, 64);
		const cursor = integer(args, 'cursor', Number.MAX_SAFE_INTEGER);
		const wait = integer(args, 'wait_seconds', MAX_WAIT_SECONDS) ?? 0;
		describe(brainState.executions.get(executionId)?.containerName, executionId);
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
		const execution = await ownedExecution(executionId);
		writeInput(execution, value, close);
		return success({ execution_id: execution.id, written: value.length, stdin_closed: close });
	}
	if (name === 'cancel_execution') {
		const args = argumentsOf(input, ['execution_id']);
		const executionId = text(args, 'execution_id', true, 64);
		describe(brainState.executions.get(executionId)?.containerName, executionId);
		const execution = await ownedExecution(executionId);
		const status = await stopExecution(execution.id, 'Cancelled by Brain');
		return success({ execution_id: execution.id, status, confirmed: status === 'stopped' });
	}
	throw new ToolInputError(`Unknown tool: ${name}`);
}
