/**
 * Short-lived launch tickets and revocable service sessions.
 * Only digests index bearer values. Global state bridges SvelteKit/custom-server imports.
 */
import { createHash, randomBytes } from 'node:crypto';
import { isSessionValid } from './auth.js';
import type { ServiceOrigin } from './serviceOriginConfig.js';

const TICKET_MS = 30_000;
const SESSION_MS = 8 * 60 * 60_000;
const MAX_ENTRIES = 2048;
interface Grant {
	origin: string;
	identity: string;
	parent: string;
	expires: number;
}
interface Store {
	tickets: Map<string, Grant>;
	sessions: Map<string, Grant>;
}
const shared = globalThis as typeof globalThis & { __ddashServiceOriginAuth?: Store };
const store = (shared.__ddashServiceOriginAuth ??= { tickets: new Map(), sessions: new Map() });

/** Hash an unguessable bearer value before using it as an index. */
function digest(token: string): string {
	return createHash('sha256').update(token).digest('base64url');
}

/** Bind a grant to a full Docker identity, not a host port that Docker can reuse. */
function identity(route: ServiceOrigin): string {
	return `${route.containerId}:${route.containerPort}`;
}

/** Expire unused grants and grants whose dashboard session was revoked. */
function prune(now: number): void {
	for (const map of [store.tickets, store.sessions]) {
		for (const [key, grant] of map) {
			if (grant.expires <= now || !isSessionValid(grant.parent)) map.delete(key);
		}
	}
}

/** Give each origin a distinct reserved cookie namespace (ports do not isolate cookies). */
export function serviceCookiePrefix(route: ServiceOrigin): string {
	return `__Secure-ddash-svc-${digest(route.origin).slice(0, 16)}-`;
}

/** Read exactly one named cookie; ambiguous cookie paths fail closed. */
export function readUniqueCookie(header: string | undefined, name: string): string | undefined {
	const values = (header ?? '').split(';').flatMap((part) => {
		const at = part.indexOf('=');
		return at >= 0 && part.slice(0, at).trim() === name ? [part.slice(at + 1).trim()] : [];
	});
	return values.length === 1 ? values[0] : undefined;
}

/** Issue a one-use ticket only for a currently authenticated dashboard session. */
export function issueServiceLaunch(route: ServiceOrigin, parent: string, now = Date.now()): string {
	prune(now);
	if (!isSessionValid(parent)) throw new Error('Dashboard authentication required.');
	if (store.tickets.size >= MAX_ENTRIES) throw new Error('Too many pending service launches.');
	const token = randomBytes(32).toString('base64url');
	store.tickets.set(digest(token), {
		origin: route.origin,
		identity: identity(route),
		parent,
		expires: now + TICKET_MS
	});
	return `${route.origin}/__ddash/launch#${token}`;
}

/** Consume atomically before any asynchronous work; wrong-origin tickets cannot be replayed. */
export function exchangeServiceLaunch(
	route: ServiceOrigin,
	ticket: string,
	now = Date.now()
): string | undefined {
	prune(now);
	const key = digest(ticket);
	const grant = store.tickets.get(key);
	if (!grant || grant.origin !== route.origin || grant.identity !== identity(route)) return undefined;
	store.tickets.delete(key);
	if (store.sessions.size >= MAX_ENTRIES) return undefined;
	const token = randomBytes(32).toString('base64url');
	store.sessions.set(digest(token), { ...grant, expires: now + SESSION_MS });
	return token;
}

/** Recheck parent logout and absolute expiry on every HTTP request and live-connection lease. */
export function isServiceSessionValid(
	route: ServiceOrigin,
	cookie: string | undefined,
	now = Date.now()
): boolean {
	prune(now);
	const token = readUniqueCookie(cookie, `${serviceCookiePrefix(route)}session`);
	const grant = token ? store.sessions.get(digest(token)) : undefined;
	return Boolean(grant && grant.origin === route.origin && grant.identity === identity(route));
}
