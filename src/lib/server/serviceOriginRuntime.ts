/**
 * Production wiring for explicit service routes, Docker discovery and launch grants.
 * Vite does not start these listeners; use the compiled production entry point.
 */
import docker from './docker.js';
import { parseServiceOrigins, findServiceOrigin } from './serviceOriginConfig.js';
import { issueServiceLaunch } from './serviceOriginAuth.js';
import { createServiceOriginServer } from './serviceOriginGateway.js';
import { resolveServicePorts } from './serviceGatewayRuntime.js';

/** Read current operator configuration; configuration is not controlled by URL parameters. */
export function configuredServiceOrigins() {
	return parseServiceOrigins(process.env.SERVICE_ORIGINS, process.env.ORIGIN ?? '');
}

/** Return an authenticated root-origin viewer target, or retain the existing path viewer. */
export function serviceOriginLaunch(
	containerId: string,
	containerPort: string,
	parent: string
): string | undefined {
	const route = findServiceOrigin(configuredServiceOrigins(), containerId, containerPort);
	return route ? issueServiceLaunch(route, parent) : undefined;
}

/** Start loopback listeners; route failures stop startup rather than silently exposing a fallback. */
export async function startServiceOrigins(dashboardPort: number): Promise<void> {
	const routes = configuredServiceOrigins();
	if (!routes.length) return;
	const ports = resolveServicePorts();
	for (const route of routes) {
		if (route.listenPort === dashboardPort) throw new Error('Service listener conflicts with PORT.');
		if (!['http', 'https'].includes(ports[route.containerPort])) {
			throw new Error(`Service port ${route.containerPort} is not enabled by SERVICE_PROXY_PORTS.`);
		}
	}
	const started: ReturnType<typeof createServiceOriginServer>[] = [];
	try {
		for (const route of routes) {
			const server = createServiceOriginServer({
				route,
				dashboardOrigin: process.env.ORIGIN!,
				inspect: (id) => docker.getContainer(id).inspect(),
				upstreamHost: process.env.SERVICE_PROXY_HOST || undefined,
				ports
			});
			started.push(server);
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(route.listenPort, '127.0.0.1', resolve);
			});
			console.log(`Service origin ready: ${route.origin} (loopback ${route.listenPort})`);
		}
	} catch (error) {
		for (const server of started) server.close();
		throw error;
	}
}
