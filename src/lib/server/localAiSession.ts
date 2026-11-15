/** Explicit shared-server commands and idempotent viewer launches. */
export type AiTool = 'opencode' | 'openchamber';
export type AiLaunch = { terminalId: string } | { target: string };
export type AiLaunchRequest = {
	path: string;
	tool: AiTool;
	launch: string;
	instance: string;
};

/** Keep launch identities bounded and safe for terminal IDs and browser URLs. */
export function validAiLaunch(value: unknown): value is string {
	return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(value);
}

/** Never fall back to discovery, which can start or replace a background server. */
function serverArguments(server: string): string[] {
	if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(server)) {
		throw new Error('An explicit dashboard-owned loopback server is required.');
	}
	const port = Number(new URL(server).port);
	if (port < 1 || port > 65535) throw new Error('Invalid OpenCode server port.');
	return ['--server', server];
}

/** Create the session on the owned server, with a literal directory in the body. */
export function sessionArguments(directory: string, server: string): string[] {
	return [
		'api',
		'session.create',
		'--data',
		JSON.stringify({
			title: `Dashboard: ${directory.split('/').pop()}`,
			location: { directory }
		}),
		...serverArguments(server)
	];
}

/** Attach the TUI to the exact session so explicit-server mode keeps its directory. */
export function tuiArguments(server: string, session: string): string[] {
	if (!/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error('Invalid OpenCode session.');
	return [...serverArguments(server), '--session', session];
}

/** Keep failures too: retrying an uncertain API result must not create another session. */
export function launchRegistry(limit = 256) {
	const launches = new Map<string, { key: string; result: Promise<AiLaunch> }>();
	return (id: string, key: string, create: () => Promise<AiLaunch>): Promise<AiLaunch> => {
		if (!validAiLaunch(id)) return Promise.reject(new Error('Invalid launch identity.'));
		const existing = launches.get(id);
		if (existing) {
			if (existing.key !== key) return Promise.reject(new Error('Launch identity already used.'));
			return existing.result;
		}
		if (launches.size >= limit) return Promise.reject(new Error('AI launch capacity reached.'));
		// Register before running create so concurrent POSTs share one operation.
		const result = Promise.resolve().then(create);
		launches.set(id, { key, result });
		return result;
	};
}

/** The v2 API wraps session information in data, not a top-level session ID. */
export function sessionId(output: string): string {
	const session = JSON.parse(output).data;
	if (!session || typeof session.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(session.id)) {
		throw new Error('OpenCode returned an unsupported session response.');
	}
	return session.id;
}
