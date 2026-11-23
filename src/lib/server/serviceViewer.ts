/**
 * The service viewer contract for one requested service identity. The desktop viewer
 * (`/service`) and the phone viewer (`/mobile/services/view`) render the same contract
 * from the same query parameters, so both validate the target in one place.
 */
import { describeServiceTarget, isServiceProxyEnabled } from '$lib/server/serviceGatewayRuntime.js';
import { launchTailscaleService } from '$lib/server/tailscaleServiceRuntime.js';
import { embedProfile, serviceDirectUrl, serviceProxyPath } from '$lib/serviceTargets.js';
import type { ViewerContract } from '$lib/serviceViewer.js';

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

/** Read the query of a viewer URL and decide what the viewer renders. */
export async function loadServiceViewer(url: URL) {
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
	if (params.get('local') === 'openchamber') {
		try {
			const { aiWebOrigin } = await import('$lib/server/aiRuntime.js');
			const { aiDirectory } = await import('$lib/server/aiPaths.js');
			const session = params.get('session');
			let search: URLSearchParams;
			if (session) {
				if (!/^[a-zA-Z0-9_-]{1,128}$/.test(session)) throw new Error('Invalid session');
				search = new URLSearchParams({ session });
			} else {
				const directory = await aiDirectory(
					process.env.WORKSPACE_ROOT ?? '/workspaces',
					params.get('directory') ?? ''
				);
				search = new URLSearchParams({ directory, new: '1' });
			}
			const origin = await aiWebOrigin(url, launchTailscaleService);
			const target = `${origin}/?${search}`;
			return {
				...base,
				label: 'OpenChamber',
				viewer: { kind: 'proxy', target, directUrl: target } satisfies ViewerContract
			};
		} catch {
			return {
				...base,
				viewer: { kind: 'unavailable', reason: 'local-ai-not-ready' } satisfies ViewerContract
			};
		}
	}

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
			// Return only known diagnostic codes, never upstream exception text.
			const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
			const reason =
				typeof code === 'string' &&
				[
					'wildcard-binding-disabled',
					'unsupported-binding',
					'ambiguous-binding',
					'invalid-service-binding',
					'port-not-allowed',
					'unknown-container',
					'not-running',
					'no-published-binding',
					'service-unreachable'
				].includes(code)
					? code
					: 'tailscale-allocation-failed';
			return {
				...base,
				viewer: {
					kind: 'unavailable',
					reason,
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
}
