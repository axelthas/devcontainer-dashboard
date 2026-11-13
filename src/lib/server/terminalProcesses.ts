/** Linux local-process cleanup. Docker-daemon work is not owned by this process tree. */
import { readdir, readFile } from 'node:fs/promises';

interface ProcessIdentity {
	pid: number;
	parent: number;
	session: number;
	started: string;
	state: string;
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read identity as well as PID, so a recycled PID is never signalled. */
async function identity(pid: number): Promise<ProcessIdentity | undefined> {
	try {
		const text = await readFile(`/proc/${pid}/stat`, 'utf8');
		const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
		return {
			pid,
			state: fields[0],
			parent: Number(fields[1]),
			session: Number(fields[3]),
			started: fields[19]
		};
	} catch {
		return undefined;
	}
}

/** Collect descendants and members of the PTY session, including job-control process groups. */
async function members(root: number): Promise<ProcessIdentity[]> {
	const entries = await readdir('/proc');
	const records = (
		await Promise.all(
			entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => identity(Number(entry)))
		)
	).filter((record): record is ProcessIdentity => Boolean(record));
	const selected = new Set([root]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const record of records) {
			if ((record.session === root || selected.has(record.parent)) && !selected.has(record.pid)) {
				selected.add(record.pid);
				changed = true;
			}
		}
	}
	return records.filter((record) => selected.has(record.pid) && record.pid !== process.pid);
}

/** Signal only the exact original process, never a PID that has been reused. */
async function signal(record: ProcessIdentity, value: NodeJS.Signals): Promise<void> {
	const current = await identity(record.pid);
	if (!current || current.started !== record.started || current.state === 'Z') return;
	try {
		process.kill(record.pid, value);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
	}
}

/** Stop a local PTY tree, escalate, and verify completion within a fixed deadline. */
export async function terminateTerminalTree(pid: number, graceMs = 2000): Promise<void> {
	if (process.platform !== 'linux')
		throw new Error('Verified terminal-tree cleanup requires Linux');
	if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid)
		throw new Error('Unsafe terminal PID');
	const original = await identity(pid);
	const tracked = new Map((await members(pid)).map((record) => [record.pid, record]));
	const start = Date.now();
	let escalated = false;
	while (true) {
		// Discover children forked during cancellation while the original leader still exists.
		const leader = await identity(pid);
		if (original && leader?.started === original.started) {
			for (const record of await members(pid))
				if (!tracked.has(record.pid)) tracked.set(record.pid, record);
		}
		const alive: ProcessIdentity[] = [];
		for (const record of tracked.values()) {
			const current = await identity(record.pid);
			if (current && current.started === record.started && current.state !== 'Z')
				alive.push(record);
		}
		if (!alive.length) return;
		const elapsed = Date.now() - start;
		if (elapsed > graceMs + 2000) throw new Error('Terminal process cleanup deadline exceeded');
		const nextSignal = elapsed >= graceMs ? 'SIGKILL' : 'SIGTERM';
		if (elapsed >= graceMs) escalated = true;
		// Children first gives the shell a chance to reap them before it exits.
		for (const record of alive.sort((a, b) => Number(a.pid === pid) - Number(b.pid === pid)))
			await signal(record, nextSignal);
		await delay(escalated ? 25 : 50);
	}
}
