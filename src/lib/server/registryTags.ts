/**
 * List the tags of a registry image with the Docker credentials of the dashboard runtime.
 * The browser never names a registry: callers pass repositories from resolved Compose
 * images. Credentials stay in this module; errors carry a kind and a safe message only.
 * Protocol: Docker Registry HTTP API v2 `GET /v2/<name>/tags/list`, with Bearer token
 * or Basic authentication from the `WWW-Authenticate` challenge, and `Link` pagination.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DOCKER_HUB = 'registry-1.docker.io';
const REQUEST_TIMEOUT_MS = 10_000;
const HELPER_TIMEOUT_MS = 5_000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;
const MAX_TAGS = 10_000;
export const TAG_CACHE_MS = 5 * 60 * 1000;

export type RegistryErrorKind = 'unauthorized' | 'not-found' | 'timeout' | 'unavailable';

/** A listing failure that is safe to show: no credentials, tokens, or response bodies. */
export class RegistryError extends Error {
	readonly kind: RegistryErrorKind;
	constructor(kind: RegistryErrorKind, message: string) {
		super(message);
		this.name = 'RegistryError';
		this.kind = kind;
	}
}

/** Where a repository lives: registry host and repository path. */
export interface RegistryLocation {
	host: string;
	path: string;
}

/**
 * Resolve a repository name as Docker does. The first component is a registry host when
 * it has a dot or a port, or is `localhost`. Otherwise the image is on Docker Hub, and a
 * one-component name is in `library/`.
 */
export function registryLocation(repository: string): RegistryLocation {
	const parts = repository.split('/');
	const first = parts[0];
	const isHost =
		parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
	if (isHost && first !== 'docker.io' && first !== 'index.docker.io') {
		return { host: first, path: parts.slice(1).join('/') };
	}
	const rest = isHost ? parts.slice(1) : parts;
	return { host: DOCKER_HUB, path: rest.length === 1 ? `library/${rest[0]}` : rest.join('/') };
}

/** Username and password or token for one registry. */
export interface RegistryCredentials {
	username: string;
	secret: string;
}

/** Effects that the client needs; tests replace them. */
export interface RegistryDeps {
	fetch: typeof fetch;
	readDockerConfig: () => Promise<DockerConfig | undefined>;
	runHelper: (helper: string, serverUrl: string) => Promise<RegistryCredentials | undefined>;
	now: () => number;
}

/** The parts of `~/.docker/config.json` that hold credentials. */
export interface DockerConfig {
	auths?: Record<string, { auth?: string; username?: string; password?: string }>;
	credHelpers?: Record<string, string>;
	credsStore?: string;
}

/** Read the Docker client configuration of the dashboard runtime, if it exists. */
async function readDockerConfig(): Promise<DockerConfig | undefined> {
	const directory = process.env.DOCKER_CONFIG || join(homedir(), '.docker');
	try {
		return JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as DockerConfig;
	} catch {
		return undefined;
	}
}

/** Ask a Docker credential helper for one server, with a deadline. */
function runHelper(helper: string, serverUrl: string): Promise<RegistryCredentials | undefined> {
	return new Promise((resolve) => {
		const child = execFile(
			`docker-credential-${helper}`,
			['get'],
			{ timeout: HELPER_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: 'utf8' },
			(cause, stdout) => {
				if (cause) return resolve(undefined);
				try {
					const value = JSON.parse(stdout) as { Username?: string; Secret?: string };
					resolve(
						value.Secret ? { username: value.Username ?? '', secret: value.Secret } : undefined
					);
				} catch {
					resolve(undefined);
				}
			}
		);
		child.stdin?.end(serverUrl);
	});
}

const defaultDeps: RegistryDeps = {
	fetch: (...args) => fetch(...args),
	readDockerConfig,
	runHelper,
	now: () => Date.now()
};

/** Server keys that Docker uses in its configuration for one registry host. */
function configKeys(host: string): string[] {
	if (host === DOCKER_HUB) return ['https://index.docker.io/v1/', 'index.docker.io', 'docker.io'];
	return [host, `https://${host}`, `http://${host}`];
}

