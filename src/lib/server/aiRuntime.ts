/** Own one foreground OpenCode server and an OpenChamber client of that exact server. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aiDirectory } from './aiPaths.js';
import { aiSessionStore, createAiSession, type AiRequest } from './aiSessions.js';
import { terminateTerminalTree } from './terminalProcesses.js';

type State = 'starting' | 'ready' | 'failed' | 'stopped';
type Runtime = {
	id: string;
	state: State;
	message: string;
	chamberPort: number;
	open: (request: AiRequest) => Promise<{ session: string; terminalId?: string }>;
	close: () => Promise<void>;
};
const shared = globalThis as typeof globalThis & { __dashboardAi?: Runtime };
const storage = '/dashboard-ai';
const workspace = () => process.env.WORKSPACE_ROOT ?? '/workspaces';

/** Never give coding processes dashboard credentials, editor hooks or Node preload hooks. */
export function aiEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(
			([key]) =>
				!key.startsWith('DASHBOARD_') &&
				!key.startsWith('VSCODE_') &&
				![
					'NODE_OPTIONS',
					'NODE_INSPECT_RESUME_ON_START',
					'GIT_ASKPASS',
					'BROWSER',
					'TERM_PROGRAM',
					'TERM_PROGRAM_VERSION'
				].includes(key)
		)
	);
}

/** Return status only, never passwords or internal endpoints. Shared across server bundles. */
export function aiStatus() {
	const runtime = shared.__dashboardAi;
	return {
		enabled: Boolean(runtime),
		state: runtime?.state ?? 'stopped',
		message: runtime?.message ?? 'Use the production launcher.'
	};
}

/** Register only the exact owned process in the existing authenticated Tailscale gateway. */
export function inspectAi(id: string) {
	const runtime = shared.__dashboardAi;
	if (!runtime || id !== runtime.id) return undefined;
	return {
		Id: runtime.id,
		State: { Running: runtime.state === 'ready' },
		NetworkSettings: {
			Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(runtime.chamberPort) }] }
		}
	};
}

/** Derive a service URL only from the live runtime and server configuration. */
export async function aiWebOrigin(
	dashboard: URL,
	ensure: (id: string, port: string) => Promise<string>
) {
	const runtime = shared.__dashboardAi;
	if (!runtime || runtime.state !== 'ready') throw new Error('AI services are not ready.');
	if (process.env.TAILSCALE_SOCKET) return ensure(runtime.id, '3000');
	const target = new URL(process.env.OPENCHAMBER_PUBLIC_ORIGIN ?? dashboard.origin);
	if (!process.env.OPENCHAMBER_PUBLIC_ORIGIN) target.port = process.env.AI_PUBLIC_PORT ?? '3002';
	if (
		!['http:', 'https:'].includes(target.protocol) ||
		target.username ||
		target.password ||
		target.pathname !== '/' ||
		target.search ||
		target.hash ||
		target.origin === dashboard.origin
	)
		throw new Error('Configure a separate OPENCHAMBER_PUBLIC_ORIGIN.');
	return target.origin;
}

/** All mutations run behind normal dashboard authentication and Origin policy. */
export function openAi(request: AiRequest) {
	if (!shared.__dashboardAi) throw new Error('AI services are disabled.');
	return shared.__dashboardAi.open(request);
}

/** Choose a host-loopback port without colliding with a host OpenCode instance. */
async function availablePort(): Promise<number> {
	const listener = createServer();
	await new Promise<void>((resolve, reject) => {
		listener.once('error', reject);
		listener.listen(0, '127.0.0.1', resolve);
	});
	const address = listener.address();
	await new Promise<void>((resolve) => listener.close(() => resolve()));
	if (!address || typeof address === 'string') throw new Error('Cannot allocate AI port.');
	return address.port;
}

/** Verify the password and v2 API, not just an arbitrary listener's HTTP response. */
export async function waitForAi(
	child: ChildProcess,
	url: string,
	headers: Record<string, string>,
	stopping: () => boolean,
	timeout = 60_000
) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (stopping() || !child.pid || child.exitCode !== null || child.signalCode !== null)
			throw new Error('AI process stopped before readiness.');
		try {
			const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
			await response.body?.cancel();
			if (response.ok) return;
		} catch {
			// Retry within the startup deadline; never spawn a replacement process.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('AI readiness timed out.');
}

