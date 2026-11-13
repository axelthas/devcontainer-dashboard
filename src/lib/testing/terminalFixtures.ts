/** Shared browser helpers for terminal tests against the compiled custom server. */
import { expect, type Page } from '@playwright/test';

/** Sign in without bypassing the application's form or session cookie. */
export async function loginTerminalTest(page: Page): Promise<void> {
	await page.goto('/login');
	await page.locator('input[name="password"]').fill('playwright-test-password');
	await page.locator('button[type="submit"]').click();
	await expect(page).not.toHaveURL(/\/login/);
}

/** Use a real pointer click; forced clicks would conceal overlapping pane regressions. */
export async function selectTerminal(page: Page, id: string): Promise<void> {
	await page.locator(`[data-terminal-tab="${id}"]`).click();
	await expect(page.locator(`[data-terminal-pane="${id}"] .xterm-helper-textarea`)).toBeFocused();
}

/** Send a harmless session-specific marker through the currently focused xterm input. */
export async function terminalMarker(page: Page, id: string, marker: string): Promise<void> {
	await page.keyboard.type(`printf '${marker}\\n'`);
	await page.keyboard.press('Enter');
	await expect(page.locator(`[data-terminal-pane="${id}"] .xterm-rows`)).toContainText(marker);
}
