/**
 * Commands for the devcontainer "Open with" menu. They run inside a running container.
 * The terminal server runs each command with `bash -c`, so every variable value is quoted
 * as one literal word.
 */
import type { ContainerData } from '$lib/types';
import { shellQuote } from '$lib/shell';

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

/** Shell in the container. This is the existing dashboard terminal command, unchanged. */
export function containerShellCommand(container: Pick<ContainerData, 'name'>): string {
	return `docker exec -it ${bareContainerName(container)} bash`;
}

/**
 * OpenCode TUI in the container's workspace folder, from the container's own label.
 * Returns null when the folder is unknown: the dashboard does not guess a container path
 * from the host path.
 */
export function containerOpenCodeCommand(
	container: Pick<ContainerData, 'name' | 'containerWorkspaceFolder'>
): string | null {
	const folder = container.containerWorkspaceFolder;
	if (!folder) return null;
	return [
		'docker',
		'exec',
		'-it',
		'-w',
		shellQuote(folder),
		shellQuote(bareContainerName(container)),
		'sh',
		'-lc',
		shellQuote(OPENCODE_LAUNCH_SCRIPT)
	].join(' ');
}
