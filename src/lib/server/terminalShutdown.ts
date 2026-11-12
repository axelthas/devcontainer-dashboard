/** Stop all tracked local PTYs and their viewers without depending on a deployment mode. */
import { listPersistentSessions, getPersistentSession } from './terminal.js';
import { terminateTerminalTree } from './terminalProcesses.js';

/** Complete local process-tree termination before the production process exits. */
export async function shutdownTerminals(): Promise<void> {
	await Promise.all(listPersistentSessions().map(async ({ id }) => {
		const session = getPersistentSession(id);
		if (!session) return;
		for (const viewer of session.viewers) viewer.close(1001, 'Server shutting down');
		await terminateTerminalTree(session.pty.pid);
	}));
}
