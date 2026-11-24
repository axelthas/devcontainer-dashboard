import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_COOKIE_NAME, createSession, resetAuthStateForTesting } from '$lib/server/auth';
import { handle } from './hooks.server';

function makeEvent(path: string, sessionToken?: string) {
	return {
		url: new URL(path, 'http://localhost'),
		cookies: {
			get: (name: string) => (name === AUTH_COOKIE_NAME ? sessionToken : undefined)
		}
	};
}

describe('MCP route authentication', () => {
	const resolve = async () => new Response('mcp');

	function mcpEvent(authorization?: string, sessionToken?: string) {
		return {
			...makeEvent('/mcp', sessionToken),
			request: new Request('http://localhost/mcp', {
				method: 'POST',
				headers: authorization ? { Authorization: authorization } : {}
			})
		} as never;
	}

	beforeEach(() => {
		process.env.DASHBOARD_PASSWORD = 'test-password';
		process.env.MCP_TOKEN = 'test-mcp-token';
		resetAuthStateForTesting();
	});

	afterEach(() => {
		delete process.env.DASHBOARD_PASSWORD;
		delete process.env.MCP_TOKEN;
		resetAuthStateForTesting();
	});

	it('allows the configured token', async () => {
		const response = await handle({ event: mcpEvent('Bearer test-mcp-token'), resolve });
		expect(await response.text()).toBe('mcp');
	});

	it('rejects a missing or wrong token', async () => {
		for (const header of [undefined, 'Bearer wrong', 'test-mcp-token', 'Basic test-mcp-token']) {
			const response = await handle({ event: mcpEvent(header), resolve });
			expect(response.status).toBe(401);
			expect(response.headers.get('www-authenticate')).toBe('Bearer');
		}
	});

	it('does not accept a browser session', async () => {
		const response = await handle({ event: mcpEvent(undefined, createSession()), resolve });
		expect(response.status).toBe(401);
	});

	it('stays closed when no token is configured, even with a session', async () => {
		delete process.env.MCP_TOKEN;
		const response = await handle({ event: mcpEvent('Bearer ', createSession()), resolve });
		expect(response.status).toBe(404);
	});

	it('keeps the MCP token away from the rest of the dashboard', async () => {
		const response = await handle({
			event: {
				...makeEvent('/api/containers'),
				request: new Request('http://localhost/api/containers', {
					headers: { Authorization: 'Bearer test-mcp-token' }
				})
			} as never,
			resolve
		});
		expect(response.status).toBe(401);
	});
});

describe('authentication hook', () => {
	beforeEach(() => {
		process.env.DASHBOARD_PASSWORD = 'test-password';
		resetAuthStateForTesting();
	});

	afterEach(() => {
		delete process.env.DASHBOARD_PASSWORD;
		resetAuthStateForTesting();
	});

	it('allows the login page without a session', async () => {
		const response = await handle({
			event: makeEvent('/login') as never,
			resolve: async () => new Response('login')
		});
		expect(await response.text()).toBe('login');
	});

	it('redirects page navigation and preserves the local destination', async () => {
		const response = await handle({
			event: makeEvent('/service?port=3000') as never,
			resolve: async () => new Response('protected')
		});
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/login?next=%2Fservice%3Fport%3D3000');
	});

	it('returns JSON 401 for unauthenticated API requests', async () => {
		const response = await handle({
			event: makeEvent('/api/containers') as never,
			resolve: async () => new Response('protected')
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: 'Authentication required' });
	});

	it('allows requests with a valid session', async () => {
		const token = createSession();
		const response = await handle({
			event: makeEvent('/', token) as never,
			resolve: async () => new Response('dashboard')
		});
		expect(await response.text()).toBe('dashboard');
	});
});
