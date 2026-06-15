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

export function buildDevcontainerUri(localWorkspacePath: string, vscodeSshHost?: string): string {
	const basename = localWorkspacePath.split('/').filter(Boolean).at(-1) ?? '';
	const containerWorkspace = `/workspace/${basename}`;
	const target = `dev-container+${hexEncode(localWorkspacePath)}`;

	if (vscodeSshHost) {
		return `vscode://vscode-remote/${target}@ssh-remote+${vscodeSshHost}${containerWorkspace}?windowId=_blank`;
	}

	return `vscode://vscode-remote/${target}${containerWorkspace}?windowId=_blank`;
}

export function buildContainerVscodeUri(
	container: Pick<ContainerData, 'name' | 'state' | 'localWorkspacePath'>,
	vscodeSshHost?: string
): string {
	if (container.localWorkspacePath) {
		return buildDevcontainerUri(container.localWorkspacePath, vscodeSshHost);
	}

	if (container.state !== 'running') {
		return '';
	}

	return buildAttachedContainerUri(container.name, vscodeSshHost);
}