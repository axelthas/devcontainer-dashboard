/** Trusted-origin and local-navigation rules shared by login and HTTP mutation handling. */
export function sameOrigin(origin: string | null | undefined, expected: string): boolean {
	if (!origin || origin === 'null') return false;
	try { return new URL(origin).origin === new URL(expected).origin && new URL(origin).origin === origin; } catch { return false; }
}

/** Reject browser-normalized authority tricks, including backslashes and control characters. */
export function safeRedirectTarget(value: unknown): string {
	if (typeof value !== 'string' || !value.startsWith('/')) return '/';
	let decoded = value;
	for (let count = 0; count < 3; count++) {
		if (decoded.startsWith('//') || /[\\-\u0020\u007f]/.test(decoded)) return '/';
		try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { return '/'; }
	}
	try {
		const parsed = new URL(value, 'http://dashboard.invalid');
		return parsed.origin === 'http://dashboard.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/';
	} catch { return '/'; }
}
