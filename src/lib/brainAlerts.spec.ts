import { describe, expect, it } from 'vitest';
import { brainAlerts, durationLabel, formatCountdown, isEndingSoon } from './brainAlerts';
import type { BrainGrantView, BrainStatus } from './brainTypes';

const NOW = Date.parse('2026-11-25T13:37:48.000Z');
const grant: BrainGrantView = {
	id: 'g1',
	containerId: 'abc123def456',
	containerName: 'fervent_bhabha',
	kind: 'devcontainer',
	startedAt: '2026-11-25T10:00:00.000Z',
	user: 'axel',
	userSource: 'Config.User',
	exposure: [],
	createdAt: '2026-11-25T13:27:00.000Z',
	expiresAt: '2026-11-25T13:42:00.000Z',
	runningExecutions: 1
};
const status = (grants: BrainGrantView[]): BrainStatus => ({
	enabled: true,
	grants,
	executions: [],
	audit: []
});

describe('brain alerts', () => {
	it('warns only inside the last five minutes', () => {
		expect(isEndingSoon(grant, NOW)).toBe(true);
		expect(isEndingSoon(grant, Date.parse('2026-11-25T13:36:59.000Z'))).toBe(false);
		expect(isEndingSoon(grant, Date.parse(grant.expiresAt))).toBe(false);
		expect(formatCountdown(grant.expiresAt, NOW)).toBe('4:12');
		expect(formatCountdown(grant.expiresAt, NOW + 600_000)).toBe('0:00');
	});

	it('raises one alert per end time and per request', () => {
		const ending = brainAlerts(status([grant]), NOW);
		expect(ending.map((alert) => alert.key)).toEqual(['g1:ending:2026-11-25T13:42:00.000Z']);
		expect(ending[0].body).toMatch(/^1 running command stops then/);
		// An extension moves the end out of the window: no warning until the new end nears.
		const extended = { ...grant, expiresAt: '2026-11-25T14:42:00.000Z' };
		expect(brainAlerts(status([extended]), NOW)).toEqual([]);
		const asked = {
			...extended,
			timeRequest: {
				minutes: 60 as const,
				reason: 'The suite needs 35 more minutes.',
				at: '2026-11-25T13:37:00.000Z',
				status: 'pending' as const
			}
		};
		const [request] = brainAlerts(status([asked]), NOW);
		expect(request.key).toBe('g1:request:2026-11-25T13:37:00.000Z');
		expect(request.title).toBe('Brain asks for 1 hour more in fervent_bhabha');
		expect(request.body).toBe('The suite needs 35 more minutes.');
		expect(brainAlerts(null, NOW)).toEqual([]);
	});

	it('names durations in operator words', () => {
		expect([15, 60, 240].map(durationLabel)).toEqual(['15 minutes', '1 hour', '4 hours']);
	});
});
