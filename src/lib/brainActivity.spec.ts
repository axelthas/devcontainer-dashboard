import { describe, expect, it } from 'vitest';
import { buildActivity, findStep, headline, stepOutcome, stepResult } from './brainActivity';
import type {
	BrainAuditEntry,
	BrainExecutionView,
	BrainGrantView,
	BrainStatus
} from './brainTypes';

const grant: BrainGrantView = {
	id: 'g1',
	containerId: 'abc123def456',
	containerName: 'nice_saha',
	kind: 'devcontainer',
	startedAt: '2026-11-23T10:00:00.000Z',
	user: 'axel',
	userSource: 'Config.User',
	exposure: [],
	createdAt: '2026-11-23T14:00:00.000Z',
	expiresAt: '2026-11-23T18:00:00.000Z',
	runningExecutions: 1
};

function execution(view: Partial<BrainExecutionView> & Pick<BrainExecutionView, 'id'>) {
	return {
		grantId: 'g1',
		containerName: 'nice_saha',
		kind: 'command',
		command: 'ls',
		user: 'axel',
		interactive: false,
		controller: 'brain',
		status: 'exited',
		exitCode: 0,
		startedAt: '2026-11-23T14:01:00.000Z',
		...view
	} as BrainExecutionView;
}

function audit(entry: Partial<BrainAuditEntry>): BrainAuditEntry {
	return {
		at: '2026-11-23T14:05:00.000Z',
		tool: 'read_output',
		detail: '',
		outcome: 'ok',
		...entry
	};
}

function status(partial: Partial<BrainStatus>): BrainStatus {
	return { enabled: true, grants: [grant], executions: [], audit: [], ...partial };
}

describe('buildActivity', () => {
	it('groups commands by container, oldest first, with their goals', () => {
		const activity = buildActivity(
			status({
				executions: [
					execution({
						id: 'x2',
						goal: 'Build it.',
						status: 'running',
						startedAt: '2026-11-23T14:03:00.000Z'
					}),
					execution({ id: 'x1', goal: 'Check the branch.' })
				]
			})
		);
		expect(activity.groups).toHaveLength(1);
		expect(activity.groups[0].steps.map((step) => step.goal)).toEqual([
			'Check the branch.',
			'Build it.'
		]);
		expect(activity.groups[0].running).toBe(1);
		expect(activity.running).toBe(1);
	});

	it('lists each command typed into a shell as its own step', () => {
		const shell = execution({
			id: 's1',
			kind: 'shell',
			command: 'shell main',
			status: 'running',
			shell: {
				name: 'main',
				ready: true,
				busy: false,
				commands: [
					{
						id: 'c1',
						command: 'git status',
						goal: 'See changes.',
						status: 'exited',
						exitCode: 0,
						startedAt: '2026-11-23T14:02:00.000Z'
					},
					{
						id: 'c2',
						command: 'npm run check',
						goal: 'Type-check.',
						status: 'exited',
						exitCode: 1,
						startedAt: '2026-11-23T14:04:00.000Z'
					}
				]
			}
		});
		const [group] = buildActivity(status({ executions: [shell] })).groups;
		expect(group.steps.map((step) => [step.commandId, step.shellName, step.goal])).toEqual([
			['c1', 'main', 'See changes.'],
			['c2', 'main', 'Type-check.']
		]);
		expect(group.shells).toEqual([
			{ executionId: 's1', name: 'main', busy: false, controller: 'brain' }
		]);
	});

	it('shows calls with the command they used, and refusals with their container', () => {
		const activity = buildActivity(
			status({
				executions: [execution({ id: 'x1' })],
				// Newest first, as the API returns it.
				audit: [
					audit({
						tool: 'execute',
						target: 'romantic_rosalind',
						outcome: 'denied',
						goal: 'Read the log.'
					}),
					audit({ tool: 'execute', target: 'nice_saha', outcome: 'error', detail: 'busy' }),
					audit({ tool: 'read_output', executionId: 'x1' }),
					audit({ tool: 'execute', executionId: 'x1', goal: 'List files.' })
				]
			})
		);
		const [group] = activity.groups;
		expect(group.steps[0].trail.map((entry) => entry.tool)).toEqual(['read_output']);
		expect(group.refused.map((entry) => entry.detail)).toEqual(['busy']);
		expect(activity.outside.map((entry) => entry.goal)).toEqual(['Read the log.']);
	});
});

describe('headline', () => {
	it('skips shell option preambles', () => {
		expect(headline('set -euo pipefail\ncpack --config x')).toBe('cpack --config x');
		expect(headline('git status')).toBe('git status');
	});
});

describe('step helpers', () => {
	it('name the result and outcome of each status', () => {
		const base = { controller: 'brain' as const, exitCode: undefined };
		expect(stepResult({ ...base, status: 'running' })).toBe('running');
		expect(stepResult({ ...base, status: 'running', controller: 'operator' })).toBe(
			'you have control'
		);
		expect(stepResult({ ...base, status: 'exited', exitCode: 7 })).toBe('exit 7');
		expect(stepOutcome({ status: 'running' })).toBe('running');
		expect(stepOutcome({ status: 'exited', exitCode: 0 })).toBe('ok');
		expect(stepOutcome({ status: 'exited', exitCode: 7 })).toBe('failed');
		expect(stepOutcome({ status: 'stopped' })).toBe('ended');
	});

	it('find a one-off command and reject an unknown shell command', () => {
		const activity = buildActivity(status({ executions: [execution({ id: 'x1' })] }));
		expect(findStep(activity, 'x1')?.step.executionId).toBe('x1');
		expect(findStep(activity, 'x1', null)?.group.containerName).toBe(grant.containerName);
		expect(findStep(activity, 'x1', 'c9')).toBeUndefined();
		expect(findStep(activity, 'missing')).toBeUndefined();
	});
});
