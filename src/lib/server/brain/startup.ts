/**
 * Brain startup: persistent credentials and an explicitly public Tailscale Funnel.
 * Only the dedicated MCP listener is published. ETag updates preserve other routes;
 * a durable intent and a process lock constrain recovery and cleanup to our route.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { brainSettings, type BrainSettings } from './gateway.js';
import { allocateServePort, type ServeConfig } from '../tailscaleServe.js';

type Client = {
	update: (
		merge: (config: ServeConfig) => ServeConfig | null | Promise<ServeConfig | null>
	) => Promise<ServeConfig>;
};
type Entry = { version: 1; hostname: string; port: number; upstream: number };
type Funnel = {
	hostname: string;
	port: number;
	upstream: number;
	stateFile: string;
};

/** Read strict boolean settings; a typo must not silently change public exposure. */
function enabled(value: string | undefined, name: string): boolean {
	if (value !== undefined && value !== '0' && value !== '1')
		throw new Error(`${name} must be 0 or 1`);
	return value === '1';
}

/** Create a private token once in the retained data volume; never overwrite an existing file. */
export async function prepareBrain(
	env: Record<string, string | undefined>,
	automaticFile = '/data/brain-mcp-token'
): Promise<BrainSettings | null> {
	const automatic = enabled(env.BRAIN_MCP_ENABLED, 'BRAIN_MCP_ENABLED');
	if (!automatic || env.BRAIN_MCP_TOKEN || env.BRAIN_MCP_TOKEN_FILE) return brainSettings(env);
	if (!isAbsolute(automaticFile)) throw new Error('Brain token path must be absolute');
	await mkdir(dirname(automaticFile), { recursive: true });
	try {
		const file = await open(automaticFile, 'wx', 0o600);
		try {
			await file.writeFile(`${randomBytes(32).toString('hex')}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
	} catch (error) {
		if (!hasCode(error, 'EEXIST')) throw error;
	}
	const stat = await lstat(automaticFile);
	if (!stat.isFile() || (stat.mode & 0o077) !== 0)
		throw new Error('Brain token must be a private regular file (mode 600)');
	return brainSettings({ ...env, BRAIN_MCP_TOKEN_FILE: automaticFile });
}

/** Narrow filesystem errors without discarding other failures. */
function hasCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

/** Validate Funnel before listeners or daemon writes. Never enable it through an inferred URL. */
export function brainFunnelSettings(
	env: Record<string, string | undefined>,
	brain: BrainSettings | null
): Funnel | null {
	if (!enabled(env.BRAIN_MCP_FUNNEL, 'BRAIN_MCP_FUNNEL')) return null;
	if (!brain || !env.TAILSCALE_SOCKET)
		throw new Error('Brain Funnel requires Brain access and an explicit Tailscale socket');
	const origin = new URL(env.ORIGIN ?? '');
	if (
		origin.protocol !== 'https:' ||
		origin.origin !== env.ORIGIN ||
		!/^[a-z0-9.-]+\.ts\.net$/.test(origin.hostname) ||
		origin.username ||
		origin.password
	)
		throw new Error('Brain Funnel requires an exact Tailscale HTTPS ORIGIN');
	const raw = env.BRAIN_MCP_FUNNEL_PORT ?? '10000';
	if (!['443', '8443', '10000'].includes(raw))
		throw new Error('Brain Funnel port must be 443, 8443 or 10000');
	const port = Number(raw);
	if (
		[Number(origin.port || '443'), Number(env.PORT || '3000'),
			Number(env.TAILSCALE_GATEWAY_PORT || '3003'), brain.port,
			Number(env.AI_PUBLIC_PORT || '3002')].includes(port)
	)
		throw new Error('Brain Funnel port conflicts with a dashboard, AI or MCP listener');
	const range = /^(\d+)-(\d+)$/.exec(env.TAILSCALE_SERVE_PORTS ?? '8400-8499');
	if (!range || (port >= Number(range[1]) && port <= Number(range[2])))
		throw new Error('Brain Funnel port must be outside the service allocation range');
	return { hostname: origin.hostname, port, upstream: brain.port, stateFile: '/data/brain-funnel.json' };
}

/** Exact values we own in the daemon configuration. No extra metadata is sent to tailscaled. */
function expected(entry: Entry) {
	return {
		key: `${entry.hostname}:${entry.port}`,
		tcp: { HTTPS: true },
		web: { Handlers: { '/': { Proxy: `http://127.0.0.1:${entry.upstream}` } } }
	};
}

/** An operator edit or a shadowing scope transfers ownership away from this process. */
export function ownsBrainFunnel(config: ServeConfig, entry: Entry): boolean {
	const want = expected(entry);
	if (
		!isDeepStrictEqual(config.TCP?.[entry.port], want.tcp) ||
		!isDeepStrictEqual(config.Web?.[want.key], want.web) ||
		config.AllowFunnel?.[want.key] !== true ||
		Object.keys(config.Web ?? {}).some((key) => key !== want.key && key.endsWith(`:${entry.port}`)) ||
		Object.keys(config.AllowFunnel ?? {}).some((key) => key !== want.key && key.endsWith(`:${entry.port}`))
	) return false;
	const occupied = (scope: ServeConfig): boolean => {
		if (
			Object.prototype.hasOwnProperty.call(scope.TCP ?? {}, String(entry.port)) ||
			['Web', 'AllowFunnel'].some((field) =>
				Object.keys((scope[field] ?? {}) as object).some((key) => key.endsWith(`:${entry.port}`))
			)
		) return true;
		return [...Object.values(scope.Foreground ?? {}), ...Object.values(scope.Services ?? {})]
			.some(occupied);
	};
	return ![...Object.values(config.Foreground ?? {}), ...Object.values(config.Services ?? {})]
		.some(occupied);
}

/** Reject malformed ownership records. Corrupt state never authorizes deletion. */
function parseEntry(value: unknown): Entry {
	const entry = value as Entry;
	if (
		!entry || entry.version !== 1 || !/^[a-z0-9.-]+\.ts\.net$/.test(entry.hostname) ||
		![443, 8443, 10000].includes(entry.port) || !Number.isInteger(entry.upstream) ||
		entry.upstream < 1 || entry.upstream > 65535
	) throw new Error('Invalid Brain Funnel journal; inspect it manually');
	return entry;
}

/** Linux process start ticks distinguish a live owner from a reused PID after a restart. */
async function processStart(pid: number): Promise<string> {
	const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
	return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

/** Lock the journal; refuse uncertain owners rather than touch another instance's route. */
async function acquireLock(path: string): Promise<() => Promise<void>> {
	await mkdir(dirname(path), { recursive: true });
	try {
		await mkdir(path);
	} catch (error) {
		if (!hasCode(error, 'EEXIST')) throw error;
		const owner = JSON.parse(await readFile(join(path, 'owner'), 'utf8')) as {
			host: string; pid: number; start: string;
		};
		if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid < 1)
			throw new Error('Brain Funnel journal locked by another instance; inspect it manually');
		let alive = true;
		try { alive = (await processStart(owner.pid)) === owner.start; }
		catch (lookup) { if (hasCode(lookup, 'ENOENT')) alive = false; else throw lookup; }
		if (alive) throw new Error('Brain Funnel journal is already in use');
		await rm(path, { recursive: true });
		await mkdir(path);
	}
	const owner = await open(join(path, 'owner'), 'wx', 0o600);
	try {
		await owner.writeFile(JSON.stringify({ host: hostname(), pid: process.pid, start: await processStart(process.pid) }));
		await owner.sync();
	} finally { await owner.close(); }
	return () => rm(path, { recursive: true });
}

/** Durable intent before a daemon write, including if the API response is lost. */
async function persist(path: string, entry: Entry): Promise<void> {
	const file = await open(`${path}.tmp`, 'w', 0o600);
	try { await file.writeFile(JSON.stringify(entry)); await file.sync(); }
	finally { await file.close(); }
	await rename(`${path}.tmp`, path);
	const directory = await open(dirname(path), 'r');
	try { await directory.sync(); } finally { await directory.close(); }
}

/** Remove only the exact listener we recorded; preserve operator edits and unrelated routes. */
async function retire(client: Client, entry: Entry): Promise<void> {
	await client.update((config) => {
		if (!ownsBrainFunnel(config, entry)) return null;
		const want = expected(entry);
		delete config.TCP?.[entry.port];
		delete config.Web?.[want.key];
		delete config.AllowFunnel?.[want.key];
		return config;
	});
}

/**
 * Reconcile a retained intent, then opt into Funnel. Call only after the MCP listener binds.
 * Passing null recovers/removes a previous owned route without publishing a replacement.
 */
export async function startBrainFunnel(
	client: Client,
	settings: Funnel | null,
	stateFile = settings?.stateFile ?? '/data/brain-funnel.json'
): Promise<{ publicUrl?: string; close: () => Promise<void> }> {
	const unlock = await acquireLock(`${stateFile}.lock`);
	let entry: Entry | undefined;
	let attemptedWrite = false;
	try {
		let previous: Entry | undefined;
		try { previous = parseEntry(JSON.parse(await readFile(stateFile, 'utf8'))); }
		catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
		if (previous) {
			await retire(client, previous);
			await rm(stateFile);
		}
		if (settings) {
			entry = { version: 1, hostname: settings.hostname, port: settings.port, upstream: settings.upstream };
			const intent = entry;
			await client.update(async (config) => {
				// Also checks foreground, services and disabled Funnel reservations. Never adopt an unowned entry.
				allocateServePort(config, intent.port, intent.port);
				await persist(stateFile, intent);
				attemptedWrite = true;
				const want = expected(intent);
				config.TCP = { ...config.TCP, [intent.port]: want.tcp };
				config.Web = { ...config.Web, [want.key]: want.web };
				config.AllowFunnel = { ...config.AllowFunnel, [want.key]: true };
				return config;
			});
		}
	} catch (error) {
		// The POST might have committed even when its response was lost. Retain intent on cleanup failure.
		try {
			if (entry && attemptedWrite) { await retire(client, entry); await rm(stateFile, { force: true }); }
		} finally { await unlock(); }
		throw error;
	}
	let closed = false;
	return {
		publicUrl: settings
			? `https://${settings.hostname}${settings.port === 443 ? '' : `:${settings.port}`}/mcp`
			: undefined,
		async close() {
			if (closed) return;
			closed = true;
			try {
				if (entry) { await retire(client, entry); await rm(stateFile, { force: true }); }
			} finally { await unlock(); }
		}
	};
}
