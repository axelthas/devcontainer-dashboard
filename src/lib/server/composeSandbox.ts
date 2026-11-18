/**
 * Discover, validate, and inspect repository Compose sandboxes.
 * Validation runs before any process starts. Inspection runs `docker compose config`,
 * which resolves the configuration but does not build, pull, or start anything.
 * Only non-secret structure leaves this module: never environment values or secrets.
 */
import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
	COMPOSE_FILE_PATTERN,
	COMPOSE_PROFILE_PATTERN,
	MAX_COMPOSE_FILES,
	MAX_COMPOSE_PROFILES,
	compareComposeFiles,
	composeBaseName,
	composeConfigCommand,
	composeDirectory,
	composeProjectDirectory,
	type ComposeSelection
} from '../composeCommands.js';
import type {
	ComposeInspection,
	ComposeNetworkSummary,
	ComposeServiceSummary,
	ComposeStackContainer
} from '../types.js';

/** Directories that never hold a runnable sandbox definition. */
const SKIPPED_DIRECTORIES = new Set(['node_modules']);
const CONFIG_TIMEOUT_MS = 30_000;
const CONFIG_MAX_BUFFER = 16 * 1024 * 1024;
const MESSAGE_LIMIT = 2000;
const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';

/** Expected input failures; routes map them to 400. */
export class ComposeTargetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ComposeTargetError';
	}
}

/** The Compose CLI is missing from the dashboard runtime; routes map this to 503. */
export class ComposeUnavailableError extends Error {
	constructor() {
		super('Docker Compose is not available in the dashboard runtime');
		this.name = 'ComposeUnavailableError';
	}
}

/** Compose rejected the configuration; the bounded CLI message is safe to show. */
export class ComposeConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ComposeConfigError';
	}
}

/** A validated selection with lexical paths for Docker and canonical paths for locking. */
export interface ComposeTarget {
	repoPath: string;
	canonicalRepoPath: string;
	projectDirectory: string;
	canonicalProjectDirectory: string;
	selection: ComposeSelection;
}

/** Untrusted selection fields as received from a request. */
export interface ComposeTargetInput {
	repoPath: unknown;
	files: unknown;
	envFile?: unknown;
	profiles?: unknown;
}

/** Require a strict descendant, not a prefix collision or the root itself. */
function isWithin(root: string, path: string): boolean {
	const child = relative(root, path);
	return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Require the path itself or a strict descendant. */
function isSameOrWithin(root: string, path: string): boolean {
	return root === path || isWithin(root, path);
}

/** Detect C0 control characters, including NUL, CR, and LF, without a control-character regex. */
function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		if (value.charCodeAt(index) < 0x20) return true;
	}
	return false;
}

/** Accept a plain relative path: no empty, dot, or parent segments, and no control characters. */
function validRelative(value: unknown, label: string): string {
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > 512 ||
		hasControlCharacter(value) ||
		value.includes('\\') ||
		isAbsolute(value)
	) {
		throw new ComposeTargetError(`${label} must be a relative path inside the repository`);
	}
	if (value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
		throw new ComposeTargetError(`${label} must be a relative path inside the repository`);
	}
	return value;
}

/** Validate the ordered file list: one directory, at most one level deep, Compose names only. */
function validFiles(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMPOSE_FILES) {
		throw new ComposeTargetError(`Select from 1 to ${MAX_COMPOSE_FILES} Compose files`);
	}
	const files = value.map((file) => validRelative(file, 'Compose file'));
	if (new Set(files).size !== files.length) throw new ComposeTargetError('Compose files repeat');
	const directory = composeDirectory(files[0]);
	for (const file of files) {
		if (!COMPOSE_FILE_PATTERN.test(composeBaseName(file))) {
			throw new ComposeTargetError(`Not a Compose file name: ${composeBaseName(file)}`);
		}
		if (file.split('/').length > 2) {
			throw new ComposeTargetError('Compose files must be at the root or one directory deep');
		}
		if (composeDirectory(file) !== directory) {
			throw new ComposeTargetError('Selected Compose files must be in the same directory');
		}
	}
	return files;
}

