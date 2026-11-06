import { describe, expect, it } from 'vitest';
import { isDashboardRequestAllowed } from './dashboardRequestPolicy';

const DASHBOARD = 'https://host.tailnet.ts.net';
const SERVICE = 'https://4096-aaaaaaaaaaaa.host.tailnet.ts.net:8443';

/** Evaluate the policy for one method and set of request headers. */
function allowed(method: string, headers: Record<string, string>): boolean {
	return isDashboardRequestAllowed(method, new Headers(headers), DASHBOARD);
}

describe('isDashboardRequestAllowed', () => {
	it('rejects writes, reads, subresources and frames from a service subdomain', () => {
		expect(allowed('POST', { origin: SERVICE })).toBe(false);
		expect(allowed('GET', { origin: SERVICE })).toBe(false);
		expect(allowed('POST', {})).toBe(false);
		expect(allowed('GET', { 'sec-fetch-dest': 'iframe' })).toBe(false);
		const script = {
			'sec-fetch-site': 'same-site',
			'sec-fetch-mode': 'no-cors',
			'sec-fetch-dest': 'script'
		};
		expect(allowed('GET', script)).toBe(false);
	});

	it('allows dashboard writes, top-level navigation and same-origin fetches', () => {
		const navigate = { 'sec-fetch-mode': 'navigate' };
		expect(allowed('POST', { origin: DASHBOARD })).toBe(true);
		expect(allowed('GET', { ...navigate, 'sec-fetch-site': 'none' })).toBe(true);
		expect(allowed('GET', { ...navigate, 'sec-fetch-site': 'same-site' })).toBe(true);
		const cors = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };
		expect(allowed('GET', cors)).toBe(true);
	});
});
