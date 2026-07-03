import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import docker from '$lib/server/docker';
import { readGitHead, readCurrentTag } from '$lib/server/git';
import { getActiveRuns } from '$lib/server/bootstrapRuns';
import { getActiveBuilds } from '$lib/server/devcontainerBuilds';
import type { LocalWorkspaceData, SolutionMetadata } from '$lib/types';

export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

/**
 * Enumerate all devcontainer.json files within a repo, returning their paths
 * relative to `repoPath`. Scans:
 *  - `.devcontainer.json` (root-level alternate)
 *  - `.devcontainer/devcontainer.json` (standard single-config)
 *  - `.devcontainer/<name>/devcontainer.json` (one-level named sub-configs)
 */
async function findDevcontainerConfigs(repoPath: string): Promise<string[]> {
	const configs: string[] = [];

	if (existsSync(join(repoPath, '.devcontainer.json'))) {
		configs.push('.devcontainer.json');
	}

	const devcontainerDir = join(repoPath, '.devcontainer');
	if (existsSync(devcontainerDir)) {
		if (existsSync(join(devcontainerDir, 'devcontainer.json'))) {
			configs.push('.devcontainer/devcontainer.json');
		}
		try {
			const entries = await readdir(devcontainerDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (existsSync(join(devcontainerDir, entry.name, 'devcontainer.json'))) {
					configs.push(`.devcontainer/${entry.name}/devcontainer.json`);
				}
			}
		} catch {
			// ignore read errors for subdirectory scan
		}
	}

	return configs;
}

async function readSolutionMetadata(workspacePath: string): Promise<SolutionMetadata | undefined> {
	const metaPath = join(workspacePath, '.solution-metadata.json');
	try {
		const raw = await readFile(metaPath, 'utf-8');
		return JSON.parse(raw) as SolutionMetadata;
	} catch {
		return undefined;
	}
}

export async function loadWorkspaces(): Promise<LocalWorkspaceData[]> {
	// Gather running container local_folder labels
	const runningContainers = await docker.listContainers({ all: false });
	const runningPaths = new Set<string>();
	for (const c of runningContainers) {
		const localFolder = c.Labels?.['devcontainer.local_folder'];
		if (localFolder) runningPaths.add(localFolder);
	}

	let taskDirs: string[] = [];
	try {
		const entries = await readdir(WORKSPACE_ROOT, { withFileTypes: true });
		taskDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}

	const workspaces: LocalWorkspaceData[] = [];

	for (const taskName of taskDirs) {
		const taskPath = join(WORKSPACE_ROOT, taskName);
		let repoDirs: string[] = [];
		try {
			const entries = await readdir(taskPath, { withFileTypes: true });
			repoDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			continue;
		}

		const repos = [];
		for (const repoName of repoDirs) {
			const repoPath = join(taskPath, repoName);
			if (!existsSync(join(repoPath, '.git'))) continue;
			const devcontainerConfigs = await findDevcontainerConfigs(repoPath);
			const hasDevcontainer = devcontainerConfigs.length > 0;
			const isRunning = runningPaths.has(repoPath);
			const currentBranch = await readGitHead(repoPath);
			const currentTag = !currentBranch ? await readCurrentTag(repoPath) : undefined;
			repos.push({
				name: repoName,
				path: repoPath,
				hasDevcontainer,
				devcontainerConfigs,
				isRunning,
				currentBranch,
				currentTag
			});
		}

		if (repos.length === 0) continue;

		const solutionMetadata = await readSolutionMetadata(taskPath);

		workspaces.push({
			id: Buffer.from(taskPath).toString('base64'),
			name: taskName,
			path: taskPath,
			repos,
			solutionMetadata
		});
	}

	return workspaces;
}

/**
 * Returns workspaces from disk merged with any in-memory active bootstrap runs
 * and devcontainer builds. Use this in both SSR and the API route so that
 * ongoing builds are visible immediately after a page load or refresh.
 */
export async function loadMergedWorkspaces(): Promise<LocalWorkspaceData[]> {
	const [workspaces, runs, devcontainerBuilds] = await Promise.all([
		loadWorkspaces(),
		Promise.resolve(getActiveRuns()),
		Promise.resolve(getActiveBuilds())
	]);

	// Merge active bootstrap runs into the workspace list
	for (const run of runs) {
		const existing = workspaces.find((w) => w.path === run.workspacePath);
		const buildSession = { id: run.id, status: run.status, startedAt: run.startedAt };

		if (existing) {
			existing.buildSession = buildSession;
		} else {
			const placeholder: LocalWorkspaceData = {
				id: run.id,
				name: run.name,
				path: run.workspacePath,
				repos: [],
				buildSession
			};
			workspaces.push(placeholder);
		}
	}

	// Merge active devcontainer builds into the matching repo inside each workspace
	for (const build of devcontainerBuilds) {
		for (const ws of workspaces) {
			const repo = ws.repos.find((r) => r.path === build.repoPath);
			if (repo) {
				repo.buildSession = { id: build.id, status: build.status, startedAt: build.startedAt };
				break;
			}
		}
	}

	return workspaces;
}
