/**
 * EXAMPLE TEST — Client project (Browser environment via Playwright).
 *
 * This file demonstrates how to write a Vitest browser-mode test for a Svelte 5
 * component using `vitest-browser-svelte`. It runs in the "client" test project
 * (see vite.config.ts) with headless Chromium.
 *
 * Requirements:
 *   - Playwright system dependencies must be installed (`npx playwright install-deps`)
 *   - File must match the pattern `*.svelte.{test,spec}.ts` to be picked up by
 *     the client project
 *
 * Use this as a template when adding tests for Svelte components.
 */
import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Welcome from './Welcome.svelte';

describe('Welcome.svelte', () => {
	it('renders an h1 greeting for the host and a paragraph greeting for the guest', async () => {
		render(Welcome, { host: 'SvelteKit', guest: 'Vitest' });

		await expect
			.element(page.getByRole('heading', { level: 1 }))
			.toHaveTextContent('Hello, SvelteKit!');
		await expect.element(page.getByText('Hello, Vitest!')).toBeInTheDocument();
	});
});
