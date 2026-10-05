import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const AUTH_COOKIE_NAME = 'devcontainer-dashboard-session';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

interface LoginAttempt {
	failedAttempts: number;
	blockedUntil: number;
}

interface AuthState {
	sessions: Set<string>;
	loginAttempts: Map<string, LoginAttempt>;
}

const globalAuth = globalThis as typeof globalThis & {
	__devcontainerDashboardAuth?: AuthState;
};

const authState = (globalAuth.__devcontainerDashboardAuth ??= {
	sessions: new Set(),
	loginAttempts: new Map()
});

function digest(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

function configuredPassword(): string {
	const password = process.env.DASHBOARD_PASSWORD;
	if (!password) {
		throw new Error('DASHBOARD_PASSWORD must be set to a non-empty value');
	}
	return password;
}

function sessionDigest(token: string): string {
	return digest(token).toString('base64url');
}

export function assertAuthConfigured(): void {
	configuredPassword();
}

export type PasswordValidationResult = 'valid' | 'invalid' | 'throttled';

export function validatePassword(
	providedPassword: string,
	clientKey: string,
	now = Date.now()
): PasswordValidationResult {
	const attempt = authState.loginAttempts.get(clientKey);
	if (attempt && attempt.blockedUntil > now) return 'throttled';
	if (attempt?.blockedUntil && attempt.blockedUntil <= now) {
		authState.loginAttempts.delete(clientKey);
	}

	const matches = timingSafeEqual(digest(providedPassword), digest(configuredPassword()));
	if (matches) {
		authState.loginAttempts.delete(clientKey);
		return 'valid';
	}

	const failedAttempts = (attempt?.failedAttempts ?? 0) + 1;
	if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
		authState.loginAttempts.set(clientKey, {
			failedAttempts,
			blockedUntil: now + LOCKOUT_MS
		});
		return 'throttled';
	}

	authState.loginAttempts.set(clientKey, { failedAttempts, blockedUntil: 0 });
	return 'invalid';
}

export function createSession(): string {
	const token = randomBytes(32).toString('base64url');
	authState.sessions.add(sessionDigest(token));
	return token;
}

export function isSessionValid(token: string | undefined): boolean {
	return Boolean(token && authState.sessions.has(sessionDigest(token)));
}

export function revokeSession(token: string | undefined): void {
	if (token) authState.sessions.delete(sessionDigest(token));
}

export function sessionTokenFromCookieHeader(cookieHeader: string | undefined): string | undefined {
	if (!cookieHeader) return undefined;

	for (const cookie of cookieHeader.split(';')) {
		const separator = cookie.indexOf('=');
		if (separator === -1) continue;
		const name = cookie.slice(0, separator).trim();
		if (name !== AUTH_COOKIE_NAME) continue;
		const value = cookie.slice(separator + 1).trim();
		if (!value) return undefined;
		try {
			return decodeURIComponent(value);
		} catch {
			return undefined;
		}
	}

	return undefined;
}

export function isCookieHeaderAuthenticated(cookieHeader: string | undefined): boolean {
	return isSessionValid(sessionTokenFromCookieHeader(cookieHeader));
}

export function resetAuthStateForTesting(): void {
	authState.sessions.clear();
	authState.loginAttempts.clear();
}
