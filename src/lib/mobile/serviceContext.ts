/**
 * Where a plain Docker service container comes from, for the phone service screen.
 * The Compose project folder links the container to the repository sandbox that runs it.
 */
import type { LocalWorkspaceData, RepositoryData } from '$lib/types';

/** The workspace and repository whose Compose sandbox owns a container. */
export interface SandboxOwner {
	workspace: LocalWorkspaceData;
	repo: RepositoryData;
}

/** Remove trailing slashes and keep the root as `/`. */
function trimSlashes(path: string): string {
	return path.replace(/\/+$/, '') || '/';
}

/** Folder of a repository-relative Compose file; empty for a file at the repository root. */
function folderOf(file: string): string {
	const index = file.lastIndexOf('/');
	return index < 0 ? '' : file.slice(0, index);
}

/** Absolute host folders that a repository's Compose sandbox can use as its project folder. */
function sandboxFolders(repo: RepositoryData): string[] {
	const root = trimSlashes(repo.path);
	return (repo.composeFiles ?? []).map((file) => {
		const folder = folderOf(file);
		return folder ? `${root}/${folder}` : root;
	});
}

/**
 * The repository whose Compose sandbox runs in `workingDir`. The folder must be the
 * repository folder or the folder of one of its Compose files. A deeper or unrelated
 * folder gives no match, so the screen never links a guessed repository.
 */
export function sandboxOwner(
	workspaces: LocalWorkspaceData[],
	workingDir: string | undefined
): SandboxOwner | undefined {
	if (!workingDir) return undefined;
	const target = trimSlashes(workingDir);
	for (const workspace of workspaces) {
		for (const repo of workspace.repos) {
			if (sandboxFolders(repo).includes(target)) return { workspace, repo };
		}
	}
	return undefined;
}
