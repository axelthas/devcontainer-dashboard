/**
 * Which DevHarbour interface a browser gets: the desktop dashboard or the dedicated mobile
 * interface. An explicit choice is kept in a cookie; without one, phones get the mobile
 * interface. The value is a non-sensitive UI preference, not an access control.
 */

export type InterfaceChoice = 'mobile' | 'desktop';

/** Cookie that keeps the explicit choice. */
export const INTERFACE_COOKIE_NAME = 'devharbour-interface';

/** Phones only: tablets and desktop browsers keep the desktop dashboard by default. */
const PHONE_USER_AGENT = /iPhone|iPod|Android.+Mobile|Windows Phone/i;

/** True for a phone browser user agent. */
export function isPhoneUserAgent(userAgent: string | null | undefined): boolean {
	return Boolean(userAgent && PHONE_USER_AGENT.test(userAgent));
}

/** Parse a stored or requested choice; anything else is no choice. */
export function parseInterfaceChoice(value: string | null | undefined): InterfaceChoice | null {
	return value === 'mobile' || value === 'desktop' ? value : null;
}

/** The interface for a request: the explicit choice, else the device default. */
export function preferredInterface(
	cookie: string | null | undefined,
	userAgent: string | null | undefined
): InterfaceChoice {
	return parseInterfaceChoice(cookie) ?? (isPhoneUserAgent(userAgent) ? 'mobile' : 'desktop');
}
