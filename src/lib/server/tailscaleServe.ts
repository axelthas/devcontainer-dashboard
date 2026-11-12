/**
 * Opt-in Tailscale Serve primitives for issue #27.
 * This module has no startup side effects and does not expose container services.
 */
import { request } from 'node:http';

export type ServeConfig = {
	TCP?: Record<string, unknown>;
	Web?: Record<string, unknown>;
	AllowFunnel?: Record<string, unknown>;
	Foreground?: Record<string, ServeConfig>;
	Services?: Record<string, ServeConfig>;
	[key: string]: unknown;
};

type Snapshot = { config: ServeConfig; etag: string };

/** Reject invalid top-level responses instead of replacing them with an empty config. */
function parseConfig(body: string): ServeConfig {
	const value: unknown = JSON.parse(body);
	if (value === null) return {};
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Invalid Tailscale Serve configuration');
	}
	return value as ServeConfig;
}

/** Read or conditionally replace Serve configuration over an explicit Unix socket. */
export function createServeConfigClient(socketPath?: string) {
	if (!socketPath) return null;
	if (!socketPath.startsWith('/')) throw new Error('Tailscale socket path must be absolute');

	/** Bound request duration and response size; never follow redirects or use TCP fallback. */
	function send(method: 'GET' | 'POST', body?: string, etag?: string) {
		return new Promise<{ body: string; etag: string }>((resolve, reject) => {
			const req = request(
				{
					socketPath,
					path: '/localapi/v0/serve-config',
					method,
					signal: AbortSignal.timeout(5000),
					headers: {
						Host: 'local-tailscaled.sock',
						...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
						...(etag === undefined ? {} : { 'If-Match': etag })
					}
				},
				(res) => {
					const chunks: Buffer[] = [];
					let size = 0;
					res.on('error', reject);
					res.on('data', (chunk: Buffer) => {
						size += chunk.length;
						if (size > 1024 * 1024) {
							req.destroy(new Error('Tailscale LocalAPI response exceeds 1 MiB'));
							return;
						}
						chunks.push(chunk);
					});
					res.on('end', () => {
						if (res.statusCode !== 200) {
							reject(
								Object.assign(new Error(`Tailscale LocalAPI returned HTTP ${res.statusCode}`), {
									statusCode: res.statusCode
								})
							);
							return;
						}
						resolve({
							body: Buffer.concat(chunks).toString('utf8'),
							etag: typeof res.headers.etag === 'string' ? res.headers.etag : ''
						});
					});
				}
			);
			req.on('error', reject);
			req.end(body);
		});
	}

	/** Require a daemon-provided ETag before allowing any update. */
	async function get(): Promise<Snapshot> {
		const response = await send('GET');
		if (!response.etag) throw new Error('Tailscale LocalAPI did not return an ETag');
		return { config: parseConfig(response.body), etag: response.etag };
	}

	/** Re-run a pure merge on fresh state after HTTP 412; null means no write. */
	async function update(
		merge: (config: ServeConfig) => ServeConfig | null | Promise<ServeConfig | null>
	): Promise<ServeConfig> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const snapshot = await get();
			const next = await merge(structuredClone(snapshot.config));
			if (next === null) return snapshot.config;
			try {
				await send('POST', JSON.stringify(next), snapshot.etag);
				return next;
			} catch (error) {
				if (!(error instanceof Error) || !('statusCode' in error) || error.statusCode !== 412) {
					throw error;
				}
			}
		}
		throw new Error('Tailscale Serve configuration changed during all three update attempts');
	}

	return { get, update };
}

/** Find an unused port without changing any background, foreground, service, or Funnel entry. */
export function allocateServePort(config: ServeConfig, first: number, last: number): number {
	if (
		!Number.isInteger(first) ||
		!Number.isInteger(last) ||
		first < 1 ||
		last > 65535 ||
		first > last
	) {
		throw new Error('Invalid Tailscale Serve port range');
	}
	const occupied = new Set<number>();

	/** Conservatively reserve ports in every known config scope, including disabled Funnel keys. */
	function collect(scope: ServeConfig) {
		if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
			throw new Error('Invalid Tailscale Serve configuration scope');
		}
		for (const [field, hostPort] of [
			['TCP', false],
			['Web', true],
			['AllowFunnel', true]
		] as const) {
			const entries = scope[field];
			if (entries === undefined || entries === null) continue;
			if (typeof entries !== 'object' || Array.isArray(entries)) {
				throw new Error(`Invalid Tailscale Serve ${field} map`);
			}
			for (const key of Object.keys(entries)) {
				const value = hostPort ? key.slice(key.lastIndexOf(':') + 1) : key;
				if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
					throw new Error('Invalid port in Tailscale Serve configuration');
				}
				occupied.add(Number(value));
			}
		}
		for (const field of ['Foreground', 'Services'] as const) {
			const scopes = scope[field];
			if (scopes === undefined || scopes === null) continue;
			if (typeof scopes !== 'object' || Array.isArray(scopes)) {
				throw new Error(`Invalid Tailscale Serve ${field} map`);
			}
			for (const child of Object.values(scopes)) collect(child);
		}
	}

	collect(config);
	for (let port = first; port <= last; port++) {
		if (!occupied.has(port)) return port;
	}
	throw new Error('No free Tailscale Serve port in the configured range');
}
