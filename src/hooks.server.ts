import { AUTH_COOKIE_NAME, assertAuthConfigured, isSessionValid } from '$lib/server/auth';
import { sameOrigin } from '$lib/server/requestPolicy';
import type { Handle } from '@sveltejs/kit';
const PUBLIC_PATHS = new Set(['/login', '/robots.txt']);

/** Enforce browser-origin writes before authentication in HTTP and Tailscale deployments. */
export const handle: Handle = async ({ event, resolve }) => {
	assertAuthConfigured();
	const expected = process.env.ORIGIN || event.url.origin;
	const origin = event.request.headers.get('origin');
	const write = !['GET', 'HEAD', 'OPTIONS'].includes(event.request.method);
	if (write && !sameOrigin(origin, expected))
		return new Response('Dashboard origin required', { status: 403 });
	if (process.env.TAILSCALE_SOCKET) {
		const site = event.request.headers.get('sec-fetch-site');
		const navigation = event.request.headers.get('sec-fetch-mode') === 'navigate';
		if (
			event.request.headers.has('service-worker') ||
			(origin && !sameOrigin(origin, expected)) ||
			(!origin && site && !['same-origin', 'none'].includes(site) && !navigation)
		)
			return new Response('Dashboard origin required', { status: 403 });
	}
	if (PUBLIC_PATHS.has(event.url.pathname) || event.url.pathname.startsWith('/_app/'))
		return resolve(event);
	if (isSessionValid(event.cookies.get(AUTH_COOKIE_NAME))) return resolve(event);
	if (event.url.pathname.startsWith('/api/'))
		return new Response(JSON.stringify({ message: 'Authentication required' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' }
		});
	return new Response(null, {
		status: 303,
		headers: {
			Location: `/login?${new URLSearchParams({ next: `${event.url.pathname}${event.url.search}` })}`
		}
	});
};
