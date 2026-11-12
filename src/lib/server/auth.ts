/** Shared-password operator authentication with bounded, expiring process-local sessions. */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
export const AUTH_COOKIE_NAME = 'devcontainer-dashboard-session';
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
interface LoginAttempt { failedAttempts: number; blockedUntil: number; lastAttemptAt: number; }
interface PasswordVerifier { salt: Buffer; key: Buffer; }
interface Session { createdAt: number; lastUsedAt: number; }
interface AuthState { sessions: Map<string, Session>; loginAttempts: Map<string, LoginAttempt>; passwordVerifier?: Promise<PasswordVerifier>; }
const globalAuth = globalThis as typeof globalThis & { __devcontainerDashboardAuth?: AuthState };
const authState = (globalAuth.__devcontainerDashboardAuth ??= { sessions: new Map(), loginAttempts: new Map() });
// HMR may retain the previous Set-based representation; those tokens have no trustworthy timestamps.
if (!(authState.sessions instanceof Map)) authState.sessions = new Map();

/** Read bounded operator policy. Invalid configuration fails rather than disabling expiration. */
function authPolicy() {
	function positive(name: string, fallback: number, maximum: number): number {
		const raw = process.env[name];
		if (!raw) return fallback;
		const value = Number(raw);
		if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`Invalid ${name}`);
		return value;
	}
	return { idle: positive('AUTH_IDLE_MS', 43_200_000, 2_000_000_000), absolute: positive('AUTH_ABSOLUTE_MS', 604_800_000, 2_000_000_000), count: positive('AUTH_MAX_SESSIONS', 256, 4096) };
}
/** Require the configured shared secret without exposing it to clients or terminal children. */
function configuredPassword(): string { const value = process.env.DASHBOARD_PASSWORD; if (!value) throw new Error('DASHBOARD_PASSWORD must be set to a non-empty value'); return value; }
/** Derive a salted verifier using the asynchronous crypto worker pool. */
function deriveKey(password: string, salt: Buffer): Promise<Buffer> { return new Promise((resolve, reject) => scrypt(password, salt, 32, (error, key) => error ? reject(error) : resolve(key))); }
/** Cache one random-salted verifier per server process. */
function passwordVerifier(): Promise<PasswordVerifier> {
	if (!authState.passwordVerifier) { const password = configuredPassword(); const salt = randomBytes(16); authState.passwordVerifier = deriveKey(password, salt).then((key) => ({ salt, key })); }
	return authState.passwordVerifier;
}
/** Compare equal-length derived keys without timing-dependent string comparison. */
async function passwordMatches(password: string): Promise<boolean> { const { salt, key } = await passwordVerifier(); return timingSafeEqual(await deriveKey(password, salt), key); }
/** Retain only a digest of each random 256-bit session token. */
function sessionDigest(token: string): string { return createHash('sha256').update(token).digest('base64url'); }
/** Validate secret and lifetime configuration at startup. */
export function assertAuthConfigured(): void { configuredPassword(); authPolicy(); }
export type PasswordValidationResult = 'valid' | 'invalid' | 'throttled';
/** Remove inactive throttle records; admission has an additional hard bound. */
function pruneLoginAttempts(now: number): void {
	for (const [key, attempt] of authState.loginAttempts) if (Math.max(attempt.blockedUntil, attempt.lastAttemptAt + LOCKOUT_MS) <= now) authState.loginAttempts.delete(key);
}
/** Count before asynchronous derivation so concurrent guesses cannot bypass throttling. */
export async function validatePassword(password: string, clientKey: string, now = Date.now()): Promise<PasswordValidationResult> {
	pruneLoginAttempts(now);
	let attempt = authState.loginAttempts.get(clientKey);
	if (attempt && attempt.blockedUntil > now) return 'throttled';
	if (!attempt) { if (authState.loginAttempts.size >= 1024) return 'throttled'; attempt = { failedAttempts: 0, blockedUntil: 0, lastAttemptAt: now }; authState.loginAttempts.set(clientKey, attempt); }
	attempt.failedAttempts++;
	attempt.lastAttemptAt = now;
	const number = attempt.failedAttempts;
	if (number > MAX_FAILED_ATTEMPTS) { attempt.blockedUntil = now + LOCKOUT_MS; return 'throttled'; }
	if (await passwordMatches(password)) { authState.loginAttempts.delete(clientKey); return 'valid'; }
	if (number >= MAX_FAILED_ATTEMPTS) { attempt.blockedUntil = now + LOCKOUT_MS; return 'throttled'; }
	return 'invalid';
}
/** Opportunistically prune tokens on creation and validation; storage is always count-bounded. */
function pruneSessions(now: number): void {
	const policy = authPolicy();
	for (const [key, session] of authState.sessions) if (now - session.createdAt >= policy.absolute || now - session.lastUsedAt >= policy.idle) authState.sessions.delete(key);
}
/** Evict the least recently used token when capacity is reached. Background jobs are unaffected. */
export function createSession(now = Date.now()): string {
	pruneSessions(now);
	while (authState.sessions.size >= authPolicy().count) {
		const oldest = [...authState.sessions].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
		authState.sessions.delete(oldest[0]);
	}
	const token = randomBytes(32).toString('base64url');
	authState.sessions.set(sessionDigest(token), { createdAt: now, lastUsedAt: now });
	return token;
}
/** Heartbeat checks use touch=false so socket liveness does not renew idle authentication. */
export function isSessionValid(token: string | undefined, touch = true, now = Date.now()): boolean {
	pruneSessions(now);
	if (!token || token.length > 128) return false;
	const session = authState.sessions.get(sessionDigest(token));
	if (!session) return false;
	if (touch) session.lastUsedAt = now;
	return true;
}
/** Revoke browser access without cancelling persistent processes. */
export function revokeSession(token: string | undefined): void { if (token) authState.sessions.delete(sessionDigest(token)); }
/** Parse only the dashboard cookie and tolerate malformed percent encoding safely. */
export function sessionTokenFromCookieHeader(header: string | undefined): string | undefined {
	if (!header) return undefined;
	for (const cookie of header.split(';')) {
		const separator = cookie.indexOf('=');
		if (separator === -1 || cookie.slice(0, separator).trim() !== AUTH_COOKIE_NAME) continue;
		try { return decodeURIComponent(cookie.slice(separator + 1).trim()) || undefined; } catch { return undefined; }
	}
	return undefined;
}
/** Shared cookie contract for HTTP, terminal transport, and service gateways. */
export function isCookieHeaderAuthenticated(header: string | undefined, touch = true): boolean { return isSessionValid(sessionTokenFromCookieHeader(header), touch); }
/** Reset process-local test state without retaining tokens between cases. */
export function resetAuthStateForTesting(): void { authState.sessions.clear(); authState.loginAttempts.clear(); authState.passwordVerifier = undefined; }
