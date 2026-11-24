import { basename } from 'node:path';
import docker from '$lib/server/docker';
import { findHarnessEndpoints } from '$lib/harness';
import {
	getAvailableSources,
	getAvailableTagsForSource,
	getDefaultServices,
	getPolarisType,
	getServicesFromCompose,
	groupIntoInstances
} from '$lib/server/polaris-manager';
import type { ContainerData, PolarisInstance, PolarisType } from '$lib/types';

export interface PolarisSource {
	type: string;
	tags: string[];
	allServices: string[];
	defaultServices: string[];
}

async function listPolarisContainers(): Promise<ContainerData[]> {
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

		const ipAddress =
			Object.values(c.NetworkSettings?.Networks ?? {}).find((n) => n.IPAddress)?.IPAddress ||
			undefined;

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
			ipAddress,
			harnesses: findHarnessEndpoints(c.Ports, ipAddress)
		});
	}

	return result;
}

export async function listPolarisInstances(): Promise<PolarisInstance[]> {
	return groupIntoInstances(await listPolarisContainers());
}

export async function listPolarisSources(): Promise<PolarisSource[]> {
	// Fetch available Docker image tags for each source type in parallel
	return Promise.all(
		Object.keys(getAvailableSources()).map(async (type) => ({
			type,
			tags: await getAvailableTagsForSource(type as PolarisType),
			allServices: getServicesFromCompose(type as PolarisType),
			defaultServices: getDefaultServices(type as PolarisType)
		}))
	);
}
