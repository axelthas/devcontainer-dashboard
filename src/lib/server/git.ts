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
 * Read the current tag when HEAD is detached.
 * Returns undefined if HEAD is on a branch or no tag points at HEAD.
 */
export async function readCurrentTag(repoPath: string): Promise<string | undefined> {
	const headPath = join(repoPath, '.git', 'HEAD');
	try {
		const content = await readFile(headPath, 'utf-8');
		const trimmed = content.trim();
		// If HEAD is a ref (branch), not detached
		if (trimmed.startsWith('ref:')) return undefined;
		// HEAD is a raw commit SHA — check if any tag points to it
		const headSha = trimmed;
		const tags = await listTags(repoPath);
		for (const tag of tags) {
			const sha = await resolveTagSha(repoPath, tag);
			if (sha === headSha) return tag;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a tag name to the commit SHA it points at.
 */
async function resolveTagSha(repoPath: string, tag: string): Promise<string | undefined> {
	// Check lightweight tag in refs/tags/
	const tagRefPath = join(repoPath, '.git', 'refs', 'tags', ...tag.split('/'));
	try {
		const content = await readFile(tagRefPath, 'utf-8');
		return content.trim();
	} catch {
		// Fall through to packed-refs
	}
	// Check packed-refs
	const packedRefsPath = join(repoPath, '.git', 'packed-refs');
	try {
		const content = await readFile(packedRefsPath, 'utf-8');
		const lines = content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.startsWith('#') || line.startsWith('^')) continue;
			const match = line.match(/^([0-9a-f]+) refs\/tags\/(.+)$/);
			if (match && match[2] === tag) {
				// If next line starts with ^, that's the dereferenced (commit) SHA for annotated tags
				if (i + 1 < lines.length && lines[i + 1].startsWith('^')) {
					return lines[i + 1].slice(1).trim();
				}
				return match[1];
			}
		}
	} catch {
		// packed-refs may not exist
	}
	return undefined;
}

/**
 * List tag names from .git/refs/tags/ and packed-refs.
 */
export async function listTags(repoPath: string): Promise<string[]> {
	const tags = new Set<string>();

	// Read from refs/tags/ recursively
	const tagsDir = join(repoPath, '.git', 'refs', 'tags');
	await walkRefs(tagsDir, '', tags);

	// Also read packed-refs for tags that have been packed
	const packedRefsPath = join(repoPath, '.git', 'packed-refs');
	try {
		const content = await readFile(packedRefsPath, 'utf-8');
		for (const line of content.split('\n')) {
			if (line.startsWith('#') || line.startsWith('^')) continue;
			const match = line.match(/^[0-9a-f]+ refs\/tags\/(.+)$/);
			if (match) tags.add(match[1]);
		}
	} catch {
		// packed-refs may not exist
	}

	return [...tags].sort();
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
 * List remote branch names (strips the remote prefix, e.g. "origin/main" → "main").
 * Excludes HEAD pointers.
 */
export async function listRemoteBranches(repoPath: string): Promise<string[]> {
	const branches = new Set<string>();

	// Read from refs/remotes/ recursively
	const remotesDir = join(repoPath, '.git', 'refs', 'remotes');
	if (existsSync(remotesDir)) {
		try {
			const remotes = await readdir(remotesDir, { withFileTypes: true });
			for (const remote of remotes) {
				if (!remote.isDirectory()) continue;
				const remoteDir = join(remotesDir, remote.name);
				const refSet = new Set<string>();
				await walkRefs(remoteDir, '', refSet);
				for (const ref of refSet) {
					if (ref === 'HEAD') continue;
					branches.add(ref);
				}
			}
		} catch {
			// Ignore read errors
		}
	}

	// Also read packed-refs for remote branches
	const packedRefsPath = join(repoPath, '.git', 'packed-refs');
	try {
		const content = await readFile(packedRefsPath, 'utf-8');
		for (const line of content.split('\n')) {
			if (line.startsWith('#') || line.startsWith('^')) continue;
			const match = line.match(/^[0-9a-f]+ refs\/remotes\/[^/]+\/(.+)$/);
			if (match && match[1] !== 'HEAD') branches.add(match[1]);
		}
	} catch {
		// packed-refs may not exist
	}

	return [...branches].sort();
}

/**
 * Checkout a branch. Validates branch name against known local or remote branches.
 * For remote-only branches, creates a local tracking branch.
 */
export async function gitCheckout(
	repoPath: string,
	branch: string,
	allowedBranches?: string[],
	allowedRemoteBranches?: string[]
): Promise<void> {
	const inLocal = !allowedBranches || allowedBranches.includes(branch);
	const inRemote = allowedRemoteBranches?.includes(branch);

	if (allowedBranches && !inLocal && !inRemote) {
		throw new Error(`Branch "${branch}" not found in repository`);
	}

	// Validate branch name format to prevent injection
	if (!/^[\w\-/.]+$/.test(branch)) {
		throw new Error(`Invalid branch name: "${branch}"`);
	}

	if (inLocal) {
		await execFileAsync('git', ['-C', repoPath, 'checkout', branch]);
	} else {
		// Create local tracking branch from remote
		await execFileAsync('git', ['-C', repoPath, 'checkout', '-b', branch, `origin/${branch}`]);
	}
}

/**
 * Checkout a tag (results in detached HEAD).
 * Validates tag name format to prevent injection.
 */
export async function gitCheckoutTag(repoPath: string, tag: string): Promise<void> {
	if (!/^[\w\-/.]+$/.test(tag)) {
		throw new Error(`Invalid tag name: "${tag}"`);
	}
	await execFileAsync('git', ['-C', repoPath, 'checkout', `tags/${tag}`]);
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