/** Validate profile names; an absent list means no explicit profiles. */
function validProfiles(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_COMPOSE_PROFILES) {
		throw new ComposeTargetError(`Select at most ${MAX_COMPOSE_PROFILES} profiles`);
	}
	for (const profile of value) {
		if (typeof profile !== 'string' || !COMPOSE_PROFILE_PATTERN.test(profile)) {
			throw new ComposeTargetError('Profile names use letters, digits, dot, dash, and underscore');
		}
	}
	return [...new Set(value as string[])];
}

/** Resolve a path and require a regular file inside the canonical repository. */
async function requireFileWithin(realRepo: string, path: string, label: string): Promise<void> {
	let real: string;
	let info;
	try {
		[real, info] = await Promise.all([realpath(path), stat(path)]);
	} catch {
		throw new ComposeTargetError(`${label} is missing or inaccessible`);
	}
	if (!info.isFile()) throw new ComposeTargetError(`${label} must be a file`);
	if (!isWithin(realRepo, real))
		throw new ComposeTargetError(`${label} symlink escapes the repository`);
}

/** Check lexical and real paths before any Compose process can read the selection. */
export async function resolveComposeTarget(
	workspaceRoot: string,
	input: ComposeTargetInput
): Promise<ComposeTarget> {
	const { repoPath } = input;
	if (typeof repoPath !== 'string' || !isAbsolute(repoPath) || hasControlCharacter(repoPath)) {
		throw new ComposeTargetError('Repository must be an absolute local path');
	}
	const files = validFiles(input.files);
	const envFile =
		input.envFile === undefined || input.envFile === ''
			? undefined
			: validRelative(input.envFile, 'Environment file');
	const profiles = validProfiles(input.profiles);
	const root = resolve(workspaceRoot);
	const repo = resolve(repoPath);
	if (!isWithin(root, repo)) {
		throw new ComposeTargetError('Repository must be inside the workspace root');
	}
	let realRoot: string;
	let realRepo: string;
	try {
		const [rootPath, repositoryPath, info] = await Promise.all([
			realpath(root),
			realpath(repo),
			stat(repo)
		]);
		if (!info.isDirectory()) throw new ComposeTargetError('Repository must be a directory');
		realRoot = rootPath;
		realRepo = repositoryPath;
	} catch (cause) {
		if (cause instanceof ComposeTargetError) throw cause;
		throw new ComposeTargetError('Repository is missing or inaccessible');
	}
	if (!isWithin(realRoot, realRepo)) {
		throw new ComposeTargetError('Repository symlink escapes the workspace root');
	}
	for (const file of files) await requireFileWithin(realRepo, join(repo, file), 'Compose file');
	if (envFile) await requireFileWithin(realRepo, join(repo, envFile), 'Environment file');
	const selection: ComposeSelection = { files, profiles, ...(envFile ? { envFile } : {}) };
	const projectDirectory = composeProjectDirectory(repo, selection);
	let canonicalProjectDirectory: string;
	try {
		canonicalProjectDirectory = await realpath(projectDirectory);
	} catch {
		throw new ComposeTargetError('Project directory is missing or inaccessible');
	}
	if (!isSameOrWithin(realRepo, canonicalProjectDirectory)) {
		throw new ComposeTargetError('Project directory symlink escapes the repository');
	}
	return {
		repoPath: repo,
		canonicalRepoPath: realRepo,
		projectDirectory,
		canonicalProjectDirectory,
		selection
	};
}

/** Return Compose files in a directory listing, as paths relative to the repository. */
async function composeFilesIn(repoPath: string, directory: string): Promise<string[]> {
	try {
		const entries = await readdir(join(repoPath, directory), { withFileTypes: true });
		return entries
			.filter(
				(entry) =>
					(entry.isFile() || entry.isSymbolicLink()) && COMPOSE_FILE_PATTERN.test(entry.name)
			)
			.map((entry) => (directory ? `${directory}/${entry.name}` : entry.name));
	} catch {
		return [];
	}
}

/**
 * Find Compose files at the repository root and one directory below it.
 * Hidden directories are skipped, so `.devcontainer/` Compose definitions stay with
 * the devcontainer workflow. Validation happens again when a selection is used.
 */
