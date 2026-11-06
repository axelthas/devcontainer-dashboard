/**
 * Prevent service subdomains from using ambient dashboard cookies. Sibling subdomains of
 * one Tailscale node are same-site, so SameSite cookies alone do not stop them.
 */

/** Enforce exact-origin writes and CORS reads, and reject cross-origin resource embeddings. */
export function isDashboardRequestAllowed(
	method: string,
	headers: Headers,
	dashboardOrigin: string
): boolean {
	const origin = headers.get('origin');
	if (origin && origin !== dashboardOrigin) return false;
	if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && origin !== dashboardOrigin) return false;
	const site = headers.get('sec-fetch-site');
	const mode = headers.get('sec-fetch-mode');
	const dest = headers.get('sec-fetch-dest');
	if (['iframe', 'frame', 'object', 'embed'].includes(dest ?? '')) return false;
	if (site && site !== 'same-origin' && site !== 'none' && mode !== 'navigate') return false;
	return true;
}
