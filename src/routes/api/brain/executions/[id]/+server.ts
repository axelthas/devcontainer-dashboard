import { error, json } from '@sveltejs/kit';
import { readOutput, stopExecution } from '$lib/server/brain/executions';
import { brainHttpError } from '$lib/server/brain/http';
import { brainState } from '$lib/server/brain/state';
import type { RequestHandler } from './$types';

/** Read retained output from an absolute cursor; the operator can read ended grants too. */
export const GET: RequestHandler = async ({ params, url }) => {
	const execution = brainState.executions.get(params.id);
	if (!execution) throw error(404, 'The command is no longer retained.');
	const raw = url.searchParams.get('cursor');
	if (raw !== null && !/^\d{1,15}$/.test(raw)) throw error(400, 'Invalid cursor');
	return json(readOutput(execution, raw === null ? undefined : Number(raw)), {
		headers: { 'Cache-Control': 'no-store' }
	});
};

/** Stop one command and report whether the stop was confirmed. */
export const DELETE: RequestHandler = async ({ params }) => {
	try {
		return json({ status: await stopExecution(params.id, 'Stopped by the operator') });
	} catch (cause) {
		brainHttpError(cause);
	}
};
