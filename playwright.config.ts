import { defineConfig } from '@playwright/test';

export default defineConfig({
	use: { baseURL: 'http://127.0.0.1:4173' },
	webServer: {
		command: 'npm run build && npm run build:server && npm start',
		url: 'http://127.0.0.1:4173/healthz',
		env: { DASHBOARD_PASSWORD: 'playwright-test-password', PORT: '4173' }
	},
	testMatch: '**/*.e2e.{ts,js}'
});
