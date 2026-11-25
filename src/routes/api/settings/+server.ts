/** Authenticated Settings API. Global hooks enforce session and same-origin writes. */
import { json } from '@sveltejs/kit';
import { readSettings, settingsBody, settingsOperation, SettingsError } from '$lib/server/settings';
import type { RequestHandler } from './$types';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
export const GET: RequestHandler = async () => json(await readSettings(), { headers });
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await settingsBody(request);
		if (!['save', 'environment', 'password'].includes(String(body.operation)))
			throw new SettingsError('Unknown Settings operation.');
		return json(await settingsOperation(body), { headers });
	} catch (error) {
		return json(
			{ message: error instanceof SettingsError ? error.message : 'Settings could not be saved.' },
			{
				status: error instanceof SettingsError ? error.status : 500,
				headers
			}
		);
	}
};
