import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_COOKIE_NAME, createSession, resetAuthStateForTesting } from '$lib/server/auth';
import { handle } from './hooks.server';

function makeEvent(path: string, sessionToken?: string, method = 'GET', origin?: string) {
	return {
		url: new URL(path, 'http://localhost'),
		request: new Request(new URL(path, 'http://localhost'), {
			method,
			headers: origin ? { Origin: origin } : {}
		}),
		cookies: {
			get: (name: string) => (name === AUTH_COOKIE_NAME ? sessionToken : undefined)
		}
	};
}

describe('authentication hook', () => {
	beforeEach(() => {
		process.env.DASHBOARD_PASSWORD = 'test-password';
		resetAuthStateForTesting();
	});
	afterEach(() => {
		delete process.env.DASHBOARD_PASSWORD;
		resetAuthStateForTesting();
	});
	it('allows the login page without a session', async () => {
		const response = await handle({ event: makeEvent('/login') as never, resolve: async () => new Response('login') });
		expect(await response.text()).toBe('login');
	});
	it('preserves a local login destination', async () => {
		const response = await handle({ event: makeEvent('/service?port=3000') as never, resolve: async () => new Response('protected') });
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/login?next=%2Fservice%3Fport%3D3000');
	});
	it('returns JSON 401 for unauthenticated API requests', async () => {
		const response = await handle({ event: makeEvent('/api/containers') as never, resolve: async () => new Response('protected') });
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: 'Authentication required' });
	});
	it('allows requests with a valid session', async () => {
		const token = createSession();
		const response = await handle({ event: makeEvent('/', token) as never, resolve: async () => new Response('dashboard') });
		expect(await response.text()).toBe('dashboard');
	});
	it('requires the exact trusted origin for every HTTP mutation', async () => {
		const token = createSession();
		for (const origin of [undefined, 'https://evil.invalid', 'https://localhost']) {
			const response = await handle({ event: makeEvent('/api/terminal/sessions', token, 'POST', origin) as never, resolve: async () => new Response('unexpected') });
			expect(response.status).toBe(403);
		}
		const response = await handle({ event: makeEvent('/api/terminal/sessions', token, 'POST', 'http://localhost') as never, resolve: async () => new Response('allowed') });
		expect(await response.text()).toBe('allowed');
	});
});
