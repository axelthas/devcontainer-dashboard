import type { ContainerData } from '$lib/types';

function hexEncode(value: string): string {
	return Array.from(new TextEncoder().encode(value))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function normalizeContainerName(name: string): string {
	return name.startsWith('/') ? name : `/${name}`;
}

export function buildAttachedContainerUri(containerName: string, vscodeSshHost?: string): string {
	const config = JSON.stringify({ containerName: normalizeContainerName(containerName) });
	const target = `attached-container+${hexEncode(config)}`;

	if (vscodeSshHost) {
		return `vscode://vscode-remote/${target}@ssh-remote+${vscodeSshHost}?windowId=_blank`;
	}

	return `vscode://vscode-remote/${target}?windowId=_blank`;
}

/**
 * Locations the Dev Containers extension probes when the authority carries no
 * explicit config file. Anything else has to be named in the authority payload.
 */
function isWellKnownConfigFile(localWorkspacePath: string, configFile: string): boolean {
	return (
		configFile === `${localWorkspacePath}/.devcontainer/devcontainer.json` ||
		configFile === `${localWorkspacePath}/.devcontainer.json`
	);
}

function toFileUriString(path: string): string {
	return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Mirrors the authority payload VS Code itself writes: a marshalled URI (`$mid: 1`)
 * pointing at the exact devcontainer.json.
 */
function buildAuthorityPayload(
	localWorkspacePath: string,
	configFile: string,
	vscodeSshHost?: string
): string {
	// Over SSH the config lives on the Docker host; a `file` URI makes VS Code copy it from the client.
	if (vscodeSshHost) {
		return JSON.stringify({
			hostPath: localWorkspacePath,
			localDocker: false,
			configFile: {
				$mid: 1,
				path: configFile,
				scheme: 'vscode-fileHost'
			}
		});
	}

	return JSON.stringify({
		hostPath: localWorkspacePath,
		configFile: {
			$mid: 1,
			fsPath: configFile,
			external: toFileUriString(configFile),
			path: configFile,
			scheme: 'file'
		}
	});
}

export interface DevcontainerUriOptions {
	vscodeSshHost?: string;
	/** Absolute host path of the devcontainer.json the container was built from */
	configFile?: string;
	/** Path the workspace is mounted at inside the container */
	containerWorkspaceFolder?: string;
}

export function buildDevcontainerUri(
	localWorkspacePath: string,
	options: DevcontainerUriOptions = {}
): string {
	const { vscodeSshHost, configFile, containerWorkspaceFolder } = options;

	const basename = localWorkspacePath.split('/').filter(Boolean).at(-1) ?? '';
	const containerWorkspace = containerWorkspaceFolder ?? `/workspace/${basename}`;

	const payload =
		configFile && !isWellKnownConfigFile(localWorkspacePath, configFile)
			? buildAuthorityPayload(localWorkspacePath, configFile, vscodeSshHost)
			: localWorkspacePath;
	const target = `dev-container+${hexEncode(payload)}`;

	if (vscodeSshHost) {
		return `vscode://vscode-remote/${target}@ssh-remote+${vscodeSshHost}${containerWorkspace}?windowId=_blank`;
	}

	return `vscode://vscode-remote/${target}${containerWorkspace}?windowId=_blank`;
}

export function buildContainerVscodeUri(
	container: Pick<
		ContainerData,
		'name' | 'state' | 'localWorkspacePath' | 'devcontainerConfigFile' | 'containerWorkspaceFolder'
	>,
	vscodeSshHost?: string
): string {
	if (container.localWorkspacePath) {
		return buildDevcontainerUri(container.localWorkspacePath, {
			vscodeSshHost,
			configFile: container.devcontainerConfigFile,
			containerWorkspaceFolder: container.containerWorkspaceFolder
		});
	}

	if (container.state !== 'running') {
		return '';
	}

	return buildAttachedContainerUri(container.name, vscodeSshHost);
}
