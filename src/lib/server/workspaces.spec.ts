import { describe, expect, it } from 'vitest';
import { resolveContainerWorkspaceFolder } from './workspaces';

describe('resolveContainerWorkspaceFolder', () => {
	it('maps a workspace that is bind-mounted directly', () => {
		expect(
			resolveContainerWorkspaceFolder(
				[
					{
						Type: 'bind',
						Source: '/home/axel/git.workspaces',
						Destination: '/home/axel/git.workspaces'
					},
					{
						Type: 'bind',
						Source: '/home/axel/git.workspaces/task/repo',
						Destination: '/home/axel/git.workspaces/task/repo'
					}
				],
				'/home/axel/git.workspaces/task/repo'
			)
		).toBe('/home/axel/git.workspaces/task/repo');
	});

	it('maps a workspace inherited from a mounted ancestor directory', () => {
		expect(
			resolveContainerWorkspaceFolder(
				[
					{ Type: 'bind', Source: '/tmp/.X11-unix', Destination: '/tmp/.X11-unix' },
					{ Type: 'bind', Source: '/home/axel/git.workspaces/task', Destination: '/workspace' }
				],
				'/home/axel/git.workspaces/task/repo'
			)
		).toBe('/workspace/repo');
	});

	it('prefers the longest matching mount', () => {
		expect(
			resolveContainerWorkspaceFolder(
				[
					{ Type: 'bind', Source: '/home/axel', Destination: '/host-home' },
					{ Type: 'bind', Source: '/home/axel/task', Destination: '/workspace' }
				],
				'/home/axel/task/repo'
			)
		).toBe('/workspace/repo');
	});

	it('ignores volumes and unrelated mounts', () => {
		expect(
			resolveContainerWorkspaceFolder(
				[
					{ Type: 'volume', Source: '/var/lib/docker/volumes/x/_data', Destination: '/vscode' },
					{ Type: 'bind', Source: '/home/axel/other', Destination: '/workspace' }
				],
				'/home/axel/task/repo'
			)
		).toBeUndefined();
	});

	it('does not match on partial path segments', () => {
		expect(
			resolveContainerWorkspaceFolder(
				[{ Type: 'bind', Source: '/home/axel/task', Destination: '/workspace' }],
				'/home/axel/task-other/repo'
			)
		).toBeUndefined();
	});

	it('returns undefined when there are no mounts', () => {
		expect(resolveContainerWorkspaceFolder(undefined, '/home/axel/task/repo')).toBeUndefined();
	});
});
