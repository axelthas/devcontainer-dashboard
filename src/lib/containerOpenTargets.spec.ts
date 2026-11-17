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

const folder = "/workspaces/it's $HOME; `id`";

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
	it('opens a zsh login shell as the remote user in the workspace folder', () => {
		const command = containerShellCommand({
			name: '/fixture_1',
			remoteUser: 'vscode',
			containerWorkspaceFolder: folder
		});
		expect(dockerArgv(command!)).toEqual([
			'exec',
			'-it',
			'-u',
			'vscode',
			'-w',
			folder,
			'fixture_1',
			'zsh',
			'-l'
		]);
	});

	it('uses the container default user and folder when the metadata names neither', () => {
		expect(dockerArgv(containerShellCommand({ name: '/fixture_1' })!)).toEqual([
			'exec',
			'-it',
			'fixture_1',
			'zsh',
			'-l'
		]);
	});

	it('does not guess the container folder from the host path', () => {
		expect(containerOpenCodeCommand({ name: '/fixture_1', remoteUser: 'vscode' })).toBeNull();
	});

	it('starts OpenCode as the remote user in the labelled folder with literal arguments', () => {
		const command = containerOpenCodeCommand({
			name: '/fixture_1',
			remoteUser: '1000:1000',
			containerWorkspaceFolder: folder
		});
		expect(dockerArgv(command!)).toEqual([
			'exec',
			'-it',
			'-u',
			'1000:1000',
			'-w',
			folder,
			'fixture_1',
			'sh',
			'-lc',
			OPENCODE_LAUNCH_SCRIPT
		]);
	});

	it('runs nothing when the remote user cannot be resolved', () => {
		const container = {
			name: '/fixture_1',
			containerWorkspaceFolder: folder,
			remoteUserError: 'remoteUser "${localEnv:USER}" is not a plain user name'
		};
		expect(containerShellCommand(container)).toBeNull();
		expect(containerOpenCodeCommand(container)).toBeNull();
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
