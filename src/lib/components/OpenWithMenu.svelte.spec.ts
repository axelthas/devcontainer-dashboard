/** Browser regressions for the compact folder action menu. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import OpenWithMenu from './OpenWithMenu.svelte';

const mounted: ReturnType<typeof mount>[] = [];
const targets: HTMLElement[] = [];

/** Mount inside a clipped row, as the workspace table does. */
function fixture(aiDisabled = false) {
	const target = document.createElement('div');
	target.style.overflow = 'hidden';
	document.body.append(target);
	targets.push(target);
	const onOpenTerminal = vi.fn();
	mounted.push(
		mount(OpenWithMenu, {
			target,
			props: {
				path: '/workspaces/plain folder',
				vscodeSshHost: 'fixture-host',
				onOpenTerminal,
				aiDisabled
			}
		})
	);
	return { target, onOpenTerminal };
}

/** Remove test-owned DOM without closing actual terminal processes. */
afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	for (const target of targets.splice(0)) target.remove();
	vi.restoreAllMocks();
});

describe('Open with', () => {
	it('opens four actions without starting an application and closes on Escape', async () => {
		fixture();
		const open = vi.spyOn(window, 'open').mockReturnValue(null);
		await page.getByRole('button', { name: 'Open with: plain folder' }).click();
		for (const name of ['VS Code', 'Terminal', 'OpenCode TUI', 'OpenChamber'])
			await expect.element(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
		expect(open).not.toHaveBeenCalled();
		const item = document.activeElement as HTMLElement;
		item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await expect
			.element(page.getByRole('button', { name: 'Open with: plain folder' }))
			.toHaveAttribute('aria-expanded', 'false');
	});

	it('closes on a second trigger click instead of reopening', async () => {
		fixture();
		const trigger = page.getByRole('button', { name: 'Open with: plain folder' });
		await trigger.click();
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');
		await trigger.click();
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
	});

	it('keeps the existing terminal callback and VS Code SSH target', async () => {
		const { target, onOpenTerminal } = fixture();
		await page.getByRole('button', { name: 'Open with: plain folder' }).click();
		expect(target.querySelector('a')?.getAttribute('href')).toBe(
			'vscode://vscode-remote/ssh-remote+fixture-host/workspaces/plain folder?windowId=_blank'
		);
		await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
		expect(onOpenTerminal).toHaveBeenCalledWith(
			expect.any(String),
			'',
			'plain folder',
			'/workspaces/plain folder'
		);
	});

	it.each(['OpenCode TUI', 'OpenChamber'])(
		'opens %s synchronously without creating a conversation',
		async (name) => {
			fixture();
			const open = vi.spyOn(window, 'open').mockReturnValue(null);
			await page.getByRole('button', { name: 'Open with: plain folder' }).click();
			await page.getByRole('menuitem', { name, exact: true }).click();
			expect(open).toHaveBeenCalledOnce();
			const url = new URL(String(open.mock.calls[0][0]), window.location.origin);
			expect(url.pathname).toBe('/ai');
			expect(url.searchParams.get('path')).toBe('/workspaces/plain folder');
			expect(url.searchParams.get('tool')).toBe(
				name === 'OpenCode TUI' ? 'opencode' : 'openchamber'
			);
			expect(url.searchParams.has('session')).toBe(false);
		}
	);

	it('disables only AI actions when the backend is unavailable', async () => {
		fixture(true);
		await page.getByRole('button', { name: 'Open with: plain folder' }).click();
		await expect
			.element(page.getByRole('menuitem', { name: 'Terminal', exact: true }))
			.toBeEnabled();
		await expect.element(page.getByRole('menuitem', { name: 'OpenCode TUI' })).toBeDisabled();
		await expect.element(page.getByRole('menuitem', { name: 'OpenChamber' })).toBeDisabled();
	});
});
