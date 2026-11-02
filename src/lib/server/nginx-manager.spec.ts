/**
 * Unit tests for nginx-manager.ts
 *
 * Tests the pure / env-var-driven parts:
 *   - getNginxConfig  (reads env vars; returns null or NginxConfig)
 *
 * Docker-dependent functions (discoverProxyEntries, updateNginx) are
 * integration-level and require a live Docker daemon — they are not covered
 * here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';

// Prevent Dockerode from attempting to connect to /var/run/docker.sock.
vi.mock('./docker', () => ({ default: {} }));

import { getNginxConfig } from './nginx-manager';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reset env vars before each test and restore afterwards. */
function useCleanEnv(vars: Record<string, string | undefined>) {
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const key of Object.keys(vars)) {
			saved[key] = process.env[key];
			if (vars[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = vars[key];
			}
		}
	});
	afterEach(() => {
		for (const key of Object.keys(saved)) {
			if (saved[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = saved[key];
			}
		}
	});
}

// ── getNginxConfig ─────────────────────────────────────────────────────────────

describe('getNginxConfig', () => {
	describe('returns null when required env vars are missing', () => {
		useCleanEnv({
			NGINX_DOMAIN: undefined,
			NGINX_CERT_FULLCHAIN: undefined,
			NGINX_CERT_KEY: undefined
		});

		it('returns null when all three required vars are absent', () => {
			expect(getNginxConfig()).toBeNull();
		});

		it('returns null when only NGINX_DOMAIN is set', () => {
			process.env.NGINX_DOMAIN = 'polaris.example.com';
			expect(getNginxConfig()).toBeNull();
		});

		it('returns null when NGINX_DOMAIN and NGINX_CERT_FULLCHAIN are set but not key', () => {
			process.env.NGINX_DOMAIN = 'polaris.example.com';
			process.env.NGINX_CERT_FULLCHAIN = '/etc/ssl/fullchain.pem';
			expect(getNginxConfig()).toBeNull();
		});

		it('returns null when NGINX_DOMAIN and NGINX_CERT_KEY are set but not fullchain', () => {
			process.env.NGINX_DOMAIN = 'polaris.example.com';
			process.env.NGINX_CERT_KEY = '/etc/ssl/privkey.pem';
			expect(getNginxConfig()).toBeNull();
		});
	});

	describe('returns a valid config when all required vars are present', () => {
		useCleanEnv({
			NGINX_DOMAIN: 'polaris.example.com',
			NGINX_CERT_FULLCHAIN: '/etc/ssl/fullchain.pem',
			NGINX_CERT_KEY: '/etc/ssl/privkey.pem',
			NGINX_CONF_PATH: undefined,
			NGINX_HTPASSWD: undefined,
			NGINX_SSL_OPTIONS: undefined,
			NGINX_SSL_DHPARAM: undefined
		});

		it('returns a non-null config object', () => {
			expect(getNginxConfig()).not.toBeNull();
		});

		it('maps env vars to the correct config fields', () => {
			const cfg = getNginxConfig()!;
			expect(cfg.domain).toBe('polaris.example.com');
			expect(cfg.certFullchain).toBe('/etc/ssl/fullchain.pem');
			expect(cfg.certKey).toBe('/etc/ssl/privkey.pem');
		});

		it('uses the default conf path when NGINX_CONF_PATH is not set', () => {
			const cfg = getNginxConfig()!;
			expect(cfg.confPath).toBe('/etc/nginx/conf.d/polaris-dashboard.conf');
		});

		it('sets htpasswd to undefined when NGINX_HTPASSWD is not set', () => {
			const cfg = getNginxConfig()!;
			expect(cfg.htpasswd).toBeUndefined();
		});

		it('sets sslOptions to undefined when NGINX_SSL_OPTIONS is not set', () => {
			const cfg = getNginxConfig()!;
			expect(cfg.sslOptions).toBeUndefined();
		});

		it('sets sslDhparam to undefined when NGINX_SSL_DHPARAM is not set', () => {
			const cfg = getNginxConfig()!;
			expect(cfg.sslDhparam).toBeUndefined();
		});
	});

	describe('optional env vars are forwarded when set', () => {
		useCleanEnv({
			NGINX_DOMAIN: 'polaris.example.com',
			NGINX_CERT_FULLCHAIN: '/etc/ssl/fullchain.pem',
			NGINX_CERT_KEY: '/etc/ssl/privkey.pem',
			NGINX_CONF_PATH: '/custom/nginx.conf',
			NGINX_HTPASSWD: '/etc/nginx/.htpasswd',
			NGINX_SSL_OPTIONS: '/etc/letsencrypt/options-ssl-nginx.conf',
			NGINX_SSL_DHPARAM: '/etc/letsencrypt/ssl-dhparams.pem'
		});

		it('uses custom NGINX_CONF_PATH when provided', () => {
			expect(getNginxConfig()!.confPath).toBe('/custom/nginx.conf');
		});

		it('includes htpasswd when NGINX_HTPASSWD is set', () => {
			expect(getNginxConfig()!.htpasswd).toBe('/etc/nginx/.htpasswd');
		});

		it('includes sslOptions when NGINX_SSL_OPTIONS is set', () => {
			expect(getNginxConfig()!.sslOptions).toBe('/etc/letsencrypt/options-ssl-nginx.conf');
		});

		it('includes sslDhparam when NGINX_SSL_DHPARAM is set', () => {
			expect(getNginxConfig()!.sslDhparam).toBe('/etc/letsencrypt/ssl-dhparams.pem');
		});
	});
});
