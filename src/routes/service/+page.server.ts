import { describeServiceTarget, isServiceProxyEnabled } from '$lib/server/serviceGatewayRuntime.js';
import { subdomainConfig, subdomainLaunch } from '$lib/server/serviceSubdomainRuntime.js';
import { AUTH_COOKIE_NAME } from '$lib/server/auth.js';
import { embedProfile, serviceDirectUrl, serviceProxyPath } from '$lib/serviceTargets.js';
import type { PageServerLoad } from './$types';

/** What the viewer should render for the requested service identity. */
interface ViewerContract {
	kind:
		| 'proxy' // iframe the gateway path proxy or a service subdomain
		| 'legacy' // iframe a raw client-provided URL (non-gateway deployments)
		| 'unsupported' // running service, but the application cannot live under a prefix
		| 'unavailable' // identity valid shape, but the target does not check out
		| 'proxy-disabled'; // gateway not enabled in this process
	/** Iframe source for proxy/legacy kinds. */
	target?: string;
	/** Best-effort direct navigation URL (may be unreachable through Tailscale). */
	directUrl?: string;
	/** Validated identity, shared with the service switcher and active-state matching. */
	containerId?: string;
	containerPort?: string;
	reason?: string;
}

function parsePortsParam(raw: string | null): Record<string, string> | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const entries = Object.entries(parsed as Record<string, unknown>).filter(
			([port, hostPort]) => /^[1-9][0-9]{0,4}$/.test(port) && typeof hostPort === 'string'
		);
		return Object.fromEntries(entries) as Record<string, string>;
	} catch {
		return null;
	}
}

function directUrlFor(hostname: string, hostPort: string | number | undefined): string | undefined {
	return typeof hostPort === 'number'
		? Number.isInteger(hostPort) && hostPort >= 1 && hostPort <= 65535
			? serviceDirectUrl(hostname, String(hostPort))
			: undefined
		: hostPort && /^[1-9][0-9]{0,4}$/.test(hostPort)
			? serviceDirectUrl(hostname, hostPort)
			: undefined;
}

/**
 * Subdomain viewer contract, or undefined to fall back to the path gateway. A subdomain
 * gives each allowed port its own root origin, so it takes precedence when enabled.
 */
async function subdomainViewer(
	containerId: string,
	containerPort: string,
	parent: string | undefined
): Promise<ViewerContract | undefined> {
	if (!parent || !subdomainConfig()) return undefined;
	const launch = await subdomainLaunch(containerId, containerPort, parent);
	if (launch.status === 'ok') {
		return { kind: 'proxy', target: launch.target, containerId, containerPort };
	}
	// Without the path gateway there is no fallback, so report the subdomain result.
	if (isServiceProxyEnabled()) return undefined;
	return { kind: 'unavailable', containerId, containerPort, reason: launch.status };
}

export const load: PageServerLoad = async ({ url, cookies }) => {
	const params = url.searchParams;
	const containerId = params.get('cid');
	const containerPort = params.get('port');
	const legacyUrl = params.get('url');
	const label = params.get('label') ?? 'Service';
	const project = params.get('project') ?? '';
	const container = params.get('container') ?? '';
	const workspacePath = params.get('path') ?? '';
	const allPorts = parsePortsParam(params.get('ports'));

	const base = {
		label,
		project,
		container,
		workspacePath,
		allPorts,
		containerId,
		containerPort
	};

	// Validated identity contract: the server, not the query string, decides the iframe target.
	if (containerId && containerPort) {
		const parent = cookies.get(AUTH_COOKIE_NAME);
		const subdomain = await subdomainViewer(containerId, containerPort, parent);
		if (subdomain) return { ...base, viewer: subdomain };
		if (!isServiceProxyEnabled()) {
			return {
				...base,
				viewer: { kind: 'proxy-disabled', containerId, containerPort } satisfies ViewerContract
			};
		}
		const target = await describeServiceTarget(containerId, containerPort);
		if (target.status === 'ok') {
			const directUrl = directUrlFor(url.hostname, target.publishedHostPort);
			if (embedProfile(containerPort).mode === 'prefix') {
				return {
					...base,
					viewer: {
						kind: 'proxy',
						target: serviceProxyPath(containerId, containerPort),
						containerId,
						containerPort,
						directUrl
					} satisfies ViewerContract
				};
			}
			// Verified root-absolute applications (e.g. OpenCode) cannot embed under a prefix.
			return {
				...base,
				viewer: {
					kind: 'unsupported',
					containerId,
					containerPort,
					directUrl
				} satisfies ViewerContract
			};
		}
		const fallbackHostPort = allPorts?.[containerPort];
		return {
			...base,
			viewer: {
				kind: 'unavailable',
				containerId,
				containerPort,
				reason: target.status,
				directUrl: directUrlFor(url.hostname, fallbackHostPort)
			} satisfies ViewerContract
		};
	}

	// Legacy raw-URL authority, kept for non-gateway deployments and stale links.
	if (legacyUrl && /^https?:\/\//.test(legacyUrl)) {
		return {
			...base,
			viewer: { kind: 'legacy', target: legacyUrl, directUrl: legacyUrl } satisfies ViewerContract
		};
	}

	return {
		...base,
		viewer: { kind: 'unavailable', reason: 'missing-identity' } satisfies ViewerContract
	};
};
