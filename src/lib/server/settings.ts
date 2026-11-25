/** Settings IPC: fixed Python entrypoint, literal argv, bounded stdin/stdout, no shell.
 * Python owns the shared schema, validation, cross-process flock and atomic writes.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { SettingsResult, SettingsSnapshot } from '../settings/types';

let active = 0;
const MAX_BYTES = 262144;
export class SettingsError extends Error {
	constructor(
		message: string,
		public status = 400
	) {
		super(message);
	}
}

/** Invoke one persistence operation without forwarding secrets into command arguments. */
export async function settingsOperation(
	payload: Record<string, unknown>
): Promise<SettingsSnapshot> {
	const config = process.env.DEVHARBOUR_CONFIG;
	if (!config || !config.startsWith('/'))
		throw new SettingsError(
			'Settings need a managed config mount. Recreate DevHarbour with the updated host CLI.',
			409
		);
	const input = JSON.stringify(payload);
	if (Buffer.byteLength(input) > MAX_BYTES) throw new SettingsError('Request is too large.', 413);
	if (active >= 4) throw new SettingsError('Settings are busy. Retry shortly.', 429);
	active++;
	try {
		const text = await new Promise<string>((fulfil, reject) => {
			const child = spawn(
				'python3',
				[resolve('scripts/devharbour_settings.py'), '--config', config],
				{
					stdio: ['pipe', 'pipe', 'ignore'],
					env: { PATH: '/usr/local/bin:/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }
				}
			);
			let output = '';
			let oversized = false;
			const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
			child.stdout.on('data', (data: Buffer) => {
				if (Buffer.byteLength(output) + data.length > 2_000_000) {
					oversized = true;
					child.kill('SIGKILL');
				} else output += data.toString('utf8');
			});
			child.stdin.on('error', () => {
				/* Exit handler reports a safe diagnostic. */
			});
			child.on('error', () => {
				clearTimeout(timer);
				reject(new SettingsError('Settings service is unavailable.', 503));
			});
			child.on('close', (code) => {
				clearTimeout(timer);
				if (code !== 0 || oversized)
					reject(
						new SettingsError('Settings operation failed. Check the host configuration.', 503)
					);
				else fulfil(output);
			});
			child.stdin.end(input);
		});
		let result;
		try {
			result = JSON.parse(text);
		} catch {
			throw new SettingsError('Invalid Settings service response.', 503);
		}
		if (!result.ok)
			throw new SettingsError(
				result.message,
				[400, 409, 413].includes(result.status) ? result.status : 400
			);
		return result.data as SettingsSnapshot;
	} finally {
		active--;
	}
}

/** Return a useful read-only state for unmanaged or incompatible installations. */
export async function readSettings(): Promise<SettingsResult> {
	try {
		return await settingsOperation({ operation: 'read' });
	} catch (error) {
		return {
			available: false,
			message: error instanceof SettingsError ? error.message : 'Settings are unavailable.'
		};
	}
}

/** Bound a request even when Content-Length is absent or incorrect. */
export async function settingsBody(request: Request): Promise<Record<string, unknown>> {
	const reader = request.body?.getReader();
	if (!reader) throw new SettingsError('A JSON body is required.');
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.length;
			if (bytes > MAX_BYTES) {
				await reader.cancel();
				throw new SettingsError('Request is too large.', 413);
			}
			chunks.push(value);
		}
		const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
		return body;
	} catch (error) {
		if (error instanceof SettingsError) throw error;
		throw new SettingsError('A JSON object is required.');
	} finally {
		reader.releaseLock();
	}
}
