/** Canonical folder selection for local AI. This is input validation, not a sandbox. */
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/** Accept an existing directory at or below the configured root after symlink resolution. */
export async function aiFolder(root: string, requested: string): Promise<string> {
	if (!isAbsolute(root) || !isAbsolute(requested) || requested.includes('\0')) {
		throw new Error('Select an absolute directory inside the workspace root.');
	}
	const [base, target] = await Promise.all([realpath(root), realpath(requested)]);
	const remainder = relative(base, target);
	if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
		throw new Error('The directory is outside the workspace root.');
	}
	if (!(await stat(target)).isDirectory()) throw new Error('Select a directory.');
	return target;
}

/** Read one level, including non-Git folders and safe symlinks, without recursive scanning. */
export async function aiFolders(root: string, requested = root) {
	const path = await aiFolder(root, requested);
	const base = await realpath(root);
	const children: { name: string; path: string }[] = [];
	const entries = await readdir(path, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		try {
			const target = await aiFolder(base, join(path, entry.name));
			children.push({ name: entry.name, path: target });
		} catch {
			// Broken, inaccessible and escaping symlinks are not selectable.
		}
	}
	children.sort((a, b) => a.name.localeCompare(b.name));
	return { root: base, path, parent: path === base ? null : dirname(path), children };
}
