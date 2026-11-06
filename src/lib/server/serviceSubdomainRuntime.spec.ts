import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_COOKIE_NAME, createSession, resetAuthStateForTesting } from './auth';
import type { ContainerInspection } from './serviceGateway';

vi.mock('$lib/server/docker', () => ({
	default: { getContainer: vi.fn() }
}));

const { load } = await import('../../routes/service/+page.server');
const docker = (await import('$lib/server/docker')).default as {
	getContainer: (id: string) => { inspect: () => Promise<ContainerInspection> };
};

const SHORT_ID = 'abcdef123456';
const FULL_ID = `${SHORT_ID}${'a'.repeat(52)}`;
const LAUNCH = /^https:\/\/4096-abcdef123456\.host\.tailnet\.ts\.net:8443\/__ddash\/launch#/;

/** Return Docker state for one published container port. */
function inspection(running = true): ContainerInspection {
	return {
		Id: FULL_ID,
		State: { Running: running },
		NetworkSettings: { Ports: { '4096/tcp': [{ HostIp: '127.0.0.1', HostPort: '32768' }] } }
	};
}

/** Run the viewer load with a valid dashboard session cookie. */
async function view(search: string) {
	const token = createSession();
	const event = {
		url: new URL(`https://host.tailnet.ts.net/service${search}`),
		cookies: { get: (name: string) => (name === AUTH_COOKIE_NAME ? token : undefined) }
	} as unknown as Parameters<typeof load>[0];
	return (await load(event)) as { viewer: { kind: string; target?: string; reason?: string } };
}

beforeEach(() => {
	resetAuthStateForTesting();
	process.env.ORIGIN = 'https://host.tailnet.ts.net';
	process.env.SERVICE_SUBDOMAIN_BASE = 'host.tailnet.ts.net';
	vi.mocked(docker.getContainer).mockReset();
});

afterEach(() => {
	delete process.env.ORIGIN;
	delete process.env.SERVICE_SUBDOMAIN_BASE;
	delete process.env.SERVICE_PROXY_ENABLED;
	resetAuthStateForTesting();
});

describe('service viewer with subdomains', () => {
	it('launches a root-origin subdomain without the path gateway', async () => {
		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () => Promise.resolve(inspection())
		}));
		const { viewer } = await view(`?cid=${SHORT_ID}&port=4096`);
		expect(viewer.kind).toBe('proxy');
		expect(viewer.target).toMatch(LAUNCH);
	});

	it('reports a stopped container instead of issuing a ticket', async () => {
		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () => Promise.resolve(inspection(false))
		}));
		const { viewer } = await view(`?cid=${SHORT_ID}&port=4096`);
		expect(viewer).toMatchObject({ kind: 'unavailable', reason: 'not-running' });
	});

	it('falls back to the path gateway when the subdomain launch fails', async () => {
		process.env.SERVICE_PROXY_ENABLED = '1';
		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () => Promise.reject(new Error('no such container'))
		}));
		const { viewer } = await view(`?cid=${SHORT_ID}&port=4096`);
		expect(viewer).toMatchObject({ kind: 'unavailable', reason: 'unknown-container' });
		expect(viewer.target).toBeUndefined();
	});

	it('rejects a malformed identity before Docker access', async () => {
		const { viewer } = await view('?cid=not-a-container&port=4096');
		expect(viewer.kind).toBe('unavailable');
		expect(docker.getContainer).not.toHaveBeenCalled();
	});
});
