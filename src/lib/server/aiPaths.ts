/** Canonical directory selection. This validates input; it is not an agent sandbox. */
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/** Accept existing directories at or below the mounted root after resolving symlinks. */
export async function aiDirectory(root: string, requested: string): Promise<string> {
	if (!isAbsolute(root) || !isAbsolute(requested) || requested.includes('\0'))
		throw new Error('Select an absolute workspace directory.');
	const [base, path] = await Promise.all([realpath(root), realpath(requested)]);
	const rest = relative(base, path);
	if (rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest))
		throw new Error('Directory is outside the workspace.');
	if (!(await stat(path)).isDirectory()) throw new Error('Select a directory.');
	return path;
}

/** Read one level, including ordinary folders and safe symlinks. */
export async function aiFolders(root: string, requested = root) {
	const path = await aiDirectory(root, requested);
	const base = await realpath(root);
	const children: { name: string; path: string }[] = [];
	for (const entry of await readdir(path, { withFileTypes: true })) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		try {
			children.push({ name: entry.name, path: await aiDirectory(base, join(path, entry.name)) });
		} catch {
			// Omit broken, inaccessible and escaping links.
		}
	}
	children.sort((a, b) => a.name.localeCompare(b.name));
	return { path, parent: path === base ? null : dirname(path), children };
}
