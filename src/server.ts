// Custom production entry point: HTTP, terminal WebSockets, and coordinated shutdown.
import { createServer } from 'node:http';
import { attachTerminalServer } from './lib/server/terminal.js';
import { attachBrainTerminalServer } from './lib/server/brainTerminal.js';
import { assertAuthConfigured, isCookieHeaderAuthenticated } from './lib/server/auth.js';
import {
	createRuntimeServiceGateway,
	resolveServicePorts
} from './lib/server/serviceGatewayRuntime.js';
import docker from './lib/server/docker.js';
import { allocateServePort, createServeConfigClient } from './lib/server/tailscaleServe.js';
import { startTailscaleServices, tailscaleSettings } from './lib/server/tailscaleServiceRuntime.js';
import { installShutdown } from './lib/server/shutdown.js';
import { startAi, inspectAi } from './lib/server/aiRuntime.js';
import { createBrainServer } from './lib/server/brain/gateway.js';
import { stopAllExecutions } from './lib/server/brain/executions.js';
import {
	prepareBrain,
	brainFunnelSettings,
	preflightBrainFunnel,
	startBrainFunnel
} from './lib/server/brain/startup.js';
import { brainState } from './lib/server/brain/state.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
assertAuthConfigured();
// Read the Brain MCP credential once, then remove it, so no child process inherits it.
const brain = await prepareBrain(process.env);
delete process.env.BRAIN_MCP_TOKEN;
const tailscale = tailscaleSettings(process.env);
const funnelSettings = brainFunnelSettings(process.env, brain);
// Check permissions before any Serve cleanup, daemon writes, child processes or listeners.
if (tailscale && funnelSettings) await preflightBrainFunnel(tailscale.socket, funnelSettings);
const INTERNAL_PROTOCOL_HEADER = 'x-devcontainer-dashboard-protocol';
const proxyConfigured = Boolean(process.env.ORIGIN || process.env.PROTOCOL_HEADER);
if (!proxyConfigured) process.env.PROTOCOL_HEADER = INTERNAL_PROTOCOL_HEADER;
const tailscaleClient = createServeConfigClient(tailscale?.socket);
const tailscaleRuntime =
	tailscale && tailscaleClient
		? await startTailscaleServices({
				settings: tailscale,
				client: tailscaleClient,
				allocate: allocateServePort,
				inspect: (id) => {
					const local = inspectAi(id);
					return local ? Promise.resolve(local) : docker.getContainer(id).inspect();
				},
				authenticated: isCookieHeaderAuthenticated,
				ports: resolveServicePorts()
			})
		: null;
const ai = startAi();
// @ts-expect-error: build output, types not available at source time
const { handler } = await import('./handler.js');
const serviceGateway = tailscale ? null : createRuntimeServiceGateway(`http://localhost:${PORT}`);
const server = createServer((request, response) => {
	if (request.url === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
		response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
		response.end(request.method === 'HEAD' ? undefined : '{"status":"ready"}');
		return;
	}
	if (!proxyConfigured) request.headers[INTERNAL_PROTOCOL_HEADER] = 'http';
	if (serviceGateway?.matches(request.url)) {
		void serviceGateway.handle(request, response);
		return;
	}
	handler(request, response);
});
server.on('upgrade', (request, socket, head) => {
	if (serviceGateway?.matches(request.url)) void serviceGateway.upgrade(request, socket, head);
});
attachTerminalServer(server);
// Brain terminal tabs use the dashboard's authenticated listener, never the MCP listener.
attachBrainTerminalServer(server);
// The MCP endpoint has its own listener, so publishing it never exposes the dashboard.
const brainServer = brain ? createBrainServer(brain) : null;
let funnel: Awaited<ReturnType<typeof startBrainFunnel>> | null = null;
/** Close only the owned Funnel and all local resources, including on failed startup. */
async function closeResources() {
	if (brainServer) {
		brainServer.closeAllConnections();
		await new Promise<void>((resolve) => brainServer.close(() => resolve()));
	}
	await stopAllExecutions('The dashboard is shutting down');
	try {
		await funnel?.close();
	} finally {
		try {
			await tailscaleRuntime?.close();
		} finally {
			await ai?.close();
		}
	}
}
try {
	if (brain && brainServer) {
		await new Promise<void>((resolve, reject) => {
			brainServer.once('error', reject);
			brainServer.listen(brain.port, tailscale ? '127.0.0.1' : '0.0.0.0', resolve);
		});
		console.log(`Brain MCP endpoint listening on port ${brain.port}`);
	}
	if (tailscaleClient) {
		// With Funnel disabled this also retires a previous owned route from the retained volume.
		funnel = await startBrainFunnel(tailscaleClient, funnelSettings);
		if (brainState.gateway && funnel.publicUrl) {
			brainState.gateway.publicUrl = funnel.publicUrl;
			console.log(`Brain MCP PUBLIC Funnel: ${funnel.publicUrl}`);
		}
	}
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(PORT, tailscale ? '127.0.0.1' : '0.0.0.0', resolve);
	});
} catch (error) {
	await closeResources();
	throw error;
}
installShutdown(server, closeResources);
console.log(`DevDashboard server running on port ${PORT}`);
