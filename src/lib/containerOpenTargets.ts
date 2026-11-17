/**
 * Commands for the devcontainer "Open with" menu. They run inside a running container as
 * its remote user, in its workspace folder. The terminal server runs each command with
 * `bash -c`, so every variable value is quoted as one literal word.
 */
import type { ContainerData } from '$lib/types';
import { shellQuote } from '$lib/shell';

/** Container fields that the commands use. */
export type CommandTarget = Pick<
	ContainerData,
	'name' | 'containerWorkspaceFolder' | 'remoteUser' | 'remoteUserError'
>;

/** Shown in the terminal when the container has no `opencode` executable. */
export const OPENCODE_MISSING_MESSAGE = 'OpenCode is not installed in this container.';

/**
 * Script that runs inside the container. It explains a missing executable and does not
 * install anything. A login shell loads the user's PATH, for example `~/.opencode/bin`.
 */
export const OPENCODE_LAUNCH_SCRIPT = `command -v opencode >/dev/null 2>&1 || { echo ${shellQuote(OPENCODE_MISSING_MESSAGE)} >&2; exit 127; }; exec opencode`;

/** Docker reports names with a leading slash; `docker exec` takes the bare name. */
export function bareContainerName(container: Pick<ContainerData, 'name'>): string {
	return container.name.replace(/^\//, '');
}

/**
 * `docker exec` prefix for the remote user and the workspace folder. Without a remote
 * user in the metadata, the container's default user applies, as in VS Code.
 */
function execPrefix(container: CommandTarget): string[] {
	const parts = ['docker', 'exec', '-it'];
	if (container.remoteUser) parts.push('-u', shellQuote(container.remoteUser));
	if (container.containerWorkspaceFolder)
		parts.push('-w', shellQuote(container.containerWorkspaceFolder));
	parts.push(shellQuote(bareContainerName(container)));
	return parts;
}

/** Why the Terminal action cannot run, or null when it can. */
export function containerShellBlocker(container: CommandTarget): string | null {
	return container.remoteUserError ? `Unavailable: ${container.remoteUserError}` : null;
}

/** Why the OpenCode TUI action cannot run, or null when it can. */
export function containerOpenCodeBlocker(container: CommandTarget): string | null {
	if (container.remoteUserError) return `Unavailable: ${container.remoteUserError}`;
	if (!container.containerWorkspaceFolder)
		return 'Unavailable: the container workspace folder is unknown';
	return null;
}

/** Login shell as the remote user in the workspace folder, or null when blocked. */
export function containerShellCommand(container: CommandTarget): string | null {
	if (containerShellBlocker(container)) return null;
	return [...execPrefix(container), 'bash', '-l'].join(' ');
}

/**
 * OpenCode TUI as the remote user in the workspace folder, or null when blocked.
 * The dashboard does not guess a container path from the host path.
 */
export function containerOpenCodeCommand(container: CommandTarget): string | null {
	if (containerOpenCodeBlocker(container)) return null;
	return [...execPrefix(container), 'sh', '-lc', shellQuote(OPENCODE_LAUNCH_SCRIPT)].join(' ');
}
