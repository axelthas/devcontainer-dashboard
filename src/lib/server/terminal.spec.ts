import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_COOKIE_NAME, createSession, resetAuthStateForTesting } from './auth';
import { isCancelledExit, isTerminalUpgradeAuthorized } from './terminal';

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

describe('isCancelledExit', () => {
	it('treats hangup, interrupt, and termination as a cancellation', () => {
		expect(isCancelledExit(0, 1)).toBe(true);
		expect(isCancelledExit(0, 2)).toBe(true);
		expect(isCancelledExit(0, 15)).toBe(true);
		expect(isCancelledExit(129)).toBe(true);
		expect(isCancelledExit(130)).toBe(true);
		expect(isCancelledExit(143)).toBe(true);
	});

	it('treats other exits as the result of the process', () => {
		expect(isCancelledExit(0)).toBe(false);
		expect(isCancelledExit(1)).toBe(false);
		expect(isCancelledExit(0, 0)).toBe(false);
		// SIGKILL, for example from the out-of-memory killer, is a failure.
		expect(isCancelledExit(137)).toBe(false);
		expect(isCancelledExit(0, 9)).toBe(false);
	});
});
