// Custom production entry point: HTTP and terminal WebSocket support.
import { createServer } from 'node:http';
import { attachTerminalServer } from './lib/server/terminal.js';
import { assertAuthConfigured, isCookieHeaderAuthenticated } from './lib/server/auth.js';
import {
	createRuntimeServiceGateway,
	resolveServicePorts
} from './lib/server/serviceGatewayRuntime.js';
import docker from './lib/server/docker.js';
import { allocateServePort, createServeConfigClient } from './lib/server/tailscaleServe.js';
import { startTailscaleServices, tailscaleSettings } from './lib/server/tailscaleServiceRuntime.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
assertAuthConfigured();
const tailscale = tailscaleSettings(process.env);

// Ignore forwarded protocol headers unless the operator configured a proxy.
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
				inspect: (id) => docker.getContainer(id).inspect(),
				authenticated: isCookieHeaderAuthenticated,
				ports: resolveServicePorts()
			})
		: null;

// @ts-expect-error: build output, types not available at source time
const { handler } = await import('./handler.js');
// The existing flag also enables identity-based UI links. Do not expose its
// same-origin path proxy when dedicated Tailscale service origins are active.
const serviceGateway = tailscale ? null : createRuntimeServiceGateway(`http://localhost:${PORT}`);

const server = createServer((request, response) => {
	if (request.url === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
		response.writeHead(200, {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store'
		});
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

// Host-network mode is Linux-only and both listeners must remain host-loopback only.
server.listen(PORT, tailscale ? '127.0.0.1' : '0.0.0.0', () => {
	console.log(`DevDashboard server running on port ${PORT}`);
});

/** Stop public work first, then conditionally retire owned Serve listeners on graceful shutdown. */
async function shutdown() {
	server.close();
	const deadline = setTimeout(() => process.exit(1), 15_000);
	deadline.unref();
	try {
		await tailscaleRuntime?.close();
		process.exit(0);
	} catch {
		console.error('[tailscale] Shutdown cleanup incomplete; ownership journal retained');
		process.exit(1);
	}
}
if (tailscaleRuntime) {
	process.once('SIGTERM', () => {
		void shutdown();
	});
	process.once('SIGINT', () => {
		void shutdown();
	});
}
