/**
 * Test harnesses compiled into the `:mcp` sandbox images. Only those images declare these ports,
 * so a declared port is enough to tell that a container carries a harness.
 */

export type HarnessKind = 'asd' | 'orion-pilot' | 'orion-creator' | 'tatoo';

interface HarnessDefinition {
	kind: HarnessKind;
	label: string;
	/** JSON-RPC method that answers as soon as the harness is listening. */
	livenessMethod: string;
}

const HARNESS_BY_PORT: Record<string, HarnessDefinition> = {
	'19777': { kind: 'asd', label: 'ASD', livenessMethod: 'get_header_info' },
	'19778': { kind: 'orion-pilot', label: 'Orion pilot', livenessMethod: 'get_clock' },
	'19779': { kind: 'orion-creator', label: 'Orion creator', livenessMethod: 'list_environments' },
	'9776': { kind: 'tatoo', label: 'TAToo', livenessMethod: 'get_status' }
};

export interface HarnessEndpoint extends HarnessDefinition {
	containerPort: number;
	/** `ip:port` on the sandbox network; only set while the container is running. */
	containerAddress?: string;
	/** Host port, when the harness is published on the Docker host. */
	hostPort?: string;
	/** Host address the port is published on, for example 127.0.0.1. */
	hostIp?: string;
}

interface DockerPort {
	PrivatePort?: number;
	PublicPort?: number;
	IP?: string;
	Type?: string;
}

export function isHarnessPort(containerPort: string | number): boolean {
	return String(containerPort) in HARNESS_BY_PORT;
}

/** Docker lists a published port once per address family and an unpublished one without a host port. */
export function findHarnessEndpoints(
	ports: DockerPort[] | undefined,
	ipAddress?: string
): HarnessEndpoint[] {
	const endpoints = new Map<number, HarnessEndpoint>();

	for (const port of ports ?? []) {
		if (!port.PrivatePort || (port.Type && port.Type !== 'tcp')) continue;
		const definition = HARNESS_BY_PORT[String(port.PrivatePort)];
		if (!definition) continue;

		const endpoint = endpoints.get(port.PrivatePort) ?? {
			...definition,
			containerPort: port.PrivatePort,
			containerAddress: ipAddress ? `${ipAddress}:${port.PrivatePort}` : undefined
		};
		const isIpv6 = port.IP?.includes(':');
		if (port.PublicPort && (!endpoint.hostPort || !isIpv6)) {
			endpoint.hostPort = String(port.PublicPort);
			endpoint.hostIp = port.IP;
		}
		endpoints.set(port.PrivatePort, endpoint);
	}

	return [...endpoints.values()].sort((a, b) => a.containerPort - b.containerPort);
}

/** The published port on the host the client used, otherwise the address on the sandbox network. */
export function harnessAddress(endpoint: HarnessEndpoint, hostname: string): string | undefined {
	return endpoint.hostPort ? `${hostname}:${endpoint.hostPort}` : endpoint.containerAddress;
}

export function isHarnessLoopbackOnly(endpoint: HarnessEndpoint): boolean {
	return Boolean(endpoint.hostIp?.startsWith('127.') || endpoint.hostIp === '::1');
}