export async function findComposeFiles(repoPath: string): Promise<string[]> {
	const files = await composeFilesIn(repoPath, '');
	let directories: string[];
	try {
		const entries = await readdir(repoPath, { withFileTypes: true });
		directories = entries
			.filter(
				(entry) =>
					entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)
			)
			.map((entry) => entry.name);
	} catch {
		return files.sort(compareComposeFiles);
	}
	for (const directory of directories) files.push(...(await composeFilesIn(repoPath, directory)));
	return files.sort(compareComposeFiles);
}

/** Remove dashboard credentials and editor hooks, as terminal.ts does for PTY children. */
export function composeEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const excluded = [
		'DASHBOARD_PASSWORD',
		'TERM_PROGRAM',
		'TERM_PROGRAM_VERSION',
		'GIT_ASKPASS',
		'BROWSER'
	];
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || key.startsWith('VSCODE_') || excluded.includes(key)) continue;
		result[key] = value;
	}
	return result;
}

/** Output of one config run. */
export interface ConfigOutput {
	stdout: string;
	stderr: string;
}
export type ConfigRunner = (target: ComposeTarget) => Promise<ConfigOutput>;

/** Bound CLI text before it reaches a response. */
function bounded(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > MESSAGE_LIMIT ? `${trimmed.slice(0, MESSAGE_LIMIT)}…` : trimmed;
}

/** Run `docker compose config` with literal argv, a filtered environment, and a deadline. */
export const runComposeConfig: ConfigRunner = (target) => {
	const command = composeConfigCommand(target.repoPath, target.selection);
	return new Promise((resolvePromise, reject) => {
		execFile(
			command.file,
			command.args,
			{
				cwd: target.projectDirectory,
				env: composeEnvironment(),
				timeout: CONFIG_TIMEOUT_MS,
				maxBuffer: CONFIG_MAX_BUFFER,
				encoding: 'utf8'
			},
			(cause, stdout, stderr) => {
				if (!cause) {
					resolvePromise({ stdout, stderr });
					return;
				}
				const code = (cause as NodeJS.ErrnoException).code;
				const text = `${stderr ?? ''}`;
				if (code === 'ENOENT' || /is not a docker command|unknown command "?compose/i.test(text)) {
					reject(new ComposeUnavailableError());
					return;
				}
				if ((cause as { killed?: boolean }).killed) {
					reject(new ComposeConfigError('Compose configuration check timed out'));
					return;
				}
				reject(new ComposeConfigError(bounded(text) || 'Compose rejected the configuration'));
			}
		);
	});
};

/** Narrow an unknown value to a plain object. */
function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Narrow an unknown value to a string list. */
function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];
}

