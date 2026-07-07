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
});

describe('buildContainerVscodeUri', () => {
	it('returns an empty string for stopped containers without a workspace path', () => {
		expect(
			buildContainerVscodeUri({
				name: '/sandbox-demo',
				state: 'exited',
				localWorkspacePath: undefined
			})
		).toBe('');
	});
});
