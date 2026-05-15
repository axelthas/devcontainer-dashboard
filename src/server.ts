// Custom server entry point that extends the SvelteKit-built handler with WebSocket support.
// This file is compiled separately (see build script) and runs as: node build/server.js
import { createServer } from 'node:http';
// @ts-expect-error — build output, types not available at source time
import { handler } from './handler.js';
import { attachTerminalServer } from './lib/server/terminal.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const server = createServer(handler);

attachTerminalServer(server);

server.listen(PORT, '0.0.0.0', () => {
	console.log(`DevDashboard server running on port ${PORT}`);
});
