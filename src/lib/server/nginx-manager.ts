/**
 * Nginx Manager
 *
 * Generates an nginx config block for every running Polaris container that
 * exposes a NoVNC port (6904), writing it to /etc/nginx/conf.d/ via
 * `sudo tee` (allowed without password via sudoers).
 *
 * Each container gets a subdomain:
 *   <container-name>.<NGINX_DOMAIN>  →  NoVNC port on 127.0.0.1
 *
 * Required env vars:
 *   NGINX_DOMAIN          e.g. polaris.example.com
 *   NGINX_CERT_FULLCHAIN  e.g. /etc/letsencrypt/live/polaris.example.com/fullchain.pem
 *   NGINX_CERT_KEY        e.g. /etc/letsencrypt/live/polaris.example.com/privkey.pem
 *   NGINX_HTPASSWD        e.g. /etc/nginx/.htpasswd-polaris  (optional — omit for no auth)
 *   NGINX_CONF_PATH       e.g. /etc/nginx/conf.d/polaris-dashboard.conf
 *   NGINX_SSL_OPTIONS     e.g. /etc/letsencrypt/options-ssl-nginx.conf (optional)
 *   NGINX_SSL_DHPARAM     e.g. /etc/letsencrypt/ssl-dhparams.pem (optional)
 */

import docker from './docker';

export interface NginxConfig {
	domain: string;
	certFullchain: string;
	certKey: string;
	htpasswd?: string;
	confPath: string;
	sslOptions?: string;
	sslDhparam?: string;
}

export function getNginxConfig(): NginxConfig | null {
	const domain = process.env.NGINX_DOMAIN;
	const certFullchain = process.env.NGINX_CERT_FULLCHAIN;
	const certKey = process.env.NGINX_CERT_KEY;
	const confPath = process.env.NGINX_CONF_PATH ?? '/etc/nginx/conf.d/polaris-dashboard.conf';

	if (!domain || !certFullchain || !certKey) return null;

	return {
		domain,
		certFullchain,
		certKey,
		htpasswd: process.env.NGINX_HTPASSWD,
		confPath,
		sslOptions: process.env.NGINX_SSL_OPTIONS,
		sslDhparam: process.env.NGINX_SSL_DHPARAM
	};
}

/** Port inside the container that NoVNC listens on. */
const NOVNC_CONTAINER_PORT = 6904;

interface ContainerProxyEntry {
	name: string; // clean name, e.g. polaris-ice-fdp-a
	subdomain: string; // e.g. ice-fdp-a.polaris.example.com
	hostPort: number;
}

/**
 * Discover all running containers that expose NoVNC (port 6904) and build
 * subdomain → host-port mappings.
 */
