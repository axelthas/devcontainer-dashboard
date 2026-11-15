/** Dashboard-owned OpenCode v2 and OpenChamber processes. No Docker database sharing. */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { aiFolder } from './localAiPaths.js';
import {
	sessionArguments,
	sessionId,
	tuiArguments,
	launchRegistry,
	type AiLaunch,
	type AiLaunchRequest
} from './localAiSession.js';
import { startAiGateway } from './localAiGateway.js';
import { terminateTerminalTree } from './terminalProcesses.js';

const exec = promisify(execFile);
const root = () => process.env.WORKSPACE_ROOT ?? '/workspaces';
type State = 'starting' | 'ready' | 'failed' | 'stopped';
type Runtime = {
	state: State;
	id: string;
	chamberPort: number;
	server: string;
	open: (request: AiLaunchRequest, dashboard: URL) => Promise<AiLaunch>;
	close: () => Promise<void>;
};
const shared = globalThis as typeof globalThis & { __ddashLocalAi?: Runtime };

/** Avoid passing dashboard login secrets and editor hooks to coding processes. */
export function aiEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(
			([key]) =>
				!key.startsWith('DASHBOARD_') &&
				!key.startsWith('VSCODE_') &&
				!key.startsWith('ELECTRON_') &&
				!['NODE_OPTIONS', 'NODE_INSPECT_RESUME_ON_START'].includes(key)
		)
	);
}

/** The separate web origin must share the dashboard hostname for its host-only session cookie. */
export function localAiOrigin(dashboard: URL, env: NodeJS.ProcessEnv): string {
	const configured = env.LOCAL_AI_ORIGIN;
	const target = configured ? new URL(configured) : new URL(dashboard.origin);
	if (!configured) {
		if (
			dashboard.protocol !== 'http:' ||
			!['127.0.0.1', 'localhost'].includes(dashboard.hostname)
		) {
			throw new Error('Configure LOCAL_AI_ORIGIN on the same HTTPS hostname, or use Tailscale.');
		}
		target.port = env.LOCAL_AI_PUBLIC_PORT ?? '3002';
	}
	if (
		target.origin === dashboard.origin ||
		target.hostname !== dashboard.hostname ||
		target.protocol !== dashboard.protocol ||
		target.username ||
		target.password ||
		target.pathname !== '/' ||
		target.search ||
		target.hash
	)
		throw new Error('Local AI needs a separate port on the same dashboard hostname and protocol.');
	return target.origin;
}

/** Reserve an available loopback port; child startup is still checked for bind failure. */
async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('No service port');
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

/** Readiness never treats a failed child or an unrelated listener as a successful startup. */
async function waitReady(child: ChildProcess, port: number, stopping: () => boolean) {
	const end = Date.now() + 60_000;
	while (Date.now() < end) {
		if (stopping()) throw new Error('Stopping');
		if (!child.pid || child.exitCode !== null || child.signalCode !== null)
			throw new Error('AI service exited');
		try {
			const response = await fetch(`http://127.0.0.1:${port}/`, {
				signal: AbortSignal.timeout(1000)
			});
			await response.body?.cancel();
			if (response.ok || response.status === 401) {
				await new Promise((resolve) => setTimeout(resolve, 200));
				if (child.exitCode !== null || child.signalCode !== null)
					throw new Error('AI service exited');
				return;
			}
		} catch {
			/* Wait within the bounded startup deadline. */
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('AI service readiness timeout');
}

/** Share state between the custom server and the SvelteKit bundle, like authentication. */
export function localAiStatus() {
	return {
		enabled: Boolean(shared.__ddashLocalAi),
		state: shared.__ddashLocalAi?.state ?? 'stopped',
		instance: shared.__ddashLocalAi?.id ?? ''
	};
}

/** Only exact, server-created synthetic identities can use the existing Tailscale gateway. */
export function inspectLocalAi(id: string) {
	const runtime = shared.__ddashLocalAi;
	if (!runtime || runtime.id !== id) return undefined;
	return {
		Id: runtime.id,
		State: { Running: runtime.state === 'ready' },
		NetworkSettings: {
			Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(runtime.chamberPort) }] }
		}
	};
}

/** Create one directory-scoped session for an explicitly requested service window. */
export async function openLocalAi(request: AiLaunchRequest, dashboard: URL) {
	if (!shared.__ddashLocalAi)
		throw new Error('Local AI requires the production image and launcher.');
	return shared.__ddashLocalAi.open(request, dashboard);
}

