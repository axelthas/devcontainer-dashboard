/**
 * Server-only orchestration for Compose instances: create, review a plan, resolve a run target,
 * and run declared kind actions. Every input is revalidated here; routes only map errors.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { composeGlobalArgs, type ComposeInstanceCommand } from '../composeCommands.js';
import { collectInstanceOccupancy } from './composeInstanceOccupancy.js';
import { instanceHostPath } from './composeInstanceHostPath.js';
import { INSTANCE_LABEL, VOLUME_IDENTITY_LABEL } from './composeInstanceOverride.js';
import { prepareInstance } from './composeInstancePrepare.js';
import {
	findInstanceRecord,
	instanceDigest,
	instanceRoot,
	replanInstance,
	reserveInstance,
	type InstanceRecord
} from './composeInstances.js';
import type { InstancePool } from './composeInstancePlan.js';
import { reserveProjectRemoval } from './composeRuns.js';
import {
	composeEnvironment,
	loadComposeInstanceSource,
	type ComposeInstanceSource,
	type ComposeTarget
} from './composeSandbox.js';
import type { KindAction } from './kindDescriptor.js';

const CHECK_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/** An expected refusal with an HTTP status and an operator message without config values. */
export class InstanceRequestError extends Error {
	readonly status: 400 | 404 | 409 | 422 | 503;
	constructor(status: 400 | 404 | 409 | 422 | 503, message: string) {
		super(message);
		this.name = 'InstanceRequestError';
		this.status = status;
	}
}

/** The Docker client operations this module needs. */
export interface InstanceDocker {
	listNetworks(): Promise<unknown>;
	listContainers(options: object): Promise<unknown>;
	listVolumes(): Promise<unknown>;
	getContainer(id: string): { inspect(): Promise<{ Mounts?: unknown[] }> };
}

/** Client-safe summary of one instance. */
export interface InstanceSummary {
	project: string;
	slot: number;
	state: InstanceRecord['state'];
	subnets: string[];
	createdAt: string;
}

/** Strip digests, identity and paths. */
export function instanceSummary(record: InstanceRecord): InstanceSummary {
	const { project, slot, state, subnets, createdAt } = record;
	return { project, slot, state, subnets, createdAt };
}

/** Operator pool settings from the environment; Settings integration reads the same keys. */
export function instancePool(env: NodeJS.ProcessEnv = process.env): InstancePool {
	const reserved = (env.DEVHARBOUR_INSTANCE_RESERVED ?? '').split(/[\s,]+/).filter(Boolean);
	return {
		...(env.DEVHARBOUR_INSTANCE_POOL ? { defaultSubnet: env.DEVHARBOUR_INSTANCE_POOL } : {}),
		...(reserved.length ? { occupiedSubnets: reserved } : {})
	};
}

/** Run one literal docker command with the filtered environment and a deadline. */
function docker(
	args: string[],
	cwd: string,
	timeout: number,
	extraEnv: Record<string, string> = {}
): Promise<{ stdout: string; code: number }> {
	return new Promise((resolve) => {
		execFile(
			'docker',
			args,
			{
				cwd,
				env: { ...composeEnvironment(), ...extraEnv },
				timeout,
				maxBuffer: MAX_BUFFER,
				encoding: 'utf8'
			},
			(cause, stdout) => {
				const code = cause ? Number((cause as { code?: unknown }).code) || 1 : 0;
				resolve({ stdout: stdout ?? '', code });
			}
		);
	});
}

/** The instance arguments for Compose. */
function instanceCommand(root: string, record: InstanceRecord): ComposeInstanceCommand {
	return { projectName: record.project, overrideFile: join(root, record.project, 'override.yaml') };
}

/** The instance environment that interpolation may use. */
function instanceEnv(record: InstanceRecord): Record<string, string> {
	return { DEVHARBOUR_INSTANCE: record.project, DEVHARBOUR_SLOT: String(record.slot) };
}

/** Same repository and same selection (files, profiles, env file). The version may change. */
function matchesTarget(record: InstanceRecord, target: ComposeTarget): boolean {
	const a = record.selection;
	const b = target.selection;
	return (
		record.canonicalRepoPath === target.canonicalRepoPath &&
		JSON.stringify([a.files, a.profiles, a.envFile ?? '']) ===
			JSON.stringify([b.files, b.profiles, b.envFile ?? ''])
	);
}

/** Map a dashboard path to the Docker host path through this container's own bind mounts. */
async function hostPathFor(client: InstanceDocker, path: string): Promise<string | undefined> {
	try {
		const info = await client.getContainer(hostname()).inspect();
		return instanceHostPath(path, (info.Mounts ?? []) as never[]);
	} catch {
		// Outside a container, dashboard paths are host paths.
		return existsSync('/.dockerenv') ? undefined : path;
	}
}

