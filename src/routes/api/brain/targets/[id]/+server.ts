import { json } from '@sveltejs/kit';
import { brainHttpError } from '$lib/server/brain/http';
import { inspectBrainTarget } from '$lib/server/brain/targets';
import type { RequestHandler } from './$types';

/** What a grant to this container would allow. Nothing is granted here. */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const { preview } = await inspectBrainTarget(params.id);
		return json(preview, { headers: { 'Cache-Control': 'no-store' } });
	} catch (cause) {
		brainHttpError(cause);
	}
};
