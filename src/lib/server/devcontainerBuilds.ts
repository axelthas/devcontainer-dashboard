import { realpathSync } from 'node:fs';
import { devcontainerCommand } from './devcontainerRebuild.js';
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
	/** Canonical repository identity used to serialize starts and rebuilds. */
	canonicalRepoPath?: string;
	/** Hold the repository lock until explicit process-tree cancellation is verified. */
	stopping?: boolean;
	/** True when the output of a failed run is kept as a log */
	hasLog?: boolean;
}

export class DevcontainerBuildConflict extends Error {
	/** Expose an explicit conflict instead of starting a second replacement process. */
	constructor() {
		super('A devcontainer build or rebuild is already running for this workspace');
		this.name = 'DevcontainerBuildConflict';
	}
}

// Use globalThis so the Map survives Vite HMR reloads in dev mode.
const g = globalThis as typeof globalThis & {
	__devcontainerBuilds?: Map<string, ActiveDevcontainerBuild>;
};
if (!g.__devcontainerBuilds) g.__devcontainerBuilds = new Map();
const activeBuilds = g.__devcontainerBuilds;

/** Start one persistent CLI process per canonical repository; spawning must be atomic with tracking. */
export function startDevcontainerBuild(
	id: string,
	repoPath: string,
	repoName: string,
	configPath?: string,
	rebuildLabels?: Record<string, string>
): ActiveDevcontainerBuild {
	cleanupOldBuilds();
	const canonicalRepoPath = realpathSync(repoPath);
	for (const existing of activeBuilds.values()) {
		if (
			existing.status === 'running' &&
			(existing.canonicalRepoPath ?? realpathSync(existing.repoPath)) === canonicalRepoPath
		) {
			throw new DevcontainerBuildConflict();
		}
	}
	const executable = devcontainerCommand(repoPath, configPath, rebuildLabels);

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
		canonicalRepoPath,
		status: 'running',
		startedAt: new Date().toISOString()
	};
	activeBuilds.set(id, build);

	try {
		createPersistentSession(id, undefined, repoPath, {
			executable,
			name: rebuildLabels ? `Rebuild ${repoName}` : repoName,
			kind: 'devcontainer-build',
			maxOutputChars: RUN_LOG_MAX_CHARS,
			onExit: ({ exitCode, signal, output }) => {
				// A build that is no longer tracked was cancelled, dismissed, or replaced.
				if (activeBuilds.get(id) !== build) return;
				if (build.stopping) return;
				if (isCancelledExit(exitCode, signal)) {
					activeBuilds.delete(id);
					return;
				}
				build.exitCode = exitCode;
				build.status = exitCode === 0 ? 'success' : 'failed';
				if (build.status === 'failed') keepFailedBuildLog(build, output);
			}
		});
	} catch (cause) {
		// Capacity and spawn errors must not leave an immortal running build/lock.
		activeBuilds.delete(id);
		throw cause;
	}

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
export function removeDevcontainerBuild(id: string): Promise<void> {
	const build = activeBuilds.get(id);
	if (!build) return Promise.resolve();
	// Retain a running lock until verified process-tree termination completes.
	build.stopping = true;
	const operation = deletePersistentSession(id)
		.then(async () => {
			if (activeBuilds.get(id) === build) activeBuilds.delete(id);
			if (build.hasLog) await deleteRunLog(id);
		})
		.catch((error) => {
			build.stopping = false;
			if (!activeBuilds.has(id)) activeBuilds.set(id, build);
			throw error;
		});
	void operation.catch((error) => console.error('Could not stop devcontainer build', error));
	return operation;
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
