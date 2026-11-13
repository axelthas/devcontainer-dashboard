import { json, error, isHttpError } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { basename, relative } from 'node:path';
import docker from '$lib/server/docker';
import {
	DevcontainerBuildConflict,
	getActiveBuilds,
	startDevcontainerBuild
} from '$lib/server/devcontainerBuilds';
import {
	DevcontainerTargetError,
	resolveRebuildTarget
} from '$lib/server/devcontainerRebuild';
import type { RequestHandler } from './$types';

const ALLOWED_ACTIONS = ['start', 'stop', 'restart', 'delete', 'rebuild'] as const;
type Action = (typeof ALLOWED_ACTIONS)[number];
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';

/** Inspect live Docker labels and reject ambiguous replacement identity before starting the CLI. */
async function rebuildContainer(id: string) {
	let info;
	try {
		info = await docker.getContainer(id).inspect();
	} catch {
		throw error(404, 'Container is missing or cannot be inspected. Refresh the dashboard.');
	}
	const labels = info.Config?.Labels ?? {};
	try {
		const target = await resolveRebuildTarget(WORKSPACE_ROOT, labels);
		const identityLabels = {
			'devcontainer.local_folder': labels['devcontainer.local_folder'],
			'devcontainer.config_file': labels['devcontainer.config_file']
		};
		const matches = await docker.listContainers({
			all: true,
			filters: { label: Object.entries(identityLabels).map(([key, value]) => `${key}=${value}`) }
		});
		if (matches.length !== 1 || matches[0].Id !== info.Id) {
			throw error(409, 'Container identity changed or matches multiple containers. Refresh before rebuilding.');
		}
		const build = startDevcontainerBuild(
			randomUUID(),
			target.repoPath,
			basename(target.repoPath),
			relative(target.repoPath, target.configPath),
			identityLabels
		);
		return json(
			{ id: build.id, repoPath: build.repoPath, repoName: build.repoName },
			{ status: 202 }
		);
	} catch (cause) {
		if (cause instanceof DevcontainerTargetError) throw error(400, cause.message);
		if (cause instanceof DevcontainerBuildConflict) throw error(409, cause.message);
		if (isHttpError(cause)) throw cause;
		throw error(503, 'Could not start rebuild. Check Docker, Dev Containers CLI availability and terminal capacity.');
	}
}

/** Poll the tracked build, not the old container ID, which disappears during replacement. */
export const GET: RequestHandler = async ({ params, url }) => {
	if (params.action !== 'rebuild') throw error(405, 'Only rebuild supports status requests');
	const sessionId = url.searchParams.get('sessionId');
	const build = getActiveBuilds().find((entry) => entry.id === sessionId);
	if (!build) throw error(404, 'Build no longer tracked. Check the terminal and refresh.');
	return json(
		{ id: build.id, status: build.status, exitCode: build.exitCode, hasLog: build.hasLog },
		{ headers: { 'Cache-Control': 'no-store' } }
	);
};

export const POST: RequestHandler = async ({ params }) => {
	const { id, action } = params;

	if (!ALLOWED_ACTIONS.includes(action as Action)) {
		throw error(400, `Invalid action: ${action}`);
	}
	if (action === 'rebuild') return rebuildContainer(id);

	const container = docker.getContainer(id);

	try {
		if (action === 'start') {
			await container.start();
		} else if (action === 'stop') {
			await container.stop();
		} else if (action === 'restart') {
			await container.restart();
		} else if (action === 'delete') {
			await container.remove({ force: true, v: true });
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		throw error(500, message);
	}

	return json({ success: true });
};
