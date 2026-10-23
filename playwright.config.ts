import { defineConfig } from '@playwright/test';

export default defineConfig({
	use: { baseURL: 'http://127.0.0.1:4173' },
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173,
		env: { DASHBOARD_PASSWORD: 'playwright-test-password' }
	},
	testMatch: '**/*.e2e.{ts,js}'
});
