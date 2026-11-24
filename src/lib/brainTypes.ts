/**
 * Client-safe shapes for Brain shell access: an operator grants an MCP client (ClickUp Brain)
 * shell access to one running container at a time. Server modules and components share them.
 */

/** How serious one resource reachable from a container is. `danger` needs explicit acceptance. */
export type BrainExposureLevel = 'info' | 'warning' | 'danger';

export interface BrainExposure {
	level: BrainExposureLevel;
	message: string;
}

export type BrainTargetKind = 'devcontainer' | 'service';

/** Grant durations that the dashboard offers, in minutes. */
export const BRAIN_GRANT_MINUTES = [15, 60, 240] as const;
export type BrainGrantMinutes = (typeof BRAIN_GRANT_MINUTES)[number];

/** What a grant allows, read from live Docker state before the operator confirms it. */
export interface BrainTargetPreview {
	/** Short (12 character) container ID */
	containerId: string;
	containerName: string;
	kind: BrainTargetKind;
	/** Docker `State.StartedAt`. A grant binds to this exact container run. */
	startedAt: string;
	/** User that commands run as */
	user: string;
	/** Where the user comes from, for display */
	userSource: string;
	/** Default working directory for commands, when known */
	workdir?: string;
	composeProject?: string;
	composeService?: string;
	/** Host folder of a devcontainer workspace */
	localFolder?: string;
	exposure: BrainExposure[];
}

/** Body of POST /api/brain/grants. */
export interface BrainGrantRequest {
	containerId: string;
	/** The `startedAt` value that the operator reviewed */
	startedAt: string;
	minutes: BrainGrantMinutes;
	/** Required when the preview lists a `danger` exposure */
	acceptRisks: boolean;
}

export interface BrainGrantView extends BrainTargetPreview {
	id: string;
	/** The broader task Brain last supplied for this grant. */
	intent?: string;
	createdAt: string;
	expiresAt: string;
	runningExecutions: number;
}

/**
 * `stopping`: termination was requested. `stopped`: the process group is confirmed gone.
 * `stop_unconfirmed`: signals were sent, but the dashboard could not confirm completion.
 */
export type BrainExecutionStatus =
	| 'running'
	| 'stopping'
	| 'exited'
	| 'stopped'
	| 'stop_unconfirmed'
	| 'failed';

/** Who may type into a Brain terminal: Brain (through write_stdin) or the operator. */
export type BrainController = 'brain' | 'operator';

/**
 * `command`: one process per `execute` call, as before. `shell`: one persistent interactive
 * bash that Brain types commands into, so the working directory and variables carry over.
 */
export type BrainExecutionKind = 'command' | 'shell';

/** One command that Brain typed into a shell, for the operator's activity view. */
export interface BrainShellCommandView {
	id: string;
	command: string;
	/** What Brain said the command should accomplish */
	goal?: string;
	status: 'running' | 'exited';
	exitCode?: number;
	/** Working directory after the command */
	cwd?: string;
	startedAt: string;
	endedAt?: string;
}

/** Live state of one persistent Brain shell. */
export interface BrainShellView {
	/** Name that Brain gave the shell, unique among the open shells of one grant */
	name: string;
	/** True after the shell showed its first prompt */
	ready: boolean;
	/** True while a command that Brain typed runs */
	busy: boolean;
	/** Working directory reported at the last prompt */
	cwd?: string;
	/** The running command, or the last command that Brain typed */
	command?: string;
	/** Exit code reported at the last prompt */
	exitCode?: number;
	/** Retained commands that Brain typed, oldest first */
	commands: BrainShellCommandView[];
}

export interface BrainExecutionView {
	id: string;
	grantId: string;
	containerName: string;
	kind: BrainExecutionKind;
	/** The command, or `shell <name>` for a shell */
	command: string;
	/** What Brain said a one-off command should accomplish */
	goal?: string;
	/** Set for a shell */
	shell?: BrainShellView;
	user: string;
	workdir?: string;
	interactive: boolean;
	controller: BrainController;
	status: BrainExecutionStatus;
	exitCode?: number;
	error?: string;
	stopReason?: string;
	startedAt: string;
	endedAt?: string;
}

/** Server message on the Brain terminal WebSocket. */
export type BrainTerminalMessage =
	| {
			type: 'ready';
			/** Tail of the retained output */
			output: string;
			/** True when older output is not part of `output` */
			truncated: boolean;
			state: BrainTerminalState;
	  }
	| { type: 'data'; data: string }
	| { type: 'state'; state: BrainTerminalState }
	| { type: 'error'; message: string }
	| { type: 'missing' };

/** Live state of one Brain terminal. */
export interface BrainTerminalState {
	status: BrainExecutionStatus;
	controller: BrainController;
	interactive: boolean;
	exitCode?: number;
}

/** One Brain call or operator decision. Details never contain stdin or output. */
export interface BrainAuditEntry {
	at: string;
	tool: string;
	target?: string;
	detail: string;
	outcome: 'ok' | 'denied' | 'error';
	/** Execution or shell that the call used, so the dashboard shows it with that command */
	executionId?: string;
	/** Shell command that the call used */
	commandId?: string;
	/** Goal that Brain gave with an `execute` call */
	goal?: string;
}

/** Response of GET /api/brain. */
export interface BrainStatus {
	/** True when the MCP listener runs in this dashboard process */
	enabled: boolean;
	/** Externally reachable MCP URL, from BRAIN_MCP_PUBLIC_URL */
	publicUrl?: string;
	grants: BrainGrantView[];
	executions: BrainExecutionView[];
	audit: BrainAuditEntry[];
}

/** One page of retained execution output. Cursors are absolute character offsets. */
export interface BrainOutputView {
	executionId: string;
	text: string;
	cursor: number;
	nextCursor: number;
	/** True when output before `cursor` was dropped by the retention limit */
	truncatedBefore: boolean;
	/** True when more retained output follows `nextCursor` */
	more: boolean;
	status: BrainExecutionStatus;
	exitCode?: number;
}
