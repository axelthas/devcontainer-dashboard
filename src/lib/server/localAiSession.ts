/** OpenCode 2.3 session-create wire contract, kept separate for regression tests. */
export function sessionArguments(directory: string): string[] {
	return [
		'api',
		'session.create',
		'--data',
		JSON.stringify({
			title: `Dashboard: ${directory.split('/').pop()}`,
			location: { directory }
		})
	];
}

/** The v2 API wraps session information in data, not a top-level session ID. */
export function sessionId(output: string): string {
	const session = JSON.parse(output).data;
	if (!session || typeof session.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(session.id)) {
		throw new Error('OpenCode returned an unsupported session response.');
	}
	return session.id;
}
