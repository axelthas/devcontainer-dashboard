/** List reservations for a validated Compose selection without exposing instance records. */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveComposeTarget, ComposeTargetError } from '$lib/server/composeSandbox';
import { listInstanceRecords } from '$lib/server/composeInstances';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

/** File order, profiles and environment file identify the system; version can change. */
function sameSelection(
	a: { files: string[]; profiles: string[]; envFile?: string },
	b: { files: string[]; profiles: string[]; envFile?: string }
): boolean {
	return (
		JSON.stringify([a.files, a.profiles, a.envFile ?? '']) ===
		JSON.stringify([b.files, b.profiles, b.envFile ?? ''])
	);
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const target = await resolveComposeTarget(WORKSPACE_ROOT, {
			repoPath: url.searchParams.get('repoPath') ?? undefined,
			files: url.searchParams.getAll('file'),
			envFile: url.searchParams.get('envFile') ?? undefined,
			profiles: url.searchParams.getAll('profile')
		});
		const all = await listInstanceRecords(WORKSPACE_ROOT);
		const instances = all
			.filter(
				(item) =>
					item.canonicalRepoPath === target.canonicalRepoPath &&
					sameSelection(item.selection, target.selection)
			)
			.map(({ project, slot, state, subnets, createdAt }) => ({
				project,
				slot,
				state,
				subnets,
				createdAt
			}));
		return json({ instances }, { headers: { 'cache-control': 'no-store' } });
	} catch (cause) {
		if (cause instanceof ComposeTargetError) throw error(400, cause.message);
		throw error(503, 'Could not read instance reservations');
	}
};