/** Start once; preserve conversations on disk and fail closed on process failure. */
export function startAi() {
	if (process.env.AI_ENABLED !== '1' || shared.__dashboardAi) return null;
	const children: ChildProcess[] = [];
	const sessions = aiSessionStore(join(storage, 'windows'));
	let closing = false;
	let endpoint = '';
	let password = '';
	const launches = new Map<string, Promise<{ session: string; terminalId?: string }>>();
	const runtime: Runtime = {
		id: randomBytes(32).toString('hex'),
		state: 'starting',
		message: '',
		chamberPort: 0,
		async open(request) {
			if (runtime.state !== 'ready')
				throw new Error('AI services are not ready. Check container logs.');
			const path = await aiDirectory(workspace(), request.path);
			const key = JSON.stringify({ ...request, path });
			const existing = launches.get(key);
			if (existing) return existing;
			if (launches.size >= 512)
				throw new Error('AI window capacity reached. Restart the dashboard.');
			const operation = (async () => {
				const session = await sessions({ ...request, path }, () =>
					createAiSession(endpoint, password, path)
				);
				if (runtime.state !== 'ready') throw new Error('AI services stopped during launch.');
				if (request.tool === 'openchamber') return { session };
				const { createPersistentSession } = await import('./terminal.js');
				const terminalId = `ai-${request.launch}`;
				createPersistentSession(terminalId, undefined, path, {
					name: `OpenCode: ${path.split('/').pop()}`,
					executable: { file: '/opt/dashboard-tools/bin/opencode', args: ['--session', session] }
				});
				return { session, terminalId };
			})();
			launches.set(key, operation);
			return operation;
		},
		async close() {
			closing = true;
			runtime.state = 'stopped';
			await rm(join(storage, 'server-url'), { force: true });
			await Promise.all(
				children.map(async (child) => {
					if (child.pid && child.exitCode === null && child.signalCode === null)
						await terminateTerminalTree(child.pid);
				})
			);
		}
	};
	shared.__dashboardAi = runtime;
	/** Every child is tracked before readiness and gets the same filtered environment. */
	function launch(command: string, args: string[], extra: NodeJS.ProcessEnv) {
		const child = spawn(command, args, {
			cwd: workspace(),
			env: { ...aiEnvironment(process.env), ...extra },
			stdio: ['ignore', 'inherit', 'inherit'],
			detached: true
		});
		children.push(child);
		const failed = () => {
			if (closing) return;
			runtime.state = 'failed';
			runtime.message = 'An AI service stopped. Check container logs, then restart the dashboard.';
			void runtime
				.close()
				.catch(() => {})
				.finally(() => {
					runtime.state = 'failed';
				});
		};
		child.once('error', failed);
		child.once('exit', failed);
		return child;
	}
	const starting = (async () => {
		try {
			await mkdir(storage, { recursive: true, mode: 0o700 });
			await rm(join(storage, 'server-url'), { force: true });
			password = randomBytes(32).toString('base64url');
			await writeFile(join(storage, 'server-password'), password, { mode: 0o600 });
			const port = await availablePort();
			if (closing) return;
			endpoint = `http://127.0.0.1:${port}`;
			const code = launch(
				`${process.env.HOME}/.opencode/bin/opencode`,
				['serve', '--hostname', '127.0.0.1', '--port', String(port)],
				{ OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password }
			);
			await waitForAi(
				code,
				`${endpoint}/api/info`,
				{ Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
				() => closing
			);
			if (closing) return;
			await writeFile(join(storage, 'server-url'), endpoint, { mode: 0o600 });
			// Match devcontainer launch configuration. Keep the internal API credential separate.
			let uiPassword = process.env.OPENCODE_PASSWORD || process.env.OPENCHAMBER_UI_PASSWORD;
			if (!uiPassword) {
				try {
					uiPassword = await readFile(join(storage, 'ui-password'), 'utf8');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
			}
			uiPassword ||= randomBytes(24).toString('base64url');
			await writeFile(join(storage, 'ui-password'), uiPassword, { mode: 0o600 });
			runtime.chamberPort = process.env.TAILSCALE_SOCKET ? await availablePort() : 3002;
			if (closing) return;
			const chamber = launch(
				'openchamber',
				[
					'serve',
					'--foreground',
					'--host',
					process.env.TAILSCALE_SOCKET ? '127.0.0.1' : '0.0.0.0',
					'--port',
					String(runtime.chamberPort)
				],
				{
					OPENCODE_HOST: endpoint,
					OPENCODE_PORT: String(port),
					OPENCODE_SKIP_START: 'true',
					OPENCODE_PASSWORD: password,
					OPENCODE_SERVER_PASSWORD: password,
					OPENCHAMBER_UI_PASSWORD: uiPassword,
					OPENCHAMBER_RELAY_HOST: 'off',
					OPENCHAMBER_FRAME_ANCESTORS: [
						process.env.ORIGIN ?? 'http://127.0.0.1:* http://localhost:*',
						process.env.OPENCHAMBER_FRAME_ANCESTORS ?? ''
					].join(' ')
				}
			);
			await waitForAi(chamber, `http://127.0.0.1:${runtime.chamberPort}/`, {}, () => closing);
			if (!closing) runtime.state = 'ready';
		} catch (error) {
			if (closing) return;
			console.error(
				'[ai] Startup failed:',
				error instanceof Error ? error.message : 'unknown error'
			);
			runtime.message = 'AI startup failed. Check container logs, then restart the dashboard.';
			await runtime.close().catch(() => {});
			runtime.state = 'failed';
		}
	})();
	return {
		async close() {
			await runtime.close();
			await starting;
			await runtime.close();
		}
	};
}
