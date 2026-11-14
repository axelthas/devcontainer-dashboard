/** Deduplicate explicit starts across viewer remounts. Reconnect never calls this operation. */
export interface TerminalStart {
	id: string;
	command?: string;
	cwd?: string;
	name?: string;
	kind?: 'shell' | 'bootstrap' | 'devcontainer-build';
}
const creations = new Map<string, Promise<void>>();

/** Create a user-requested terminal once, or probe an existing server-created run by ID. */
export async function ensureTerminal(start: TerminalStart, signal?: AbortSignal): Promise<void> {
	let creation = creations.get(start.id);
	if (!creation) {
		creation = (async () => {
			const probe = await fetch(`/api/terminal/sessions?id=${encodeURIComponent(start.id)}`);
			if (probe.ok) return;
			if (probe.status !== 404)
				throw new Error(
					probe.status === 401
						? 'Sign in to attach to this terminal.'
						: 'Could not check terminal session.'
				);
			// Server-created bootstrap/build viewers carry no creation command or shell name.
			if (start.command === undefined && start.name === undefined)
				throw new Error('Session no longer exists. Start a new run explicitly.');
			const response = await fetch('/api/terminal/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(start)
			});
			if (!response.ok)
				throw new Error(
					response.status === 401
						? 'Sign in to start this terminal.'
						: 'Could not start terminal session.'
				);
		})();
		creations.set(start.id, creation);
		// Bound the client-side ledger without introducing automatic restart on reconnect.
		if (creations.size > 1000) creations.delete(creations.keys().next().value!);
	}
	await creation;
	if (signal?.aborted) throw new DOMException('Viewer disposed', 'AbortError');
}
