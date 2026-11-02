/**
 * POST /api/stacks/[instance]/mode/[mode]
 *
 * mode: 'training' | 'playback' | 'testing' | 'operational'
 *
 * Body (JSON): { containerIds: string[] }
 *   containerIds — 12-char Docker container IDs to switch mode on.
 *   Pass all running (non-mysql) containers of the instance.
 *
 * Internally calls `supervisorctl start mode-<mode>` inside each container.
 * The per-container ansible-playbook reads hosts files from the bind-mounted
 * location, so subnet-specific IP rewrites are picked up automatically.
 */

import { json, error } from '@sveltejs/kit';
import { switchMode } from '$lib/server/polaris-manager';
import type { RequestHandler } from './$types';

const ALLOWED_MODES = ['training', 'playback', 'testing', 'operational'] as const;

export const POST: RequestHandler = async ({ params, request }) => {
	const { mode, instance } = params;

	if (!(ALLOWED_MODES as readonly string[]).includes(mode)) {
		throw error(400, `Invalid mode "${mode}". Allowed: ${ALLOWED_MODES.join(', ')}`);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Expected JSON body: { containerIds: string[] }');
	}

	const { containerIds } = body as { containerIds?: unknown };
	if (!Array.isArray(containerIds) || containerIds.some((id) => typeof id !== 'string')) {
		throw error(400, 'containerIds must be an array of strings');
	}

	try {
		await switchMode(containerIds, mode, instance);
		return json({ success: true });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw error(500, msg);
	}
};