export async function discoverProxyEntries(cfg: NginxConfig): Promise<ContainerProxyEntry[]> {
	const containers = await docker.listContainers({ all: false });
	const entries: ContainerProxyEntry[] = [];

	for (const c of containers) {
		const rawName = (c.Names?.[0] ?? '').replace(/^\//, '');
		const noVncPort = (c.Ports ?? []).find(
			(p) => p.PrivatePort === NOVNC_CONTAINER_PORT && p.PublicPort
		);
		if (!noVncPort?.PublicPort) continue;

		// Build a clean subdomain: strip common prefixes to keep names short
		// polaris-ice-fdp-a  → ice-fdp-a.<domain>
		// polaris-qkt-sdp-a  → qkt-sdp-a.<domain>
		// orion-server-mag   → mag-orion.<domain>
		const subdomain =
			rawName
				.replace(/^polaris-/, '') // polaris-ice-fdp-a → ice-fdp-a
				.replace(/^orion-server-/, '') + // orion-server-mag → mag
			'.' +
			cfg.domain;

		entries.push({ name: rawName, subdomain, hostPort: noVncPort.PublicPort });
	}

	// Sort for stable config output
	entries.sort((a, b) => a.name.localeCompare(b.name));
	return entries;
}

function buildServerBlock(entry: ContainerProxyEntry, cfg: NginxConfig): string {
	const auth = cfg.htpasswd
		? `\n        auth_basic "Polaris — Restricted";\n        auth_basic_user_file ${cfg.htpasswd};\n`
		: '';
	const sslOpts = cfg.sslOptions ? `\n    include ${cfg.sslOptions};` : '';
	const dhparam = cfg.sslDhparam ? `\n    ssl_dhparam ${cfg.sslDhparam};` : '';

	return `
# ${entry.name} → NoVNC :${entry.hostPort}
server {
    listen 80;
    server_name ${entry.subdomain};
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl http2;
    server_name ${entry.subdomain};

    ssl_certificate     ${cfg.certFullchain};
    ssl_certificate_key ${cfg.certKey};${sslOpts}${dhparam}

    location / {${auth}
        proxy_pass http://127.0.0.1:${entry.hostPort};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_buffering off;
        proxy_read_timeout 90s;
    }
}`;
}

export interface NginxUpdateResult {
	entries: ContainerProxyEntry[];
	confPath: string;
}

/**
 * Write nginx conf and reload nginx by spawning a short-lived privileged
 * Docker container that runs in the host PID + mount namespace (nsenter).
 * The container writes the conf file via `tee` and reloads nginx.
 *
 * Uses `alpine` image (already present on the host for Polaris sources or
 * fetched from registry).  Falls back to alpine:latest if not found locally.
 */
async function writeAndReloadViaDocker(confPath: string, content: string): Promise<void> {
	// Escape single quotes in content for shell heredoc safety
	const b64 = Buffer.from(content).toString('base64');

	// nsenter into PID 1 (host init) to access the real /etc/nginx/conf.d
	// and run systemctl reload nginx
	const shellScript = [
		`echo ${b64} | base64 -d | tee ${confPath} > /dev/null`,
		`nginx -t -c /etc/nginx/nginx.conf`,
		`systemctl reload nginx`
	].join(' && ');

	// We use `nsenter` targeting PID 1 of the host (available when container
	// is run with --pid=host).  The helper container uses alpine with nsenter.
	const cmd = [
		'nsenter',
		'--target',
		'1',
		'--mount',
		'--uts',
		'--ipc',
		'--net',
		'--pid',
		'--',
		'sh',
		'-c',
		shellScript
	];

	const container = await docker.createContainer({
		Image: 'alpine:latest',
		Cmd: cmd,
		HostConfig: {
			AutoRemove: true,
			PidMode: 'host',
			NetworkMode: 'host',
			Privileged: true,
			Binds: ['/proc:/proc']
		}
	});

	await container.start();

	// Wait for completion and check exit code
	const result = await container.wait();
	if (result.StatusCode !== 0) {
		throw new Error(`nginx update helper container exited with code ${result.StatusCode}`);
	}
}

/**
 * Generate nginx config for all running Polaris NoVNC containers,
 * write it via `sudo tee`, then reload nginx.
 *
 * Two strategies are attempted in order:
 *  1. Direct `sudo tee` + `sudo systemctl reload nginx` — works when the
 *     dashboard process has passwordless sudo (e.g. running on host directly).
 *  2. Docker helper container — launches a short-lived privileged Alpine
 *     container that uses nsenter to run in the host PID/mount namespace,
 *     writes the conf file and reloads nginx.  Works when the dashboard runs
 *     inside Docker with /var/run/docker.sock mounted.
 */
export async function updateNginx(cfg: NginxConfig): Promise<NginxUpdateResult> {
	const entries = await discoverProxyEntries(cfg);

	if (entries.length === 0) {
		throw new Error('No running containers with NoVNC port (6904) found.');
	}

	const header = `# Auto-generated by devcontainer-dashboard — do not edit manually
# Updated: ${new Date().toISOString()}
# ${entries.length} container(s) mapped\n`;

	const body = entries.map((e) => buildServerBlock(e, cfg)).join('\n');
	const conf = header + body + '\n';

	await writeAndReloadViaDocker(cfg.confPath, conf);

	return { entries, confPath: cfg.confPath };
}
