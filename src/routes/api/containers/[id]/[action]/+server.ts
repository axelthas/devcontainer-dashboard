import { json, error } from '@sveltejs/kit';
import docker from '$lib/server/docker';
import type { RequestHandler } from './$types';

const ALLOWED_ACTIONS = ['start', 'stop', 'restart'] as const;
type Action = (typeof ALLOWED_ACTIONS)[number];

export const POST: RequestHandler = async ({ params }) => {
	const { id, action } = params;

	if (!ALLOWED_ACTIONS.includes(action as Action)) {
		throw error(400, `Invalid action: ${action}`);
	}

	const container = docker.getContainer(id);

	try {
		if (action === 'start') {
			await container.start();
		} else if (action === 'stop') {
			await container.stop();
		} else if (action === 'restart') {
			await container.restart();
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		throw error(500, message);
	}

	return json({ success: true });
};
