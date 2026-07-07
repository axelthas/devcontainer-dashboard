import {
	createPersistentSession,
	getPersistentSession,
	deletePersistentSession
} from './terminal.js';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ActiveBootstrapRun {
	id: string;
	name: string;
	workspacePath: string;
	status: 'running' | 'success' | 'failed';
	startedAt: string;
	exitCode?: number;
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

	createPersistentSession(id, command, WORKSPACE_ROOT);

	// Poll for session exit to update run status
	const poll = setInterval(() => {
		const session = getPersistentSession(id);
		if (!session) {
			clearInterval(poll);
			return;
		}
		if (session.status === 'exited') {
			clearInterval(poll);
			run.exitCode = session.exitCode;
			run.status = session.exitCode === 0 ? 'success' : 'failed';
		}
	}, 500);

	return run;
}

export function getActiveRuns(): ActiveBootstrapRun[] {
	cleanupOldRuns();
	return Array.from(activeRuns.values());
}

export function removeBootstrapRun(id: string): void {
	if (!activeRuns.has(id)) return;
	deletePersistentSession(id);
	activeRuns.delete(id);
}

function cleanupOldRuns(): void {
	const cutoff = Date.now() - CLEANUP_AGE_MS;
	for (const [id, run] of activeRuns) {
		if (new Date(run.startedAt).getTime() < cutoff) {
			activeRuns.delete(id);
		}
	}
}
