/** Same-origin, authenticated review/queue/status for the independent CLI worker. */
import { json } from '@sveltejs/kit';
import { settingsBody, settingsOperation, SettingsError } from '$lib/server/settings';
import type { RequestHandler } from './$types';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
export const GET: RequestHandler = async () => {
	try {
		return json(await settingsOperation({ operation: 'apply-status' }), { headers });
	} catch (cause) {
		return failure(cause);
	}
};
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await settingsBody(request);
		if (!['apply-review', 'apply-queue'].includes(String(body.operation)))
			throw new SettingsError('Unknown apply operation.');
		return json(await settingsOperation(body), { headers });
	} catch (cause) {
		return failure(cause);
	}
};
/** Keep unexpected failures and raw Docker diagnostics out of browser responses. */
function failure(cause: unknown) {
	return json(
		{
			message:
				cause instanceof SettingsError ? cause.message : 'Apply is unavailable. Use the host CLI.'
		},
		{ status: cause instanceof SettingsError ? cause.status : 503, headers }
	);
}
