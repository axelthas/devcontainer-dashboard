import { describeServiceTarget, isServiceProxyEnabled } from '$lib/server/serviceGatewayRuntime.js';
import { launchTailscaleService } from '$lib/server/tailscaleServiceRuntime.js';
import { embedProfile, serviceDirectUrl, serviceProxyPath } from '$lib/serviceTargets.js';
import type { PageServerLoad } from './$types';

/** What the viewer should render for the requested service identity. */
interface ViewerContract {
	kind: 'proxy' | 'legacy' | 'unsupported' | 'unavailable' | 'proxy-disabled';
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

export const load: PageServerLoad = async ({ url }) => {
	const params = url.searchParams;
	const containerId = params.get('cid');
	const containerPort = params.get('port');
	const legacyUrl = params.get('url');
	const label = params.get('label') ?? 'Service';
	const project = params.get('project') ?? '';
	const container = params.get('container') ?? '';
	const workspacePath = params.get('path') ?? '';
	const allPorts = parsePortsParam(params.get('ports'));
	const base = { label, project, container, workspacePath, allPorts, containerId, containerPort };

	// In Tailscale mode the custom server alone allocates and validates HTTPS origins.
	// Never fall back to a raw URL or the same-origin path gateway on an allocation failure.
	if (process.env.TAILSCALE_SOCKET) {
		try {
			if (!containerId || !containerPort) throw new Error('Missing service identity');
			const origin = await launchTailscaleService(containerId, containerPort);
			return {
				...base,
				viewer: {
					kind: 'proxy',
					target: `${origin}/`,
					directUrl: `${origin}/`,
					containerId,
					containerPort
				} satisfies ViewerContract
			};
		} catch (error) {
			console.error(
				'[tailscale] Service launch failed:',
				error instanceof Error ? error.message : 'unknown'
			);
			return {
				...base,
				viewer: {
					kind: 'unavailable',
					reason: 'tailscale-allocation-failed',
					containerId: containerId ?? undefined,
					containerPort: containerPort ?? undefined
				} satisfies ViewerContract
			};
		}
	}

	if (containerId && containerPort) {
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
		return {
			...base,
			viewer: {
				kind: 'unavailable',
				containerId,
				containerPort,
				reason: target.status,
				directUrl: directUrlFor(url.hostname, allPorts?.[containerPort])
			} satisfies ViewerContract
		};
	}
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
