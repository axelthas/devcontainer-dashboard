import { join } from 'node:path';
import { createPersistentSession, deletePersistentSession, isCancelledExit } from './terminal.js';
import {
	deleteRunLog,
	listRunLogs,
	RUN_LOG_MAX_CHARS,
	RUN_LOG_RETENTION_MS,
	saveRunLog,
	type RunLogMetadata
} from './runLogs.js';

const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ActiveDevcontainerBuild {
	id: string;
	repoPath: string;
	repoName: string;
	/** Relative path to the devcontainer.json used for this build (e.g. '.devcontainer/rocky8/devcontainer.json') */
	configPath?: string;
	status: 'running' | 'success' | 'failed';
	startedAt: string;
	exitCode?: number;
	/** True when the output of a failed build is kept as a log */
	hasLog?: boolean;
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
	repoName: string,
	configPath?: string
): ActiveDevcontainerBuild {
	cleanupOldBuilds();

	// Remove any prior completed build for the same repo to avoid stale entries on retry.
	for (const [existingId, existing] of activeBuilds) {
		if (existing.repoPath === repoPath && existing.status !== 'running') {
			removeDevcontainerBuild(existingId);
		}
	}

	const build: ActiveDevcontainerBuild = {
		id,
		repoPath,
		repoName,
		configPath,
		status: 'running',
		startedAt: new Date().toISOString()
	};
	activeBuilds.set(id, build);

	const command = configPath
		? `devcontainer up --workspace-folder ${repoPath} --config ${join(repoPath, configPath)}`
		: `devcontainer up --workspace-folder ${repoPath}`;
	createPersistentSession(id, command, repoPath, {
		name: repoName,
		kind: 'devcontainer-build',
		maxOutputChars: RUN_LOG_MAX_CHARS,
		onExit: ({ exitCode, signal, output }) => {
			// A build that is no longer tracked was cancelled, dismissed, or replaced.
			if (activeBuilds.get(id) !== build) return;
			if (isCancelledExit(exitCode, signal)) {
				activeBuilds.delete(id);
				return;
			}
			build.exitCode = exitCode;
			build.status = exitCode === 0 ? 'success' : 'failed';
			if (build.status === 'failed') keepFailedBuildLog(build, output);
		}
	});

	return build;
}

function keepFailedBuildLog(build: ActiveDevcontainerBuild, output: string): void {
	build.hasLog = true;
	const metadata: RunLogMetadata = {
		id: build.id,
		kind: 'devcontainer-build',
		name: build.repoName,
		path: build.repoPath,
		configPath: build.configPath,
		startedAt: build.startedAt,
		endedAt: new Date().toISOString(),
		exitCode: build.exitCode ?? 1
	};
	saveRunLog(metadata, output).catch((err) => console.error('Could not keep the run log', err));
}

export function getActiveBuilds(): ActiveDevcontainerBuild[] {
	cleanupOldBuilds();
	return Array.from(activeBuilds.values());
}

/** Cancels a running build, or dismisses a finished build and deletes its log. */
export function removeDevcontainerBuild(id: string): void {
	const build = activeBuilds.get(id);
	if (!build) return;
	// Untrack the build first, so that its exit callback treats it as cancelled.
	activeBuilds.delete(id);
	deletePersistentSession(id);
	if (build.hasLog) {
		deleteRunLog(id).catch((err) => console.error('Could not delete the run log', err));
	}
}

function cleanupOldBuilds(now = Date.now()): void {
	for (const [id, build] of activeBuilds) {
		if (build.status === 'running') continue;
		const maxAge = build.hasLog ? RUN_LOG_RETENTION_MS : CLEANUP_AGE_MS;
		if (now - new Date(build.startedAt).getTime() > maxAge) removeDevcontainerBuild(id);
	}
}

// Show failed builds with a kept log again after a restart.
async function restoreFailedBuilds(): Promise<void> {
	for (const log of await listRunLogs()) {
		if (log.kind !== 'devcontainer-build' || activeBuilds.has(log.id)) continue;
		activeBuilds.set(log.id, {
			id: log.id,
			repoPath: log.path,
			repoName: log.name,
			configPath: log.configPath,
			status: 'failed',
			startedAt: log.startedAt,
			exitCode: log.exitCode,
			hasLog: true
		});
	}
}

if (!process.env.VITEST) restoreFailedBuilds();