/** Read a scalar as text; Compose JSON uses strings for published ports. */
function scalar(value: unknown): string | undefined {
	return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/** Extract service structure only. Environment, secrets, labels, and commands are dropped. */
function summarizeService(name: string, raw: unknown): ComposeServiceSummary {
	const service = record(raw) ?? {};
	const ports = (Array.isArray(service.ports) ? service.ports : [])
		.map(record)
		.filter((port): port is Record<string, unknown> => Boolean(port))
		.map((port) => ({
			target: scalar(port.target) ?? '',
			...(scalar(port.published) ? { published: scalar(port.published) } : {}),
			protocol: scalar(port.protocol) ?? 'tcp',
			...(scalar(port.host_ip) ? { hostIp: scalar(port.host_ip) } : {})
		}))
		.filter((port) => port.target);
	const networks = Array.isArray(service.networks)
		? strings(service.networks)
		: Object.keys(record(service.networks) ?? {});
	return {
		name,
		...(typeof service.image === 'string' ? { image: service.image } : {}),
		hasBuild: service.build !== undefined && service.build !== null,
		profiles: strings(service.profiles),
		ports,
		networks: networks.sort(),
		...(typeof service.container_name === 'string' ? { containerName: service.container_name } : {})
	};
}

/** Extract network identity, external flag, and the first IPAM subnet. */
function summarizeNetwork(key: string, raw: unknown): ComposeNetworkSummary {
	const network = record(raw) ?? {};
	const config = Array.isArray(record(network.ipam)?.config)
		? (record(network.ipam)!.config as unknown[])
		: [];
	const subnet = config.map(record).find((entry) => typeof entry?.subnet === 'string')?.subnet;
	return {
		key,
		name: typeof network.name === 'string' ? network.name : key,
		external: Boolean(network.external),
		...(typeof subnet === 'string' ? { subnet } : {})
	};
}

/** Reduce resolved Compose JSON to the non-secret structure the dashboard displays. */
export function summarizeComposeConfig(raw: unknown): {
	projectName: string;
	services: ComposeServiceSummary[];
	networks: ComposeNetworkSummary[];
} {
	const config = record(raw);
	if (!config || typeof config.name !== 'string' || !config.name) {
		throw new ComposeConfigError('Compose returned a configuration without a project name');
	}
	const services = Object.entries(record(config.services) ?? {})
		.map(([name, service]) => summarizeService(name, service))
		.sort((a, b) => a.name.localeCompare(b.name));
	const networks = Object.entries(record(config.networks) ?? {})
		.map(([key, network]) => summarizeNetwork(key, network))
		.sort((a, b) => a.key.localeCompare(b.key));
	return { projectName: config.name, services, networks };
}

/** Keep Compose warning lines, such as unset variables, without other stderr noise. */
export function composeWarnings(stderr: string): string[] {
	return stderr
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /warn|variable is not set|obsolete/i.test(line))
		.map(bounded)
		.slice(0, 20);
}

/** The one Docker listing filter this module uses: every container of a project. */
export interface ContainerListFilter {
	all: boolean;
	filters: { label: string[] };
}

/** Minimal Docker container listing shape used for stack ownership. */
export interface ListedContainer {
	Id: string;
	Names?: string[];
	State?: string;
	Labels?: Record<string, string>;
}

/**
 * Classify existing containers of the resolved project name.
 * `other` means some container belongs to a different working directory, or has no
 * working-directory label. Compose would then reconcile, recreate, or stop it.
 */
export function classifyStack(
	containers: ListedContainer[],
	projectDirectories: string[]
): Pick<ComposeInspection, 'ownership' | 'containers' | 'otherWorkingDirs'> {
	const mine = new Set(projectDirectories.map((path) => path.replace(/\/+$/, '')));
	const others = new Set<string>();
	const summaries: ComposeStackContainer[] = containers.map((container) => {
		const workingDir = container.Labels?.[WORKING_DIR_LABEL];
		if (!workingDir || !mine.has(workingDir.replace(/\/+$/, '')))
			others.add(workingDir || 'unknown');
		return {
			id: container.Id.slice(0, 12),
			name: (container.Names?.[0] ?? '').replace(/^\//, ''),
			service: container.Labels?.['com.docker.compose.service'] ?? '',
			state: container.State ?? 'unknown',
			...(workingDir ? { workingDir } : {})
		};
	});
	summaries.sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
	return {
		ownership: others.size > 0 ? 'other' : summaries.length > 0 ? 'this' : 'none',
		containers: summaries,
		otherWorkingDirs: [...others].sort()
	};
}

/** Resolve configuration, then compare it with live Docker containers of the same project. */
export async function inspectComposeTarget(
	target: ComposeTarget,
	listContainers: (options: ContainerListFilter) => Promise<ListedContainer[]>,
	run: ConfigRunner = runComposeConfig
): Promise<ComposeInspection> {
	const output = await run(target);
	let raw: unknown;
	try {
		raw = JSON.parse(output.stdout);
	} catch {
		throw new ComposeConfigError('Compose returned unreadable configuration output');
	}
	const summary = summarizeComposeConfig(raw);
	const containers = await listContainers({
		all: true,
		filters: { label: [`com.docker.compose.project=${summary.projectName}`] }
	});
	return {
		...summary,
		projectDirectory: target.projectDirectory,
		selection: target.selection,
		warnings: composeWarnings(output.stderr),
		...classifyStack(containers, [target.projectDirectory, target.canonicalProjectDirectory])
	};
}
