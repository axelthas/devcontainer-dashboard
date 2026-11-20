/** DevHarbour branding regressions against the compiled custom server. */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { SERVER_INFO } from '../server/brain/mcp';
import { loginTerminalTest } from './terminalFixtures';

const nordColours = new Set(['#2e3440', '#eceff4', '#88c0d0', '#d08770', '#ebcb8b']);

test('brand assets are standalone Nord vectors and package metadata agrees', () => {
	for (const path of ['src/lib/assets/favicon.svg', 'static/devharbour-logo.svg']) {
		const svg = readFileSync(path, 'utf8');
		expect(svg).toContain('<svg');
		expect(svg).toContain('DevHarbour');
		expect(svg).not.toMatch(/<image\b|<script\b|<foreignObject\b|<text\b|href=/i);
		const colours = [...svg.matchAll(/fill="(#[a-f0-9]{6})"/g)].map((match) => match[1]);
		expect(colours.length).toBeGreaterThan(0);
		for (const colour of colours) expect(nordColours.has(colour)).toBe(true);
	}
	const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
	const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
	expect(manifest.name).toBe('devharbour');
	expect(lock.name).toBe(manifest.name);
	expect(lock.packages[''].name).toBe(manifest.name);
	expect(SERVER_INFO.name).toBe('devcontainer-dashboard');
	expect(SERVER_INFO.title).toBe('DevHarbour');
});

test('sign-in shows the new name and loads the puffin before authentication', async ({ page }) => {
	await page.goto('/login');
	await expect(page).toHaveTitle('Sign in | DevHarbour');
	await expect(page.getByRole('heading', { name: 'DevHarbour', exact: true })).toBeVisible();
	const icon = page.locator('section img');
	await expect(icon).toHaveAttribute('aria-hidden', 'true');
	await expect(icon).toHaveJSProperty('naturalWidth', 244);
	const favicon = page.locator('link[rel="icon"]');
	const href = await favicon.getAttribute('href');
	expect(href).toBeTruthy();
	const response = await page.request.get(href!);
	expect(response.ok()).toBe(true);
	expect(response.headers()['content-type']).toContain('image/svg+xml');
	expect(await response.text()).toContain('DevHarbour puffin');
});

test('dashboard branding preserves saved preferences in both themes', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem('devcontainer-dashboard-theme', 'light');
		localStorage.setItem('devcontainer-dashboard-view', 'list');
		localStorage.setItem('devcontainer-dashboard-vscode-ssh-host', 'branding-test-host');
		localStorage.setItem('devcontainer-dashboard-show-stopped', 'true');
	});
	await loginTerminalTest(page);
	await expect(page).toHaveTitle('DevHarbour');
	await expect(
		page.getByRole('heading', { level: 1, name: 'DevHarbour', exact: true })
	).toBeVisible();
	await expect(page.locator('header img')).toHaveJSProperty('naturalWidth', 244);
	await expect(page.locator('header')).toContainText('Your development environments, together.');
	await expect(page.getByPlaceholder('SSH host')).toHaveValue('branding-test-host');
	await expect(page.locator('header').locator('xpath=../..')).not.toHaveClass('dark');
	await page.getByTitle('Toggle theme').click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem('devcontainer-dashboard-theme')))
		.toBe('dark');
	await expect(page.locator('header').locator('xpath=../..')).toHaveClass('dark');
	const saved = await page.evaluate(() => ({
		view: localStorage.getItem('devcontainer-dashboard-view'),
		host: localStorage.getItem('devcontainer-dashboard-vscode-ssh-host'),
		stopped: localStorage.getItem('devcontainer-dashboard-show-stopped')
	}));
	expect(saved).toEqual({ view: 'list', host: 'branding-test-host', stopped: 'true' });
	await expect(
		page.getByRole('heading', { level: 1, name: 'DevHarbour', exact: true })
	).toBeVisible();
});
