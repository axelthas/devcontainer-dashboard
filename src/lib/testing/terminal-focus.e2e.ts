/** Real-pointer focus regressions. Run against the compiled custom server. */
import { expect, test } from '@playwright/test';
import { loginTerminalTest, selectTerminal, terminalMarker } from './terminalFixtures';

test('three terminal panes remain independently usable', async ({ page }) => {
	await loginTerminalTest(page);
	const ids: string[] = [];
	for (let index = 0; index < 3; index++) {
		await page.getByRole('button', { name: 'New shell', exact: true }).click();
		const tab = page.locator('[data-terminal-tab]').last();
		ids.push((await tab.getAttribute('data-terminal-tab'))!);
	}
	for (const [index, id] of ids.entries()) {
		await selectTerminal(page, id);
		const pane = page.locator(`[data-terminal-pane="${id}"]`);
		await pane.locator('.xterm-screen').click({ position: { x: 25, y: 20 } });
		await expect(pane.locator('.xterm-helper-textarea')).toBeFocused();
		await terminalMarker(page, id, `terminal-${index}-ok`);
	}
	await page.getByRole('button', { name: 'Toggle terminal drawer' }).click();
	await page.getByRole('button', { name: 'Toggle terminal drawer' }).click();
	await selectTerminal(page, ids[0]);
	await page.getByRole('button', { name: 'Maximize terminal' }).click();
	await page.getByRole('button', { name: 'Restore terminal' }).click();
	await selectTerminal(page, ids[1]);
});
