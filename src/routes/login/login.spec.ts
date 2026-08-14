import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_COOKIE_NAME, isSessionValid, resetAuthStateForTesting } from '$lib/server/auth';
import { actions } from './+page.server';

function loginRequest(password: string, next = '/'): Request {
	return new Request('http://localhost/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ password, next })
	});
}

describe('login action', () => {
	beforeEach(() => {
		process.env.DASHBOARD_PASSWORD = 'test-password';
		resetAuthStateForTesting();
	});

	afterEach(() => {
		delete process.env.DASHBOARD_PASSWORD;
		resetAuthStateForTesting();
	});

	it('rejects an invalid password without setting a cookie', async () => {
		let cookieWasSet = false;
		const result = await actions.default!({
			request: loginRequest('wrong'),
			url: new URL('http://localhost/login'),
			getClientAddress: () => '127.0.0.1',
			cookies: { set: () => (cookieWasSet = true) }
		} as never);
		expect(result).toMatchObject({ status: 400, data: { message: 'Invalid password' } });
		expect(cookieWasSet).toBe(false);
	});

	it('sets a valid session cookie and redirects to a local destination', async () => {
		let sessionToken: string | undefined;
		await expect(
			actions.default!({
				request: loginRequest('test-password', '/demo/playwright?mode=test'),
				url: new URL('http://localhost/login'),
				getClientAddress: () => '127.0.0.1',
				cookies: {
					set: (name: string, value: string) => {
						expect(name).toBe(AUTH_COOKIE_NAME);
						sessionToken = value;
					}
				}
			} as never)
		).rejects.toMatchObject({ status: 303, location: '/demo/playwright?mode=test' });
		expect(isSessionValid(sessionToken)).toBe(true);
	});

	it('does not redirect to a protocol-relative destination', async () => {
		await expect(
			actions.default!({
				request: loginRequest('test-password', '//attacker.example'),
				url: new URL('http://localhost/login'),
				getClientAddress: () => '127.0.0.1',
				cookies: { set: () => undefined }
			} as never)
		).rejects.toMatchObject({ status: 303, location: '/' });
	});
});
