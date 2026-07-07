/**
 * E2E smoke test — Playwright canary.
 *
 * This test validates that the Playwright e2e infrastructure works correctly:
 * the app builds, the preview server starts, and the browser can navigate and
 * assert against a rendered page.
 *
 * It uses the `/demo/playwright` route which is a minimal static page designed
 * specifically for this purpose — it has no server-side dependencies (Docker,
 * file system, etc.) so it can run in any CI environment.
 *
 * Requirements:
 *   - Playwright system dependencies installed (`npx playwright install-deps`)
 *   - The app must build successfully (`npm run build`)
 *   - Preview server must be reachable on port 4173
 */
import { expect, test } from '@playwright/test';

test('demo page renders with the expected heading', async ({ page }) => {
	await page.goto('/demo/playwright');
	await expect(page.locator('h1')).toBeVisible();
	await expect(page.locator('h1')).toHaveText('Playwright e2e test demo');
});
