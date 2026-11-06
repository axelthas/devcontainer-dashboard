import { describeServiceTarget, isServiceProxyEnabled } from '$lib/server/serviceGatewayRuntime.js';
import { subdomainConfig, subdomainLaunch } from '$lib/server/serviceSubdomainRuntime.js';
import { AUTH_COOKIE_NAME } from '$lib/server/auth.js';
import { embedProfile, serviceDirectUrl, serviceProxyPath } from '$lib/serviceTargets.js';
import type { PageServerLoad } from './$types';

/** What the viewer should render for the requested service identity. */
interface ViewerContract {
	kind:
		| 'proxy'
		| 'legacy'
		| 'unsupported'
		| 'unavailable'
		| 'proxy-disabled';
	target?: string;
	directUrl?: string;
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
		label, project, container, workspacePath, allPorts, containerId, containerPort
	};

	// Root-origin subdomains are independent of the older same-origin path gateway.
	const subdomainsEnabled = Boolean(subdomainConfig());
	if (containerId && containerPort) {
		if (!/^[a-f0-9]{12,64}$/.test(containerId) ||
			!/^[1-9][0-9]{0,4}$/.test(containerPort) || Number(containerPort) > 65535) {
			return { ...base, viewer: {
				kind: 'unavailable', reason: 'missing-identity'
			} satisfies ViewerContract };
		}
		if (!isServiceProxyEnabled() && !subdomainsEnabled) {
			return { ...base, viewer: {
				kind: 'proxy-disabled', containerId, containerPort
			} satisfies ViewerContract };
		}
		// Subdomains give every allowed web port its own root origin, so they win when enabled.
		// The launch validates live Docker state and issues a one-use, origin-bound ticket.
		if (subdomainsEnabled) {
			const parent = cookies.get(AUTH_COOKIE_NAME);
			const launch = parent
				? await subdomainLaunch(containerId, containerPort, parent)
				: { status: 'disabled' as const };
			if (launch.status === 'ok') {
				return { ...base, viewer: {
					kind: 'proxy', target: launch.target, containerId, containerPort
				} satisfies ViewerContract };
			}
			if (launch.status !== 'disabled' && !isServiceProxyEnabled()) {
				return { ...base, viewer: {
					kind: 'unavailable', containerId, containerPort, reason: launch.status
				} satisfies ViewerContract };
			}
		}
		const target = await describeServiceTarget(containerId, containerPort);
		if (target.status === 'ok') {
			const directUrl = directUrlFor(url.hostname, target.publishedHostPort);
			if (embedProfile(containerPort).mode === 'prefix') {
				return { ...base, viewer: {
					kind: 'proxy', target: serviceProxyPath(containerId, containerPort),
					containerId, containerPort, directUrl
				} satisfies ViewerContract };
			}
			return { ...base, viewer: {
				kind: 'unsupported', containerId, containerPort, directUrl
			} satisfies ViewerContract };
		}
		const fallbackHostPort = allPorts?.[containerPort];
		return { ...base, viewer: {
			kind: 'unavailable', containerId, containerPort, reason: target.status,
			directUrl: directUrlFor(url.hostname, fallbackHostPort)
		} satisfies ViewerContract };
	}

	if (legacyUrl && /^https?:\/\//.test(legacyUrl)) {
		return { ...base, viewer: {
			kind: 'legacy', target: legacyUrl, directUrl: legacyUrl
		} satisfies ViewerContract };
	}
	return { ...base, viewer: {
		kind: 'unavailable', reason: 'missing-identity'
	} satisfies ViewerContract };
};
