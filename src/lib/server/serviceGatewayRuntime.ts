/**
 * Connect the service gateway to the dashboard's Docker and session state.
 * Keep this unfinished integration opt-in until real service/browser validation.
 */
import docker from './docker.js';
import { isCookieHeaderAuthenticated } from './auth.js';
import { createServiceGateway } from './serviceGateway.js';

/** Create a gateway only when the operator explicitly enables the trusted-service preview. */
export function createRuntimeServiceGateway(defaultOrigin: string) {
	if (process.env.SERVICE_PROXY_ENABLED !== '1') return null;
	const configuredOrigin = process.env.ORIGIN ?? defaultOrigin;
	const origin = new URL(configuredOrigin);
	if (
		!['http:', 'https:'].includes(origin.protocol) ||
		origin.origin !== configuredOrigin ||
		origin.username ||
		origin.password
	) {
		throw new Error('The service gateway requires an exact HTTP(S) ORIGIN without a path or trailing slash.');
	}
	return createServiceGateway({
		inspect: (id) => docker.getContainer(id).inspect(),
		authenticated: isCookieHeaderAuthenticated,
		origin: origin.origin,
		upstreamHost: process.env.SERVICE_PROXY_HOST || undefined
	});
}
