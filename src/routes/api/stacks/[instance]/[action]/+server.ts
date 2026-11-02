/**
 * POST /api/stacks/[instance]/[action]
 *
 * action: 'start' | 'stop'
 *
 * Operates on instances managed by the dashboard (in registry).
 * Returns { success: true } or HTTP 4xx/5xx on error.
 */

import { json, error } from '@sveltejs/kit';
import { startStack, stopStack } from '$lib/server/polaris-manager';
import type { RequestHandler } from './$types';

const ALLOWED_ACTIONS = ['start', 'stop'] as const;
type Action = (typeof ALLOWED_ACTIONS)[number];

export const POST: RequestHandler = async ({ params }) => {
	const { instance, action } = params;

	if (!ALLOWED_ACTIONS.includes(action as Action)) {
		throw error(400, `Invalid action "${action}". Allowed: ${ALLOWED_ACTIONS.join(', ')}`);
	}

	try {
		if (action === 'start') {
			// Run in background — docker compose up can take a long time (image pulls,
			// container init). Return 202 immediately; the UI polls for container state.
			startStack(instance).catch((err: unknown) => {
				console.error(`[startStack] ${instance}:`, err instanceof Error ? err.message : err);
			});
			return json({ success: true, async: true }, { status: 202 });
		} else {
			// stop is fast, await it
			await stopStack(instance);
			return json({ success: true });
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw error(500, msg);
	}
};
