import { json, error } from '@sveltejs/kit';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}
	const tmp = join(dir, `.presets-${randomUUID()}.tmp`);
	await writeFile(tmp, JSON.stringify(presets, null, '\t'), 'utf-8');
	await rename(tmp, PRESETS_FILE);
}

export const GET: RequestHandler = async () => {
	const presets = await readPresets();
	return json(presets);
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { id, name, command, interactive, fields } = body as Partial<BootstrapPreset>;

	if (!name || typeof name !== 'string' || !name.trim()) {
		throw error(400, 'name is required');
	}
	if (!command || typeof command !== 'string' || !command.trim()) {
		throw error(400, 'command is required');
	}

	const presets = await readPresets();

	if (id) {
		// Upsert existing preset
		const idx = presets.findIndex((p) => p.id === id);
		if (idx === -1) {
			throw error(404, 'Preset not found');
		}
		// Check duplicate name (excluding self)
		if (presets.some((p) => p.id !== id && p.name === name.trim())) {
			throw error(409, 'A preset with this name already exists');
		}
		presets[idx] = {
			...presets[idx],
			name: name.trim(),
			command: command.trim(),
			interactive,
			fields
		};
	} else {
		// Create new preset
		if (presets.some((p) => p.name === name.trim())) {
			throw error(409, 'A preset with this name already exists');
		}
		const newPreset: BootstrapPreset = {
			id: randomUUID(),
			name: name.trim(),
			command: command.trim(),
			interactive,
			fields
		};
		presets.push(newPreset);
	}

	await writePresets(presets);
	return json(presets);
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { id } = body as { id?: string };

	if (!id || typeof id !== 'string') {
		throw error(400, 'id is required');
	}

	const presets = await readPresets();
	const idx = presets.findIndex((p) => p.id === id);
	if (idx === -1) {
		throw error(404, 'Preset not found');
	}

	presets.splice(idx, 1);
	await writePresets(presets);
	return new Response(null, { status: 204 });
};
