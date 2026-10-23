import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Failed run logs are deleted after this period. */
export const RUN_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Builds and bootstrap runs keep at most this much output for their log. */
export const RUN_LOG_MAX_CHARS = 5_000_000;

export type RunLogKind = 'devcontainer-build' | 'bootstrap';

export interface RunLogMetadata {
	id: string;
	kind: RunLogKind;
	name: string;
	/** Repository path for devcontainer builds; workspace path for bootstrap runs */
	path: string;
	configPath?: string;
	startedAt: string;
	endedAt: string;
	exitCode: number;
}

export interface RunLog {
	metadata: RunLogMetadata;
	output: string;
}

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const ESC = 0x1b;
const BEL = 0x07;

// Logs that cannot be written to disk stay readable until the process restarts.
const g = globalThis as typeof globalThis & {
	__runLogFallback?: Map<string, RunLog>;
};
const memoryLogs = (g.__runLogFallback ??= new Map());

export function runLogDir(): string {
	return process.env.BUILD_LOG_DIR ?? '/data/build-logs';
}

function logFiles(id: string): { output: string; metadata: string } {
	const dir = runLogDir();
	return { output: join(dir, `${id}.log`), metadata: join(dir, `${id}.json`) };
}

export async function saveRunLog(metadata: RunLogMetadata, output: string): Promise<void> {
	if (!ID_PATTERN.test(metadata.id)) throw new Error('Invalid run log id');
	const files = logFiles(metadata.id);
	try {
		await mkdir(runLogDir(), { recursive: true, mode: 0o700 });
		await writeFile(files.output, output, { mode: 0o600 });
		// Write the metadata last, so that a metadata file always has a complete log next to it.
		await writeFile(files.metadata, JSON.stringify(metadata), { mode: 0o600 });
	} catch (err) {
		console.error(`Could not write the run log to ${runLogDir()}; keeping it in memory`, err);
		memoryLogs.set(metadata.id, { metadata, output });
	}
}

export async function readRunLog(id: string): Promise<RunLog | undefined> {
	if (!ID_PATTERN.test(id)) return undefined;
	const memoryLog = memoryLogs.get(id);
	if (memoryLog) return memoryLog;

	const files = logFiles(id);
	try {
		const [metadata, output] = await Promise.all([
			readFile(files.metadata, 'utf-8'),
			readFile(files.output, 'utf-8')
		]);
		return { metadata: JSON.parse(metadata) as RunLogMetadata, output };
	} catch {
		return undefined;
	}
}

export async function deleteRunLog(id: string): Promise<void> {
	if (!ID_PATTERN.test(id)) return;
	memoryLogs.delete(id);
	const files = logFiles(id);
	await Promise.all([rm(files.output, { force: true }), rm(files.metadata, { force: true })]);
}

/** Lists the persisted run logs and deletes the logs that are older than the retention period. */
export async function listRunLogs(now = Date.now()): Promise<RunLogMetadata[]> {
	let entries: string[];
	try {
		entries = await readdir(runLogDir());
	} catch {
		return [];
	}

	const logs: RunLogMetadata[] = [];
	for (const entry of entries) {
		if (!entry.endsWith('.json')) continue;
		const id = entry.slice(0, -'.json'.length);
		try {
			const raw = await readFile(join(runLogDir(), entry), 'utf-8');
			const metadata = JSON.parse(raw) as RunLogMetadata;
			if (metadata.id !== id) continue;
			if (now - new Date(metadata.endedAt).getTime() > RUN_LOG_RETENTION_MS) {
				await deleteRunLog(id);
				continue;
			}
			logs.push(metadata);
		} catch {
			// ignore unreadable metadata files
		}
	}
	return logs;
}

function isCsiFinalByte(code: number): boolean {
	return code >= 0x40 && code <= 0x7e;
}

/** Returns the index after the escape sequence that starts at `index`. */
function skipEscapeSequence(text: string, index: number): number {
	const type = text[index + 1];
	let i = index + 2;
	if (type === '[') {
		while (i < text.length && !isCsiFinalByte(text.charCodeAt(i))) i++;
		return i + 1;
	}
	if (type === ']') {
		while (i < text.length) {
			if (text.charCodeAt(i) === BEL) return i + 1;
			if (text.charCodeAt(i) === ESC && text[i + 1] === '\\') return i + 2;
			i++;
		}
		return i;
	}
	return Math.min(index + 2, text.length);
}

/**
 * Converts terminal output to plain text for a downloaded log: removes escape sequences and
 * keeps only the final state of lines that progress output rewrote with carriage returns.
 */
export function toPlainText(output: string): string {
	let stripped = '';
	let start = 0;
	let i = 0;
	while (i < output.length) {
		if (output.charCodeAt(i) !== ESC) {
			i++;
			continue;
		}
		stripped += output.slice(start, i);
		i = skipEscapeSequence(output, i);
		start = i;
	}
	stripped += output.slice(start);

	const lines = stripped.split(/\r?\n/);
	return lines.map((line) => line.slice(line.lastIndexOf('\r') + 1)).join('\n');
}
