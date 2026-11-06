/**
 * Wildcard service-origin naming: https://<container-port>-<12-hex-id>.<node-name>[:port].
 * All names are derived from Docker identity at request time; nothing is configured per service.
 */
export interface SubdomainConfig {
	/** Tailscale node name that also serves the dashboard, e.g. host.tailnet.ts.net. */
	baseDomain: string;
	/** Browser-facing HTTPS port of the shared service listener (Tailscale Serve TCP port). */
	publicPort: number;
	/** Exact dashboard origin; service origins must be its subdomains. */
	dashboardOrigin: string;
}

export interface ServiceHost {
	origin: string;
	shortId: string;
	containerPort: string;
}

const DOMAIN = /^(?=.{1,200}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Validate operator configuration. Unset base domain means the feature is disabled. */
export function parseSubdomainConfig(env: Record<string, string | undefined>): SubdomainConfig | undefined {
	const baseDomain = env.SERVICE_SUBDOMAIN_BASE?.trim().toLowerCase();
	if (!baseDomain) return undefined;
	if (!DOMAIN.test(baseDomain)) throw new Error('SERVICE_SUBDOMAIN_BASE must be a DNS name.');
	const publicPort = Number(env.SERVICE_SUBDOMAIN_PUBLIC_PORT || '8443');
	if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
		throw new Error('SERVICE_SUBDOMAIN_PUBLIC_PORT must be from 1 to 65535.');
	}
	const dashboardOrigin = env.ORIGIN ?? '';
	let dashboard: URL;
	try {
		dashboard = new URL(dashboardOrigin);
	} catch {
		throw new Error('Service subdomains require an exact HTTPS ORIGIN.');
	}
	// The wildcard certificate covers *.<node>, so the dashboard must use that node name.
	if (dashboard.protocol !== 'https:' || dashboard.origin !== dashboardOrigin || dashboard.hostname !== baseDomain) {
		throw new Error('ORIGIN must be the exact HTTPS origin of SERVICE_SUBDOMAIN_BASE.');
	}
	return { baseDomain, publicPort, dashboardOrigin };
}

/** Build the browser origin for one container port. */
export function serviceOrigin(config: SubdomainConfig, shortId: string, containerPort: string): string {
	const port = config.publicPort === 443 ? '' : `:${config.publicPort}`;
	return `https://${containerPort}-${shortId}.${config.baseDomain}${port}`;
}

/** Parse a Host header strictly; unknown names, ports or nested labels return undefined. */
export function parseServiceHost(config: SubdomainConfig, host: string | undefined): ServiceHost | undefined {
	const parts = /^([^:]+)(?::([0-9]{1,5}))?$/.exec((host ?? '').toLowerCase());
	if (!parts) return undefined;
	// Browsers omit the default port; any explicit port must be the configured public port.
	if (parts[2] === undefined ? config.publicPort !== 443 : Number(parts[2]) !== config.publicPort) {
		return undefined;
	}
	const name = parts[1];
	const suffix = `.${config.baseDomain}`;
	if (!name.endsWith(suffix)) return undefined;
	const match = /^([1-9][0-9]{0,4})-([a-f0-9]{12})$/.exec(name.slice(0, -suffix.length));
	if (!match || Number(match[1]) > 65535) return undefined;
	return {
		origin: serviceOrigin(config, match[2], match[1]),
		shortId: match[2],
		containerPort: match[1]
	};
}
