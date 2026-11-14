import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Logs expire after seven days; output caps count UTF-16 characters, not bytes. */
export const RUN_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RUN_LOG_MAX_CHARS = 5_000_000;
export const RUN_LOG_FALLBACK_MAX_CHARS = 20_000_000;
export const RUN_LOG_FALLBACK_MAX_COUNT = 32;
export type RunLogKind = 'devcontainer-build' | 'bootstrap';
export interface RunLogMetadata {
	id: string;
	kind: RunLogKind;
	name: string;
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
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ESC = 0x1b;
const BEL = 0x07;
const globalLogs = globalThis as typeof globalThis & { __runLogFallback?: Map<string, RunLog> };
const memoryLogs = (globalLogs.__runLogFallback ??= new Map());
const pending = new Set<Promise<void>>();

/** Return the operator-owned persistent log directory. */
export function runLogDir(): string {
	return process.env.BUILD_LOG_DIR ?? '/data/build-logs';
}
/** Derive safe file names only after validating the identity at each public entry point. */
function logFiles(id: string) {
	return { output: join(runLogDir(), `${id}.log`), metadata: join(runLogDir(), `${id}.json`) };
}
/** Prune expired logs and evict oldest fallback entries to bound global memory. */
function pruneMemory(now = Date.now()): void {
	for (const [id, log] of memoryLogs)
		if (
			!Number.isFinite(Date.parse(log.metadata.endedAt)) ||
			now - Date.parse(log.metadata.endedAt) > RUN_LOG_RETENTION_MS
		)
			memoryLogs.delete(id);
	let size = [...memoryLogs.values()].reduce((sum, log) => sum + log.output.length, 0);
	for (const [id, log] of [...memoryLogs].sort(
		(a, b) => Date.parse(a[1].metadata.endedAt) - Date.parse(b[1].metadata.endedAt)
	)) {
		if (size <= RUN_LOG_FALLBACK_MAX_CHARS && memoryLogs.size <= RUN_LOG_FALLBACK_MAX_COUNT) break;
		memoryLogs.delete(id);
		size -= log.output.length;
	}
}
/** Persist bounded output; preserve a bounded, expiring fallback on disk failure. */
export function saveRunLog(metadata: RunLogMetadata, rawOutput: string): Promise<void> {
	if (!ID_PATTERN.test(metadata.id)) return Promise.reject(new Error('Invalid run log id'));
	const output = rawOutput.slice(-RUN_LOG_MAX_CHARS);
	const operation = (async () => {
		const files = logFiles(metadata.id);
		try {
			await mkdir(runLogDir(), { recursive: true, mode: 0o700 });
			await writeFile(files.output, output, { mode: 0o600 });
			await writeFile(files.metadata, JSON.stringify(metadata), { mode: 0o600 });
			memoryLogs.delete(metadata.id);
		} catch (error) {
			console.error('Could not persist run log; using bounded memory fallback', error);
			memoryLogs.set(metadata.id, { metadata, output });
			pruneMemory();
		}
	})();
	pending.add(operation);
	void operation.finally(() => pending.delete(operation));
	return operation;
}
/** Await exit-callback writes before graceful server termination. */
export async function flushRunLogs(): Promise<void> {
	await Promise.all([...pending]);
}
/** Read retained output; expired fallback output is never returned. */
export async function readRunLog(id: string): Promise<RunLog | undefined> {
	if (!ID_PATTERN.test(id)) return undefined;
	pruneMemory();
	const memory = memoryLogs.get(id);
	if (memory) return memory;
	const files = logFiles(id);
	try {
		const [rawMetadata, output] = await Promise.all([
			readFile(files.metadata, 'utf8'),
			readFile(files.output, 'utf8')
		]);
		const metadata = JSON.parse(rawMetadata) as RunLogMetadata;
		if (metadata.id !== id) return undefined;
		return { metadata, output: output.slice(-RUN_LOG_MAX_CHARS) };
	} catch {
		return undefined;
	}
}
/** Remove persisted and fallback output together. */
export async function deleteRunLog(id: string): Promise<void> {
	if (!ID_PATTERN.test(id)) return;
	memoryLogs.delete(id);
	const files = logFiles(id);
	await Promise.all([rm(files.output, { force: true }), rm(files.metadata, { force: true })]);
}
/** Include fallback entries even when the disk directory cannot be read. */
export async function listRunLogs(now = Date.now()): Promise<RunLogMetadata[]> {
	pruneMemory(now);
	const logs = new Map([...memoryLogs].map(([id, log]) => [id, log.metadata]));
	let entries: string[] = [];
	try {
		entries = await readdir(runLogDir());
	} catch {
		/* Fallback logs remain discoverable. */
	}
	for (const entry of entries) {
		if (!entry.endsWith('.json')) continue;
		const id = entry.slice(0, -5);
		if (!ID_PATTERN.test(id) || logs.has(id)) continue;
		try {
			const metadata = JSON.parse(await readFile(logFiles(id).metadata, 'utf8')) as RunLogMetadata;
			if (metadata.id !== id) continue;
			if (
				!Number.isFinite(Date.parse(metadata.endedAt)) ||
				now - Date.parse(metadata.endedAt) > RUN_LOG_RETENTION_MS
			) {
				await deleteRunLog(id);
				continue;
			}
			logs.set(id, metadata);
		} catch {
			/* Ignore unreadable metadata. */
		}
	}
	return [...logs.values()];
}
function isCsiFinalByte(code: number): boolean {
	return code >= 0x40 && code <= 0x7e;
}
/** Skip terminal escape sequences for plain-text downloads. */
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
/** Remove ANSI sequences and retain the final carriage-return state of each line. */
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
	return stripped
		.split(/\r?\n/)
		.map((line) => line.slice(line.lastIndexOf('\r') + 1))
		.join('\n');
}
