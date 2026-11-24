import {
	AUTH_COOKIE_NAME,
	assertAuthConfigured,
	isMcpAuthorized,
	isMcpEnabled,
	isSessionValid
} from '$lib/server/auth';
import type { Handle } from '@sveltejs/kit';

const PUBLIC_PATHS = new Set(['/login', '/robots.txt']);

function isPublicPath(pathname: string): boolean {
	return PUBLIC_PATHS.has(pathname) || pathname.startsWith('/_app/');
}

function unauthorizedApiResponse(): Response {
	return new Response(JSON.stringify({ message: 'Authentication required' }), {
		status: 401,
		headers: { 'Content-Type': 'application/json' }
	});
}

/** MCP clients authenticate with their own token: a browser session must not open this route. */
function mcpAccessDenied(authorizationHeader: string | null): Response | null {
	if (!isMcpEnabled()) {
		return new Response(JSON.stringify({ message: 'MCP is disabled: MCP_TOKEN is not set' }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' }
		});
	}
	if (isMcpAuthorized(authorizationHeader)) return null;
	const response = unauthorizedApiResponse();
	response.headers.set('WWW-Authenticate', 'Bearer');
	return response;
}

export const handle: Handle = async ({ event, resolve }) => {
	assertAuthConfigured();

	if (event.url.pathname === '/mcp') {
		return mcpAccessDenied(event.request.headers.get('authorization')) ?? resolve(event);
	}

	if (isPublicPath(event.url.pathname)) return resolve(event);

	const sessionToken = event.cookies.get(AUTH_COOKIE_NAME);
	if (isSessionValid(sessionToken)) return resolve(event);

	if (event.url.pathname.startsWith('/api/')) return unauthorizedApiResponse();

	const next = `${event.url.pathname}${event.url.search}`;
	const location = `/login?${new URLSearchParams({ next })}`;
	return new Response(null, { status: 303, headers: { Location: location } });
};
