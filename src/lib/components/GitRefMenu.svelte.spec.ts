/** Browser regressions for the Git ref menu of a repository row. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { flushSync, mount, unmount } from 'svelte';
import GitRefMenu from './GitRefMenu.svelte';
import type { RepoRefsResponse } from '$lib/types';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();

const response: RepoRefsResponse = {
	branches: ['feat/new', 'main'],
	tags: ['v1.0.0', 'v1.1.0'],
	currentBranch: 'main',
	refs: {
		local: [
			{ name: 'feat/new', sha: 'a1', date: hoursAgo(1) },
			{ name: 'main', sha: 'b2', date: hoursAgo(20), upstream: 'origin/main', ahead: 0, behind: 2 }
		],
		remote: [
			{
				name: 'origin/main',
				sha: 'c3',
				date: hoursAgo(2),
				remote: 'origin',
				branch: 'main',
				hasLocal: true
			},
			{
				name: 'origin/fix/13-production-startup',
				sha: 'd4',
				date: hoursAgo(72),
				remote: 'origin',
				branch: 'fix/13-production-startup',
				hasLocal: false
			}
		],
		tags: [
			{ name: 'v1.1.0', sha: 'c3', date: hoursAgo(30) },
			{ name: 'v1.0.0', sha: 'e5', date: hoursAgo(300) }
		],
		lastFetchedAt: hoursAgo(3)
	}
};

const mounted: ReturnType<typeof mount>[] = [];
const targets: HTMLElement[] = [];

/** Mount the menu with a parent that owns `open`, as LocalWorkspaces does. */
function fixture() {
	vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(response));
	const target = document.createElement('div');
	target.style.cssText = 'padding: 16px; min-height: 520px';
	document.body.append(target);
	targets.push(target);
	const outside = document.createElement('button');
	outside.textContent = 'Outside';
	document.body.append(outside);
	targets.push(outside);
	const onCheckout = vi.fn();
	const props = $state({ open: false });
	const component = mount(GitRefMenu, {
		target,
		props: {
			repoPath: '/workspaces/task/devharbour',
			currentBranch: 'main',
			get open() {
				return props.open;
			},
			checkingOut: false,
			onToggle: () => (props.open = !props.open),
			onClose: () => (props.open = false),
			onCheckout
		}
	});
	mounted.push(component);
	flushSync();
	return { onCheckout, outside, props };
}

afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	for (const target of targets.splice(0)) target.remove();
	vi.restoreAllMocks();
});

describe('Git ref menu', () => {
	it('lists local branches, remote branches and tags, each newest first', async () => {
		fixture();
		await page.getByRole('button', { name: 'main' }).click();
		await expect.element(page.getByRole('option', { name: /feat\/new/ })).toBeVisible();
		const names = [...document.querySelectorAll('[role="option"] .truncate')].map(
			(el) => el.textContent
		);
		expect(names).toEqual([
			'feat/new',
			'main',
			'origin/main',
			'origin/fix/13-production-startup',
			'v1.1.0',
			'v1.0.0'
		]);
		await expect.element(page.getByRole('combobox')).toHaveFocus();
	});

	it('filters with every search word and checks out with the keyboard', async () => {
		const { onCheckout } = fixture();
		await page.getByRole('button', { name: 'main' }).click();
		await expect.element(page.getByRole('option', { name: /feat\/new/ })).toBeVisible();
		await userEvent.type(page.getByRole('combobox'), 'fix 13');
		await expect.element(page.getByRole('option', { name: /feat\/new/ })).not.toBeInTheDocument();
		await userEvent.keyboard('{Enter}');
		expect(onCheckout).toHaveBeenCalledWith({ remote: 'origin/fix/13-production-startup' });
	});

	it('closes on a press outside the menu and on Escape', async () => {
		const { outside, props } = fixture();
		await page.getByRole('button', { name: 'main' }).click();
		expect(props.open).toBe(true);
		await userEvent.click(outside);
		expect(props.open).toBe(false);
		await page.getByRole('button', { name: 'main' }).click();
		expect(props.open).toBe(true);
		await userEvent.keyboard('{Escape}');
		expect(props.open).toBe(false);
	});
});
