import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitLocalBranch, GitRefEntry, GitRefs, GitRemoteBranch } from '$lib/types';

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

/** Network operations stop after this time, so that an unreachable remote cannot block a request. */
const NETWORK_TIMEOUT_MS = 120_000;

/** Git never prompts: the server has no terminal, and a prompt would hang the request. */
const NON_INTERACTIVE_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' };

/** Field separator for `git for-each-ref` output. Ref names cannot contain NUL. */
const FIELD = '%00';

/**
 * Turn a failed Git process into a short message. The message is Git's own stderr
 * without the `Command failed: git ...` prefix that execFile adds.
 */
export function gitFailureMessage(cause: unknown): string {
	const failure = cause as { stderr?: string; killed?: boolean; message?: string };
	if (failure?.killed) return 'Git did not finish in time. Check the network and the remote.';
	const stderr = typeof failure?.stderr === 'string' ? failure.stderr.trim() : '';
	if (stderr) return stderr.split('\n').slice(-6).join('\n').slice(0, 500);
	return failure?.message?.split('\n')[0] ?? 'Git failed';
}

/** Parse `ahead N, behind M` or `gone` from `%(upstream:track,nobracket)`. */
export function parseTrack(
	track: string
): Pick<GitLocalBranch, 'ahead' | 'behind' | 'upstreamGone'> {
	if (track === 'gone') return { upstreamGone: true };
	const ahead = track.match(/ahead (\d+)/);
	const behind = track.match(/behind (\d+)/);
	return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

/** Newest date first. Entries without a date go last, in name order. */
function newestFirst(a: GitRefEntry, b: GitRefEntry): number {
	if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
	if (a.date && !b.date) return -1;
	if (!a.date && b.date) return 1;
	return a.name.localeCompare(b.name);
}

/** Normalize an ISO date with an offset to UTC, so that string order is time order. */
function utc(date: string): string | undefined {
	const time = Date.parse(date);
	return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/**
 * Parse branch lines of `git for-each-ref` into local and remote branches.
 * Fields: full ref name, short SHA, committer date, upstream, upstream track, symref target.
 */
export function parseBranchRefs(output: string): Pick<GitRefs, 'local' | 'remote'> {
	const local: GitLocalBranch[] = [];
	const remote: GitRemoteBranch[] = [];
	for (const line of output.split('\n')) {
		if (!line) continue;
		const [ref, sha, date, upstream, track, symref] = line.split('\0');
		// Skip symbolic refs such as refs/remotes/origin/HEAD.
		if (symref) continue;
		if (ref.startsWith('refs/heads/')) {
			local.push({
				name: ref.slice('refs/heads/'.length),
				sha,
				date: utc(date),
				...(upstream ? { upstream, ...parseTrack(track) } : {})
			});
		} else if (ref.startsWith('refs/remotes/')) {
			const name = ref.slice('refs/remotes/'.length);
			const slash = name.indexOf('/');
			if (slash < 1) continue;
			remote.push({
				name,
				sha,
				date: utc(date),
				remote: name.slice(0, slash),
				branch: name.slice(slash + 1),
				hasLocal: false
			});
		}
	}
	const localNames = new Set(local.map((b) => b.name));
	for (const branch of remote) branch.hasLocal = localNames.has(branch.branch);
	return { local: local.sort(newestFirst), remote: remote.sort(newestFirst) };
}

/** Parse tag lines of `git for-each-ref`. Fields: tag name, peeled or direct short SHA, creator date. */
export function parseTagRefs(output: string): GitRefEntry[] {
	const tags: GitRefEntry[] = [];
	for (const line of output.split('\n')) {
		if (!line) continue;
		const [name, sha, date] = line.split('\0');
		tags.push({ name, sha, date: utc(date) });
	}
	return tags.sort(newestFirst);
}

/** Read the time of the last fetch from `.git/FETCH_HEAD`, if a fetch has run. */
async function lastFetchTime(repoPath: string): Promise<string | undefined> {
	try {
		return (await stat(join(repoPath, '.git', 'FETCH_HEAD'))).mtime.toISOString();
	} catch {
		return undefined;
	}
}

/**
 * List local branches, remote branches and tags, each ordered newest first.
 * Branches use the committer date of their tip. Tags use their creation date.
 */
export async function listRefs(repoPath: string): Promise<GitRefs> {
	const branchFormat = [
		'%(refname)',
		'%(objectname:short)',
		'%(committerdate:iso-strict)',
		'%(upstream:short)',
		'%(upstream:track,nobracket)',
		'%(symref)'
	].join(FIELD);
	const tagFormat = [
		'%(refname:strip=2)',
		'%(if)%(*objectname)%(then)%(*objectname:short)%(else)%(objectname:short)%(end)',
		'%(creatordate:iso-strict)'
	].join(FIELD);
	const options = { maxBuffer: 16 * 1024 * 1024 };
	const [branches, tags, lastFetchedAt] = await Promise.all([
		execFileAsync(
			'git',
			['-C', repoPath, 'for-each-ref', `--format=${branchFormat}`, 'refs/heads', 'refs/remotes'],
			options
		),
		execFileAsync(
			'git',
			['-C', repoPath, 'for-each-ref', `--format=${tagFormat}`, 'refs/tags'],
			options
		),
		lastFetchTime(repoPath)
	]);
	return { ...parseBranchRefs(branches.stdout), tags: parseTagRefs(tags.stdout), lastFetchedAt };
}

/**
 * Fetch all remotes and prune remote-tracking branches that the remotes deleted.
 * Local tags are never pruned: `--prune` without `--tags` touches remote-tracking refs only.
 */
export async function gitFetch(repoPath: string): Promise<string> {
	const { stdout, stderr } = await execFileAsync(
		'git',
		['-C', repoPath, 'fetch', '--all', '--prune'],
		{ env: NON_INTERACTIVE_ENV, timeout: NETWORK_TIMEOUT_MS }
	);
	return (stdout + stderr).trim();
}

/**
 * Pull the current branch from its upstream with fast-forward only.
 * A diverged branch fails with Git's message instead of creating a merge commit.
 */
export async function gitPullFastForward(repoPath: string): Promise<string> {
	const { stdout, stderr } = await execFileAsync('git', ['-C', repoPath, 'pull', '--ff-only'], {
		env: NON_INTERACTIVE_ENV,
		timeout: NETWORK_TIMEOUT_MS
	});
	return (stdout + stderr).trim();
}

/**
 * Check out a remote-tracking branch, for example `origin/feat/x`.
 * Git creates the local branch `feat/x` that tracks it. The caller must first verify
 * that the remote branch exists and that no local branch with the same name exists.
 */
export async function gitCheckoutRemote(repoPath: string, remoteBranch: string): Promise<void> {
	if (!/^[\w\-/.]+$/.test(remoteBranch) || remoteBranch.startsWith('-')) {
		throw new Error(`Invalid branch name: "${remoteBranch}"`);
	}
	await execFileAsync('git', ['-C', repoPath, 'switch', '--track', remoteBranch]);
}

/** Remote-tracking branches only, for checkout validation. */
export async function listRemoteRefs(repoPath: string): Promise<GitRemoteBranch[]> {
	return (await listRefs(repoPath)).remote;
}
