import { createPersistentSession, getPersistentSession, deletePersistentSession } from './terminal.js';

const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ActiveDevcontainerBuild {
	id: string;
	repoPath: string;
	repoName: string;
	status: 'running' | 'success' | 'failed';
	startedAt: string;
	exitCode?: number;
}

// Use globalThis so the Map survives Vite HMR reloads in dev mode.
const g = globalThis as typeof globalThis & {
	__devcontainerBuilds?: Map<string, ActiveDevcontainerBuild>;
};
if (!g.__devcontainerBuilds) g.__devcontainerBuilds = new Map();
const activeBuilds = g.__devcontainerBuilds;

export function startDevcontainerBuild(
	id: string,
	repoPath: string,
	repoName: string
): ActiveDevcontainerBuild {
	cleanupOldBuilds();

	const build: ActiveDevcontainerBuild = {
		id,
		repoPath,
		repoName,
		status: 'running',
		startedAt: new Date().toISOString()
	};
	activeBuilds.set(id, build);

	createPersistentSession(id, `devcontainer up --workspace-folder ${repoPath}`, repoPath);

	// Poll for session exit to update build status
	const poll = setInterval(() => {
		const session = getPersistentSession(id);
		if (!session) {
			clearInterval(poll);
			return;
		}
		if (session.status === 'exited') {
			clearInterval(poll);
			build.exitCode = session.exitCode;
			build.status = session.exitCode === 0 ? 'success' : 'failed';
		}
	}, 500);

	return build;
}

export function getActiveBuilds(): ActiveDevcontainerBuild[] {
	cleanupOldBuilds();
	return Array.from(activeBuilds.values());
}

export function removeDevcontainerBuild(id: string): void {
	if (!activeBuilds.has(id)) return;
	deletePersistentSession(id);
	activeBuilds.delete(id);
}

function cleanupOldBuilds(): void {
	const cutoff = Date.now() - CLEANUP_AGE_MS;
	for (const [id, build] of activeBuilds) {
		if (new Date(build.startedAt).getTime() < cutoff) {
			activeBuilds.delete(id);
		}
	}
}
