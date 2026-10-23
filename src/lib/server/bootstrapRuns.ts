import { createPersistentSession, deletePersistentSession, isCancelledExit } from './terminal.js';
import {
	deleteRunLog,
	listRunLogs,
	RUN_LOG_MAX_CHARS,
	RUN_LOG_RETENTION_MS,
	saveRunLog,
	type RunLogMetadata
} from './runLogs.js';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ActiveBootstrapRun {
	id: string;
	name: string;
	workspacePath: string;
	status: 'running' | 'success' | 'failed';
	startedAt: string;
	exitCode?: number;
	/** True when the output of a failed run is kept as a log */
	hasLog?: boolean;
}

// Use globalThis so the Map survives Vite HMR reloads in dev mode.
const g = globalThis as typeof globalThis & {
	__bootstrapRuns?: Map<string, ActiveBootstrapRun>;
};
if (!g.__bootstrapRuns) g.__bootstrapRuns = new Map();
const activeRuns = g.__bootstrapRuns;

export function startBootstrapRun(
	id: string,
	name: string,
	command: string,
	destDir: string
): ActiveBootstrapRun {
	cleanupOldRuns();

	const workspacePath = WORKSPACE_ROOT + '/' + destDir;

	const run: ActiveBootstrapRun = {
		id,
		name,
		workspacePath,
		status: 'running',
		startedAt: new Date().toISOString()
	};
	activeRuns.set(id, run);

	createPersistentSession(id, command, WORKSPACE_ROOT, {
		name,
		kind: 'bootstrap',
		maxOutputChars: RUN_LOG_MAX_CHARS,
		onExit: ({ exitCode, signal, output }) => {
			// A run that is no longer tracked was dismissed, or its workspace was deleted.
			if (activeRuns.get(id) !== run) return;
			// A successful run appears as a workspace on disk, and a cancelled run leaves nothing.
			if (exitCode === 0 || isCancelledExit(exitCode, signal)) {
				activeRuns.delete(id);
				return;
			}
			run.status = 'failed';
			run.exitCode = exitCode;
			keepFailedRunLog(run, output);
		}
	});

	return run;
}

function keepFailedRunLog(run: ActiveBootstrapRun, output: string): void {
	run.hasLog = true;
	const metadata: RunLogMetadata = {
		id: run.id,
		kind: 'bootstrap',
		name: run.name,
		path: run.workspacePath,
		startedAt: run.startedAt,
		endedAt: new Date().toISOString(),
		exitCode: run.exitCode ?? 1
	};
	saveRunLog(metadata, output).catch((err) => console.error('Could not keep the run log', err));
}

export function getActiveRuns(): ActiveBootstrapRun[] {
	cleanupOldRuns();
	return Array.from(activeRuns.values());
}

/** Stops a running bootstrap run, or dismisses a failed run and deletes its log. */
export function removeBootstrapRun(id: string): void {
	const run = activeRuns.get(id);
	if (!run) return;
	// Untrack the run first, so that its exit callback keeps no log.
	activeRuns.delete(id);
	deletePersistentSession(id);
	if (run.hasLog) {
		deleteRunLog(id).catch((err) => console.error('Could not delete the run log', err));
	}
}

function cleanupOldRuns(now = Date.now()): void {
	for (const [id, run] of activeRuns) {
		if (run.status === 'running') continue;
		const maxAge = run.hasLog ? RUN_LOG_RETENTION_MS : CLEANUP_AGE_MS;
		if (now - new Date(run.startedAt).getTime() > maxAge) removeBootstrapRun(id);
	}
}

// Show failed bootstrap runs with a kept log again after a restart.
async function restoreFailedRuns(): Promise<void> {
	for (const log of await listRunLogs()) {
		if (log.kind !== 'bootstrap' || activeRuns.has(log.id)) continue;
		activeRuns.set(log.id, {
			id: log.id,
			name: log.name,
			workspacePath: log.path,
			status: 'failed',
			startedAt: log.startedAt,
			exitCode: log.exitCode,
			hasLog: true
		});
	}
}

if (!process.env.VITEST) restoreFailedRuns();
