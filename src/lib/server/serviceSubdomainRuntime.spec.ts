/** Viewer integration for subdomain launches; listener I/O is covered by the Node suite. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AUTH_COOKIE_NAME, createSession, resetAuthStateForTesting } from './auth.js';

vi.mock('$lib/server/docker', () => ({ default: { getContainer: vi.fn() } }));
const { load } = await import('../../routes/service/+page.server');
const docker = (await import('$lib/server/docker')).default as unknown as {
	getContainer: ReturnType<typeof vi.fn>;
};
const ID = 'abcdef123456' + 'a'.repeat(52);

/** Build a viewer load event with an optional dashboard session cookie. */
function event(search: string, token?: string) {
	return {
		url: new URL(`https://host.tailnet.ts.net/service${search}`),
		cookies: { get: (name: string) => (name === AUTH_COOKIE_NAME ? token : undefined) }
	} as unknown as Parameters<typeof load>[0];
}

/** Return fake Docker state for one published container port. */
function inspection(running = true) {
	return {
		Id: ID,
		State: { Running: running },
		NetworkSettings: { Ports: { '4096/tcp': [{ HostIp: '127.0.0.1', HostPort: '32768' }] } }
	};
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
	resetAuthStateForTesting();
});

it('launches a root-origin subdomain without the path gateway or any route file', async () => {
	vi.mocked(docker.getContainer).mockReturnValue({ inspect: () => Promise.resolve(inspection()) });
	const result = (await load(event('?cid=abcdef123456&port=4096', createSession()))) as {
		viewer: { kind: string; target?: string };
	};
	expect(result.viewer.kind).toBe('proxy');
	expect(result.viewer.target).toMatch(
		/^https:\/\/4096-abcdef123456\.host\.tailnet\.ts\.net:8443\/__ddash\/launch#[a-zA-Z0-9_-]{43}$/
	);
});

it('reports stopped containers instead of issuing a ticket', async () => {
	vi.mocked(docker.getContainer).mockReturnValue({ inspect: () => Promise.resolve(inspection(false)) });
	const result = (await load(event('?cid=abcdef123456&port=4096', createSession()))) as {
		viewer: { kind: string; reason?: string };
	};
	expect(result.viewer).toMatchObject({ kind: 'unavailable', reason: 'not-running' });
});

it('rejects malformed identities before Docker access', async () => {
	const result = (await load(event('?cid=not-a-container&port=4096', createSession()))) as {
		viewer: { kind: string };
	};
	expect(result.viewer.kind).toBe('unavailable');
	expect(docker.getContainer).not.toHaveBeenCalled();
});
