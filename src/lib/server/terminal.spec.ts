import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_COOKIE_NAME, createSession, resetAuthStateForTesting } from './auth';
import { isTerminalUpgradeAuthorized } from './terminal';

function request(headers: Record<string, string>) {
	return { headers } as never;
}

describe('terminal WebSocket authorization', () => {
	beforeEach(() => {
		process.env.DASHBOARD_PASSWORD = 'test-password';
		resetAuthStateForTesting();
	});

	afterEach(() => {
		delete process.env.DASHBOARD_PASSWORD;
		resetAuthStateForTesting();
	});

	it('accepts a valid session from the same origin', () => {
		const token = createSession();
		expect(
			isTerminalUpgradeAuthorized(
				request({
					cookie: `${AUTH_COOKIE_NAME}=${token}`,
					host: 'localhost:3000',
					origin: 'http://localhost:3000'
				})
			)
		).toBe(true);
	});

	it('rejects a missing or invalid session', () => {
		expect(
			isTerminalUpgradeAuthorized(
				request({ host: 'localhost:3000', origin: 'http://localhost:3000' })
			)
		).toBe(false);
		expect(
			isTerminalUpgradeAuthorized(
				request({
					cookie: `${AUTH_COOKIE_NAME}=invalid`,
					host: 'localhost:3000',
					origin: 'http://localhost:3000'
				})
			)
		).toBe(false);
	});

	it('rejects cross-origin and origin-less requests', () => {
		const token = createSession();
		const cookie = `${AUTH_COOKIE_NAME}=${token}`;
		expect(
			isTerminalUpgradeAuthorized(
				request({ cookie, host: 'localhost:3000', origin: 'http://attacker.example' })
			)
		).toBe(false);
		expect(isTerminalUpgradeAuthorized(request({ cookie, host: 'localhost:3000' }))).toBe(false);
	});
});
