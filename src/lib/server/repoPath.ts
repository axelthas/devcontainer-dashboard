import { error } from '@sveltejs/kit';
import { WORKSPACE_ROOT } from '$lib/server/workspaces';

/**
 * Accept only a normalized path below WORKSPACE_ROOT for repository routes.
 * Throws a 400 HTTP error for any other value.
 */
export function validateRepoPath(path: unknown): string {
	if (typeof path !== 'string' || !path.startsWith(WORKSPACE_ROOT + '/')) {
		throw error(400, 'Invalid repository path');
	}
	const normalized = new URL('file://' + path).pathname;
	if (!normalized.startsWith(WORKSPACE_ROOT + '/')) {
		throw error(400, 'Invalid repository path');
	}
	return normalized;
}
