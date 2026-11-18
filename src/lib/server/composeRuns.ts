/**
 * Track Compose lifecycle runs as persistent PTY sessions.
 * A browser disconnect never stops a run. Explicit cancellation stops the process tree,
 * but does not roll back containers, networks, or images that Compose already created.
 */
import {
	COMPOSE_ACTION_LABELS,
	composeActionCommand,
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
const g = globalThis as typeof globalThis & { __composeRuns?: Map<string, ActiveComposeRun> };
if (!g.__composeRuns) g.__composeRuns = new Map();
const activeRuns = g.__composeRuns;

/** Start one persistent process per stack. Lock checks and tracking are synchronous. */
export function startComposeRun(
	id: string,
	target: ComposeTarget,
	repoName: string,
	projectName: string,
	action: ComposeAction,
	services: string[] = []
): ActiveComposeRun {
	cleanupOldRuns();
	for (const existing of activeRuns.values()) {
		if (
			existing.status === 'running' &&
			(existing.canonicalProjectDirectory === target.canonicalProjectDirectory ||
				existing.projectName === projectName)
		) {
			throw new ComposeRunConflict();
		}
	}
	const executable = composeActionCommand(target.repoPath, target.selection, action, services);

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
		canonicalProjectDirectory: target.canonicalProjectDirectory,
		status: 'running',
		startedAt: new Date().toISOString()
	};
	activeRuns.set(id, run);

	try {
		createPersistentSession(id, undefined, target.projectDirectory, {
			executable,
			name: `${COMPOSE_ACTION_LABELS[action]} ${projectName}`,
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
			}
		});
	} catch (cause) {
		// Capacity and spawn errors must not leave a permanent lock.
		activeRuns.delete(id);
		throw cause;
	}
	return run;
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
		const action = (['build', 'up', 'up-build', 'stop'] as const).find(
			(item) => item === log.action
		);
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
