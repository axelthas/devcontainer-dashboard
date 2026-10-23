import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	AUTH_COOKIE_NAME,
	createSession,
	isSessionValid,
	resetAuthStateForTesting
} from '$lib/server/auth';
import { POST } from './+server';

describe('POST /logout', () => {
	beforeEach(() => {
		process.env.DASHBOARD_PASSWORD = 'test-password';
		resetAuthStateForTesting();
	});

	afterEach(() => {
		delete process.env.DASHBOARD_PASSWORD;
		resetAuthStateForTesting();
	});

	it('revokes the session, clears its cookie, and redirects', async () => {
		const token = createSession();
		let deletedCookie: string | undefined;
		let thrown: unknown;
		try {
			POST({
				url: new URL('http://localhost/logout'),
				cookies: {
					get: (name: string) => (name === AUTH_COOKIE_NAME ? token : undefined),
					delete: (name: string) => (deletedCookie = name)
				}
			} as never);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({ status: 303, location: '/login' });
		expect(deletedCookie).toBe(AUTH_COOKIE_NAME);
		expect(isSessionValid(token)).toBe(false);
	});
});
