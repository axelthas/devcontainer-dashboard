/**
 * Client-safe view model of Brain's work for the Brain pane: one group per granted
 * container, one step per command with the goal that Brain gave, and every call
 * (read_output, write_stdin, cancel_execution, refusals) shown with the command it used.
 * There is no separate activity list: a call without a command belongs to its container,
 * or to the "outside granted containers" list when it names no granted container.
 */
import type {
	BrainAuditEntry,
	BrainController,
	BrainExecutionStatus,
	BrainExecutionView,
	BrainGrantView,
	BrainStatus
} from './brainTypes';

/** One command: a one-off execution, or one command that Brain typed into a shell. */
export interface BrainStep {
	/** Unique in the pane: the execution ID, plus the command ID for a shell command */
	key: string;
	executionId: string;
	/** Set for a shell command */
	commandId?: string;
	/** Set for a shell command */
	shellName?: string;
	command: string;
	goal?: string;
	status: BrainExecutionStatus;
	exitCode?: number;
	controller: BrainController;
	startedAt: string;
	endedAt?: string;
	/** Stop reason or error, for a command that did not end by itself */
	note?: string;
	/** Calls that used this command after it started, oldest first */
	trail: BrainAuditEntry[];
}

/** Open shell of a group, for the group header. */
export interface BrainShellSummary {
	executionId: string;
	name: string;
	busy: boolean;
	controller: BrainController;
}

export interface BrainActivityGroup {
	grantId: string;
	containerName: string;
	/** Undefined after the grant ended; its retained commands stay visible */
	grant?: BrainGrantView;
	/** Oldest first, so the group reads top to bottom like a log */
	steps: BrainStep[];
	shells: BrainShellSummary[];
	/** Refused or failed calls in this container that started no command, newest first */
	refused: BrainAuditEntry[];
	running: number;
	/** Start time of the newest step, for ordering the groups */
	latest: string;
}

export interface BrainActivity {
	groups: BrainActivityGroup[];
	/** Refused or failed calls that named no granted container, newest first */
	outside: BrainAuditEntry[];
	running: number;
}

/** True until a command has a final status. */
export function isRunningStep(step: Pick<BrainStep, 'status'>): boolean {
	return step.status === 'running' || step.status === 'stopping';
}

/** The first line that does real work: skips `set -euo pipefail` style preambles. */
export function headline(command: string): string {
	const lines = command
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.find((line) => !/^set\s+[-+]/.test(line)) ?? lines[0] ?? command;
}

/** Steps of one execution: the command itself, or each command typed into the shell. */
function stepsOf(execution: BrainExecutionView): BrainStep[] {
	if (execution.kind === 'shell' && execution.shell) {
		const shell = execution.shell;
		const shellEnded = execution.status !== 'running' && execution.status !== 'stopping';
		return (shell.commands ?? []).map((command) => ({
			key: `${execution.id}:${command.id}`,
			executionId: execution.id,
			commandId: command.id,
			shellName: shell.name,
			command: command.command,
			goal: command.goal,
			// A command that still runs when its shell ends ends with the shell.
			status: command.status === 'running' && shellEnded ? execution.status : command.status,
			exitCode: command.exitCode,
			controller: execution.controller,
			startedAt: command.startedAt,
			endedAt: command.endedAt,
			trail: []
		}));
	}
	return [
		{
			key: execution.id,
			executionId: execution.id,
			command: execution.command,
			goal: execution.goal,
			status: execution.status,
			exitCode: execution.exitCode,
			controller: execution.controller,
			startedAt: execution.startedAt,
			endedAt: execution.endedAt,
			note: execution.error ?? execution.stopReason,
			trail: []
		}
	];
}

/** The `execute` call that started a step is the step itself, not part of its trail. */
function startedStep(entry: BrainAuditEntry): boolean {
	return entry.tool === 'execute' && entry.outcome === 'ok';
}

/** Group Brain's commands and calls by container. */
export function buildActivity(status: BrainStatus | null): BrainActivity {
	if (!status) return { groups: [], outside: [], running: 0 };
	const groups = new Map<string, BrainActivityGroup>();
	const groupFor = (grantId: string, containerName: string) => {
		let group = groups.get(grantId);
		if (!group) {
			group = {
				grantId,
				containerName,
				grant: status.grants.find((grant) => grant.id === grantId),
				steps: [],
				shells: [],
				refused: [],
				running: 0,
				latest: ''
			};
			groups.set(grantId, group);
		}
		return group;
	};
	// Granted containers show first, also before Brain runs anything in them.
	for (const grant of status.grants) groupFor(grant.id, grant.containerName);

	const steps = new Map<string, BrainStep>();
	const byExecution = new Map<string, BrainStep[]>();
	for (const execution of status.executions) {
		const group = groupFor(execution.grantId, execution.containerName);
		if (execution.kind === 'shell' && execution.shell && isRunningStep(execution))
			group.shells.push({
				executionId: execution.id,
				name: execution.shell.name,
				busy: execution.shell.busy,
				controller: execution.controller
			});
		for (const step of stepsOf(execution)) {
			group.steps.push(step);
			steps.set(step.key, step);
			if (!byExecution.has(step.executionId)) byExecution.set(step.executionId, []);
			byExecution.get(step.executionId)?.push(step);
		}
	}

	const shellIds = new Set(
		status.executions.filter((execution) => execution.kind === 'shell').map(({ id }) => id)
	);
	const outside: BrainAuditEntry[] = [];
	// The audit log is newest first; trails read oldest first, so walk it backwards.
	for (const entry of [...status.audit].reverse()) {
		if (entry.executionId) {
			// A shell call without a command, such as open_shell, belongs to no step.
			const step = entry.commandId
				? steps.get(`${entry.executionId}:${entry.commandId}`)
				: shellIds.has(entry.executionId)
					? undefined
					: byExecution.get(entry.executionId)?.[0];
			if (step && !startedStep(entry)) step.trail.push(entry);
			if (step || entry.outcome === 'ok') continue;
		}
		if (entry.outcome === 'ok') continue;
		const group = [...groups.values()].find(
			(candidate) => candidate.containerName === entry.target
		);
		if (group) group.refused.unshift(entry);
		else outside.unshift(entry);
	}

	let running = 0;
	for (const group of groups.values()) {
		group.steps.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
		group.running = group.steps.filter(isRunningStep).length;
		group.latest = group.steps.at(-1)?.startedAt ?? group.grant?.createdAt ?? '';
		running += group.running;
	}
	// Live grants first, then the most recent work.
	const ordered = [...groups.values()].sort(
		(a, b) =>
			Number(Boolean(b.grant)) - Number(Boolean(a.grant)) || b.latest.localeCompare(a.latest)
	);
	return { groups: ordered, outside, running };
}
