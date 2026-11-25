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
import { durationLabel } from './brainAlerts';

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
	/** Extensions, Brain's time requests and their dismissals, oldest first */
	events: BrainAuditEntry[];
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

/** Exit code, live state or stop result of a step, in operator words. */
export function stepResult(step: Pick<BrainStep, 'status' | 'controller' | 'exitCode'>): string {
	if (step.status === 'running')
		return step.controller === 'operator' ? 'you have control' : 'running';
	if (step.status === 'exited') return `exit ${step.exitCode ?? '?'}`;
	if (step.status === 'stop_unconfirmed') return 'stop not confirmed';
	return step.status;
}

/** Outcome class of a step, for its status colour. */
export function stepOutcome(
	step: Pick<BrainStep, 'status' | 'exitCode'>
): 'running' | 'ok' | 'failed' | 'ended' {
	if (isRunningStep(step)) return 'running';
	if (step.status === 'exited') return step.exitCode === 0 ? 'ok' : 'failed';
	return step.status === 'failed' ? 'failed' : 'ended';
}

/** The step of one execution, or of one shell command when `commandId` is set. */
export function findStep(
	activity: BrainActivity,
	executionId: string,
	commandId?: string | null
): { group: BrainActivityGroup; step: BrainStep } | undefined {
	for (const group of activity.groups)
		for (const step of group.steps)
			if (step.executionId === executionId && (step.commandId ?? null) === (commandId || null))
				return { group, step };
	return undefined;
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

/** Grant decisions that show in the timeline of their group. */
export const GRANT_EVENT_TOOLS = new Set(['extend', 'request_more_time', 'dismiss_time_request']);

/** One timeline item: a command, or an extension or time request between commands. */
export type BrainTimelineItem =
	| { kind: 'step'; key: string; at: string; step: BrainStep }
	| { kind: 'event'; key: string; at: string; entry: BrainAuditEntry };

/** Steps and grant events of a group in time order. */
export function timelineOf(steps: BrainStep[], events: BrainAuditEntry[]): BrainTimelineItem[] {
	return [
		...steps.map((step) => ({ kind: 'step' as const, key: step.key, at: step.startedAt, step })),
		...events.map((entry) => ({
			kind: 'event' as const,
			key: `event:${entry.at}:${entry.tool}`,
			at: entry.at,
			entry
		}))
	].sort((a, b) => a.at.localeCompare(b.at));
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
				events: [],
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
		if (entry.grantId && entry.outcome === 'ok' && GRANT_EVENT_TOOLS.has(entry.tool)) {
			groups.get(entry.grantId)?.events.push(entry);
			continue;
		}
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

/** Operator wording of a grant event in the timeline: a title and an optional detail. */
export function grantEventText(entry: BrainAuditEntry): { title: string; detail?: string } {
	const minutes = Number(/^(?:by )?(\d+) minutes/.exec(entry.detail)?.[1] ?? NaN);
	const amount = Number.isFinite(minutes) ? durationLabel(minutes) : 'more time';
	if (entry.tool === 'extend') {
		const end = /ends (\S+)$/.exec(entry.detail)?.[1];
		const at = end ? Date.parse(end) : NaN;
		return {
			title: `You extended access by ${amount}`,
			detail: Number.isFinite(at)
				? `Ends ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
				: undefined
		};
	}
	if (entry.tool === 'request_more_time')
		return {
			title: `Brain asked for ${amount} more`,
			detail: entry.detail.replace(/^\d+ minutes: /, '') || undefined
		};
	return { title: `You dismissed Brain's request for ${amount} more` };
}
