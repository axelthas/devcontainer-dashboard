/**
 * Operator-owned, opt-in routing for root-mounted service applications.
 * A listener has one immutable full Docker identity; it is never a browser input.
 */
export interface ServiceOrigin {
	origin: string;
	listenPort: number;
	containerId: string;
	containerPort: string;
}

/** Parse a bounded routing table and reject ambiguous listener or service identities. */
export function parseServiceOrigins(raw: string | undefined, dashboardOrigin: string): ServiceOrigin[] {
	if (!raw) return [];
	const dashboard = new URL(dashboardOrigin);
	if (dashboard.protocol !== 'https:' || dashboard.origin !== dashboardOrigin) {
		throw new Error('Service origins require an exact HTTPS dashboard ORIGIN.');
	}
	const rows: unknown = JSON.parse(raw);
	if (!Array.isArray(rows) || rows.length > 32) {
		throw new Error('SERVICE_ORIGINS must be an array with at most 32 entries.');
	}
	const origins = new Set<string>();
	const listeners = new Set<number>();
	const identities = new Set<string>();
	return rows.map((row: unknown) => {
		if (!row || typeof row !== 'object') throw new Error('Invalid service origin entry.');
		const item = row as Record<string, unknown>;
		if (
			typeof item.origin !== 'string' ||
			typeof item.listenPort !== 'number' ||
			!Number.isInteger(item.listenPort) ||
			item.listenPort < 1024 ||
			item.listenPort > 65535 ||
			typeof item.containerId !== 'string' ||
			!/^[a-f0-9]{64}$/.test(item.containerId) ||
			typeof item.containerPort !== 'string' ||
			!/^[1-9][0-9]{0,4}$/.test(item.containerPort) ||
			Number(item.containerPort) > 65535
		) {
			throw new Error('Invalid service origin, listener port, full container ID or container port.');
		}
		const origin = new URL(item.origin);
		// Same-host origins keep iframe cookies same-site. Different-host support needs
		// a separately validated third-party-cookie/authentication deployment profile.
		if (
			origin.protocol !== 'https:' ||
			origin.origin !== item.origin ||
			origin.username ||
			origin.password ||
			origin.hostname !== dashboard.hostname ||
			origin.origin === dashboard.origin
		) {
			throw new Error('Each service needs a distinct HTTPS port on the dashboard hostname.');
		}
		const identity = `${item.containerId}:${item.containerPort}`;
		if (origins.has(origin.origin) || listeners.has(item.listenPort) || identities.has(identity)) {
			throw new Error('Duplicate service origin, listener or container/port identity.');
		}
		origins.add(origin.origin);
		listeners.add(item.listenPort);
		identities.add(identity);
		return {
			origin: origin.origin,
			listenPort: item.listenPort,
			containerId: item.containerId,
			containerPort: item.containerPort
		};
	});
}

/** Resolve a UI short ID only when it identifies exactly one configured service. */
export function findServiceOrigin(
	routes: ServiceOrigin[],
	containerId: string,
	containerPort: string
): ServiceOrigin | undefined {
	if (!/^[a-f0-9]{12,64}$/.test(containerId)) return undefined;
	const matches = routes.filter(
		(route) => route.containerId.startsWith(containerId) && route.containerPort === containerPort
	);
	return matches.length === 1 ? matches[0] : undefined;
}
