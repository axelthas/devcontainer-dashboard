/**
 * Client-safe helpers for the Git ref menu: search, relative age, keyboard order and
 * short summaries of fetch and pull output. No server imports.
 */
import type {
	GitLocalBranch,
	GitRefEntry,
	GitRefs,
	GitRemoteBranch,
	RepoRefsResponse
} from '$lib/types';

/** What a menu item checks out. `remote` is the remote-tracking name, for example `origin/x`. */
export type RefTarget = { branch: string } | { remote: string } | { tag: string };

/** One selectable row in menu order: local branches, remote branches, tags. */
export type RefItem =
	| { kind: 'local'; ref: GitLocalBranch; target: RefTarget }
	| { kind: 'remote'; ref: GitRemoteBranch; target: RefTarget }
	| { kind: 'tag'; ref: GitRefEntry; target: RefTarget };

/** The filtered sections. `totals` counts all matches, also those over the display limit. */
export interface RefView {
	local: GitLocalBranch[];
	remote: GitRemoteBranch[];
	tags: GitRefEntry[];
	totals: { local: number; remote: number; tags: number };
}

/**
 * True when every whitespace-separated word of the query occurs in the name.
 * The match ignores case, so `feat 42` finds `feat/42-terminal-engines`.
 */
export function matchesQuery(name: string, query: string): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const haystack = name.toLowerCase();
	return words.every((word) => haystack.includes(word));
}

/** Filter the three sections with one query and keep at most `limit` rows per section. */
export function filterRefs(refs: GitRefs, query: string, limit: number): RefView {
	const local = refs.local.filter((r) => matchesQuery(r.name, query));
	const remote = refs.remote.filter((r) => matchesQuery(r.name, query));
	const tags = refs.tags.filter((r) => matchesQuery(r.name, query));
	return {
		local: local.slice(0, limit),
		remote: remote.slice(0, limit),
		tags: tags.slice(0, limit),
		totals: { local: local.length, remote: remote.length, tags: tags.length }
	};
}

/** Flatten the sections into keyboard order. */
export function refItems(view: RefView): RefItem[] {
	return [
		...view.local.map((ref) => ({ kind: 'local' as const, ref, target: { branch: ref.name } })),
		...view.remote.map((ref) => ({ kind: 'remote' as const, ref, target: { remote: ref.name } })),
		...view.tags.map((ref) => ({ kind: 'tag' as const, ref, target: { tag: ref.name } }))
	];
}

/**
 * Build sections from the plain name lists when the server could not run git.
 * The order is then alphabetical and no dates show.
 */
export function fallbackRefs(data: Pick<RepoRefsResponse, 'branches' | 'tags'>): GitRefs {
	return {
		local: data.branches.map((name) => ({ name, sha: '' })),
		remote: [],
		tags: data.tags.map((name) => ({ name, sha: '' }))
	};
}

/** Short age of an ISO date, for example `5m`, `3h`, `2d`, `3w`, `4mo` or `2y`. */
export function relativeAge(date: string | undefined, now: number): string {
	if (!date) return '';
	const seconds = Math.max(0, (now - Date.parse(date)) / 1000);
	if (Number.isNaN(seconds)) return '';
	const minute = 60;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (seconds < minute) return 'now';
	if (seconds < hour) return `${Math.floor(seconds / minute)}m`;
	if (seconds < day) return `${Math.floor(seconds / hour)}h`;
	if (seconds < 14 * day) return `${Math.floor(seconds / day)}d`;
	if (seconds < 60 * day) return `${Math.floor(seconds / (7 * day))}w`;
	if (seconds < 365 * day) return `${Math.floor(seconds / (30 * day))}mo`;
	return `${Math.floor(seconds / (365 * day))}y`;
}

/** One line for the menu after a fetch: how many remote refs changed. */
export function summarizeFetch(output: string | undefined): string {
	const updates = (output ?? '').split('\n').filter((line) => line.includes('->')).length;
	if (updates === 0) return 'Fetched. No remote changes.';
	return `Fetched. ${updates} ${updates === 1 ? 'ref' : 'refs'} updated.`;
}

/** One line for the menu after a pull: up to date, or the fast-forward range. */
export function summarizePull(output: string | undefined): string {
	const text = output ?? '';
	if (/Already up[ -]to[ -]date/i.test(text)) return 'Already up to date.';
	const range = text.match(/Updating ([0-9a-f]+\.\.[0-9a-f]+)/);
	return range ? `Fast-forwarded ${range[1]}.` : 'Pulled.';
}
