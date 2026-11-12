// Verify Linux process-tree termination independently of Docker and browser fixtures.
// Run: node --experimental-strip-types --test scripts/tests/terminal-processes.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { test } from 'node:test';
import { terminateTerminalTree } from '../../src/lib/server/terminalProcesses.ts';

// A zombie has completed execution; its parent or init still owns reaping.
async function running(pid) {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
		return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
	} catch {
		return false;
	}
}

// Start a disposable session and verify both the child and leader stop.
async function checkTree(t, command, grace) {
	const child = spawn('/bin/bash', ['-c', command], {
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	t.after(() => {
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch {
			// The owned process group has already stopped.
		}
	});
	const [data] = await once(child.stdout, 'data');
	const descendant = Number(data.toString().trim());
	assert.ok(descendant > 1);
	await terminateTerminalTree(child.pid, grace);
	assert.equal(await running(descendant), false);
	assert.equal(await running(child.pid), false);
}

test('cancellation completes the owned local process tree', { skip: process.platform !== 'linux' }, async (t) => {
	await checkTree(t, 'sleep 300 & echo $!; wait', 500);
});

test('cancellation escalates when the shell ignores SIGTERM', { skip: process.platform !== 'linux' }, async (t) => {
	await checkTree(t, "trap '' TERM; sleep 300 & echo $!; wait", 100);
});
