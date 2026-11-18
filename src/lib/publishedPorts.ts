/**
 * Client-safe rules for published ports in container details and the sandbox Services menu.
 * Docker does not say which protocol a port speaks. A port is a web service only when the
 * service port policy (built-in defaults plus `--gateway-ports`) names it `http` or `https`.
 */
import type { PublishedPortBinding, ServicePortPolicy } from './types';

/** How a published port is reachable from the host network. */
export type Exposure = 'all' | 'loopback' | 'specific' | 'default';

/** One container port with all its host addresses, for example 0.0.0.0 and :: together. */
export interface FoldedPort {
	containerPort: string;
	protocol: string;
	hostPort: string;
	addresses: string[];
	exposure: Exposure;
}

const WILDCARD = ['0.0.0.0', '::'];
const LOOPBACK = ['127.0.0.1', '::1'];

/** Classify a set of host addresses. All interfaces wins, so the widest exposure is never hidden. */
export function addressExposure(addresses: string[]): Exposure {
	if (addresses.some((address) => WILDCARD.includes(address))) return 'all';
	if (addresses.length > 0 && addresses.every((address) => LOOPBACK.includes(address)))
		return 'loopback';
	return addresses.some(Boolean) ? 'specific' : 'default';
}

/** Fold bindings that share a container port, transport and host port into one line. */
export function foldBindings(bindings: PublishedPortBinding[] | undefined): FoldedPort[] {
	const folded: FoldedPort[] = [];
	for (const binding of bindings ?? []) {
		const existing = folded.find(
			(entry) =>
				entry.containerPort === binding.containerPort &&
				entry.protocol === binding.protocol &&
				entry.hostPort === binding.hostPort
		);
		if (existing) {
			if (!existing.addresses.includes(binding.hostIp)) existing.addresses.push(binding.hostIp);
			existing.exposure = addressExposure(existing.addresses);
		} else {
			folded.push({
				containerPort: binding.containerPort,
				protocol: binding.protocol,
				hostPort: binding.hostPort,
				addresses: [binding.hostIp],
				exposure: addressExposure([binding.hostIp])
			});
		}
	}
	return folded.sort(
		(a, b) =>
			Number(a.containerPort) - Number(b.containerPort) || a.protocol.localeCompare(b.protocol)
	);
}

/** The widest exposure of a container, or null when it publishes nothing. */
export function containerExposure(bindings: PublishedPortBinding[] | undefined): Exposure | null {
	return bindings?.length ? addressExposure(bindings.map((binding) => binding.hostIp)) : null;
}

/** The web protocol of a container port, or null for TCP-only and UDP ports. */
export function webProtocol(
	policy: ServicePortPolicy,
	containerPort: string,
	protocol = 'tcp'
): 'http' | 'https' | null {
	const scheme = policy[containerPort];
	return protocol === 'tcp' && (scheme === 'http' || scheme === 'https') ? scheme : null;
}

/** Show an address as Docker means it; IPv6 gets brackets and an empty address means any. */
export function displayAddress(address: string): string {
	if (!address) return '*';
	return address.includes(':') ? `[${address}]` : address;
}

/**
 * The address a client uses for a TCP-only port. Loopback stays on 127.0.0.1; a wildcard
 * binding uses the dashboard host name; a specific address uses that address.
 */
export function copyAddress(port: FoldedPort, dashboardHost: string): string {
	const ipv4Loopback = port.addresses.includes('127.0.0.1');
	if (port.exposure === 'loopback')
		return `${ipv4Loopback ? '127.0.0.1' : '[::1]'}:${port.hostPort}`;
	if (port.exposure === 'specific') {
		const address = port.addresses.find(Boolean) ?? dashboardHost;
		return `${displayAddress(address)}:${port.hostPort}`;
	}
	return `${dashboardHost}:${port.hostPort}`;
}
