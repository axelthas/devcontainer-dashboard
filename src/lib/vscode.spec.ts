/**
 * Tests for VS Code remote URI builders.
 *
 * These functions generate `vscode://vscode-remote/...` URIs that open containers
 * in VS Code, either via the "attached-container" scheme (for standalone/sandbox
 * containers) or the "dev-container" scheme (for devcontainers with a workspace).
 *
 * The hex-encoded portions in expected URIs are the JSON-encoded container config
 * or workspace path, e.g. {"containerName":"/sandbox-demo"} → hex.
 *
 * The dev-container authority carries either the bare host workspace path or, when
 * the container was built from a non-default devcontainer.json, a JSON payload
 * naming that config file — VS Code otherwise only probes .devcontainer/devcontainer.json
 * and .devcontainer.json.
 *
 * Both builders accept an optional SSH host that appends `@ssh-remote+<host>` to
 * the URI target for remote SSH connections.
 */
import { describe, expect, it } from 'vitest';
import { buildAttachedContainerUri, buildContainerVscodeUri, buildDevcontainerUri } from './vscode';

describe('buildAttachedContainerUri', () => {
	it('builds a local attached-container URI for running sandbox containers', () => {
		expect(buildAttachedContainerUri('/sandbox-demo')).toBe(
			'vscode://vscode-remote/attached-container+7b22636f6e7461696e65724e616d65223a222f73616e64626f782d64656d6f227d?windowId=_blank'
		);
	});

	it('builds an SSH attached-container URI for running sandbox containers', () => {
		expect(buildAttachedContainerUri('/sandbox-demo', 'devbox')).toBe(
			'vscode://vscode-remote/attached-container+7b22636f6e7461696e65724e616d65223a222f73616e64626f782d64656d6f227d@ssh-remote+devbox?windowId=_blank'
		);
	});

	it('normalizes container names without a leading slash', () => {
		// Container names from Docker may or may not have a leading slash;
		// the builder always prepends one for consistency.
		expect(buildAttachedContainerUri('sandbox-demo')).toBe(
			'vscode://vscode-remote/attached-container+7b22636f6e7461696e65724e616d65223a222f73616e64626f782d64656d6f227d?windowId=_blank'
		);
	});
});

function decodeAuthority(uri: string): string {
	const hex = /dev-container\+([0-9a-f]+)/.exec(uri)?.[1] ?? '';
	const bytes = new Uint8Array(hex.match(/../g)?.map((byte) => parseInt(byte, 16)) ?? []);
	return new TextDecoder().decode(bytes);
}

describe('buildDevcontainerUri', () => {
	it('builds a local devcontainer URI when a workspace path is present', () => {
		expect(buildDevcontainerUri('/workspaces/task/repo')).toBe(
			'vscode://vscode-remote/dev-container+2f776f726b7370616365732f7461736b2f7265706f/workspace/repo?windowId=_blank'
		);
	});

	it('builds an SSH devcontainer URI when a workspace path is present', () => {
		expect(buildDevcontainerUri('/workspaces/task/repo', { vscodeSshHost: 'devbox' })).toBe(
			'vscode://vscode-remote/dev-container+2f776f726b7370616365732f7461736b2f7265706f@ssh-remote+devbox/workspace/repo?windowId=_blank'
		);
	});

	it('extracts the last path segment as the container workspace folder', () => {
		// Given /workspaces/myproject, the container workspace is /workspace/myproject
		expect(buildDevcontainerUri('/workspaces/myproject')).toContain('/workspace/myproject?');
	});

	it('uses the container workspace folder when known', () => {
		expect(
			buildDevcontainerUri('/workspaces/task/repo', {
				containerWorkspaceFolder: '/workspaces/task/repo'
			})
		).toContain('/workspaces/task/repo?windowId=_blank');
	});

	it('keeps the bare path authority for well-known config file locations', () => {
		// VS Code probes these two paths itself, so naming them adds nothing.
		const bare = buildDevcontainerUri('/workspaces/task/repo');
		expect(
			buildDevcontainerUri('/workspaces/task/repo', {
				configFile: '/workspaces/task/repo/.devcontainer/devcontainer.json'
			})
		).toBe(bare);
		expect(
			buildDevcontainerUri('/workspaces/task/repo', {
				configFile: '/workspaces/task/repo/.devcontainer.json'
			})
		).toBe(bare);
	});

	it('encodes the config file in the authority for sub-folder configs', () => {
		// VS Code only probes .devcontainer/devcontainer.json and .devcontainer.json,
		// so a named sub-config must travel in the authority payload.
		const uri = buildDevcontainerUri('/workspaces/task/repo', {
			configFile: '/workspaces/task/repo/.devcontainer/rocky8/devcontainer.json'
		});

		expect(JSON.parse(decodeAuthority(uri))).toEqual({
			hostPath: '/workspaces/task/repo',
			configFile: {
				$mid: 1,
				fsPath: '/workspaces/task/repo/.devcontainer/rocky8/devcontainer.json',
				external: 'file:///workspaces/task/repo/.devcontainer/rocky8/devcontainer.json',
				path: '/workspaces/task/repo/.devcontainer/rocky8/devcontainer.json',
				scheme: 'file'
			}
		});
	});

	it('keeps the SSH host outside the authority payload', () => {
		const uri = buildDevcontainerUri('/workspaces/task/repo', {
			vscodeSshHost: 'devbox',
			configFile: '/workspaces/task/repo/.devcontainer/rocky8/devcontainer.json',
			containerWorkspaceFolder: '/workspace/repo'
		});

		expect(uri).toContain('@ssh-remote+devbox/workspace/repo?windowId=_blank');
		expect(JSON.parse(decodeAuthority(uri)).hostPath).toBe('/workspaces/task/repo');
	});
});

