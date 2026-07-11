import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Set PRESETS_FILE to a temp path before importing the route module
const TEST_DIR = join(tmpdir(), `presets-test-${randomUUID()}`);
const TEST_FILE = join(TEST_DIR, 'presets.json');
process.env.PRESETS_FILE = TEST_FILE;

// Dynamic import after env is set (vitest hoists imports, so we use a factory)
const { GET, POST, DELETE: DELETE_HANDLER } = await import('./+server');

function makeRequest(body: unknown): Request {
	return new Request('http://localhost/api/presets', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
}

describe('GET /api/presets', () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	it('returns empty array when file does not exist', async () => {
		if (existsSync(TEST_FILE)) rmSync(TEST_FILE);
		const res = await GET({ request: new Request('http://localhost/api/presets') } as never);
		expect(await res.json()).toEqual([]);
	});

	it('returns presets from file', async () => {
		const presets = [{ id: '1', name: 'Test', command: 'echo hi' }];
		await writeFile(TEST_FILE, JSON.stringify(presets));
		const res = await GET({ request: new Request('http://localhost/api/presets') } as never);
		expect(await res.json()).toEqual(presets);
	});
});

describe('POST /api/presets', () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	it('creates a new preset when no id is provided', async () => {
		const request = makeRequest({ name: 'New Preset', command: 'echo hello' });
		const res = await POST({ request } as never);
		expect(res.status).toBe(200);
		const presets = await res.json();
		expect(presets).toHaveLength(1);
		expect(presets[0].name).toBe('New Preset');
		expect(presets[0].command).toBe('echo hello');
		expect(presets[0].id).toBeTruthy();
	});

	it('creates presets file and parent dir if missing', async () => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
		const request = makeRequest({ name: 'First', command: 'echo first' });
		const res = await POST({ request } as never);
		expect(res.status).toBe(200);
		expect(existsSync(TEST_FILE)).toBe(true);
	});

	it('updates an existing preset when id is provided', async () => {
		const initial = [{ id: 'abc', name: 'Old Name', command: 'old cmd' }];
		await writeFile(TEST_FILE, JSON.stringify(initial));

		const request = makeRequest({ id: 'abc', name: 'New Name', command: 'new cmd' });
		const res = await POST({ request } as never);
		expect(res.status).toBe(200);
		const presets = await res.json();
		expect(presets[0].name).toBe('New Name');
		expect(presets[0].command).toBe('new cmd');
	});

	it('returns 409 on duplicate name (create)', async () => {
		const initial = [{ id: 'abc', name: 'Existing', command: 'cmd' }];
		await writeFile(TEST_FILE, JSON.stringify(initial));

		const request = makeRequest({ name: 'Existing', command: 'other cmd' });
		try {
			await POST({ request } as never);
			expect.fail('should have thrown');
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(409);
		}
	});

	it('returns 409 on duplicate name (update, different id)', async () => {
		const initial = [
			{ id: 'a', name: 'First', command: 'cmd1' },
			{ id: 'b', name: 'Second', command: 'cmd2' }
		];
		await writeFile(TEST_FILE, JSON.stringify(initial));

		const request = makeRequest({ id: 'b', name: 'First', command: 'cmd2' });
		try {
			await POST({ request } as never);
			expect.fail('should have thrown');
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(409);
		}
	});

	it('returns 404 when updating non-existent id', async () => {
		await writeFile(TEST_FILE, JSON.stringify([]));
		const request = makeRequest({ id: 'nope', name: 'X', command: 'y' });
		try {
			await POST({ request } as never);
			expect.fail('should have thrown');
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(404);
		}
	});

	it('returns 400 when name is missing', async () => {
		const request = makeRequest({ command: 'echo hi' });
		try {
			await POST({ request } as never);
			expect.fail('should have thrown');
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(400);
		}
	});

	it('returns 400 when command is missing', async () => {
		const request = makeRequest({ name: 'Test' });
		try {
			await POST({ request } as never);
			expect.fail('should have thrown');
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(400);
		}
	});
});

describe('DELETE /api/presets', () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	it('deletes a preset by id', async () => {
		const initial = [
			{ id: 'a', name: 'First', command: 'cmd1' },
			{ id: 'b', name: 'Second', command: 'cmd2' }
		];
		await writeFile(TEST_FILE, JSON.stringify(initial));

		const request = new Request('http://localhost/api/presets', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 'a' })
		});
		const res = await DELETE_HANDLER({ request } as never);
		expect(res.status).toBe(204);

		// Verify file state
		const raw = await readFile(TEST_FILE, 'utf-8');
		const remaining = JSON.parse(raw);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe('b');
	});

	it('returns 404 when id does not exist', async () => {
		await writeFile(TEST_FILE, JSON.stringify([]));
		const request = new Request('http://localhost/api/presets', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 'nope' })
		});
		try {
			await DELETE_HANDLER({ request } as never);
			expect.fail('should have thrown');
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(404);
		}
	});

	it('returns 400 when id is missing', async () => {
		const request = new Request('http://localhost/api/presets', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({})
		});
		try {
			await DELETE_HANDLER({ request } as never);
			expect.fail('should have thrown');
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(400);
		}
	});
});
