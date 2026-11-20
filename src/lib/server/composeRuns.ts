/**
 * Track Compose lifecycle runs as persistent PTY sessions.
 * A browser disconnect never stops a run. Explicit cancellation stops the process tree,
 * but does not roll back containers, networks, or images that Compose already created.
 * Pull and start is two runs: when Pull succeeds, the server starts Start with the same
 * selection and override file. A failed or cancelled Pull never starts anything.
 */
import { randomUUID } from 'node:crypto';
import {
	COMPOSE_ACTION_LABELS,
	COMPOSE_ACTIONS,
	composeActionCommand,
	composeFollowUp,
	type ComposeAction
} from '../composeCommands.js';
import type { ComposeTarget } from './composeSandbox.js';
import { createPersistentSession, deletePersistentSession, isCancelledExit } from './terminal.js';
import {
	deleteRunLog,
	listRunLogs,
	RUN_LOG_MAX_CHARS,
	RUN_LOG_RETENTION_MS,
	saveRunLog,
	type RunLogMetadata
} from './runLogs.js';

const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;

export interface ActiveComposeRun {
	id: string;
	repoPath: string;
	repoName: string;
	action: ComposeAction;
	files: string[];
	/** Services passed to Compose; empty means every service. */
	services: string[];
	projectName?: string;
	/** Sandbox tag; absent means the image references in the Compose files. */
	tag?: string;
	/** Version override file passed as the last `--file` */
	overrideFile?: string;
	/** Set on the Start run that follows a successful Pull of Pull and start */
	after?: 'up-pull';
	/** Canonical project directory; one run per directory at a time. */
	canonicalProjectDirectory?: string;
	status: 'running' | 'success' | 'failed';
	startedAt: string;
	exitCode?: number;
	/** Hold the lock until explicit process-tree cancellation is verified. */
	stopping?: boolean;
	/** True when the output of a failed run is kept as a log. */
	hasLog?: boolean;
}

export class ComposeRunConflict extends Error {
	/** Refuse a second concurrent operation on the same stack. */
	constructor() {
		super('A Compose operation is already running for this sandbox');
		this.name = 'ComposeRunConflict';
	}
}

// Use globalThis so the Map survives Vite HMR reloads in dev mode.
const g = globalThis as typeof globalThis & {
	__composeRuns?: Map<string, ActiveComposeRun>;
	__composeRemovals?: Set<string>;
};
if (!g.__composeRuns) g.__composeRuns = new Map();
if (!g.__composeRemovals) g.__composeRemovals = new Set();
const activeRuns = g.__composeRuns;
/** Compose project names that a sandbox removal holds. */
const removals = g.__composeRemovals;

/** Options of one run beyond the selection. */
export interface ComposeRunOptions {
	overrideFile?: string;
	after?: 'up-pull';
}

/**
 * Reserve a project name for sandbox removal. Refuse while a Compose run of the project
 * runs or another removal holds it. Call the returned function to release the name.
 */
export function reserveProjectRemoval(projectName: string): () => void {
	const running = [...activeRuns.values()].some(
		(run) => run.status === 'running' && run.projectName === projectName
	);
	if (running || removals.has(projectName)) throw new ComposeRunConflict();
	removals.add(projectName);
	return () => removals.delete(projectName);
}

/** Start one persistent process per stack. Lock checks and tracking are synchronous. */
export function startComposeRun(
	id: string,
	target: ComposeTarget,
	repoName: string,
	projectName: string,
	action: ComposeAction,
	services: string[] = [],
	options: ComposeRunOptions = {}
): ActiveComposeRun {
	cleanupOldRuns();
	if (removals.has(projectName)) throw new ComposeRunConflict();
	for (const existing of activeRuns.values()) {
		if (
			existing.status === 'running' &&
			(existing.canonicalProjectDirectory === target.canonicalProjectDirectory ||
				existing.projectName === projectName)
		) {
			throw new ComposeRunConflict();
		}
	}
	const executable = composeActionCommand(
		target.repoPath,
		target.selection,
		action,
		services,
		options.overrideFile
	);

	// Replace a finished entry for the same repository, so the row shows the newest run.
	for (const [existingId, existing] of activeRuns) {
		if (existing.repoPath === target.repoPath && existing.status !== 'running') {
			removeComposeRun(existingId);
		}
	}

	const run: ActiveComposeRun = {
		id,
		repoPath: target.repoPath,
		repoName,
		action,
		files: [...target.selection.files],
		services: [...services],
		projectName,
		...(target.selection.tag ? { tag: target.selection.tag } : {}),
		...(options.overrideFile ? { overrideFile: options.overrideFile } : {}),
		...(options.after ? { after: options.after } : {}),
		canonicalProjectDirectory: target.canonicalProjectDirectory,
		status: 'running',
		startedAt: new Date().toISOString()
	};
	activeRuns.set(id, run);

	try {
		createPersistentSession(id, undefined, target.projectDirectory, {
			executable,
			name: `${COMPOSE_ACTION_LABELS[action]} ${projectName}${run.tag ? ` ${run.tag}` : ''}`,
			kind: 'compose',
			maxOutputChars: RUN_LOG_MAX_CHARS,
			onExit: ({ exitCode, signal, output }) => {
				// A run that is no longer tracked was cancelled, dismissed, or replaced.
				if (activeRuns.get(id) !== run) return;
				if (run.stopping) return;
				if (isCancelledExit(exitCode, signal)) {
					activeRuns.delete(id);
					return;
				}
				run.exitCode = exitCode;
				run.status = exitCode === 0 ? 'success' : 'failed';
				if (run.status === 'failed') keepFailedRunLog(run, output);
				// Leave the exit handler first; the follow-up replaces this run's session.
				else
					queueMicrotask(() =>
						startFollowUp(run, target, repoName, projectName, output, options.overrideFile)
					);
			}
		});
	} catch (cause) {
		// Capacity and spawn errors must not leave a permanent lock.
		activeRuns.delete(id);
		throw cause;
	}
	return run;
}

