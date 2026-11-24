/**
 * Process-wide Brain access state. SvelteKit routes and the custom server entry point are
 * separate bundles, so the state lives on globalThis, as terminal sessions and authentication do.
 * The MCP listener and the operator routes therefore see the same grants and executions.
 */
import type Dockerode from 'dockerode';
import type { Duplex } from 'node:stream';
import type {
	BrainAuditEntry,
	BrainController,
	BrainExecutionKind,
	BrainExecutionStatus,
	BrainExposure,
	BrainTargetKind
} from '../../brainTypes.js';
import docker from '../docker.js';

/** One operator decision: shell access to one run of one container, until it expires. */
export interface BrainGrant {
	id: string;
	/** Full container ID */
	containerId: string;
	containerName: string;
	kind: BrainTargetKind;
	/** Docker `State.StartedAt` of the run that the operator reviewed */
	startedAt: string;
	/** `docker exec --user` value. Undefined: the container's default user. */
	execUser?: string;
	/** Display user: `execUser`, or `root` for the container default */
	user: string;
	userSource: string;
	workdir?: string;
	composeProject?: string;
	composeService?: string;
	localFolder?: string;
	exposure: BrainExposure[];
	createdAt: number;
	expiresAt: number;
	/** The broader task Brain last supplied for this grant. */
	intent?: string;
}

/** One command that Brain typed into a shell. Cursors are absolute output offsets. */
export interface BrainShellCommand {
	id: string;
	command: string;
	/** What Brain said the command should accomplish */
	goal?: string;
	status: 'running' | 'exited';
	/** Output end when Brain typed the command; the echoed command line follows */
	startCursor: number;
	/** Output start after the echoed line, from the start marker (bash 4.4 and later) */
	outputCursor?: number;
	/** Position of the prompt marker that ended the command */
	endCursor?: number;
	exitCode?: number;
	/** Working directory after the command */
	cwd?: string;
	startedAt: number;
	endedAt?: number;
}

/** Persistent shell state. Prompt markers carry `nonce`, so output cannot match by accident. */
export interface BrainShell {
	name: string;
	nonce: string;
	/** True after the first prompt marker */
	ready: boolean;
	cwd?: string;
	exitCode?: number;
	/** Brain's current or last command */
	current?: BrainShellCommand;
	/** Commands that Brain typed */
	commands: number;
	/** The newest commands that Brain typed, oldest first, for the operator's activity view */
	history: BrainShellCommand[];
}

/** One command or shell that Brain started. The process runs inside the container, not here. */
export interface BrainExecution {
	id: string;
	grantId: string;
	containerId: string;
	containerName: string;
	kind: BrainExecutionKind;
	/** The command, or the shell start script */
	command: string;
	/** What Brain said a one-off command should accomplish */
	goal?: string;
	/** Set for a persistent shell */
	shell?: BrainShell;
	execUser?: string;
	user: string;
	workdir?: string;
	/** True when Brain may write to the terminal with write_stdin */
	interactive: boolean;
	/** Who may type into the terminal. The operator takes control explicitly. */
	controller: BrainController;
	/** True after Brain sent end-of-file; Brain cannot write again */
	stdinClosed: boolean;
	status: BrainExecutionStatus;
	exitCode?: number;
	error?: string;
	stopReason?: string;
	startedAt: number;
	endedAt?: number;
	/** Process group of the command inside the container, read from the start marker */
	pgid?: number;
	/** True after the Docker output stream ended */
	streamEnded: boolean;
	/** Retained output, and the absolute offset of its first character */
	output: string;
	outputStart: number;
	/** Increments on every output or status change */
	version: number;
	waiters: Set<() => void>;
	/** Terminal viewers. Each call receives new output, or no text for a state change. */
	listeners: Set<(text?: string) => void>;
	/** Hijacked Docker stream to the PTY. It carries Brain input and operator input. */
	stdin?: Duplex;
	/** PTY size control of the Docker exec */
	terminal?: { resize(size: { h: number; w: number }): Promise<unknown> };
	stopping?: Promise<BrainExecutionStatus>;
}

interface BrainState {
	grants: Map<string, BrainGrant>;
	executions: Map<string, BrainExecution>;
	audit: BrainAuditEntry[];
	/** Set while the MCP listener runs in this process */
	gateway?: { publicUrl?: string };
	/** Test override for the Docker client */
	docker?: Dockerode;
}

const globalBrain = globalThis as typeof globalThis & { __devcontainerDashboardBrain?: BrainState };
export const brainState: BrainState = (globalBrain.__devcontainerDashboardBrain ??= {
	grants: new Map(),
	executions: new Map(),
	audit: []
});

export const AUDIT_LIMIT = 200;
/** Longest goal that Brain can give with a command */
export const GOAL_LIMIT = 200;
/** Shell commands retained per shell for the activity view */
export const SHELL_HISTORY_LIMIT = 50;

/** Docker client for Brain operations. */
export function brainDocker(): Dockerode {
	return brainState.docker ?? docker;
}

/** Record one call or decision. Callers pass bounded, secret-free details, never stdin. */
export function recordAudit(entry: Omit<BrainAuditEntry, 'at'>, now = Date.now()): void {
	brainState.audit.push({
		...entry,
		at: new Date(now).toISOString(),
		detail: entry.detail.slice(0, 300),
		...(entry.goal === undefined ? {} : { goal: entry.goal.slice(0, GOAL_LIMIT) })
	});
	if (brainState.audit.length > AUDIT_LIMIT)
		brainState.audit.splice(0, brainState.audit.length - AUDIT_LIMIT);
}

/** Wake every waiter and terminal viewer after an output (`text`) or state change. */
export function notify(execution: BrainExecution, text?: string): void {
	execution.version++;
	const waiters = [...execution.waiters];
	execution.waiters.clear();
	for (const waiter of waiters) waiter();
	for (const listener of [...(execution.listeners ?? [])]) {
		try {
			listener(text);
		} catch (cause) {
			// One failing viewer must not stop output to Brain or to other viewers.
			console.error('[brain] terminal viewer failed', cause);
		}
	}
}

/** Reset process-local test state. */
export function resetBrainStateForTesting(client?: Dockerode): void {
	brainState.grants.clear();
	brainState.executions.clear();
	brainState.audit.length = 0;
	brainState.gateway = undefined;
	brainState.docker = client;
}