/** Shared adapters for reservation and preparation. */
function adapters(
	client: InstanceDocker,
	target: ComposeTarget,
	source: ComposeInstanceSource,
	root: string
) {
	return {
		getOccupancy: () =>
			collectInstanceOccupancy({
				listNetworks: () => client.listNetworks(),
				listContainers: (options) => client.listContainers(options),
				listVolumes: () => client.listVolumes()
			}),
		getComposeVersion: async () =>
			(
				await docker(['compose', 'version', '--short'], target.projectDirectory, CHECK_TIMEOUT_MS)
			).stdout.trim(),
		getSourceConfig: async () => (await loadComposeInstanceSource(target)).raw,
		hostPath: (path: string) => hostPathFor(client, path),
		checkConfig: async (record: InstanceRecord, overridePath: string) => {
			const args = [
				...composeGlobalArgs(target.repoPath, target.selection, source.overrideFile, {
					projectName: record.project,
					overrideFile: overridePath
				}),
				'config',
				'--format',
				'json'
			];
			const result = await docker(
				args,
				target.projectDirectory,
				CHECK_TIMEOUT_MS,
				instanceEnv(record)
			);
			if (result.code !== 0)
				throw new InstanceRequestError(422, 'Compose rejected the instance configuration');
			try {
				return JSON.parse(result.stdout);
			} catch {
				throw new InstanceRequestError(422, 'Compose returned unreadable instance configuration');
			}
		},
		root
	};
}

/** Reserve a slot, write the override and files, and verify the merged configuration. Starts nothing. */
export async function createInstance(
	client: InstanceDocker,
	workspaceRoot: string,
	target: ComposeTarget
): Promise<{ instance: InstanceSummary; warnings: string[] }> {
	const source = await loadComposeInstanceSource(target);
	const root = await instanceRoot(workspaceRoot);
	const io = adapters(client, target, source, root);
	const { record, plan } = await reserveInstance({
		workspaceRoot,
		canonicalRepoPath: target.canonicalRepoPath,
		selection: target.selection,
		resolvedConfig: source.raw,
		pool: instancePool(),
		policy: source.declaration?.instances,
		kind: source.kind,
		getOccupancy: io.getOccupancy
	});
	const ready = await prepareInstance({
		workspaceRoot,
		project: record.project,
		plan,
		policy: source.declaration?.instances,
		kind: source.kind,
		...io
	});
	return { instance: instanceSummary(ready), warnings: plan.warnings };
}

/** Recompute a drifted plan on the same slot and identity, then prepare it again. */
export async function reviewInstancePlan(
	client: InstanceDocker,
	workspaceRoot: string,
	target: ComposeTarget,
	project: string
): Promise<{ instance: InstanceSummary; warnings: string[] }> {
	const before = await findInstanceRecord(workspaceRoot, project);
	if (!matchesTarget(before, target))
		throw new InstanceRequestError(409, 'The instance belongs to another selection');
	const source = await loadComposeInstanceSource(target);
	const root = await instanceRoot(workspaceRoot);
	const io = adapters(client, target, source, root);
	const { plan } = await replanInstance({
		workspaceRoot,
		project,
		resolvedConfig: source.raw,
		pool: instancePool(),
		policy: source.declaration?.instances,
		kind: source.kind,
		getOccupancy: io.getOccupancy
	});
	const ready = await prepareInstance({
		workspaceRoot,
		project,
		plan,
		policy: source.declaration?.instances,
		kind: source.kind,
		owned: { subnets: before.subnets },
		...io
	});
	return { instance: instanceSummary(ready), warnings: plan.warnings };
}

/** A run target for one ready instance with no drift and no foreign containers. */
export async function resolveInstanceRun(
	client: InstanceDocker,
	workspaceRoot: string,
	target: ComposeTarget,
	project: unknown
): Promise<{ record: InstanceRecord; instance: ComposeInstanceCommand & { slot: number } }> {
	if (typeof project !== 'string') throw new InstanceRequestError(400, 'Invalid instance');
	let record: InstanceRecord;
	try {
		record = await findInstanceRecord(workspaceRoot, project);
	} catch {
		throw new InstanceRequestError(404, 'No such instance');
	}
	if (!matchesTarget(record, target))
		throw new InstanceRequestError(409, 'The instance belongs to another selection');
	if (record.state !== 'ready')
		throw new InstanceRequestError(409, `The instance is ${record.state}. Review the plan first.`);
	const source = await loadComposeInstanceSource(target);
	if (
		instanceDigest(source.raw) !== record.sourceDigest ||
		instanceDigest(source.kind) !== record.kindDigest ||
		instanceDigest(source.declaration?.instances ?? null) !== record.policyDigest
	)
		throw new InstanceRequestError(
			409,
			'The Compose source changed since the plan. Review the plan first.'
		);
	const containers = await client.listContainers({
		all: true,
		filters: { label: [`com.docker.compose.project=${record.project}`] }
	});
	if (!Array.isArray(containers))
		throw new InstanceRequestError(503, 'Could not read Docker containers');
	for (const item of containers as { Labels?: Record<string, string> }[]) {
		if (
			item.Labels?.[INSTANCE_LABEL] !== record.project ||
			item.Labels?.[VOLUME_IDENTITY_LABEL] !== record.volumeIdentity
		)
			throw new InstanceRequestError(
				409,
				'The project has containers that do not belong to this instance'
			);
	}
	const root = await instanceRoot(workspaceRoot);
	return { record, instance: { ...instanceCommand(root, record), slot: record.slot } };
}

