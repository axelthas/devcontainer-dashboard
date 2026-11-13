/** Explicit, deduplicated cancellation shared by shell, bootstrap, and build callers. */
import { terminateTerminalTree } from './terminalProcesses.js';
const pending = new Map<number, Promise<void>>();

/** Await local-process completion, not merely delivery of a signal. */
export function stopTerminalProcess(pid: number): Promise<void> {
	let result = pending.get(pid);
	if (!result) {
		result = terminateTerminalTree(pid).finally(() => pending.delete(pid));
		pending.set(pid, result);
		// Existing fire-and-forget run removers still receive a logged failure, not an unhandled rejection.
		void result.catch((error) => console.error('Terminal cleanup failed', error));
	}
	return result;
}
