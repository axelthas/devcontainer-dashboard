import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import type { Plugin } from 'vite';
import { attachTerminalServer } from './src/lib/server/terminal.js';

function terminalDevPlugin(): Plugin {
	return {
		name: 'terminal-ws-dev',
		configureServer(server) {
			server.httpServer?.once('listening', () => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				attachTerminalServer(server.httpServer as any);
			});
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