/** Services that an action targets: an explicit list or every service outside a role. */
function actionServices(action: KindAction, source: ComposeInstanceSource): string[] {
	if (Array.isArray(action.services))
		return action.services.filter((name) => source.services.includes(name));
	const role = action.services.exceptRole;
	return source.services.filter((name) => source.kind.services?.[name]?.role !== role);
}

export type ActionResult = 'ok' | 'partial' | 'failed';
const g = globalThis as typeof globalThis & {
	__kindActionState?: Map<
		string,
		Record<string, { value: string; at: string; result: ActionResult }>
	>;
};
const actionState = (g.__kindActionState ??= new Map());

/** Last successful or partial value per project and action. Process memory only. */
export function kindActionState(project: string) {
	return actionState.get(project) ?? {};
}

/**
 * Run one declared choice action. The browser sends only the action id and an option; argv comes
 * from the validated declaration. Holds the project exclusively, so no Compose run overlaps.
 */
export async function runKindAction(input: {
	client: InstanceDocker;
	workspaceRoot: string;
	target: ComposeTarget;
	instance?: string;
	action: unknown;
	option: unknown;
	confirmed: unknown;
}): Promise<{
	project: string;
	result: ActionResult;
	services: { service: string; result: 'ok' | 'failed' }[];
}> {
	const source = await loadComposeInstanceSource(input.target);
	if (
		typeof input.action !== 'string' ||
		!source.declaration?.actions ||
		!Object.hasOwn(source.declaration.actions, input.action)
	)
		throw new InstanceRequestError(400, 'Unknown action');
	const action = source.declaration.actions[input.action];
	if (typeof input.option !== 'string' || !action.options.includes(input.option))
		throw new InstanceRequestError(400, 'Unknown option');
	if (action.confirm.includes(input.option) && input.confirmed !== true)
		throw new InstanceRequestError(409, 'This option needs confirmation');
	let project = source.projectName;
	let instance: ComposeInstanceCommand | undefined;
	let env: Record<string, string> = {};
	if (input.instance !== undefined) {
		const resolved = await resolveInstanceRun(
			input.client,
			input.workspaceRoot,
			input.target,
			input.instance
		);
		project = resolved.record.project;
		instance = resolved.instance;
		env = instanceEnv(resolved.record);
	}
	const services = actionServices(action, source);
	if (!services.length) throw new InstanceRequestError(422, 'The action targets no service');
	const release = reserveProjectRemoval(project);
	try {
		const base = composeGlobalArgs(
			input.target.repoPath,
			input.target.selection,
			source.overrideFile,
			instance
		);
		const substitute = (argv: string[]) =>
			argv.map((arg) => arg.replaceAll('{option}', input.option as string));
		const results: { service: string; result: 'ok' | 'failed' }[] = [];
		for (const service of services) {
			const run = await docker(
				[...base, 'exec', '-T', service, ...substitute(action.argv)],
				input.target.projectDirectory,
				ACTION_TIMEOUT_MS,
				env
			);
			let ok = run.code === 0;
			if (ok && action.readBack) {
				const check = await docker(
					[...base, 'exec', '-T', service, ...substitute(action.readBack)],
					input.target.projectDirectory,
					ACTION_TIMEOUT_MS,
					env
				);
				ok = check.code === 0;
			}
			results.push({ service, result: ok ? 'ok' : 'failed' });
		}
		const passed = results.filter((item) => item.result === 'ok').length;
		const result: ActionResult =
			passed === results.length ? 'ok' : passed > 0 ? 'partial' : 'failed';
		// A failed action never replaces the stored value.
		if (result !== 'failed') {
			actionState.set(project, {
				...kindActionState(project),
				[input.action]: { value: input.option, at: new Date().toISOString(), result }
			});
		}
		return { project, result, services: results };
	} finally {
		release();
	}
}

/** Map expected failures to a status and a value-free message; anything else is 503. */
export function instanceHttpStatus(cause: unknown): {
	status: 400 | 404 | 409 | 422 | 503;
	message: string;
} {
	if (cause instanceof InstanceRequestError)
		return { status: cause.status, message: cause.message };
	const name = cause instanceof Error ? cause.name : '';
	if (name === 'ComposeTargetError') return { status: 400, message: (cause as Error).message };
	if (
		name === 'ComposeConfigError' ||
		name === 'ComposeInstancePlanError' ||
		name === 'KindDescriptorError'
	)
		return { status: 422, message: (cause as Error).message };
	if (name === 'ComposeRunConflict') return { status: 409, message: (cause as Error).message };
	if (name === 'InstanceStoreError') return { status: 409, message: (cause as Error).message };
	if (name === 'ComposeUnavailableError') return { status: 503, message: (cause as Error).message };
	// Preparation and removal raise plain errors with fixed, value-free messages.
	if (name === 'Error' && cause instanceof Error && cause.message.length < 160)
		return { status: 409, message: cause.message };
	return {
		status: 503,
		message: 'Could not complete the instance operation. Check Docker availability.'
	};
}
