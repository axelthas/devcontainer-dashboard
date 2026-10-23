import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_COOKIE_NAME, createSession, resetAuthStateForTesting } from '$lib/server/auth';
import { handle } from './hooks.server';

function makeEvent(path: string, sessionToken?: string) {
	return {
		url: new URL(path, 'http://localhost'),
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
		const response = await handle({
			event: makeEvent('/login') as never,
			resolve: async () => new Response('login')
		});
		expect(await response.text()).toBe('login');
	});

	it('redirects page navigation and preserves the local destination', async () => {
		const response = await handle({
			event: makeEvent('/service?port=3000') as never,
			resolve: async () => new Response('protected')
		});
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/login?next=%2Fservice%3Fport%3D3000');
	});

	it('returns JSON 401 for unauthenticated API requests', async () => {
		const response = await handle({
			event: makeEvent('/api/containers') as never,
			resolve: async () => new Response('protected')
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: 'Authentication required' });
	});

	it('allows requests with a valid session', async () => {
		const token = createSession();
		const response = await handle({
			event: makeEvent('/', token) as never,
			resolve: async () => new Response('dashboard')
		});
		expect(await response.text()).toBe('dashboard');
	});
});
