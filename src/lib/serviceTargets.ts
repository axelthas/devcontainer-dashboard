/**
 * Client-safe service identity and URL builders shared by launch, service switching,
 * and active-state matching. Server-side validation lives in
 * `$lib/server/serviceGatewayRuntime`; this module must never import server modules.
 */

/**
 * Embedding behavior for known service ports, grounded in the validated application
 * matrix (issue #21). Unknown ports default to 'direct': most web applications use
 * root-absolute asset URLs and cannot live under a path prefix.
 */
export interface ServiceEmbedProfile {
	/** 'prefix' embeds through the gateway path proxy; 'direct' needs the service origin root. */
	mode: 'prefix' | 'direct';
	/** Relative upstream WebSocket path passed as a `?path=` query hint when embedding. */
	wsPathQuery?: string;
}

const SERVICE_EMBED_PROFILES: Record<string, ServiceEmbedProfile> = {
	// Supervisor renders document-relative links and confined redirects (verified).
	'9001': { mode: 'prefix' },
	// noVNC is self-contained, imports relatively, and derives its socket path from location.
	'6904': { mode: 'prefix', wsPathQuery: 'websockify' }
};

export function embedProfile(containerPort: string): ServiceEmbedProfile {
	return SERVICE_EMBED_PROFILES[containerPort] ?? { mode: 'direct' };
}

/** Gateway path for a container service, with a WebSocket path hint for prefix-capable apps. */
export function serviceProxyPath(containerId: string, containerPort: string): string {
	const prefix = `/service-proxy/${containerId}/${containerPort}/`;
	const profile = embedProfile(containerPort);
	return profile.wsPathQuery ? `${prefix}?path=${prefix.slice(1)}${profile.wsPathQuery}` : prefix;
}

export interface ServiceViewerParams {
	containerId: string;
	containerPort: string;
	label?: string;
	projectName?: string;
	containerName?: string;
	workspacePath?: string;
	allPorts?: Record<string, string>;
}

/**
 * Canonical viewer href. Used for launch, service switching, and active-state matching
 * so all three agree on one identity format instead of reconstructing raw URLs.
 * The template-literal return type keeps `resolve()` and typed navigation usable.
 */
export function serviceViewerHref(params: ServiceViewerParams): `/service?${string}` {
	const search = new URLSearchParams({
		cid: params.containerId,
		port: params.containerPort
	});
	if (params.label) search.set('label', params.label);
	if (params.projectName) search.set('project', params.projectName);
	if (params.containerName) search.set('container', params.containerName);
	if (params.workspacePath) search.set('path', params.workspacePath);
	if (params.allPorts && Object.keys(params.allPorts).length > 1) {
		search.set('ports', JSON.stringify(params.allPorts));
	}
	return `/service?${search.toString()}`;
}

/**
 * Best-effort direct URL for top-level navigation. Reachable only when the browser can
 * connect to the published host port; Tailscale HTTPS setups typically cannot.
 */
export function serviceDirectUrl(hostname: string, hostPort: string): string {
	return `http://${hostname}:${hostPort}`;
}
