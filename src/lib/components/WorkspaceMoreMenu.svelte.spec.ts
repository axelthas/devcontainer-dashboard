/** Browser regressions for the compact workspace overflow menu. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import WorkspaceMoreMenu from './WorkspaceMoreMenu.svelte';

const mounted: ReturnType<typeof mount>[] = [];
const targets: HTMLElement[] = [];

/**
 * Mount inside a clickable, clipped row, as the workspace header does.
 * The row spy sits on a parent of the mount target: Svelte delegates onclick to the
 * mount target, so a listener on the target itself always sees the click.
 */
function fixture(props: { canRerun: boolean; rerunning?: boolean; deleting?: boolean }) {
	const row = document.createElement('div');
	const target = document.createElement('div');
	target.style.overflow = 'hidden';
	row.append(target);
	const onRow = vi.fn();
	row.addEventListener('click', onRow);
	document.body.append(row);
	targets.push(row);
	const onRerun = vi.fn();
	const onDelete = vi.fn();
	mounted.push(
		mount(WorkspaceMoreMenu, {
			target,
			props: { name: 'git.polaris-ice', onRerun, onDelete, ...props }
		})
	);
	return { onRow, onRerun, onDelete };
}

/** Remove test-owned DOM; no workspace or bootstrap action runs for real. */
afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	for (const target of targets.splice(0)) target.remove();
	vi.restoreAllMocks();
});

const trigger = () => page.getByRole('button', { name: 'More actions: git.polaris-ice' });

describe('Workspace more actions', () => {
	it('offers rerun and delete for a bootstrapped workspace without toggling the row', async () => {
		const { onRow, onRerun, onDelete } = fixture({ canRerun: true });
		await trigger().click();
		await expect.element(page.getByRole('menuitem', { name: 'Rerun bootstrap' })).toBeVisible();
		await expect.element(page.getByRole('menuitem', { name: 'Delete workspace…' })).toBeVisible();
		await page.getByRole('menuitem', { name: 'Rerun bootstrap' }).click();
		expect(onRerun).toHaveBeenCalledOnce();
		expect(onDelete).not.toHaveBeenCalled();
		expect(onRow).not.toHaveBeenCalled();
		await expect.element(trigger()).toHaveAttribute('aria-expanded', 'false');
	});

	it('offers only delete when the workspace has no bootstrap metadata', async () => {
		const { onDelete } = fixture({ canRerun: false });
		await trigger().click();
		expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
		await page.getByRole('menuitem', { name: 'Delete workspace…' }).click();
		expect(onDelete).toHaveBeenCalledOnce();
	});

	it('disables running and deleting actions', async () => {
		fixture({ canRerun: true, rerunning: true, deleting: true });
		await trigger().click();
		await expect.element(page.getByRole('menuitem', { name: 'Bootstrap running…' })).toBeDisabled();
		await expect.element(page.getByRole('menuitem', { name: 'Delete workspace…' })).toBeDisabled();
	});

	it('closes on a second trigger click instead of reopening', async () => {
		fixture({ canRerun: true });
		await trigger().click();
		await expect.element(trigger()).toHaveAttribute('aria-expanded', 'true');
		await trigger().click();
		await expect.element(trigger()).toHaveAttribute('aria-expanded', 'false');
	});

	it('closes on Escape and returns focus to the trigger', async () => {
		fixture({ canRerun: true });
		await trigger().click();
		(document.activeElement as HTMLElement).dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
		);
		await expect.element(trigger()).toHaveAttribute('aria-expanded', 'false');
		expect(document.activeElement?.getAttribute('aria-label')).toBe(
			'More actions: git.polaris-ice'
		);
	});
});
