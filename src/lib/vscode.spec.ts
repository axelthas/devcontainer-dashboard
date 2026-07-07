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
 * Each builder supports an optional `vscodeSshHost` parameter that appends
 * `@ssh-remote+<host>` to the URI target for remote SSH connections.
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

describe('buildDevcontainerUri', () => {
	it('builds a local devcontainer URI when a workspace path is present', () => {
		expect(buildDevcontainerUri('/workspaces/task/repo')).toBe(
			'vscode://vscode-remote/dev-container+2f776f726b7370616365732f7461736b2f7265706f/workspace/repo?windowId=_blank'
		);
	});

	it('builds an SSH devcontainer URI when a workspace path is present', () => {
		expect(buildDevcontainerUri('/workspaces/task/repo', 'devbox')).toBe(
			'vscode://vscode-remote/dev-container+2f776f726b7370616365732f7461736b2f7265706f@ssh-remote+devbox/workspace/repo?windowId=_blank'
		);
	});

	it('extracts the last path segment as the container workspace folder', () => {
		// Given /workspaces/myproject, the container workspace is /workspace/myproject
		expect(buildDevcontainerUri('/workspaces/myproject')).toContain('/workspace/myproject?');
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
});
