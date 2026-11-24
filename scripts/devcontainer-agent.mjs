/**
 * Run a managed devcontainer with the existing Docker-host SSH agent.
 *
 * Keep the original --config identity and relative-path base. Write a temporary
 * --override-config outside the repository, then let the Dev Containers CLI merge
 * mounts and containerEnv for both image/Dockerfile and Compose configurations.
 * Never start an agent, copy a key, change socket permissions, or replace an
 * existing container unless the caller already requested a rebuild.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AGENT_TARGET = '/tmp/devharbour-ssh-agent.sock';

/** Parse JSON with comments and trailing commas without evaluating configuration. */
export function parseConfiguration(text) {
	const withoutComments = text.replace(
		/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
		(match, string) => string ?? match.replace(/[^\r\n]/g, ' ')
	);
	const json = withoutComments.replace(
		/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g,
		(match, string, closing) => string ?? closing
	);
	const configuration = JSON.parse(json);
	if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
		throw new Error('devcontainer.json must contain an object');
	}
	return configuration;
}

/** Restrict paths to the common literal grammar supported by Docker and Compose mounts. */
export function agentSource(env) {
	const source = env.SSH_AUTH_SOCK;
	if (!source || !isAbsolute(source) || !/^\/[A-Za-z0-9_./ -]+$/.test(source)) {
		throw new Error(
			'Export SSH_AUTH_SOCK with the absolute Docker-host agent socket path (letters, digits, /, _, ., spaces and - only)'
		);
	}
	if (source.split('/').some((part) => part === '.' || part === '..')) {
		throw new Error('SSH_AUTH_SOCK must not contain traversal segments');
	}
	return source;
}

/** Read the source/target of the two mount representations accepted by devcontainers. */
function mountParts(mount) {
	if (mount && typeof mount === 'object' && !Array.isArray(mount)) {
		return { source: mount.source ?? '', target: mount.target ?? mount.destination ?? '' };
	}
	if (typeof mount !== 'string') throw new Error('Invalid devcontainer mount');
	const entries = Object.fromEntries(
		mount.split(',').map((entry) => {
			const separator = entry.indexOf('=');
			return [entry.slice(0, separator), entry.slice(separator + 1)];
		})
	);
	return {
		source: entries.source ?? entries.src ?? '',
		target: entries.target ?? entries.dst ?? entries.destination ?? ''
	};
}

/** Add the agent runtime environment and mount; preserve all unrelated configuration. */
export function withAgent(configuration, source) {
	if (configuration.mounts !== undefined && !Array.isArray(configuration.mounts)) {
		throw new Error('devcontainer mounts must be an array');
	}
	const mounts = (configuration.mounts ?? []).filter((mount) => {
		const parts = mountParts(mount);
		if (/(^|\/)\.ssh\/?$/.test(parts.source) || /(^|\/)\.ssh\/?$/.test(parts.target)) {
			throw new Error(
				'Remove the .ssh directory bind from devcontainer.json. DevHarbour forwards the host agent; provide trusted known_hosts separately.'
			);
		}
		const hostAgent =
			parts.source === source || /^\$\{localEnv:SSH_AUTH_SOCK(?::[^}]*)?\}$/.test(parts.source);
		if (parts.target === AGENT_TARGET && !hostAgent) {
			throw new Error(
				'The reserved DevHarbour SSH agent target is already mounted from another source'
			);
		}
		// Replace explicit agent mounts too, including the common VS Code socket target.
		return !hostAgent;
	});
	return {
		...configuration,
		mounts: [...mounts, { type: 'bind', source, target: AGENT_TARGET }],
		containerEnv: { ...configuration.containerEnv, SSH_AUTH_SOCK: AGENT_TARGET },
		remoteEnv: { ...configuration.remoteEnv, SSH_AUTH_SOCK: AGENT_TARGET }
	};
}

/** Validate the exact argv shape built by the server before running any CLI process. */
export function commandTarget(args) {
	if (args[0] !== 'up') throw new Error('The agent runner only supports devcontainer up');
	let workspace;
	let config;
	for (let index = 1; index < args.length; index++) {
		const option = args[index];
		if (option === '--remove-existing-container') continue;
		if (!['--workspace-folder', '--config', '--id-label'].includes(option) || !args[index + 1]) {
			throw new Error('Unsupported managed devcontainer argument');
		}
		const value = args[++index];
		if (option === '--workspace-folder') {
			if (workspace) throw new Error('Duplicate workspace argument');
			workspace = value;
		}
		if (option === '--config') {
			if (config) throw new Error('Duplicate configuration argument');
			config = value;
		}
	}
	if (!workspace || !isAbsolute(workspace) || (config && !isAbsolute(config))) {
		throw new Error('Managed workspace and configuration paths must be absolute');
	}
	return { workspace, config };
}

