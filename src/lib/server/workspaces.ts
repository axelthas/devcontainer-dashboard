import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import docker from '$lib/server/docker';
import type { LocalWorkspaceData } from '$lib/types';

export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/bootstrap_workspaces';

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
			const hasDevcontainer = existsSync(join(repoPath, '.devcontainer'));
			const isRunning = runningPaths.has(repoPath);
			repos.push({ name: repoName, path: repoPath, hasDevcontainer, isRunning });
		}

		if (repos.length === 0) continue;

		workspaces.push({
			id: Buffer.from(taskPath).toString('base64'),
			name: taskName,
			path: taskPath,
			repos
		});
	}

	return workspaces;
}