/** Find credentials as the Docker CLI does: a per-registry helper, then the store, then auths. */
export async function credentialsFor(
	host: string,
	deps: RegistryDeps = defaultDeps
): Promise<RegistryCredentials | undefined> {
	const config = await deps.readDockerConfig();
	if (!config) return undefined;
	for (const key of configKeys(host)) {
		const helper = config.credHelpers?.[key];
		if (helper && /^[A-Za-z0-9_-]+$/.test(helper)) return deps.runHelper(helper, key);
	}
	for (const key of configKeys(host)) {
		const entry = config.auths?.[key];
		if (!entry) continue;
		if (entry.username && entry.password) {
			return { username: entry.username, secret: entry.password };
		}
		if (entry.auth) {
			const decoded = Buffer.from(entry.auth, 'base64').toString('utf8');
			const colon = decoded.indexOf(':');
			if (colon > 0) return { username: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
		}
	}
	// Without inline credentials, the default store holds them, as in the Docker CLI.
	if (config.credsStore && /^[A-Za-z0-9_-]+$/.test(config.credsStore)) {
		return deps.runHelper(config.credsStore, configKeys(host)[0]);
	}
	return undefined;
}

/** Parse `Bearer realm="…",service="…",scope="…"` or `Basic realm="…"`. */
export function parseChallenge(
	header: string | null
): { scheme: string; params: Record<string, string> } | undefined {
	if (!header) return undefined;
	const match = /^\s*(\w+)\s*(.*)$/.exec(header);
	if (!match) return undefined;
	const params: Record<string, string> = {};
	for (const part of match[2].matchAll(/(\w+)="([^"]*)"/g)) params[part[1].toLowerCase()] = part[2];
	return { scheme: match[1].toLowerCase(), params };
}

/** Read the `rel="next"` target of a `Link` header, resolved against the current URL. */
export function nextLink(header: string | null, current: URL): URL | undefined {
	const match = header ? /<([^>]+)>\s*;\s*rel="?next"?/.exec(header) : null;
	if (!match) return undefined;
	const next = new URL(match[1], current);
	// Never follow pagination to another origin.
	return next.origin === current.origin ? next : undefined;
}

/** Encode Basic credentials. */
function basic(credentials: RegistryCredentials): string {
	return `Basic ${Buffer.from(`${credentials.username}:${credentials.secret}`).toString('base64')}`;
}

/** One request with a deadline; network and deadline failures become RegistryError. */
async function request(url: URL, headers: Record<string, string>, deps: RegistryDeps) {
	try {
		return await deps.fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	} catch (cause) {
		const name = (cause as { name?: string })?.name;
		if (name === 'TimeoutError' || name === 'AbortError') {
			throw new RegistryError('timeout', `${url.host} did not answer in time`);
		}
		throw new RegistryError('unavailable', `Could not reach ${url.host}`);
	}
}

/** Exchange a Bearer challenge for a pull token. */
async function bearerToken(
	params: Record<string, string>,
	path: string,
	credentials: RegistryCredentials | undefined,
	deps: RegistryDeps
): Promise<string> {
	let realm: URL;
	try {
		realm = new URL(params.realm);
	} catch {
		throw new RegistryError('unavailable', 'The registry sent an invalid authentication challenge');
	}
	if (realm.protocol !== 'https:' && !isLoopback(realm.hostname)) {
		throw new RegistryError('unavailable', 'The registry token service does not use HTTPS');
	}
	if (params.service) realm.searchParams.set('service', params.service);
	realm.searchParams.set('scope', `repository:${path}:pull`);
	const response = await request(
		realm,
		credentials ? { Authorization: basic(credentials) } : {},
		deps
	);
	if (response.status === 401 || response.status === 403) {
		throw new RegistryError('unauthorized', `${realm.host} refused the credentials for ${path}`);
	}
	if (!response.ok)
		throw new RegistryError('unavailable', `Token service answered ${response.status}`);
	const body = (await response.json().catch(() => ({}))) as {
		token?: string;
		access_token?: string;
	};
	const token = body.token ?? body.access_token;
	if (!token) throw new RegistryError('unavailable', 'The token service returned no token');
	return token;
}

/** Loopback registries may use plain HTTP, as Docker allows for `localhost`. */
function isLoopback(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Map a final HTTP status to a safe error. */
function statusError(status: number, host: string, path: string): RegistryError {
	if (status === 401 || status === 403) {
		return new RegistryError('unauthorized', `${host} refused tag listing for ${path} (${status})`);
	}
	if (status === 404) return new RegistryError('not-found', `${host} has no repository ${path}`);
	return new RegistryError('unavailable', `${host} answered ${status}`);
}

const cache = new Map<string, { at: number; tags: string[] }>();

/** Sort tags newest first by numeric segments: 26.0.47 before 26.0.9, then text order. */
export function compareTags(a: string, b: string): number {
	return b.localeCompare(a, 'en', { numeric: true });
}

/**
 * List every tag of one repository, newest first. Results are cached for five minutes per
 * repository; `refresh` skips the cache.
 */
export async function listRegistryTags(
	repository: string,
	options: { refresh?: boolean } = {},
	deps: RegistryDeps = defaultDeps
): Promise<string[]> {
	const cached = cache.get(repository);
	if (!options.refresh && cached && deps.now() - cached.at < TAG_CACHE_MS) return cached.tags;
	const { host, path } = registryLocation(repository);
	const scheme = isLoopback(host.replace(/:\d+$/, '')) ? 'http' : 'https';
	let url: URL | undefined = new URL(`${scheme}://${host}/v2/${path}/tags/list?n=${PAGE_SIZE}`);
	const headers: Record<string, string> = { Accept: 'application/json' };
	const tags = new Set<string>();
	let credentials: RegistryCredentials | undefined;
	let credentialsRead = false;
	let authenticated = false;
	for (let page = 0; url && page < MAX_PAGES && tags.size < MAX_TAGS; page++) {
		let response = await request(url, headers, deps);
		if (response.status === 401 && !authenticated) {
			// Authenticate once, from the challenge, then retry the same page.
			const challenge = parseChallenge(response.headers.get('www-authenticate'));
			if (!credentialsRead) {
				credentials = await credentialsFor(host, deps);
				credentialsRead = true;
			}
			if (challenge?.scheme === 'bearer' && challenge.params.realm) {
				headers.Authorization = `Bearer ${await bearerToken(challenge.params, path, credentials, deps)}`;
			} else if (challenge?.scheme === 'basic' && credentials) {
				headers.Authorization = basic(credentials);
			} else {
				throw statusError(401, host, path);
			}
			authenticated = true;
			response = await request(url, headers, deps);
		}
		if (!response.ok) throw statusError(response.status, host, path);
		const body = (await response.json().catch(() => ({}))) as { tags?: unknown };
		if (Array.isArray(body.tags)) {
			for (const tag of body.tags) if (typeof tag === 'string') tags.add(tag);
		}
		url = nextLink(response.headers.get('link'), url);
	}
	const sorted = [...tags].sort(compareTags).slice(0, MAX_TAGS);
	cache.set(repository, { at: deps.now(), tags: sorted });
	return sorted;
}

/** Forget cached listings; tests use this between cases. */
export function clearRegistryTagCache(): void {
	cache.clear();
}
