import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	AUTH_COOKIE_NAME,
	assertAuthConfigured,
	createSession,
	isCookieHeaderAuthenticated,
	isSessionValid,
	resetAuthStateForTesting,
	revokeSession,
	sessionTokenFromCookieHeader,
	validatePassword
} from './auth';

describe('dashboard authentication', () => {
	beforeEach(() => {
		process.env.DASHBOARD_PASSWORD = 'correct horse battery staple';
		resetAuthStateForTesting();
	});

	afterEach(() => {
		delete process.env.DASHBOARD_PASSWORD;
		resetAuthStateForTesting();
	});

	it('requires a configured password', () => {
		delete process.env.DASHBOARD_PASSWORD;
		expect(() => assertAuthConfigured()).toThrow(/DASHBOARD_PASSWORD/);
	});

	it('validates the configured password', () => {
		expect(validatePassword('correct horse battery staple', 'client')).toBe('valid');
		expect(validatePassword('wrong', 'client')).toBe('invalid');
	});

	it('throttles a client after repeated failures', () => {
		for (let attempt = 0; attempt < 4; attempt += 1) {
			expect(validatePassword('wrong', 'client', 1_000)).toBe('invalid');
		}
		expect(validatePassword('wrong', 'client', 1_000)).toBe('throttled');
		expect(validatePassword('correct horse battery staple', 'client', 1_001)).toBe('throttled');
		expect(validatePassword('correct horse battery staple', 'client', 61_001)).toBe('valid');
	});

	it('creates and revokes opaque sessions', () => {
		const token = createSession();
		expect(token).not.toContain('correct horse battery staple');
		expect(isSessionValid(token)).toBe(true);
		revokeSession(token);
		expect(isSessionValid(token)).toBe(false);
	});

	it('reads and validates the session cookie', () => {
		const token = createSession();
		const cookieHeader = `theme=dark; ${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; other=value`;
		expect(sessionTokenFromCookieHeader(cookieHeader)).toBe(token);
		expect(isCookieHeaderAuthenticated(cookieHeader)).toBe(true);
		expect(isCookieHeaderAuthenticated(`${AUTH_COOKIE_NAME}=invalid`)).toBe(false);
	});

	it('rejects malformed cookie values', () => {
		expect(sessionTokenFromCookieHeader(`${AUTH_COOKIE_NAME}=%E0%A4%A`)).toBeUndefined();
		expect(sessionTokenFromCookieHeader(undefined)).toBeUndefined();
	});
});
