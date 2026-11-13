/** Validated operator limits. Zero lifetime limits preserve deliberate background work. */
export function terminalLimits(env: NodeJS.ProcessEnv = process.env) {
	function limit(name: string, fallback: number, max: number, allowZero = false): number {
		const raw = env[name];
		if (raw === undefined || raw === '') return fallback;
		const value = Number(raw);
		if (
			!/^\d+$/.test(raw) ||
			!Number.isSafeInteger(value) ||
			value < (allowZero ? 0 : 1) ||
			value > max
		)
			throw new Error(`Invalid ${name}`);
		return value;
	}
	return {
		sessions: limit('TERMINAL_MAX_SESSIONS', 32, 256),
		viewers: limit('TERMINAL_MAX_VIEWERS', 8, 64),
		output: limit('TERMINAL_OUTPUT_CHARS', 500_000, 10_000_000),
		totalOutput: limit('TERMINAL_TOTAL_OUTPUT_CHARS', 32_000_000, 256_000_000),
		idleMs: limit('TERMINAL_IDLE_MS', 0, 2_000_000_000, true),
		lifetimeMs: limit('TERMINAL_LIFETIME_MS', 0, 2_000_000_000, true)
	};
}

/** Enforce the cap even when the incoming chunk alone is larger than the entire buffer. */
export function appendOutput(buffer: string[], data: string, limit: number): number {
	buffer.push(data.length > limit ? data.slice(-limit) : data);
	let length = buffer.reduce((sum, chunk) => sum + chunk.length, 0);
	while (length > limit) {
		const excess = length - limit;
		if (buffer[0].length <= excess) length -= buffer.shift()!.length;
		else {
			buffer[0] = buffer[0].slice(excess);
			length = limit;
		}
	}
	return length;
}
