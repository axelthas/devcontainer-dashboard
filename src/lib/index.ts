// place files you want to import through the `$lib` alias in this folder.

/**
 * Opens a custom protocol URL (e.g. vscode://) via a server-side `code` CLI call so
 * the browser never handles the protocol directly and shows no confirmation dialog.
 * Falls back to direct browser navigation if the server-side CLI is unavailable.
 */
export function openProtocolUrl(url: string): void {
	fetch('/api/open-vscode', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ url })
	})
		.then((res) => {
			if (!res.ok) window.location.href = url;
		})
		.catch(() => {
			window.location.href = url;
		});
}

/** Generate a UUID that works in non-secure contexts (plain HTTP on LAN hostnames). */
export function generateId(): string {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	// Fallback for non-secure contexts
	return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
		(+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16)
	);
}