/** Start services once. Crashes fail closed; container restart is the explicit retry. */
export async function startLocalAi(options: {
	tailscale: boolean;
	authenticated: (cookie: string | undefined, touch?: boolean) => boolean;
	ensureOrigin: (id: string, port: string) => Promise<string>;
}) {
	if (process.env.LOCAL_AI_ENABLED !== '1') return null;
	// Set the singleton synchronously before any await. A second caller never owns another backend.
	if (shared.__ddashLocalAi) return null;
	const children: ChildProcess[] = [];
	const env = aiEnvironment(process.env);
	const once = launchRegistry();
	let gateway: Awaited<ReturnType<typeof startAiGateway>> | undefined;
	let closing = false;
	const runtime: Runtime = {
		state: 'starting',
		id: randomBytes(32).toString('hex'),
		chamberPort: 0,
		server: '',
		async open(request, dashboard) {
			if (request.instance !== runtime.id)
				throw new Error('Dashboard restarted. Open a new service window.');
			if (runtime.state !== 'ready')
				throw new Error('Local AI is not ready. Check container logs.');
			const directory = await aiFolder(root(), request.path);
			return once(
				request.launch,
				JSON.stringify([directory, request.tool, dashboard.origin]),
				async () => {
					// Recheck after queued work; never start a replacement backend on failure.
					if (runtime.state !== 'ready') throw new Error('Local AI is not ready.');
					const origin =
						request.tool === 'openchamber'
							? options.tailscale
								? await options.ensureOrigin(runtime.id, '3000')
								: localAiOrigin(dashboard, process.env)
							: undefined;
					const { stdout } = await exec('opencode', sessionArguments(directory, runtime.server), {
						cwd: directory,
						env,
						timeout: 30_000,
						maxBuffer: 1024 * 1024
					});
					const session = sessionId(stdout);
					if (runtime.state !== 'ready') throw new Error('Local AI stopped during launch.');
					if (request.tool === 'openchamber') {
						return { target: `${origin}/?${new URLSearchParams({ session })}` };
					}
					// The browser gets an attach-only identity, never a command or a backend password.
					const { createPersistentSession } = await import('./terminal.js');
					if (runtime.state !== 'ready') throw new Error('Local AI stopped during launch.');
					const terminalId = `ai-${request.launch}`;
					createPersistentSession(terminalId, undefined, directory, {
						name: `OpenCode: ${directory.split('/').pop()}`,
						executable: { file: 'opencode', args: tuiArguments(runtime.server, session) }
					});
					return { terminalId };
				}
			);
		},
		async close() {
			closing = true;
			runtime.state = 'stopped';
			await gateway?.close();
			// Stop the UI first so it cannot reconnect while the backend stops.
			await Promise.all(
				children
					.slice()
					.reverse()
					.map(async (child) => {
						if (child.pid && child.exitCode === null && child.signalCode === null)
							await terminateTerminalTree(child.pid);
					})
			);
			if (shared.__ddashLocalAi === runtime) delete shared.__ddashLocalAi;
		}
	};
	shared.__ddashLocalAi = runtime;
	function launch(command: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
		const child = spawn(command, args, {
			cwd: root(),
			env: { ...env, ...extra },
			stdio: ['ignore', 'inherit', 'inherit'],
			detached: true
		});
		children.push(child);
		child.once('error', () => {
			if (!closing) runtime.state = 'failed';
		});
		child.once('exit', () => {
			if (!closing) runtime.state = 'failed';
		});
		return child;
	}
	// Keep the dashboard available while services start, and surface failure without an automatic restart loop.
	const starting = (async () => {
		try {
			const opencodePort = await availablePort();
			if (closing) return;
			runtime.server = `http://127.0.0.1:${opencodePort}`;
			const code = launch('opencode', [
				'serve',
				'--service',
				'--hostname',
				'127.0.0.1',
				'--port',
				String(opencodePort)
			]);
			await waitReady(code, opencodePort, () => closing);
			if (closing) return;
			runtime.chamberPort = await availablePort();
			if (closing) return;
			const chamber = launch(
				'openchamber',
				['serve', '--host', '127.0.0.1', '--port', String(runtime.chamberPort), '--foreground'],
				{
					OPENCODE_PORT: String(opencodePort),
					OPENCODE_SKIP_START: 'true',
					OPENCODE_HOST: runtime.server,
					OPENCHAMBER_RELAY_HOST: 'off',
					OPENCHAMBER_FRAME_ANCESTORS: process.env.ORIGIN ?? 'http://127.0.0.1:* http://localhost:*'
				}
			);
			await waitReady(chamber, runtime.chamberPort, () => closing);
			if (closing || runtime.state === 'failed') return;
			if (!options.tailscale) {
				const port = process.env.LOCAL_AI_PUBLIC_PORT ?? '3002';
				const origins = process.env.LOCAL_AI_ORIGIN
					? [process.env.LOCAL_AI_ORIGIN]
					: [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
				for (const origin of origins) {
					const parsed = new URL(origin);
					if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin)
						throw new Error('Invalid LOCAL_AI_ORIGIN');
				}
				gateway = await startAiGateway({
					port: 3002,
					origins,
					upstream: () => (runtime.state === 'ready' ? runtime.chamberPort : undefined),
					authenticated: options.authenticated
				});
			}
			runtime.state = 'ready';
		} catch {
			if (!closing) {
				runtime.state = 'failed';
				console.error('[local-ai] Startup failed. Inspect service logs and restart the container.');
				for (const child of children) {
					if (child.pid && child.exitCode === null && child.signalCode === null) {
						await terminateTerminalTree(child.pid).catch(() => {});
					}
				}
			}
		}
	})();
	return {
		async close() {
			closing = true;
			await runtime.close();
			await starting;
			// Catch children whose launch raced with shutdown.
			await runtime.close();
		}
	};
}
