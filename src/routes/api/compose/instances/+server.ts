/** List, create, and review instances of one validated Compose selection. Responses hold summaries only. */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import docker from '$lib/server/docker';
import { resolveComposeTarget, ComposeTargetError } from '$lib/server/composeSandbox';
import { listInstanceRecords } from '$lib/server/composeInstances';
import {
	createInstance,
	instanceHttpStatus,
	instanceSummary,
	kindActionState,
	reviewInstancePlan
} from '$lib/server/composeInstanceService';

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
			.map((item) => ({ ...instanceSummary(item), actions: kindActionState(item.project) }));
		return json({ instances }, { headers: { 'cache-control': 'no-store' } });
	} catch (cause) {
		if (cause instanceof ComposeTargetError) throw error(400, cause.message);
		throw error(503, 'Could not read instance reservations');
	}
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');
	const { repoPath, files, envFile, profiles, tag, operation, project } = body as Record<
		string,
		unknown
	>;
	if (operation !== 'create' && operation !== 'review') throw error(400, 'Unsupported operation');
	try {
		const target = await resolveComposeTarget(WORKSPACE_ROOT, {
			repoPath,
			files,
			envFile,
			profiles,
			tag
		});
		const result =
			operation === 'create'
				? await createInstance(docker as never, WORKSPACE_ROOT, target)
				: await reviewInstancePlan(docker as never, WORKSPACE_ROOT, target, String(project ?? ''));
		return json(result);
	} catch (cause) {
		const mapped = instanceHttpStatus(cause);
		throw error(mapped.status, mapped.message);
	}
};
