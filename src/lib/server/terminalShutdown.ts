/** Stop every tracked local PTY before production exits. */
import { beginTerminalShutdown, listPersistentSessions, getPersistentSession, deletePersistentSession } from './terminal.js';

/** Disconnect viewers and await verified cancellation in every deployment mode. */
export async function shutdownTerminals(): Promise<void> {
	beginTerminalShutdown();
	await Promise.all(listPersistentSessions().map(async ({ id }) => {
		const session = getPersistentSession(id);
		if (!session) return;
		for (const viewer of session.viewers) viewer.close(1001, 'Server shutting down');
		await deletePersistentSession(id);
	}));
}
