/**
 * Client-safe Compose sandbox contract: actions, selection limits, and literal argv.
 * The server executes these argv arrays without a shell. The browser uses the same
 * builders to show the exact Docker calls and to open an operator log terminal.
 */

/** Allowlisted lifecycle actions. Down and volume removal are deliberately absent. */
export const COMPOSE_ACTIONS = ['build', 'up', 'up-build', 'stop'] as const;
export type ComposeAction = (typeof COMPOSE_ACTIONS)[number];

/** Button labels. Each label names one Compose operation. */
export const COMPOSE_ACTION_LABELS: Record<ComposeAction, string> = {
	build: 'Build',
	up: 'Start',
	'up-build': 'Build and start',
	stop: 'Stop'
};

/** compose.yaml, docker-compose.yml, docker-compose.override.yml, compose.sandbox.yaml, ... */
export const COMPOSE_FILE_PATTERN = /^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)*\.ya?ml$/;
/** Compose profile names, kept strict so they never look like options. */
export const COMPOSE_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MAX_COMPOSE_FILES = 8;
export const MAX_COMPOSE_PROFILES = 16;

/** Base names that Compose itself loads by default, in its precedence order. */
export const DEFAULT_COMPOSE_FILES = [
	'compose.yaml',
	'compose.yml',
	'docker-compose.yaml',
	'docker-compose.yml'
];

/** One operator selection. Paths are relative to the repository, in Compose merge order. */
export interface ComposeSelection {
	files: string[];
	envFile?: string;
	profiles: string[];
}

/** One literal process invocation. */
export interface ComposeCommand {
	file: 'docker';
	args: string[];
}

/** Narrow untrusted input to the action allowlist. */
export function isComposeAction(value: unknown): value is ComposeAction {
	return typeof value === 'string' && (COMPOSE_ACTIONS as readonly string[]).includes(value);
}

/** Return the directory part of a relative path, or '' for the repository root. */
export function composeDirectory(file: string): string {
	const index = file.lastIndexOf('/');
	return index < 0 ? '' : file.slice(0, index);
}

/** Return the base name of a relative path. */
export function composeBaseName(file: string): string {
	return file.slice(file.lastIndexOf('/') + 1);
}

/** Join an absolute repository path and a validated relative path without Node imports. */
function absolutePath(repoPath: string, relativePath: string): string {
	const base = repoPath.replace(/\/+$/, '');
	return relativePath ? `${base}/${relativePath}` : base;
}

/** Absolute project directory: the directory of the first selected file, as in Compose. */
export function composeProjectDirectory(repoPath: string, selection: ComposeSelection): string {
	return absolutePath(repoPath, composeDirectory(selection.files[0] ?? ''));
}

/** Global options shared by inspection, actions, and log commands. Order is significant. */
export function composeGlobalArgs(repoPath: string, selection: ComposeSelection): string[] {
	const args = ['compose', '--project-directory', composeProjectDirectory(repoPath, selection)];
	for (const file of selection.files) args.push('--file', absolutePath(repoPath, file));
	if (selection.envFile) args.push('--env-file', absolutePath(repoPath, selection.envFile));
	for (const profile of selection.profiles) args.push('--profile', profile);
	return args;
}

/** Action arguments. Start is detached: the stack outlives the dashboard process. */
const ACTION_ARGS: Record<ComposeAction, string[]> = {
	build: ['build'],
	up: ['up', '--detach'],
	'up-build': ['up', '--detach', '--build'],
	stop: ['stop']
};

/** Build the argv for one lifecycle action. */
export function composeActionCommand(
	repoPath: string,
	selection: ComposeSelection,
	action: ComposeAction
): ComposeCommand {
	return {
		file: 'docker',
		args: [...composeGlobalArgs(repoPath, selection), ...ACTION_ARGS[action]]
	};
}

/** Build the argv that resolves and validates the effective configuration. */
export function composeConfigCommand(
	repoPath: string,
	selection: ComposeSelection
): ComposeCommand {
	return {
		file: 'docker',
		args: [...composeGlobalArgs(repoPath, selection), 'config', '--format', 'json']
	};
}

/** Build the argv that follows service logs in an operator terminal. */
export function composeLogsCommand(repoPath: string, selection: ComposeSelection): ComposeCommand {
	return {
		file: 'docker',
		args: [...composeGlobalArgs(repoPath, selection), 'logs', '--follow', '--tail', '200']
	};
}

/** POSIX single-quote one argument when it contains characters outside a safe set. */
export function shellQuote(arg: string): string {
	return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Render a command for display or for an operator terminal. */
export function shellCommand(command: ComposeCommand): string {
	return [command.file, ...command.args].map(shellQuote).join(' ');
}

/** Encode a selection as the query string of `GET /api/compose`. Repeated keys keep order. */
export function composeQuery(repoPath: string, selection: ComposeSelection): string {
	const parts = [`repoPath=${encodeURIComponent(repoPath)}`];
	for (const file of selection.files) parts.push(`file=${encodeURIComponent(file)}`);
	if (selection.envFile) parts.push(`envFile=${encodeURIComponent(selection.envFile)}`);
	for (const profile of selection.profiles) parts.push(`profile=${encodeURIComponent(profile)}`);
	return parts.join('&');
}

/** Split a comma or whitespace separated profile field and remove duplicates. */
export function parseProfiles(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/** Sort discovered files: root first, then directories; Compose defaults, overrides, others. */
export function compareComposeFiles(a: string, b: string): number {
	const directoryA = composeDirectory(a);
	const directoryB = composeDirectory(b);
	if (directoryA !== directoryB) {
		if (!directoryA) return -1;
		if (!directoryB) return 1;
		return directoryA.localeCompare(directoryB);
	}
	return rank(composeBaseName(a)) - rank(composeBaseName(b)) || a.localeCompare(b);
}

/** Rank a base name: default files, then their override files, then named variants. */
function rank(name: string): number {
	const primary = DEFAULT_COMPOSE_FILES.indexOf(name);
	if (primary >= 0) return primary;
	if (/^(?:docker-)?compose\.override\.ya?ml$/.test(name)) return 10;
	return 20;
}

/** Default selection for one directory: the first default file plus its matching override. */
export function defaultComposeSelection(files: string[], directory?: string): string[] {
	const inDirectory = files.filter(
		(file) => composeDirectory(file) === (directory ?? composeDirectory(files[0] ?? ''))
	);
	const primary = inDirectory.find((file) => DEFAULT_COMPOSE_FILES.includes(composeBaseName(file)));
	if (!primary) return inDirectory.slice(0, 1);
	const stem = composeBaseName(primary).replace(/\.ya?ml$/, '');
	const override = inDirectory.find((file) =>
		new RegExp(`^${stem.replace('.', '\\.')}\\.override\\.ya?ml$`).test(composeBaseName(file))
	);
	return override ? [primary, override] : [primary];
}
