/** Deduplicate explicit starts without replaying a confirmed or uncertain command. */
export interface TerminalStart {
	id: string;
	command?: string;
	cwd?: string;
	name?: string;
	kind?: 'shell' | 'bootstrap' | 'devcontainer-build';
}
interface CreationAttempt {
	outcome: 'not-started' | 'uncertain' | 'confirmed';
	pending?: Promise<void>;
}
const creations = new Map<string, CreationAttempt>();
const MAX_CREATIONS = 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Check an existing identity before deciding whether an explicit start is still safe. */
async function attemptStart(start: TerminalStart, attempt: CreationAttempt): Promise<void> {
	const probe = await fetch(`/api/terminal/sessions?id=${encodeURIComponent(start.id)}`, {
		cache: 'no-store',
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	});
	if (probe.ok) {
		attempt.outcome = 'confirmed';
		return;
	}
	if (probe.status !== 404)
		throw new Error(
			probe.status === 401
				? 'Sign in to attach to this terminal.'
				: 'Could not check terminal session. Retry the connection.'
		);
	if (attempt.outcome === 'uncertain')
		throw new Error(
			'Terminal start outcome is unknown. Start a new terminal explicitly; the previous command will not be rerun.'
		);
	if (start.command === undefined && start.name === undefined)
		throw new Error('Session no longer exists. Start a new run explicitly.');
	if (attempt.outcome === 'confirmed')
		throw new Error('Session no longer exists. Start a new terminal explicitly.');

	// After dispatch, a lost response cannot prove that the command did not run.
	attempt.outcome = 'uncertain';
	const response = await fetch('/api/terminal/sessions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(start),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	});
	if (!response.ok) {
		// These responses from the terminal API reject creation before a process starts.
		// Other failures can come from an intermediary after the server accepted the command.
		if ([400, 401, 403].includes(response.status)) attempt.outcome = 'not-started';
		throw new Error(
			response.status === 401
				? 'Sign in to start this terminal, then retry.'
				: attempt.outcome === 'not-started'
					? 'Terminal start was rejected. Check the request, then retry.'
					: 'Could not confirm terminal start. Retry to check for an existing process; the command will not be rerun.'
		);
	}
	attempt.outcome = 'confirmed';
}

/** Retry only pre-dispatch failures; reconnect and uncertain starts can only probe. */
export async function ensureTerminal(start: TerminalStart, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new DOMException('Viewer disposed', 'AbortError');
	let attempt = creations.get(start.id);
	if (!attempt) {
		// Never evict a previous outcome: forgetting it could replay a completed command.
		if (creations.size >= MAX_CREATIONS)
			throw new Error('Terminal start history is full. Reload before starting another terminal.');
		attempt = { outcome: 'not-started' };
		creations.set(start.id, attempt);
	}
	const entry = attempt;
	if (!entry.pending) {
		entry.pending = attemptStart(start, entry).finally(() => {
			entry.pending = undefined;
		});
	}
	await entry.pending;
	// A viewer does not own the shared start. Its disposal must not abort another viewer's start.
	if (signal?.aborted) throw new DOMException('Viewer disposed', 'AbortError');
}
