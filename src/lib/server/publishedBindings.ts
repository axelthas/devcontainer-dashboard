/**
 * Preserve Docker published addresses for UI diagnostics, including stopped containers.
 * This display-only data must never select or authorize a service gateway upstream.
 */
import type { PublishedPortBinding } from '../types.js';

/** Read live list data, or configured bindings when a stopped container has none. */
export function publishedBindings(
	ports: { PrivatePort: number; PublicPort?: number; IP?: string; Type: string }[] | undefined,
	configured?: Record<string, { HostIp?: string; HostPort?: string }[] | null>
): PublishedPortBinding[] {
	const live = (ports ?? []).flatMap((port) =>
		port.PublicPort
			? [
					{
						containerPort: String(port.PrivatePort),
						hostPort: String(port.PublicPort),
						hostIp: port.IP ?? '',
						protocol: port.Type
					}
				]
			: []
	);
	if (live.length) return live;
	return Object.entries(configured ?? {}).flatMap(([key, bindings]) => {
		const [containerPort, protocol] = key.split('/');
		return (bindings ?? []).map((binding) => ({
			containerPort,
			hostPort: binding.HostPort || 'dynamic',
			hostIp: binding.HostIp ?? '',
			protocol: protocol ?? 'tcp'
		}));
	});
}
