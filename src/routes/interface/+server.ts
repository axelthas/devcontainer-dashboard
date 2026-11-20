/**
 * Switch between the desktop dashboard and the mobile interface: keep the choice in a
 * cookie, then open the chosen interface. GET keeps it a plain link from either interface.
 */
import { error, redirect } from '@sveltejs/kit';
import { INTERFACE_COOKIE_NAME, parseInterfaceChoice } from '$lib/interfacePreference';
import type { RequestHandler } from './$types';

/** One year: the choice is a device preference, not a session. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const GET: RequestHandler = ({ url, cookies }) => {
	const choice = parseInterfaceChoice(url.searchParams.get('use'));
	if (!choice) error(400, 'Use "mobile" or "desktop".');
	cookies.set(INTERFACE_COOKIE_NAME, choice, {
		path: '/',
		maxAge: MAX_AGE_SECONDS,
		sameSite: 'lax',
		httpOnly: true
	});
	redirect(303, choice === 'mobile' ? '/mobile' : '/');
};
