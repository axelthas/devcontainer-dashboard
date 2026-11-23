import { describe, expect, it } from 'vitest';
import type { LocalWorkspaceData, RepositoryData } from '$lib/types';
import { sandboxOwner } from './serviceContext';
import { serviceLogsCommand, serviceShellCommand } from '$lib/containerOpenTargets';

/** A repository with only the fields that the match reads. */
function repo(path: string, composeFiles?: string[]): RepositoryData {
	return {
		name: path.split('/').pop() ?? path,
		path,
		hasDevcontainer: false,
		devcontainerConfigs: [],
		isRunning: false,
		composeFiles
	};
}

const ice = repo('/workspaces/git.polaris-ice/polaris-ice', ['docker-compose.yml']);
const nested = repo('/workspaces/git.polaris-ice/polaris-tools', ['sandbox/compose.yaml']);
const plain = repo('/workspaces/git.polaris-ice/polaris-backend');
const workspaces = [
	{ id: 'aWNl', name: 'git.polaris-ice', repos: [plain, ice, nested] }
] as unknown as LocalWorkspaceData[];

describe('sandboxOwner', () => {
	it('matches the repository folder of a root Compose file', () => {
		expect(sandboxOwner(workspaces, '/workspaces/git.polaris-ice/polaris-ice')?.repo).toBe(ice);
		expect(sandboxOwner(workspaces, '/workspaces/git.polaris-ice/polaris-ice/')?.repo).toBe(ice);
	});

	it('matches the folder of a Compose file one directory deep', () => {
		expect(
			sandboxOwner(workspaces, '/workspaces/git.polaris-ice/polaris-tools/sandbox')?.repo
		).toBe(nested);
		expect(sandboxOwner(workspaces, '/workspaces/git.polaris-ice/polaris-tools')).toBeUndefined();
	});

	it('never guesses from a prefix, a repository without Compose files, or no folder', () => {
		expect(
			sandboxOwner(workspaces, '/workspaces/git.polaris-ice/polaris-ice/deep')
		).toBeUndefined();
		expect(sandboxOwner(workspaces, '/workspaces/git.polaris-ice/polaris-backend')).toBeUndefined();
		expect(sandboxOwner(workspaces, '/workspaces/git.polaris-ice/polaris-ic')).toBeUndefined();
		expect(sandboxOwner(workspaces, undefined)).toBeUndefined();
	});
});

describe('service commands', () => {
	it('keeps the desktop shell command for plain Docker containers', () => {
		expect(serviceShellCommand({ name: '/polaris-ice-stm-a' })).toBe(
			'docker exec -it polaris-ice-stm-a bash || docker exec -it polaris-ice-stm-a sh'
		);
	});

	it('follows the logs of the bare container name', () => {
		expect(serviceLogsCommand({ name: '/polaris-ice-stm-a' })).toBe(
			"docker logs --follow --tail 200 'polaris-ice-stm-a'"
		);
	});
});
