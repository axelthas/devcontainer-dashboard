/**
 * Published ports of one container as the phone lists them: web services open in
 * DevHarbour's service viewer, everything else is an address to copy. The rules are the
 * desktop rules: every devcontainer port opens as a service (as in the Services menu);
 * Docker services use the web-port policy.
 */
import { getPortLabel } from '$lib/portConfig';
import { copyAddress, foldBindings, webProtocol, type FoldedPort } from '$lib/publishedPorts';
import type { ContainerData, ServicePortPolicy } from '$lib/types';

export interface PortEntry {
	containerPort: string;
	hostPort: string;
	label: string;
	web: boolean;
	port: FoldedPort;
}

/** Docker's published bindings, or the plain port map when an older response has none. */
function folded(container: ContainerData): FoldedPort[] {
	return container.portBindings?.length
		? foldBindings(container.portBindings)
		: Object.entries(container.ports).map(([containerPort, hostPort]) => ({
				containerPort,
				hostPort,
				protocol: 'tcp',
				addresses: [''],
				exposure: 'default' as const
			}));
}

/** One entry per published port; web entries appear once per container port. */
export function portEntries(container: ContainerData, policy: ServicePortPolicy): PortEntry[] {
	const seen = new Set<string>();
	const entries: PortEntry[] = [];
	for (const port of folded(container)) {
		const web = container.isDevcontainer
			? port.protocol === 'tcp'
			: webProtocol(policy, port.containerPort, port.protocol) !== null;
		if (web && seen.has(port.containerPort)) continue;
		if (web) seen.add(port.containerPort);
		entries.push({
			containerPort: port.containerPort,
			hostPort: container.ports[port.containerPort] ?? port.hostPort,
			label: getPortLabel(port.containerPort),
			web,
			port
		});
	}
	return entries;
}

/** The address that a client on another machine uses for a TCP port. */
export function tcpAddress(entry: PortEntry, dashboardHost: string): string {
	return copyAddress(entry.port, dashboardHost);
}
