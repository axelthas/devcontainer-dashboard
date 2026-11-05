/** Viewer integration tests; listener I/O is covered by the standalone Node suite. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSession, resetAuthStateForTesting, AUTH_COOKIE_NAME } from './auth.js';

vi.mock('$lib/server/docker', () => ({ default: { getContainer: vi.fn() } }));
const { load } = await import('../../routes/service/+page.server');
const ID = 'a'.repeat(64);

beforeEach(() => {
	resetAuthStateForTesting();
	process.env.ORIGIN = 'https://dashboard.example';
	process.env.SERVICE_ORIGINS = JSON.stringify([{
		origin: 'https://dashboard.example:8443',
		listenPort: 4301,
		containerId: ID,
		containerPort: '4096'
	}]);
});

afterEach(() => {
	delete process.env.ORIGIN;
	delete process.env.SERVICE_ORIGINS;
	resetAuthStateForTesting();
});

it('uses a one-use root-origin launch without enabling the path gateway', async () => {
	const token = createSession();
	const event = {
		url: new URL(`https://dashboard.example/service?cid=${ID.slice(0, 12)}&port=4096`),
		cookies: { get: (name: string) => name === AUTH_COOKIE_NAME ? token : undefined }
	} as unknown as Parameters<typeof load>[0];
	const result = await load(event) as { viewer: { kind: string; target?: string } };
	expect(result.viewer.kind).toBe('proxy');
	expect(result.viewer.target).toMatch(
		/^https:\/\/dashboard\.example:8443\/__ddash\/launch#[a-zA-Z0-9_-]{43}$/
	);
});

it('rejects malformed service identities before Docker access', async () => {
	const event = {
		url: new URL('https://dashboard.example/service?cid=not-a-container&port=4096'),
		cookies: { get: () => createSession() }
	} as unknown as Parameters<typeof load>[0];
	const result = await load(event) as { viewer: { kind: string } };
	expect(result.viewer.kind).toBe('unavailable');
});
