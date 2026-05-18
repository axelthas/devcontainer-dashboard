import { json } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { BootstrapPreset } from '$lib/types';
import type { RequestHandler } from './$types';

const PRESETS_FILE = process.env.PRESETS_FILE ?? '/data/presets.json';

async function readPresets(): Promise<BootstrapPreset[]> {
	if (!existsSync(PRESETS_FILE)) return [];
	try {
		const raw = await readFile(PRESETS_FILE, 'utf-8');
		return JSON.parse(raw) as BootstrapPreset[];
	} catch {
		return [];
	}
}

export const GET: RequestHandler = async () => {
	const presets = await readPresets();
	return json(presets);
};
