// Custom server entry point that extends the SvelteKit-built handler with WebSocket support.
// This file is compiled separately (see build script) and runs as: node build/server.js
import { createServer } from 'node:http';
import { attachTerminalServer } from './lib/server/terminal.js';
import { assertAuthConfigured } from './lib/server/auth.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

assertAuthConfigured();
process.env.PROTOCOL_HEADER ??= 'x-forwarded-proto';

// @ts-expect-error — build output, types not available at source time
const { handler } = await import('./handler.js');

const server = createServer((request, response) => {
	request.headers['x-forwarded-proto'] ??= 'http';
	handler(request, response);
});

attachTerminalServer(server);

server.listen(PORT, '0.0.0.0', () => {
	console.log(`DevDashboard server running on port ${PORT}`);
});
