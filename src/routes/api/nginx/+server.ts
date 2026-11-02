/**
 * POST /api/nginx/update
 *
 * Generates an nginx reverse-proxy config for all running Polaris containers
 * that expose NoVNC (port 6904), writes it to /etc/nginx/conf.d/ and reloads
 * nginx.
 *
 * GET /api/nginx/status — returns current nginx config state (entries mapped)
 *
 * Requires NGINX_DOMAIN, NGINX_CERT_FULLCHAIN, NGINX_CERT_KEY to be set.
 */

import { json, error } from '@sveltejs/kit';
import { getNginxConfig, updateNginx, discoverProxyEntries } from '$lib/server/nginx-manager';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const cfg = getNginxConfig();
	if (!cfg) {
		return json({
			available: false,
			reason: 'NGINX_DOMAIN / NGINX_CERT_FULLCHAIN / NGINX_CERT_KEY not configured'
		});
	}
	try {
		const entries = await discoverProxyEntries(cfg);
		return json({ available: true, domain: cfg.domain, entries });
	} catch (err: unknown) {
		return json({ available: false, reason: err instanceof Error ? err.message : String(err) });
	}
};

export const POST: RequestHandler = async () => {
	const cfg = getNginxConfig();
	if (!cfg) {
		throw error(
			501,
			'Nginx integration not configured. Set NGINX_DOMAIN, NGINX_CERT_FULLCHAIN, NGINX_CERT_KEY env vars.'
		);
	}
	try {
		const result = await updateNginx(cfg);
		return json({
			success: true,
			confPath: result.confPath,
			entries: result.entries
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw error(500, msg);
	}
};
