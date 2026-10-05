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

test('protected page requires a valid dashboard session', async ({ page }) => {
	await page.goto('/demo/playwright');
	await expect(page).toHaveURL(/\/login\?next=%2Fdemo%2Fplaywright$/);

	await page.getByLabel('Password').fill('wrong-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toHaveText('Invalid password');

	await page.getByLabel('Password').fill('playwright-test-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/demo/playwright');
	await expect(page.locator('h1')).toBeVisible();
	await expect(page.locator('h1')).toHaveText('Playwright e2e test demo');

	const logout = await page.request.post('/logout', { maxRedirects: 0 });
	expect(logout.status()).toBe(303);
	await page.goto('/demo/playwright');
	await expect(page).toHaveURL(/\/login\?next=%2Fdemo%2Fplaywright$/);
});
