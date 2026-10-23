import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	deleteRunLog,
	listRunLogs,
	readRunLog,
	saveRunLog,
	toPlainText,
	type RunLogMetadata
} from './runLogs';

function metadata(id: string, endedAt = '2026-10-20T12:00:00.000Z'): RunLogMetadata {
	return {
		id,
		kind: 'devcontainer-build',
		name: 'repo',
		path: '/workspaces/task/repo',
		startedAt: '2026-10-20T11:59:00.000Z',
		endedAt,
		exitCode: 1
	};
}

describe('run logs', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'run-logs-'));
		process.env.BUILD_LOG_DIR = dir;
	});

	afterEach(async () => {
		delete process.env.BUILD_LOG_DIR;
		await rm(dir, { recursive: true, force: true });
	});

	it('saves, reads, and deletes a log', async () => {
		await saveRunLog(metadata('build-1'), 'error output\r\n');
		expect(await readRunLog('build-1')).toEqual({
			metadata: metadata('build-1'),
			output: 'error output\r\n'
		});

		await deleteRunLog('build-1');
		expect(await readRunLog('build-1')).toBeUndefined();
		expect(await readdir(dir)).toEqual([]);
	});

	it('rejects ids that are not plain identifiers', async () => {
		expect(await readRunLog('../secrets')).toBeUndefined();
		await expect(saveRunLog(metadata('../secrets'), 'output')).rejects.toThrow(/Invalid/);
	});

	it('lists kept logs and deletes expired logs', async () => {
		await saveRunLog(metadata('recent'), 'recent output');
		await saveRunLog(metadata('expired', '2026-10-01T12:00:00.000Z'), 'expired output');

		const logs = await listRunLogs(new Date('2026-10-23T12:00:00.000Z').getTime());
		expect(logs.map((log) => log.id)).toEqual(['recent']);
		expect(await readRunLog('expired')).toBeUndefined();
	});
});

describe('toPlainText', () => {
	const ESC = String.fromCharCode(27);
	const BEL = String.fromCharCode(7);

	it('removes colour and title escape sequences', () => {
		expect(toPlainText(`${ESC}[31mfailed${ESC}[0m${ESC}]0;title${BEL} here`)).toBe('failed here');
	});

	it('keeps the final state of lines rewritten with carriage returns', () => {
		const output = 'step 1\r\nprogress 10%\rprogress 100%\r\n';
		expect(toPlainText(output)).toBe('step 1\nprogress 100%\n');
	});
});
