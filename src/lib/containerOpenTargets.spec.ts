/** Literal-argument regressions for the devcontainer Open with commands. */
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shellQuote } from '$lib/shell';
import {
	OPENCODE_LAUNCH_SCRIPT,
	OPENCODE_MISSING_MESSAGE,
	containerOpenCodeCommand,
	containerShellCommand
} from '$lib/containerOpenTargets';

/** Run a command with `docker` replaced by a printer, as the terminal server runs it (`bash -c`). */
function dockerArgv(command: string): string[] {
	return execFileSync('bash', ['-c', `docker() { printf '%s\\n' "$@"; }; ${command}`], {
		encoding: 'utf8'
	})
		.replace(/\n$/, '')
		.split('\n');
}

describe('shellQuote', () => {
	it.each(['plain', 'with space', "it's", '$HOME', '`id`', 'a;b|c&d>e', ''])(
		'keeps %j as one literal word',
		(value) => {
			expect(
				execFileSync('bash', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' })
			).toBe(value);
		}
	);
});

describe('devcontainer Open with commands', () => {
	it('keeps the existing container shell command', () => {
		expect(containerShellCommand({ name: '/fixture_1' })).toBe('docker exec -it fixture_1 bash');
	});

	it('does not guess the container folder from the host path', () => {
		expect(containerOpenCodeCommand({ name: '/fixture_1' })).toBeNull();
	});

	it('starts OpenCode in the labelled container folder with literal arguments', () => {
		const command = containerOpenCodeCommand({
			name: '/fixture_1',
			containerWorkspaceFolder: "/workspaces/it's $HOME; `id`"
		});
		expect(dockerArgv(command!)).toEqual([
			'exec',
			'-it',
			'-w',
			"/workspaces/it's $HOME; `id`",
			'fixture_1',
			'sh',
			'-lc',
			OPENCODE_LAUNCH_SCRIPT
		]);
	});

	it('explains a missing OpenCode executable and installs nothing', () => {
		const result = spawnSync('/bin/sh', ['-c', OPENCODE_LAUNCH_SCRIPT], {
			encoding: 'utf8',
			env: { PATH: '/nonexistent' }
		});
		expect(result.status).toBe(127);
		expect(result.stderr).toContain(OPENCODE_MISSING_MESSAGE);
	});
});
