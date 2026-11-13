import { expect, it } from 'vitest';
import { sameOrigin, safeRedirectTarget } from './requestPolicy';
import { createSession, isSessionValid, resetAuthStateForTesting } from './auth';

it('rejects authority tricks and preserves local destinations', () => {
	for (const input of [
		'//evil.invalid',
		'/\\evil.invalid',
		'/%5cevil.invalid',
		'/\t/evil.invalid',
		'/%2f%2fevil.invalid',
		'https://evil.invalid'
	])
		expect(safeRedirectTarget(input)).toBe('/');
	expect(safeRedirectTarget('/service?port=9001')).toBe('/service?port=9001');
	expect(sameOrigin('https://dashboard.test', 'https://dashboard.test')).toBe(true);
	expect(sameOrigin('http://dashboard.test', 'https://dashboard.test')).toBe(false);
	expect(sameOrigin(null, 'https://dashboard.test')).toBe(false);
});

it('expires idle tokens and does not let heartbeats renew them', () => {
	resetAuthStateForTesting();
	const token = createSession(0);
	expect(isSessionValid(token, false, 1000)).toBe(true);
	expect(isSessionValid(token, false, 43_200_000)).toBe(false);
	resetAuthStateForTesting();
});

it('enforces absolute expiry despite recent activity', () => {
	resetAuthStateForTesting();
	const token = createSession(0);
	for (let now = 1; now < 604_800_000; now += 20_000_000)
		expect(isSessionValid(token, true, now)).toBe(true);
	expect(isSessionValid(token, true, 604_800_000)).toBe(false);
	resetAuthStateForTesting();
});
