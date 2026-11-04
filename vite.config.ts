import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import type { Plugin } from 'vite';
import { assertAuthConfigured } from './src/lib/server/auth.js';
import { attachTerminalServer } from './src/lib/server/terminal.js';
import { createRuntimeServiceGateway } from './src/lib/server/serviceGatewayRuntime.js';

function terminalDevPlugin(): Plugin {
	return {
		name: 'terminal-ws-dev',
		configureServer(server) {
			if (!process.env.VITEST) assertAuthConfigured();
			const gateway = process.env.VITEST
				? null
				: createRuntimeServiceGateway('http://localhost:5173');
			if (gateway) {
				server.middlewares.use((request, response, next) => {
					if (gateway.matches(request.url)) void gateway.handle(request, response);
					else next();
				});
				server.httpServer?.on('upgrade', (request, socket, head) => {
					if (gateway.matches(request.url)) void gateway.upgrade(request, socket, head);
				});
			}
			server.httpServer?.once('listening', () => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				attachTerminalServer(server.httpServer as any);
			});
		},
		configurePreviewServer() {
			assertAuthConfigured();
		}
	};
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), terminalDevPlugin()],
	server: {
		host: '0.0.0.0',
		allowedHosts: true,
		cors: true
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
