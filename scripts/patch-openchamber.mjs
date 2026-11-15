/**
 * Apply the dashboard's directory-only draft integration to pinned OpenChamber sources.
 * Verify every original hash before writing anything. Never rewrite published/minified assets.
 * Usage: node scripts/patch-openchamber.mjs /path/to/openchamber-source
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const plans = [
	{
		path: 'packages/ui/src/App.tsx',
		hash: 'a8ca6026eeb505cc92673fa283a0f7231efafa0c5f9b06540928fe7e1bf27ecf',
		edits: [
			[
				"import { useRouter } from '@/hooks/useRouter';",
				"import { useRouter } from '@/hooks/useRouter';\nimport { readDashboardDraft } from '@/lib/dashboard-launch';"
			],
			[
				'    if (restore.attempt) return;\n    restore.attempt = beginLastSessionRestore',
				'    if (restore.attempt) return;\n    if (readDashboardDraft()) { restore.done = true; return; }\n    restore.attempt = beginLastSessionRestore'
			]
		]
	},
	{
		path: 'packages/ui/src/hooks/useRouter.ts',
		hash: 'a4a327768c98ca4a972b665deb543bea9dbc3f3464defb9612997a4c63625aa8',
		edits: [
			[
				"import React from 'react';",
				"import React from 'react';\nimport { initializeDashboardDraft } from '@/lib/dashboard-launch';"
			],
			[
				'    initializedRef.current = true;\n',
				`    initializedRef.current = true;
    if (!isVSCode && initializeDashboardDraft(
      new URLSearchParams(window.location.search),
      (options) => useSessionUIStore.getState().openNewSessionDraft(options),
    )) return;
`
			]
		]
	},
	{
		path: 'packages/ui/src/sync/session-ui-store.ts',
		hash: 'd31d42523995a63ceb0cb91d3e9ebcab29c275dc2c85b93f0d4444bf13506388',
		edits: [
			[
				'options?: Partial<NewSessionDraftState> & { automatic?: boolean }',
				'options?: Partial<NewSessionDraftState> & { automatic?: boolean; routeScoped?: boolean }'
			],
			[
				'    if (!(target === "chat" && isImplicitExternalChatFallback)) {',
				'    if (!options?.routeScoped && !(target === "chat" && isImplicitExternalChatFallback)) {'
			],
			[
				'      useDirectoryStore.getState().setDirectory(directory)\n',
				'      useDirectoryStore.getState().setDirectory(directory, { persist: !options?.routeScoped })\n'
			]
		]
	},
	{
		path: 'packages/ui/src/stores/useDirectoryStore.ts',
		hash: 'cc6c924232964473e9bb7736d1bfad737c5aec26acfa8408446b9b5e70069382',
		edits: [
			[
				'  setDirectory: (path: string, options?: { showOverlay?: boolean }) => void;',
				'  setDirectory: (path: string, options?: { showOverlay?: boolean; persist?: boolean }) => void;'
			],
			[
				'      setDirectory: (path: string, options?: { showOverlay?: boolean }) => {\n        void options;',
				'      setDirectory: (path: string, options?: { showOverlay?: boolean; persist?: boolean }) => {'
			],
			[
				"          safeStorage.setItem('lastDirectory', resolvedPath);\n          void updateDesktopSettings({ lastDirectory: resolvedPath });",
				"          if (options?.persist !== false) {\n            safeStorage.setItem('lastDirectory', resolvedPath);\n            void updateDesktopSettings({ lastDirectory: resolvedPath });\n          }"
			],
			[
				'            historyIndex: alreadyCurrent ? state.historyIndex : newHistory.length - 1,\n            hasPersistedDirectory: true,',
				'            historyIndex: alreadyCurrent ? state.historyIndex : newHistory.length - 1,\n            hasPersistedDirectory: options?.persist === false ? state.hasPersistedDirectory : true,'
			]
		]
	}
];

/** A new upstream version requires an explicit patch review, never a best-effort partial edit. */
export function patchSource(path, source) {
	const plan = plans.find((entry) => entry.path === path);
	if (!plan || createHash('sha256').update(source).digest('hex') !== plan.hash)
		throw new Error(`Unsupported OpenChamber source: ${path}`);
	let result = source;
	for (const [before, after] of plan.edits) {
		if (result.split(before).length !== 2)
			throw new Error(`Non-unique OpenChamber patch anchor: ${path}`);
		result = result.replace(before, after);
	}
	return result;
}

/** Validate the full patch first; only then write the four sources and the integration helper. */
export async function patchOpenChamber(root) {
	const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
	if (metadata.version !== '2.7.1') throw new Error('This integration requires OpenChamber 2.7.1.');
	const helper = join(root, 'packages/ui/src/lib/dashboard-launch.ts');
	try {
		await access(helper);
		throw new Error('OpenChamber dashboard integration already exists.');
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	const pending = await Promise.all(
		plans.map(async ({ path }) => ({
			path: join(root, path),
			content: patchSource(path, await readFile(join(root, path), 'utf8'))
		}))
	);
	const content = await readFile(
		new URL('../integrations/openchamber/dashboard-launch.ts', import.meta.url),
		'utf8'
	);
	for (const file of pending) await writeFile(file.path, file.content);
	await writeFile(helper, content);
	return pending.map((file) => file.path);
}

/** Keep imports side-effect free for regression tests. */
async function main() {
	if (!process.argv[2]) throw new Error('An OpenChamber source directory is required.');
	await patchOpenChamber(resolve(process.argv[2]));
	console.log('Applied the pinned OpenChamber directory-draft integration.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	await main();
