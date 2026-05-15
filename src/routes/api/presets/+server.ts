import { json } from '@sveltejs/kit';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
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

async function writePresets(presets: BootstrapPreset[]): Promise<void> {
	const dir = dirname(PRESETS_FILE);
	await mkdir(dir, { recursive: true });
	await writeFile(PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf-8');
}

export const GET: RequestHandler = async () => {
	const presets = await readPresets();
	return json(presets);
};

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as Partial<BootstrapPreset>;
	if (!body.name || !body.command) {
		return json({ error: 'name and command are required' }, { status: 400 });
	}

	const presets = await readPresets();
	const existing = body.id ? presets.find((p) => p.id === body.id) : undefined;

	if (existing) {
		existing.name = body.name;
		existing.command = body.command;
	} else {
		presets.push({ id: randomUUID(), name: body.name, command: body.command });
	}

	await writePresets(presets);
	return json({ ok: true });
};
