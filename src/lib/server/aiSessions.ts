/** Durable window-to-session mapping. A reload must not create another conversation. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AiTool = 'opencode' | 'openchamber';
export type AiRequest = { launch: string; path: string; tool: AiTool };
type Record = AiRequest & { session?: string };

/** Window identities are filenames, terminal IDs and URL parameters. */
export function validAiId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(value);
}

/** Enforce the v2 response envelope rather than accepting v1's different wire shape. */
export function aiSessionId(value: unknown): string {
	const id = (value as { data?: { id?: unknown } } | null)?.data?.id;
	if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
		throw new Error('OpenCode returned an invalid v2 session.');
	return id;
}

/** Send a literal directory in JSON, never through a shell or an unsupported URL parameter. */
export async function createAiSession(server: string, password: string, path: string) {
	const response = await fetch(`${server}/api/session`, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			title: `Dashboard: ${path.split('/').pop()}`,
			location: { directory: path }
		}),
		signal: AbortSignal.timeout(30_000)
	});
	if (!response.ok) throw new Error(`OpenCode session request failed (${response.status}).`);
	return aiSessionId(await response.json());
}

/** Persist before and after creation. An uncertain response fails closed instead of duplicating work. */
export function aiSessionStore(directory: string) {
	const pending = new Map<string, Promise<string>>();
	/** Replace the completed record atomically on the same persistent filesystem. */
	async function save(file: string, record: Record) {
		const temporary = `${file}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
		await rename(temporary, file);
	}
	return (request: AiRequest, create: () => Promise<string>): Promise<string> => {
		if (!validAiId(request.launch)) return Promise.reject(new Error('Invalid window identity.'));
		const key = JSON.stringify(request);
		const current = pending.get(key);
		if (current) return current;
		if (pending.size >= 512)
			return Promise.reject(new Error('Window capacity reached. Restart the dashboard.'));
		const operation = (async () => {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const file = join(directory, `${request.launch}.json`);
			let saved: Record | undefined;
			try {
				saved = JSON.parse(await readFile(file, 'utf8')) as Record;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
			if (saved) {
				if (
					saved.path !== request.path ||
					saved.tool !== request.tool ||
					saved.launch !== request.launch
				)
					throw new Error('Window identity already belongs to another folder or tool.');
				if (!saved.session) throw new Error('Previous launch was interrupted. Open a new window.');
				return aiSessionId({ data: { id: saved.session } });
			}
			await writeFile(file, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
			const session = await create();
			await save(file, { ...request, session });
			return session;
		})();
		pending.set(key, operation);
		return operation;
	};
}
