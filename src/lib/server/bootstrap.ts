import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { BootstrapProvider } from '$lib/types';

const BOOTSTRAP_PROVIDERS_FILE =
	process.env.BOOTSTRAP_PROVIDERS_FILE ?? '/data/bootstrap-providers.json';

/**
 * Expand ~ to the user's home directory in a path.
 */
export function expandHome(p: string): string {
	if (p.startsWith('~/')) return p.replace('~', homedir());
	if (p === '~') return homedir();
	return p;
}

/**
 * Read the bootstrap providers configuration file.
 * Returns an empty array if the file doesn't exist.
 */
export async function loadBootstrapProviders(): Promise<BootstrapProvider[]> {
	if (!existsSync(BOOTSTRAP_PROVIDERS_FILE)) return [];
	try {
		const raw = await readFile(BOOTSTRAP_PROVIDERS_FILE, 'utf-8');
		return JSON.parse(raw) as BootstrapProvider[];
	} catch {
		return [];
	}
}

/**
 * Get the default provider (first one configured), or a fallback
 * provider pointing to ~/.devbootstrap if no config file exists.
 */
export async function getActiveProvider(): Promise<BootstrapProvider | undefined> {
	const providers = await loadBootstrapProviders();
	if (providers.length > 0) return providers[0];

	// Fallback: check if ~/.devbootstrap exists
	const defaultPath = expandHome('~/.devbootstrap');
	if (existsSync(defaultPath)) {
		return {
			id: 'devbootstrap',
			name: 'Dev Bootstrap',
			repoPath: defaultPath,
			commands: {
				update: 'devbootstrap -u',
				rerun: 'devbootstrap --rerun -d {workspacePath}'
			},
			metadataFile: '.solution-metadata.json'
		};
	}

	return undefined;
}
