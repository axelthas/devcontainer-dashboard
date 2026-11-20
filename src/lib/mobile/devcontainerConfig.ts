/**
 * Devcontainer configuration choice per repository. The key and format are the ones the
 * desktop Local Workspaces section uses, so both interfaces build the same configuration.
 */
export const CONFIG_SELECTIONS_KEY = 'devcontainer-config-selections';

/** '.devcontainer/rocky8/devcontainer.json' is 'rocky8'; other layouts are 'default'. */
export function configDisplayName(configPath: string): string {
	const parts = configPath.split('/');
	return parts.length === 3 ? parts[1] : 'default';
}

/** Read every saved choice; storage errors mean no saved choice. */
function readAll(): Map<string, string> {
	try {
		const raw = localStorage.getItem(CONFIG_SELECTIONS_KEY);
		return new Map(raw ? (JSON.parse(raw) as [string, string][]) : []);
	} catch {
		return new Map();
	}
}

/** The saved configuration of a repository when it still exists, else the first one. */
export function savedConfig(repoPath: string, configs: string[]): string | undefined {
	const saved = readAll().get(repoPath);
	return saved && configs.includes(saved) ? saved : configs[0];
}

/** Save the choice for the desktop and the mobile interface. */
export function saveConfig(repoPath: string, configPath: string): void {
	const all = readAll();
	all.set(repoPath, configPath);
	try {
		localStorage.setItem(CONFIG_SELECTIONS_KEY, JSON.stringify([...all]));
	} catch {
		// The choice still applies to this page.
	}
}
