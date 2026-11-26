import { describe, expect, it } from 'vitest';
import {
	fallbackRefs,
	filterRefs,
	matchesQuery,
	refItems,
	relativeAge,
	summarizeFetch,
	summarizePull
} from './gitRefs';
import type { GitRefs } from './types';

const refs: GitRefs = {
	local: [
		{ name: 'feat/42-terminal-engines', sha: 'a1' },
		{ name: 'main', sha: 'b2' }
	],
	remote: [
		{
			name: 'origin/feat/42-terminal-engines',
			sha: 'a1',
			remote: 'origin',
			branch: 'feat/42-terminal-engines',
			hasLocal: true
		},
		{
			name: 'origin/fix/13-production-startup',
			sha: 'c3',
			remote: 'origin',
			branch: 'fix/13-production-startup',
			hasLocal: false
		}
	],
	tags: [{ name: 'v1.0.2', sha: 'd4' }]
};

describe('matchesQuery', () => {
	it('requires every word in any order and ignores case', () => {
		expect(matchesQuery('feat/42-Terminal-engines', 'terminal 42')).toBe(true);
		expect(matchesQuery('feat/42-terminal-engines', '42 mobile')).toBe(false);
		expect(matchesQuery('main', '   ')).toBe(true);
	});
});

describe('filterRefs and refItems', () => {
	it('keeps the section order local, remote, tags', () => {
		const items = refItems(filterRefs(refs, '', 100));
		expect(items.map((i) => i.kind)).toEqual(['local', 'local', 'remote', 'remote', 'tag']);
		expect(items[2].target).toEqual({ remote: 'origin/feat/42-terminal-engines' });
		expect(items[4].target).toEqual({ tag: 'v1.0.2' });
	});

	it('filters all sections and counts matches over the limit', () => {
		const view = filterRefs(refs, 'feat', 0);
		expect(view.totals).toEqual({ local: 1, remote: 1, tags: 0 });
		expect(view.local).toEqual([]);
	});
});

describe('fallbackRefs', () => {
	it('builds dateless sections from the name lists', () => {
		expect(fallbackRefs({ branches: ['main'], tags: ['v1'] })).toEqual({
			local: [{ name: 'main', sha: '' }],
			remote: [],
			tags: [{ name: 'v1', sha: '' }]
		});
	});
});

describe('relativeAge', () => {
	const now = Date.parse('2026-11-26T12:00:00Z');
	it('uses short units', () => {
		expect(relativeAge('2026-11-26T11:59:30Z', now)).toBe('now');
		expect(relativeAge('2026-11-26T11:55:00Z', now)).toBe('5m');
		expect(relativeAge('2026-11-26T09:00:00Z', now)).toBe('3h');
		expect(relativeAge('2026-11-24T12:00:00Z', now)).toBe('2d');
		expect(relativeAge('2026-11-05T12:00:00Z', now)).toBe('3w');
		expect(relativeAge('2026-07-26T12:00:00Z', now)).toBe('4mo');
		expect(relativeAge('2024-11-01T12:00:00Z', now)).toBe('2y');
		expect(relativeAge(undefined, now)).toBe('');
	});
});

describe('summaries', () => {
	it('counts updated refs after a fetch', () => {
		expect(summarizeFetch('')).toBe('Fetched. No remote changes.');
		expect(
			summarizeFetch('From x\n   1..2  main -> origin/main\n * [new branch] a -> origin/a')
		).toBe('Fetched. 2 refs updated.');
	});
	it('reports up to date and fast-forward pulls', () => {
		expect(summarizePull('Already up to date.')).toBe('Already up to date.');
		expect(summarizePull('Updating 97ffd3b..167a730\nFast-forward')).toBe(
			'Fast-forwarded 97ffd3b..167a730.'
		);
	});
});
