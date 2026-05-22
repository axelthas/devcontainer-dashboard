import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Read current branch from .git/HEAD without spawning git.
 * Returns undefined if not a branch (detached HEAD) or unreadable.
 */
export async function readGitHead(repoPath: string): Promise<string | undefined> {
	const headPath = join(repoPath, '.git', 'HEAD');
	try {
		const content = await readFile(headPath, 'utf-8');
		const match = content.trim().match(/^ref: refs\/heads\/(.+)$/);
		return match ? match[1] : undefined;
	} catch {
		return undefined;
	}
}

/**
 * List local branch names from .git/refs/heads/ (recursive) and packed-refs.
 */
export async function listLocalBranches(repoPath: string): Promise<string[]> {
	const branches = new Set<string>();

	// Read from refs/heads/ recursively
	const refsDir = join(repoPath, '.git', 'refs', 'heads');
	await walkRefs(refsDir, '', branches);

	// Also read packed-refs for branches that have been packed
	const packedRefsPath = join(repoPath, '.git', 'packed-refs');
	try {
		const content = await readFile(packedRefsPath, 'utf-8');
		for (const line of content.split('\n')) {
			if (line.startsWith('#') || line.startsWith('^')) continue;
			const match = line.match(/^[0-9a-f]+ refs\/heads\/(.+)$/);
			if (match) branches.add(match[1]);
		}
	} catch {
		// packed-refs may not exist
	}

	return [...branches].sort();
}

async function walkRefs(dir: string, prefix: string, branches: Set<string>): Promise<void> {
	if (!existsSync(dir)) return;
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const name = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walkRefs(join(dir, entry.name), name, branches);
			} else {
				branches.add(name);
			}
		}
	} catch {
		// Ignore read errors
	}
}

/**
 * Checkout a branch. Validates branch name against known local branches.
 */
export async function gitCheckout(
	repoPath: string,
	branch: string,
	allowedBranches?: string[]
): Promise<void> {
	if (allowedBranches && !allowedBranches.includes(branch)) {
		throw new Error(`Branch "${branch}" not found in repository`);
	}

	// Validate branch name format to prevent injection
	if (!/^[\w\-/.]+$/.test(branch)) {
		throw new Error(`Invalid branch name: "${branch}"`);
	}

	await execFileAsync('git', ['-C', repoPath, 'checkout', branch]);
}

/**
 * Pull the current branch.
 */
export async function gitPull(repoPath: string): Promise<string> {
	const { stdout, stderr } = await execFileAsync('git', ['-C', repoPath, 'pull']);
	return (stdout + stderr).trim();
}

/**
 * Check if the working tree is dirty.
 */
export async function isWorkingTreeDirty(repoPath: string): Promise<boolean> {
	const { stdout } = await execFileAsync('git', ['-C', repoPath, 'status', '--porcelain']);
	return stdout.trim().length > 0;
}

/**
 * Get version info via git describe.
 */
export async function gitDescribe(repoPath: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync('git', [
			'-C',
			repoPath,
			'describe',
			'--tags',
			'--always'
		]);
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}
