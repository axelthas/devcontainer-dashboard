/**
 * Turn Docker API listings into dashboard network data. Pure functions: callers pass the
 * raw `listNetworks` and `listContainers({ all: true })` results, typed as unknown, and
 * every field is checked before use.
 */
import type { ContainerNetwork, NetworkData, NetworkEndpoint } from '$lib/types';
import { DEFAULT_NETWORKS } from '$lib/networkRules';

/** Docker adds the short container ID as an alias; it is not a useful name. */
const CONTAINER_ID_ALIAS = /^[0-9a-f]{12}$/;

/** Return the value as a plain object, or undefined. */
function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Return the value when it is non-empty text. */
function text(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

/** Return the string items of an array; anything else gives an empty list. */
function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];
}

/** Same heuristic as the container routes, plus the Dev Containers CLI label. */
function isDevcontainer(name: string, image: string, labels: Record<string, unknown>): boolean {
	if (text(labels['devcontainer.local_folder'])) return true;
	const lower = `${name} ${image}`.toLowerCase();
	return lower.includes('vsc-') || lower.includes('devcontainer') || lower.includes('-features');
}

/** Read the network endpoints of one container from `NetworkSettings.Networks`. */
export function containerNetworks(networks: unknown): ContainerNetwork[] {
	const map = objectValue(networks);
	if (!map) return [];
	return Object.entries(map)
		.map(([name, raw]) => {
			const endpoint = objectValue(raw) ?? {};
			const configuredIp = text(objectValue(endpoint.IPAMConfig)?.IPv4Address);
			return {
				name,
				ip: text(endpoint.IPAddress) ?? '',
				...(configuredIp ? { configuredIp } : {}),
				aliases: strings(endpoint.Aliases).filter((alias) => !CONTAINER_ID_ALIAS.test(alias))
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The first IPv4 subnet and its gateway from a network IPAM configuration. */
function ipv4Config(ipam: unknown): { subnet?: string; gateway?: string } {
	const configs = objectValue(ipam)?.Config;
	for (const entry of Array.isArray(configs) ? configs : []) {
		const config = objectValue(entry);
		const subnet = text(config?.Subnet);
		if (!subnet?.includes('.')) continue;
		const gateway = text(config?.Gateway);
		return { subnet, ...(gateway ? { gateway } : {}) };
	}
	return {};
}

/**
 * Build user-defined networks with every container on them, running or stopped.
 * Default networks, host and null drivers, and swarm-scoped networks are left out.
 */
export function buildNetworkData(rawNetworks: unknown[], rawContainers: unknown[]): NetworkData[] {
	const endpoints = new Map<string, NetworkEndpoint[]>();
	for (const raw of rawContainers) {
		const container = objectValue(raw);
		const id = text(container?.Id);
		if (!container || !id) continue;
		const labels = objectValue(container.Labels) ?? {};
		const containerName = (strings(container.Names)[0] ?? id).replace(/^\//, '');
		const image = text(container.Image) ?? '';
		const service = text(labels['com.docker.compose.service']);
		const composeProject = text(labels['com.docker.compose.project']);
		const settings = objectValue(objectValue(container.NetworkSettings)?.Networks);
		for (const network of containerNetworks(settings)) {
			const list = endpoints.get(network.name) ?? [];
			list.push({
				containerId: id.slice(0, 12),
				containerName,
				state: text(container.State) ?? 'unknown',
				isDevcontainer: isDevcontainer(containerName, image, labels),
				ip: network.ip || network.configuredIp || '',
				aliases: network.aliases,
				hostname: network.aliases[0] ?? service ?? containerName,
				...(composeProject ? { composeProject } : {})
			});
			endpoints.set(network.name, list);
		}
	}

	const result: NetworkData[] = [];
	for (const raw of rawNetworks) {
		const network = objectValue(raw);
		const name = text(network?.Name);
		const driver = text(network?.Driver) ?? '';
		if (!network || !name || DEFAULT_NETWORKS.has(name)) continue;
		if (['host', 'null', 'none'].includes(driver) || text(network.Scope) === 'swarm') continue;
		const members = (endpoints.get(name) ?? []).sort((a, b) =>
			a.containerName.localeCompare(b.containerName)
		);
		const owner = text(objectValue(network.Labels)?.['com.docker.compose.project']);
		const projects = [
			...new Set([
				...(owner ? [owner] : []),
				...members.flatMap((member) => (member.composeProject ? [member.composeProject] : []))
			])
		];
		result.push({ name, driver, ...ipv4Config(network.IPAM), projects, endpoints: members });
	}
	return result.sort((a, b) => a.name.localeCompare(b.name));
}
