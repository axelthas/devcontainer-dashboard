// Custom production entry point: HTTP and terminal WebSocket support.
import { createServer } from 'node:http';
import { attachTerminalServer } from './lib/server/terminal.js';
import { assertAuthConfigured } from './lib/server/auth.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

assertAuthConfigured();

// Ignore forwarded protocol headers unless the operator configured a proxy.
const INTERNAL_PROTOCOL_HEADER = 'x-devcontainer-dashboard-protocol';
const proxyConfigured = Boolean(process.env.ORIGIN || process.env.PROTOCOL_HEADER);
if (!proxyConfigured) process.env.PROTOCOL_HEADER = INTERNAL_PROTOCOL_HEADER;

// @ts-expect-error: build output, types not available at source time
const { handler } = await import('./handler.js');

const server = createServer((request, response) => {
	// Application readiness only. Do not disclose Docker, workspace, or session state.
	// This becomes reachable only after auth configuration and handler initialization.
	if (request.url === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
		response.writeHead(200, {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store'
		});
		response.end(request.method === 'HEAD' ? undefined : '{"status":"ready"}');
		return;
	}
	if (!proxyConfigured) request.headers[INTERNAL_PROTOCOL_HEADER] = 'http';
	handler(request, response);
});

attachTerminalServer(server);

server.listen(PORT, '0.0.0.0', () => {
	console.log(`DevDashboard server running on port ${PORT}`);
});
