/**
 * DELETE /api/stacks/[instance]
 *
 * Removes a managed Polaris instance: stops the stack, removes generated files
 * and deregisters from the registry.
 */

import { json, error } from '@sveltejs/kit';
import { deleteInstance } from '$lib/server/polaris-manager';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params }) => {
	const { instance } = params;

	try {
		await deleteInstance(instance);
		return json({ success: true });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw error(500, msg);
	}
};
