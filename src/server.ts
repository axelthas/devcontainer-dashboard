// Custom server entry point that extends the SvelteKit-built handler with WebSocket support.
// This file is compiled separately (see build script) and runs as: node build/server.js
import { createServer } from 'node:http';
import { attachTerminalServer } from './lib/server/terminal.js';
import { assertAuthConfigured } from './lib/server/auth.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

assertAuthConfigured();

// adapter-node assumes HTTPS unless ORIGIN or PROTOCOL_HEADER is set. When neither is set, this
// plain HTTP server sets the protocol itself and ignores client-supplied forwarded headers.
// Behind a TLS reverse proxy, set ORIGIN or PROTOCOL_HEADER (and ADDRESS_HEADER) explicitly.
const INTERNAL_PROTOCOL_HEADER = 'x-devcontainer-dashboard-protocol';
const proxyConfigured = Boolean(process.env.ORIGIN || process.env.PROTOCOL_HEADER);
if (!proxyConfigured) process.env.PROTOCOL_HEADER = INTERNAL_PROTOCOL_HEADER;

// @ts-expect-error — build output, types not available at source time
const { handler } = await import('./handler.js');

const server = createServer((request, response) => {
	if (!proxyConfigured) request.headers[INTERNAL_PROTOCOL_HEADER] = 'http';
	handler(request, response);
});

attachTerminalServer(server);

server.listen(PORT, '0.0.0.0', () => {
	console.log(`DevDashboard server running on port ${PORT}`);
});
