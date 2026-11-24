/**
 * GET  /api/stacks  — list all discovered Polaris instances
 * POST /api/stacks  — create (allocate + generate) a new Polaris instance
 * DELETE /api/stacks — not applicable at root
 *
 * POST body: { type: string, tag?: string, services?: string[] }
 */

import { json, error } from '@sveltejs/kit';
import { createInstance, getAvailableSources } from '$lib/server/polaris-manager';
import { listPolarisInstances, listPolarisSources } from '$lib/server/polaris-inventory';
import type { PolarisType } from '$lib/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const [instances, availableSources] = await Promise.all([
		listPolarisInstances(),
		listPolarisSources()
	]);
	return json({ instances, availableSources });
};

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const { type, tag, services } = body as { type?: string; tag?: string; services?: string[] };
	const availableTypes = Object.keys(getAvailableSources());
	if (!type || !availableTypes.includes(type)) {
		throw error(400, `Invalid type. Must be one of: ${availableTypes.join(', ')}`);
	}

	try {
		const entry = await createInstance(
			type as PolarisType,
			tag || undefined,
			services?.length ? services : undefined
		);
		return json(entry, { status: 201 });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw error(500, msg);
	}
};
