import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const AUTH_COOKIE_NAME = 'devcontainer-dashboard-session';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_SALT_LENGTH = 16;

interface LoginAttempt {
	failedAttempts: number;
	blockedUntil: number;
}

interface PasswordVerifier {
	salt: Buffer;
	key: Buffer;
}

interface AuthState {
	sessions: Set<string>;
	loginAttempts: Map<string, LoginAttempt>;
	passwordVerifier?: Promise<PasswordVerifier>;
}

const globalAuth = globalThis as typeof globalThis & {
	__devcontainerDashboardAuth?: AuthState;
};

const authState = (globalAuth.__devcontainerDashboardAuth ??= {
	sessions: new Set(),
	loginAttempts: new Map()
});

function configuredPassword(): string {
	const password = process.env.DASHBOARD_PASSWORD;
	if (!password) {
		throw new Error('DASHBOARD_PASSWORD must be set to a non-empty value');
	}
	return password;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, PASSWORD_KEY_LENGTH, (error, key) => {
			if (error) reject(error);
			else resolve(key);
		});
	});
}

// Derive the scrypt key of the configured password once per process, with a random salt.
function passwordVerifier(): Promise<PasswordVerifier> {
	if (!authState.passwordVerifier) {
		const password = configuredPassword();
		const salt = randomBytes(PASSWORD_SALT_LENGTH);
		authState.passwordVerifier = deriveKey(password, salt).then((key) => ({ salt, key }));
	}
	return authState.passwordVerifier;
}

async function passwordMatches(providedPassword: string): Promise<boolean> {
	const { salt, key } = await passwordVerifier();
	const candidate = await deriveKey(providedPassword, salt);
	return timingSafeEqual(candidate, key);
}

// Session tokens are 256-bit random values, so a fast digest is sufficient for them.
function sessionDigest(token: string): string {
	return createHash('sha256').update(token).digest('base64url');
}

export function assertAuthConfigured(): void {
	configuredPassword();
}

export type PasswordValidationResult = 'valid' | 'invalid' | 'throttled';

export async function validatePassword(
	providedPassword: string,
	clientKey: string,
	now = Date.now()
): Promise<PasswordValidationResult> {
	let attempt = authState.loginAttempts.get(clientKey);
	if (attempt && attempt.blockedUntil > now) return 'throttled';
	if (!attempt || attempt.blockedUntil) {
		attempt = { failedAttempts: 0, blockedUntil: 0 };
		authState.loginAttempts.set(clientKey, attempt);
	}

	// Count the attempt before the asynchronous key derivation, so that concurrent
	// guesses cannot bypass the limit.
	attempt.failedAttempts += 1;
	const attemptNumber = attempt.failedAttempts;
	if (attemptNumber > MAX_FAILED_ATTEMPTS) {
		attempt.blockedUntil = now + LOCKOUT_MS;
		return 'throttled';
	}

	if (await passwordMatches(providedPassword)) {
		authState.loginAttempts.delete(clientKey);
		return 'valid';
	}

	if (attemptNumber >= MAX_FAILED_ATTEMPTS) {
		attempt.blockedUntil = now + LOCKOUT_MS;
		return 'throttled';
	}
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
	authState.passwordVerifier = undefined;
}
