/** Sibling subdomains are same-site, so the dashboard must reject their ambient-cookie requests. */
import { describe, expect, it } from 'vitest';
import { isDashboardRequestAllowed } from './dashboardRequestPolicy';

const DASHBOARD = 'https://host.tailnet.ts.net';
const SERVICE = 'https://4096-aaaaaaaaaaaa.host.tailnet.ts.net:8443';
const allowed = (method: string, headers: Record<string, string>) =>
	isDashboardRequestAllowed(method, new Headers(headers), DASHBOARD);

describe('dashboard request policy', () => {
	it('rejects service-subdomain writes, reads, subresources and frames', () => {
		expect(allowed('POST', { origin: SERVICE })).toBe(false);
		expect(allowed('GET', { origin: SERVICE })).toBe(false);
		expect(allowed('GET', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' })).toBe(false);
		expect(allowed('GET', { 'sec-fetch-dest': 'iframe' })).toBe(false);
		expect(allowed('POST', {})).toBe(false);
	});

	it('allows dashboard writes, top-level navigation and same-origin fetches', () => {
		expect(allowed('POST', { origin: DASHBOARD })).toBe(true);
		expect(allowed('GET', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' })).toBe(true);
		expect(allowed('GET', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' })).toBe(true);
		expect(allowed('GET', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })).toBe(true);
	});
});
