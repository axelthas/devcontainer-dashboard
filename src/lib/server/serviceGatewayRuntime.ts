/**
 * Connect the service gateway to the dashboard's Docker and session state.
 * Keep this unfinished integration opt-in until real service/browser validation.
 */
import docker from './docker.js';
import { isCookieHeaderAuthenticated } from './auth.js';
import {
	createServiceGateway,
	DEFAULT_PORTS,
	inspectServiceBinding,
	resolveServiceScheme
} from './serviceGateway.js';

/** Create a gateway only when the operator explicitly enables the trusted-service preview. */
export function createRuntimeServiceGateway(defaultOrigin: string) {
	if (!isServiceProxyEnabled()) return null;
	const configuredOrigin = process.env.ORIGIN ?? defaultOrigin;
	const origin = new URL(configuredOrigin);
	if (
		!['http:', 'https:'].includes(origin.protocol) ||
		origin.origin !== configuredOrigin ||
		origin.username ||
		origin.password
	) {
		throw new Error(
			'The service gateway requires an exact HTTP(S) ORIGIN without a path or trailing slash.'
		);
	}
	return createServiceGateway({
		inspect: (id) => docker.getContainer(id).inspect(),
		authenticated: isCookieHeaderAuthenticated,
		origin: origin.origin,
		upstreamHost: process.env.SERVICE_PROXY_HOST || undefined,
		ports: resolveServicePorts()
	});
}

/** Whether the opt-in trusted-service gateway is active in this process. */
export function isServiceProxyEnabled(): boolean {
	return process.env.SERVICE_PROXY_ENABLED === '1';
}

/**
 * Parse the optional SERVICE_PROXY_PORTS policy, e.g. "9001:http,8443:https,8080:off".
 * Entries override the built-in defaults; 'off' disables a default port.
 */
function parseServiceProxyPorts(raw: string | undefined): Record<string, 'http' | 'https' | 'off'> {
	if (!raw) return {};
	const parsed: Record<string, 'http' | 'https' | 'off'> = {};
	for (const entry of raw.split(',')) {
		const match = /^([1-9][0-9]{0,4}):(http|https|off)$/i.exec(entry.trim());
		if (!match || Number(match[1]) > 65535) {
			throw new Error(
				'SERVICE_PROXY_PORTS must be comma-separated port:protocol pairs, e.g. "9001:http,8443:https,8080:off".'
			);
		}
		parsed[match[1]] = match[2].toLowerCase() as 'http' | 'https' | 'off';
	}
	return parsed;
}

/** Effective web-service protocol policy: built-in defaults overridden by SERVICE_PROXY_PORTS. */
export function resolveServicePorts(): Record<string, 'http' | 'https' | 'off'> {
	return { ...DEFAULT_PORTS, ...parseServiceProxyPorts(process.env.SERVICE_PROXY_PORTS) };
}

export type ServiceTargetStatus =
	| 'ok'
	| 'proxy-disabled'
	| 'port-not-allowed'
	| 'unknown-container'
	| 'not-running'
	| 'no-published-binding';

export interface ServiceTargetInfo {
	status: ServiceTargetStatus;
	protocol?: 'http' | 'https';
	publishedHostPort?: number;
}

/**
 * Validate a container service identity for the viewer, sharing the gateway's
 * allowlist and Docker checks without exposing upstream connection internals.
 */
export async function describeServiceTarget(
	containerId: string,
	containerPort: string
): Promise<ServiceTargetInfo> {
	if (!isServiceProxyEnabled()) return { status: 'proxy-disabled' };
	const protocol = resolveServiceScheme(resolveServicePorts(), containerPort);
	if (!protocol) return { status: 'port-not-allowed' };
	let info;
	try {
		info = await docker.getContainer(containerId).inspect();
	} catch {
		return { status: 'unknown-container' };
	}
	const binding = inspectServiceBinding(info, containerId, containerPort);
	if (binding.state !== 'ok') return { status: binding.state };
	return { status: 'ok', protocol, publishedHostPort: binding.publishedHostPort };
}