describe('buildContainerVscodeUri', () => {
	it('returns an empty string for stopped containers without a workspace path', () => {
		// Stopped sandbox containers cannot be attached to — no URI is generated
		expect(
			buildContainerVscodeUri({
				name: '/sandbox-demo',
				state: 'exited',
				localWorkspacePath: undefined
			})
		).toBe('');
	});

	it('returns an attached-container URI for running containers without a workspace', () => {
		// Running sandbox containers use the attached-container scheme
		const uri = buildContainerVscodeUri({
			name: '/sandbox-demo',
			state: 'running',
			localWorkspacePath: undefined
		});
		expect(uri).toContain('vscode://vscode-remote/attached-container+');
		expect(uri).toContain('?windowId=_blank');
	});

	it('returns a devcontainer URI when a workspace path is present regardless of state', () => {
		// Devcontainers are identified by having a localWorkspacePath — the container
		// state does not matter because VS Code can start a stopped devcontainer.
		const uri = buildContainerVscodeUri({
			name: '/my-devcontainer',
			state: 'exited',
			localWorkspacePath: '/workspaces/task/repo'
		});
		expect(uri).toContain('vscode://vscode-remote/dev-container+');
		expect(uri).toContain('/workspace/repo?windowId=_blank');
	});

	it('returns a devcontainer URI with SSH host when configured', () => {
		const uri = buildContainerVscodeUri(
			{
				name: '/my-devcontainer',
				state: 'running',
				localWorkspacePath: '/workspaces/task/repo'
			},
			'devbox'
		);
		expect(uri).toContain('@ssh-remote+devbox');
		expect(uri).toContain('/workspace/repo?windowId=_blank');
	});

	it('returns an attached-container URI with SSH host for running sandbox', () => {
		const uri = buildContainerVscodeUri(
			{
				name: '/sandbox-demo',
				state: 'running',
				localWorkspacePath: undefined
			},
			'devbox'
		);
		expect(uri).toContain('attached-container+');
		expect(uri).toContain('@ssh-remote+devbox');
	});

	it('forwards the config file and container workspace folder', () => {
		const uri = buildContainerVscodeUri({
			name: '/my-devcontainer',
			state: 'running',
			localWorkspacePath: '/workspaces/task/repo',
			devcontainerConfigFile: '/workspaces/task/repo/.devcontainer/rocky8/devcontainer.json',
			containerWorkspaceFolder: '/workspace/repo'
		});

		expect(JSON.parse(decodeAuthority(uri)).configFile.path).toBe(
			'/workspaces/task/repo/.devcontainer/rocky8/devcontainer.json'
		);
		expect(uri).toContain('/workspace/repo?windowId=_blank');
	});
});