/**
 * Start the second run of Pull and start after its Pull succeeded. The Pull run is then
 * replaced by the Start run, so the row shows the newest run. A refused start keeps the
 * Pull run as a failure with an explanation in its log.
 */
function startFollowUp(
	run: ActiveComposeRun,
	target: ComposeTarget,
	repoName: string,
	projectName: string,
	output: string,
	overrideFile?: string
): void {
	const next = composeFollowUp(run.action);
	// A dismissed or replaced Pull starts nothing.
	if (!next || activeRuns.get(run.id) !== run) return;
	try {
		startComposeRun(randomUUID(), target, repoName, projectName, next, run.services, {
			overrideFile,
			after: 'up-pull'
		});
	} catch (cause) {
		run.status = 'failed';
		run.exitCode = 1;
		const reason = cause instanceof Error ? cause.message : 'Could not start';
		keepFailedRunLog(run, `${output}\r\nPull succeeded, but Start was refused: ${reason}\r\n`);
	}
}

/** Persist failed output with enough metadata to show it again after a restart. */
function keepFailedRunLog(run: ActiveComposeRun, output: string): void {
	run.hasLog = true;
	const metadata: RunLogMetadata = {
		id: run.id,
		kind: 'compose',
		name: run.repoName,
		path: run.repoPath,
		action: run.action,
		files: run.files,
		services: run.services,
		startedAt: run.startedAt,
		endedAt: new Date().toISOString(),
		exitCode: run.exitCode ?? 1
	};
	saveRunLog(metadata, output).catch((err) => console.error('Could not keep the run log', err));
}

export function getActiveComposeRuns(): ActiveComposeRun[] {
	cleanupOldRuns();
	return Array.from(activeRuns.values());
}

/** Cancel a running operation, or dismiss a finished one and delete its log. */
export function removeComposeRun(id: string): Promise<void> {
	const run = activeRuns.get(id);
	if (!run) return Promise.resolve();
	run.stopping = true;
	const operation = deletePersistentSession(id)
		.then(async () => {
			if (activeRuns.get(id) === run) activeRuns.delete(id);
			if (run.hasLog) await deleteRunLog(id);
		})
		.catch((error) => {
			run.stopping = false;
			if (!activeRuns.has(id)) activeRuns.set(id, run);
			throw error;
		});
	void operation.catch((error) => console.error('Could not stop Compose run', error));
	return operation;
}

function cleanupOldRuns(now = Date.now()): void {
	for (const [id, run] of activeRuns) {
		if (run.status === 'running') continue;
		const maxAge = run.hasLog ? RUN_LOG_RETENTION_MS : CLEANUP_AGE_MS;
		if (now - new Date(run.startedAt).getTime() > maxAge) void removeComposeRun(id);
	}
}

/** Show failed runs with a kept log again after a restart. Running state is never restored. */
async function restoreFailedRuns(): Promise<void> {
	for (const log of await listRunLogs()) {
		if (log.kind !== 'compose' || activeRuns.has(log.id)) continue;
		const action = COMPOSE_ACTIONS.find((item) => item === log.action);
		if (!action) continue;
		activeRuns.set(log.id, {
			id: log.id,
			repoPath: log.path,
			repoName: log.name,
			action,
			files: log.files ?? [],
			services: log.services ?? [],
			status: 'failed',
			startedAt: log.startedAt,
			exitCode: log.exitCode,
			hasLog: true
		});
	}
}

if (!process.env.VITEST) void restoreFailedRuns();
