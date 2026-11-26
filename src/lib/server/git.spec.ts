import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitFetch, gitPullFastForward, listRefs, parseTrack } from './git';

/** Run git with fixed identity and dates, so the commit order is deterministic. */
function git(cwd: string, args: string[], date = '2026-01-01T00:00:00Z') {
	return execFileSync('git', args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Test',
			GIT_AUTHOR_EMAIL: 'test@example.com',
			GIT_COMMITTER_NAME: 'Test',
			GIT_COMMITTER_EMAIL: 'test@example.com',
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: date
		},
		encoding: 'utf-8'
	});
}

function commit(cwd: string, file: string, date: string) {
	writeFileSync(join(cwd, file), date);
	git(cwd, ['add', file], date);
	git(cwd, ['commit', '-q', '-m', file], date);
}

describe('listRefs, gitFetch and gitPullFastForward', () => {
	let root: string;
	let origin: string;
	let clone: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'devharbour-git-'));
		origin = join(root, 'origin');
		clone = join(root, 'clone');
		git(root, ['init', '-q', '-b', 'main', origin]);
		commit(origin, 'a.txt', '2026-01-01T00:00:00Z');
		git(origin, ['tag', 'v1.0.0'], '2026-01-01T00:00:00Z');
		git(origin, ['switch', '-q', '-c', 'feat/new'], '2026-03-01T00:00:00Z');
		commit(origin, 'b.txt', '2026-03-01T00:00:00Z');
		git(origin, ['switch', '-q', 'main']);
		commit(origin, 'c.txt', '2026-02-01T00:00:00Z');
		git(origin, ['tag', '-a', 'v1.1.0', '-m', 'release'], '2026-02-02T00:00:00Z');
		git(root, ['clone', '-q', origin, clone]);
		git(clone, ['switch', '-q', '-c', 'local-only'], '2026-04-01T00:00:00Z');
		commit(clone, 'd.txt', '2026-04-01T00:00:00Z');
		git(clone, ['switch', '-q', 'main']);
	});

	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it('orders local branches, remote branches and tags newest first', async () => {
		const refs = await listRefs(clone);
		expect(refs.local.map((b) => b.name)).toEqual(['local-only', 'main']);
		expect(refs.local[1]).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 });
		expect(refs.remote.map((b) => b.name)).toEqual(['origin/feat/new', 'origin/main']);
		expect(refs.remote.map((b) => b.hasLocal)).toEqual([false, true]);
		expect(refs.tags.map((t) => t.name)).toEqual(['v1.1.0', 'v1.0.0']);
		// An annotated tag reports the commit it points at, not the tag object.
		const mainSha = git(clone, ['rev-parse', '--short', 'origin/main']).trim();
		expect(refs.tags[0].sha).toBe(mainSha);
	});

	it('fetches new remote work and fast-forwards the current branch', async () => {
		commit(origin, 'e.txt', '2026-05-01T00:00:00Z');
		await gitFetch(clone);
		const fetched = await listRefs(clone);
		expect(fetched.local.find((b) => b.name === 'main')).toMatchObject({ behind: 1 });
		expect(fetched.lastFetchedAt).toBeDefined();
		await gitPullFastForward(clone);
		const pulled = await listRefs(clone);
		expect(pulled.local.find((b) => b.name === 'main')).toMatchObject({ behind: 0 });
	});

	it('refuses to merge a diverged branch', async () => {
		commit(origin, 'f.txt', '2026-06-01T00:00:00Z');
		commit(clone, 'g.txt', '2026-06-02T00:00:00Z');
		await gitFetch(clone);
		await expect(gitPullFastForward(clone)).rejects.toThrow();
	});

	it('parses upstream tracking text', () => {
		expect(parseTrack('ahead 2, behind 3')).toEqual({ ahead: 2, behind: 3 });
		expect(parseTrack('')).toEqual({ ahead: 0, behind: 0 });
		expect(parseTrack('gone')).toEqual({ upstreamGone: true });
	});
});
