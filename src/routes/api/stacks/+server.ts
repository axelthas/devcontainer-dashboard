/**
 * GET  /api/stacks  — list all discovered Polaris instances
 * POST /api/stacks  — create (allocate + generate) a new Polaris instance
 * DELETE /api/stacks — not applicable at root
 *
 * POST body: { type: string, tag?: string, services?: string[] }
 */

import { json, error } from '@sveltejs/kit';
import { basename } from 'node:path';
import docker from '$lib/server/docker';
import {
	groupIntoInstances,
	createInstance,
	getAvailableSources,
	getAvailableTagsForSource,
	getServicesFromCompose,
	getDefaultServices,
	getPolarisType
} from '$lib/server/polaris-manager';
import type { ContainerData, PolarisType } from '$lib/types';
import type { RequestHandler } from './$types';

/** Reuse the same container-building logic but add compose labels. */
async function fetchContainersWithLabels(): Promise<ContainerData[]> {
	const raw = await docker.listContainers({ all: true });
	const result: ContainerData[] = [];

	for (const c of raw) {
		const ports: Record<string, string> = {};
		for (const p of c.Ports ?? []) {
			if (p.PublicPort && p.PrivatePort) {
				ports[String(p.PrivatePort)] = String(p.PublicPort);
			}
		}

		const rawName = c.Names?.[0] ?? c.Id;
		const image = c.Image ?? '';
		const labels = (c.Labels ?? {}) as Record<string, string>;
		const composeProject = labels['com.docker.compose.project'] ?? undefined;

		// Include containers with no exposed ports if they are polaris containers
		if (Object.keys(ports).length === 0 && !getPolarisType(rawName, composeProject, image))
			continue;

		result.push({
			id: c.Id.substring(0, 12),
			name: rawName,
			projectName: labels['devcontainer.local_folder']
				? basename(labels['devcontainer.local_folder'])
				: rawName.replace(/^\//, ''),
			state: c.State ?? 'unknown',
			isDevcontainer: false,
			ports,
			image,
			localWorkspacePath: labels['devcontainer.local_folder'] ?? undefined,
			composeProject,
			composeWorkingDir: labels['com.docker.compose.project.working_dir'] ?? undefined,
			composeConfigFiles: labels['com.docker.compose.project.config_files'] ?? undefined,
			ipAddress:
				Object.values(c.NetworkSettings?.Networks ?? {}).find((n) => n.IPAddress)?.IPAddress ||
				undefined
		});
	}

	return result;
}

export const GET: RequestHandler = async () => {
	const containers = await fetchContainersWithLabels();
	const instances = groupIntoInstances(containers);
	const sources = getAvailableSources();
	// Fetch available Docker image tags for each source type in parallel
	const availableSources = await Promise.all(
		Object.keys(sources).map(async (type) => ({
			type,
			tags: await getAvailableTagsForSource(type as PolarisType),
			allServices: getServicesFromCompose(type as PolarisType),
			defaultServices: getDefaultServices(type as PolarisType)
		}))
	);
	return json({ instances, availableSources });
};

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const { type, tag, services } = body as { type?: string; tag?: string; services?: string[] };
	const availableTypes = Object.keys(getAvailableSources());
	if (!type || !availableTypes.includes(type)) {
		throw error(400, `Invalid type. Must be one of: ${availableTypes.join(', ')}`);
	}

	try {
		const entry = await createInstance(
			type as PolarisType,
			tag || undefined,
			services?.length ? services : undefined
		);
		return json(entry, { status: 201 });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw error(500, msg);
	}
};
