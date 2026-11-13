/** Validate devcontainer targets and construct literal CLI arguments before any replacement. */
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class DevcontainerTargetError extends Error {
	/** Keep expected validation failures separate from CLI and Docker failures. */
	constructor(message: string) {
		super(message);
		this.name = 'DevcontainerTargetError';
	}
}

export interface DevcontainerTarget {
	repoPath: string;
	configPath: string;
	canonicalRepoPath: string;
}

/** Require a strict descendant, not a prefix collision or the root itself. */
function isWithin(root: string, path: string): boolean {
	const child = relative(root, path);
	return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Check both lexical and real paths; retain label paths for the Docker-host CLI identity. */
export async function resolveDevcontainerTarget(
	workspaceRoot: string,
	repoPath: string,
	configPath: string
): Promise<DevcontainerTarget> {
	if (!isAbsolute(repoPath) || !isAbsolute(configPath) || /[\0\r\n]/.test(repoPath + configPath)) {
		throw new DevcontainerTargetError('Workspace and configuration must be absolute local paths');
	}
	const root = resolve(workspaceRoot);
	const repo = resolve(repoPath);
	const config = resolve(configPath);
	if (!isWithin(root, repo) || !isWithin(repo, config)) {
		throw new DevcontainerTargetError('Workspace and configuration must be inside the workspace root');
	}
	try {
		const [realRoot, realRepo, realConfig, repoInfo, configInfo] = await Promise.all([
			realpath(root),
			realpath(repo),
			realpath(config),
			stat(repo),
			stat(config)
		]);
		if (!repoInfo.isDirectory() || !configInfo.isFile()) {
			throw new DevcontainerTargetError('Workspace must be a directory and configuration must be a file');
		}
		if (!isWithin(realRoot, realRepo) || !isWithin(realRepo, realConfig)) {
			throw new DevcontainerTargetError('Workspace or configuration symlink escapes its allowed root');
		}
		return { repoPath: repo, configPath: config, canonicalRepoPath: realRepo };
	} catch (cause) {
		if (cause instanceof DevcontainerTargetError) throw cause;
		throw new DevcontainerTargetError('Workspace or configuration is missing or inaccessible');
	}
}

/** Refuse to infer a configuration for an existing container, especially in multi-config repos. */
export async function resolveRebuildTarget(
	workspaceRoot: string,
	labels: Record<string, string>
): Promise<DevcontainerTarget> {
	const repo = labels['devcontainer.local_folder'];
	const config = labels['devcontainer.config_file'];
	if (!repo || !config) {
		throw new DevcontainerTargetError(
			'Rebuild requires devcontainer.local_folder and devcontainer.config_file labels'
		);
	}
	return resolveDevcontainerTarget(workspaceRoot, repo, config);
}

/** Use argv, not bash interpolation. Normal starts retain cache and do not replace containers. */
export function devcontainerCommand(
	repoPath: string,
	configPath?: string,
	rebuildLabels?: Record<string, string>
): { file: string; args: string[] } {
	const args = ['up', '--workspace-folder', repoPath];
	if (configPath) args.push('--config', resolve(repoPath, configPath));
	if (rebuildLabels) {
		const folder = rebuildLabels['devcontainer.local_folder'];
		const config = rebuildLabels['devcontainer.config_file'];
		if (!folder || !config || !configPath) {
			throw new DevcontainerTargetError('Rebuild requires an exact workspace and configuration');
		}
		args.push(
			'--id-label',
			`devcontainer.local_folder=${folder}`,
			'--id-label',
			`devcontainer.config_file=${config}`,
			'--remove-existing-container'
		);
	}
	return { file: 'devcontainer', args };
}
