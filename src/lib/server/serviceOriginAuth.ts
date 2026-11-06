/**
 * Short-lived launch tickets and revocable per-origin service sessions.
 * Only digests index bearer values. Global state bridges SvelteKit and custom-server imports.
 */
import { createHash, randomBytes } from 'node:crypto';
import { isSessionValid } from './auth.js';

const TICKET_MS = 30_000;
const SESSION_MS = 8 * 60 * 60_000;
const MAX_ENTRIES = 2048;

/** Host-only cookie on one service subdomain; the browser never sends it to another host. */
export const SERVICE_SESSION_COOKIE = '__Host-ddash-service-session';

/** A grant binds one browser origin to one full Docker identity and one dashboard session. */
export interface ServiceRoute {
	origin: string;
	containerId: string;
	containerPort: string;
}

interface Grant extends ServiceRoute {
	parent: string;
	expires: number;
}

interface Store {
	tickets: Map<string, Grant>;
	sessions: Map<string, Grant>;
}

const shared = globalThis as typeof globalThis & { __ddashServiceSubdomainAuth?: Store };
const store = (shared.__ddashServiceSubdomainAuth ??= { tickets: new Map(), sessions: new Map() });

/** Hash an unguessable bearer value before using it as an index. */
function digest(token: string): string {
	return createHash('sha256').update(token).digest('base64url');
}

/** Expire unused grants and grants whose dashboard session was revoked. */
function prune(now: number): void {
	for (const map of [store.tickets, store.sessions]) {
		for (const [key, grant] of map) {
			if (grant.expires <= now || !isSessionValid(grant.parent)) map.delete(key);
		}
	}
}

/** Read exactly one named cookie; ambiguous duplicates fail closed. */
export function readUniqueCookie(header: string | undefined, name: string): string | undefined {
	const values = (header ?? '').split(';').flatMap((part) => {
		const at = part.indexOf('=');
		return at >= 0 && part.slice(0, at).trim() === name ? [part.slice(at + 1).trim()] : [];
	});
	return values.length === 1 ? values[0] : undefined;
}

/** Issue a one-use ticket only for a currently authenticated dashboard session. */
export function issueServiceLaunch(route: ServiceRoute, parent: string, now = Date.now()): string {
	prune(now);
	if (!isSessionValid(parent)) throw new Error('Dashboard authentication required.');
	if (store.tickets.size >= MAX_ENTRIES) throw new Error('Too many pending service launches.');
	const token = randomBytes(32).toString('base64url');
	store.tickets.set(digest(token), { ...route, parent, expires: now + TICKET_MS });
	// A URL fragment is never sent to the server or in a Referer header.
	return `${route.origin}/__ddash/launch#${token}`;
}

/** Consume a ticket once; a ticket issued for another origin is rejected. */
export function exchangeServiceLaunch(
	origin: string,
	ticket: string,
	now = Date.now()
): string | undefined {
	prune(now);
	const key = digest(ticket);
	const grant = store.tickets.get(key);
	if (!grant || grant.origin !== origin) return undefined;
	store.tickets.delete(key);
	if (store.sessions.size >= MAX_ENTRIES) return undefined;
	const token = randomBytes(32).toString('base64url');
	store.sessions.set(digest(token), { ...grant, expires: now + SESSION_MS });
	return token;
}

/** Return the route of a valid session on this origin; callers recheck it on every request. */
export function serviceSessionRoute(
	origin: string,
	cookie: string | undefined,
	now = Date.now()
): ServiceRoute | undefined {
	prune(now);
	const token = readUniqueCookie(cookie, SERVICE_SESSION_COOKIE);
	const grant = token ? store.sessions.get(digest(token)) : undefined;
	if (!grant || grant.origin !== origin) return undefined;
	return {
		origin: grant.origin,
		containerId: grant.containerId,
		containerPort: grant.containerPort
	};
}
