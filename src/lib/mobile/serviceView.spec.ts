import { describe, expect, it } from 'vitest';
import { keepLoaded, mobileServiceHref, reloadLoaded, type LoadedService } from './serviceView';

const target = {
	containerPort: '4096',
	hostPort: '14096',
	label: 'OpenCode',
	containerName: '/blissful_williams',
	projectName: 'polaris-backend-library',
	workspacePath: '/workspaces/git.polaris-ice/polaris-backend-library',
	containerId: 'abcdefabcdef',
	allPorts: { '4096': '14096', '3000': '13000' }
};

describe('mobileServiceHref', () => {
	it('keeps gateway identity and metadata in the phone route', () => {
		const href = mobileServiceHref({ ...target, serviceProxyEnabled: true }, 'harbour.local');
		const url = new URL(href, 'https://dash.test');
		expect(url.pathname).toBe('/mobile/services/view');
		expect(url.searchParams.get('cid')).toBe('abcdefabcdef');
		expect(url.searchParams.get('port')).toBe('4096');
		expect(url.searchParams.get('url')).toBeNull();
		expect(JSON.parse(url.searchParams.get('ports') ?? '{}')).toEqual(target.allPorts);
	});

	it('uses the raw host port without the gateway', () => {
		const url = new URL(mobileServiceHref(target, 'harbour.local'), 'https://dash.test');
		expect(url.searchParams.get('url')).toBe('http://harbour.local:14096');
		expect(url.searchParams.get('port')).toBe('4096');
		expect(url.searchParams.get('project')).toBe('polaris-backend-library');
		// A `cid` would make the server pick the gateway path.
		expect(url.searchParams.get('cid')).toBeNull();
		expect(url.searchParams.get('cref')).toBe('abcdefabcdef');
	});
});

describe('keepLoaded', () => {
	const entry = (id: string, used: number, generation = 0): LoadedService => ({
		id,
		src: `/s/${id}`,
		title: id,
		generation,
		used
	});

	it('keeps the order and the page of a known service, and marks it as recent', () => {
		const next = keepLoaded([entry('a', 1), entry('b', 2)], { id: 'a', src: '/s/a', title: 'A' });
		expect(next.map((item) => item.id)).toEqual(['a', 'b']);
		expect(next[0]).toMatchObject({ generation: 0, title: 'A', used: 3 });
	});

	it('unloads the least recent service above the limit', () => {
		const next = keepLoaded([entry('a', 3), entry('b', 1), entry('c', 2)], {
			id: 'd',
			src: '/s/d',
			title: 'd'
		});
		expect(next.map((item) => item.id)).toEqual(['a', 'c', 'd']);
	});

	it('loads again when the address changed', () => {
		const next = keepLoaded([entry('a', 1, 2)], { id: 'a', src: '/other', title: 'a' });
		expect(next[0]).toMatchObject({ src: '/other', generation: 3 });
	});

	it('reload increases the generation of one service only', () => {
		expect(
			reloadLoaded([entry('a', 1), entry('b', 2)], 'b').map((item) => item.generation)
		).toEqual([0, 1]);
	});
});
