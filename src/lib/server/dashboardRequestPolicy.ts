/**
 * Prevent sibling-port service applications from using ambient dashboard cookies.
 * Different ports are different origins but share the hostname's cookie jar.
 */
/** Enforce exact-origin writes/CORS reads and reject cross-origin resource embeddings. */
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