/** Run a child without a shell; forward cancellation and preserve terminal output. */
async function run(file, args, { capture = false, timeout = 0 } = {}) {
	return new Promise((resolveResult, reject) => {
		const child = spawn(file, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
		let output = '';
		let overflow = false;
		if (capture) {
			for (const stream of [child.stdout, child.stderr]) {
				stream.on('data', (chunk) => {
					if (output.length + chunk.length > 1024 * 1024) {
						overflow = true;
						child.kill('SIGKILL');
					} else output += chunk;
				});
			}
		}
		const interrupt = () => child.kill('SIGINT');
		const terminate = () => child.kill('SIGTERM');
		process.on('SIGINT', interrupt);
		process.on('SIGTERM', terminate);
		let timedOut = false;
		const timer = timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill('SIGKILL');
				}, timeout)
			: undefined;
		const cleanup = () => {
			clearTimeout(timer);
			process.off('SIGINT', interrupt);
			process.off('SIGTERM', terminate);
		};
		child.once('error', (error) => {
			cleanup();
			reject(error);
		});
		child.once('close', (code, signal) => {
			cleanup();
			if (timedOut || overflow || signal) {
				reject(
					new Error(
						'SSH/devcontainer command timed out, exceeded its output limit, or was interrupted'
					)
				);
			} else resolveResult({ code, output });
		});
	});
}

/** Require a reachable agent, but allow an agent with no loaded identities. */
async function checkAgent(source) {
	if (!(await stat(source)).isSocket()) throw new Error('SSH_AUTH_SOCK is not a Unix socket');
	const result = await run('ssh-add', ['-l'], { capture: true, timeout: 5000 });
	if (result.code !== 0 && result.code !== 1) {
		throw new Error(
			'The host SSH agent is unreachable by the DevHarbour operator. Check its socket and permissions; do not mount private keys.'
		);
	}
}

/** Resolve only the standard CLI defaults when a caller does not supply a configuration. */
async function configurationPath(workspace, selected) {
	if (selected) return selected;
	for (const candidate of [
		join(workspace, '.devcontainer/devcontainer.json'),
		join(workspace, '.devcontainer.json')
	]) {
		try {
			if ((await stat(candidate)).isFile()) return candidate;
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
	throw new Error('Select an existing devcontainer configuration');
}

/** Check the final socket as the CLI-selected remote user, not as root. */
async function verifyRemote(workspace, config, override) {
	const script =
		'test -S "$SSH_AUTH_SOCK" || { echo "DevHarbour agent mount is missing" >&2; exit 2; }; ' +
		'command -v ssh-add >/dev/null || { echo "Install openssh-client in this devcontainer to verify agent access" >&2; exit 2; }; ' +
		'status=0; ssh-add -l >/dev/null 2>&1 || status=$?; ' +
		'case "$status" in 0|1) exit 0;; *) echo "The remote user cannot access the host SSH agent. Check remoteUser UID and socket permissions; no chmod was applied." >&2; exit 2;; esac';
	const result = await run(
		'devcontainer',
		[
			'exec',
			'--workspace-folder',
			workspace,
			'--config',
			config,
			'--override-config',
			override,
			'--remote-env',
			`SSH_AUTH_SOCK=${AGENT_TARGET}`,
			'sh',
			'-c',
			script
		],
		{ timeout: 30000 }
	);
	if (result.code !== 0) {
		throw new Error(
			'Devcontainer SSH agent verification failed. An existing container may need an explicit rebuild. The container was not removed or rolled back.'
		);
	}
}

/** Prepare an external override, start the CLI, verify access, then remove only our temporary files. */
export async function main(args = process.argv.slice(2)) {
	const target = commandTarget(args);
	const source = agentSource(process.env);
	await checkAgent(source);
	const config = await configurationPath(target.workspace, target.config);
	const configuration = parseConfiguration(await readFile(config, 'utf8'));
	const managed = withAgent(configuration, source);
	const directory = await mkdtemp(join(tmpdir(), 'devharbour-agent-'));
	try {
		const override = join(directory, 'devcontainer.json');
		await writeFile(override, JSON.stringify(managed, null, '\t') + '\n', {
			mode: 0o600,
			flag: 'wx'
		});
		// --config remains the original file: relative Dockerfiles, Features, Compose
		// files, variable substitution and identity labels keep their original base.
		const actualArgs = target.config ? args : [...args, '--config', config];
		const result = await run('devcontainer', [...actualArgs, '--override-config', override]);
		if (result.code !== 0) return result.code ?? 1;
		await verifyRemote(target.workspace, config, override);
		return 0;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(`[DevHarbour SSH] ${error.message}`);
			process.exitCode = 1;
		});
}
