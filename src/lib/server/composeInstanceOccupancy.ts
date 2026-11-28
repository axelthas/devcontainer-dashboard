/** Collect every relevant Docker resource before reserving an instance slot. */
import { isIP } from 'node:net';
import { ipv4Range } from './composeInstanceAddresses.js';
import type { DockerOccupancy } from './composeInstances.js';
import { InstanceStoreError } from './composeInstances.js';

interface DockerApi {
	listNetworks(): Promise<unknown>;
	listContainers(options: { all: true }): Promise<unknown>;
	listVolumes(): Promise<unknown>;
}

/** Narrow daemon responses and fail closed on malformed network or volume data. */
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new InstanceStoreError('Docker resource snapshot is incomplete');
	return value as Record<string, unknown>;
}

/** Collect a fresh complete snapshot; a daemon error blocks allocation. */
export async function collectInstanceOccupancy(docker: DockerApi): Promise<DockerOccupancy> {
	const [networks, containers, volumeResponse] = await Promise.all([
		docker.listNetworks(),
		docker.listContainers({ all: true }),
		docker.listVolumes()
	]);
	const volumes = object(volumeResponse).Volumes;
	if (
		!Array.isArray(networks) ||
		!Array.isArray(containers) ||
		(volumes !== null && !Array.isArray(volumes))
	)
		throw new InstanceStoreError('Docker resource snapshot is incomplete');
	const subnets: string[] = [];
	const projects = new Set<string>();
	for (const item of networks) {
		const network = object(item);
		const ipam = object(network.IPAM);
		if (ipam.Config !== null && !Array.isArray(ipam.Config))
			throw new InstanceStoreError('Docker network IPAM is incomplete');
		for (const item of ipam.Config ?? []) {
			const subnet = object(item).Subnet;
			if (typeof subnet !== 'string')
				throw new InstanceStoreError('Docker network IPAM is incomplete');
			if (isIP(subnet.split('/')[0]) === 6) continue;
			if (!ipv4Range(subnet)) throw new InstanceStoreError('Docker network IPAM is incomplete');
			subnets.push(subnet);
		}
		const labels =
			network.Labels === null || network.Labels === undefined ? {} : object(network.Labels);
		if (typeof labels['com.docker.compose.project'] === 'string')
			projects.add(labels['com.docker.compose.project']);
	}
	for (const item of containers) {
		const container = object(item);
		const labels =
			container.Labels === null || container.Labels === undefined ? {} : object(container.Labels);
		if (typeof labels['com.docker.compose.project'] === 'string')
			projects.add(labels['com.docker.compose.project']);
	}
	const volumeNames = (volumes ?? []).map((item: unknown) => {
		const name = object(item).Name;
		if (typeof name !== 'string' || !name)
			throw new InstanceStoreError('Docker volume listing is incomplete');
		return name;
	});
	return { subnets, projects: [...projects], volumeNames };
}
