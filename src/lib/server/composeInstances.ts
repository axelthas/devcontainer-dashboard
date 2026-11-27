/** Reserve Compose instance slots without creating any Docker resources. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ipv4Range } from './composeInstanceAddresses.js';
import type { ComposeSelection } from '../composeCommands.js';
import type { KindDescriptor } from '../stackKinds/types.js';
import {
	ComposeInstancePlanError,
	planComposeInstance,
	type ComposeInstancePlan,
	type InstancePool
} from './composeInstancePlan.js';
import type { KindInstanceConfig } from './kindDescriptor.js';

const MAX_RECORD_BYTES = 128 * 1024;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const IDENTITY = /^[a-f0-9]{32}$/;
const STATES = ['planned', 'ready', 'failed', 'removing'] as const;
export type InstanceState = (typeof STATES)[number];

/** Only non-secret source identity and allocation metadata are stored. */
export interface InstanceRecord {
	version: 1;
	project: string;
	slot: number;
	volumeIdentity: string;
	sourceDigest: string;
	planDigest: string;
	policyDigest: string;
	kindDigest: string;
	state: InstanceState;
	createdAt: string;
	canonicalRepoPath: string;
	selection: ComposeSelection;
	subnets: string[];
}

export interface DockerOccupancy {
	subnets: string[];
	projects: string[];
	volumeNames: string[];
}

/** Inject the actual Docker snapshot at the API boundary; failure must abort allocation. */
export interface ReserveInstanceInput {
	workspaceRoot: string;
	canonicalRepoPath: string;
	selection: ComposeSelection;
	resolvedConfig: unknown;
	pool?: InstancePool;
	policy?: KindInstanceConfig;
	kind: KindDescriptor;
	slot?: number;
	getOccupancy: () => Promise<DockerOccupancy>;
}

export class InstanceStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InstanceStoreError';
	}
}

/** Reject invalid stored data rather than silently releasing reservations. */
function invalidRecord(): never {
	throw new InstanceStoreError(
		'An instance record is invalid or inaccessible; allocation is blocked'
	);
}

/** Verify every managed directory itself is not a symlink. */
async function ensureDirectory(path: string): Promise<void> {
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
	}
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new InstanceStoreError('Instance storage is not a safe directory');
}

/** Require a real workspace root and create only its two fixed managed directories. */
export async function instanceRoot(workspaceRoot: string): Promise<string> {
	if (!isAbsolute(workspaceRoot)) throw new InstanceStoreError('Workspace root must be absolute');
	const root = await realpath(workspaceRoot);
	await ensureDirectory(join(root, '.devharbour'));
	const instances = join(root, '.devharbour', 'instances');
	await ensureDirectory(instances);
	return instances;
}

/** Acquire a kernel advisory lock on an already-open no-follow file descriptor. */
async function acquireLock(fd: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn('flock', ['--exclusive', '--timeout', '15', '3'], {
			stdio: ['ignore', 'ignore', 'ignore', fd]
		});
		child.once('error', () =>
			reject(new InstanceStoreError('Could not acquire the instance allocation lock'))
		);
		child.once('exit', (code) =>
			code === 0
				? resolve()
				: reject(new InstanceStoreError('Instance allocation lock is unavailable'))
		);
	});
}

/** Hold flock through one shared open-file description until the reservation completes. */
export async function withInstanceLock<T>(
	workspaceRoot: string,
	callback: (root: string) => Promise<T>
): Promise<T> {
	const root = await instanceRoot(workspaceRoot);
	const handle = await open(
		join(root, '.lock'),
		constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		0o600
	);
	try {
		if (!(await handle.stat()).isFile())
			throw new InstanceStoreError('Instance lock is not a regular file');
		await acquireLock(handle.fd);
		return await callback(root);
	} finally {
		await handle.close();
	}
}

/** Write a bounded private record using a unique file and an atomic rename. */
export async function writeInstanceRecord(path: string, value: InstanceRecord): Promise<void> {
	const data = JSON.stringify(value, null, 2) + '\n';
	if (Buffer.byteLength(data) > MAX_RECORD_BYTES) invalidRecord();
	const temporary = join(dirname(path), `.instance-${randomUUID()}.tmp`);
	const file = await open(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600
	);
	try {
		await file.writeFile(data, 'utf8');
		await file.sync();
		await file.close();
		await rename(temporary, path);
	} catch (cause) {
		await file.close().catch(() => {});
		await unlink(temporary).catch(() => {});
		throw cause;
	}
}

/** Read and validate a record without following symlinks or accepting oversized files. */
export async function readInstanceRecord(
	directory: string,
	project: string
): Promise<InstanceRecord> {
	try {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) invalidRecord();
		const file = await open(
			join(directory, 'instance.json'),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
		);
		let content: string;
		try {
			const fileInfo = await file.stat();
			if (!fileInfo.isFile() || fileInfo.size > MAX_RECORD_BYTES) invalidRecord();
			const data = Buffer.alloc(MAX_RECORD_BYTES + 1);
			let used = 0;
			while (used < data.length) {
				const part = await file.read(data, used, data.length - used, used);
				if (!part.bytesRead) break;
				used += part.bytesRead;
			}
			if (used > MAX_RECORD_BYTES) invalidRecord();
			content = data.toString('utf8', 0, used);
		} finally {
			await file.close();
		}
		const value = JSON.parse(content) as InstanceRecord;
		if (
			value.version !== 1 ||
			value.project !== project ||
			!PROJECT.test(value.project) ||
			!Number.isInteger(value.slot) ||
			value.slot < 0 ||
			value.slot > 255 ||
			!IDENTITY.test(value.volumeIdentity) ||
			!/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
			!/^[a-f0-9]{64}$/.test(value.planDigest) ||
			!/^[a-f0-9]{64}$/.test(value.policyDigest) ||
			!/^[a-f0-9]{64}$/.test(value.kindDigest) ||
			!STATES.includes(value.state) ||
			typeof value.createdAt !== 'string' ||
			typeof value.canonicalRepoPath !== 'string' ||
			!isAbsolute(value.canonicalRepoPath) ||
			!Array.isArray(value.subnets) ||
			value.subnets.some((item) => typeof item !== 'string' || !ipv4Range(item)) ||
			!value.selection ||
			!Array.isArray(value.selection.files) ||
			value.selection.files.some((item) => typeof item !== 'string') ||
			!Array.isArray(value.selection.profiles) ||
			value.selection.profiles.some((item) => typeof item !== 'string')
		)
			invalidRecord();
		return value;
	} catch {
		return invalidRecord();
	}
}

/** A malformed directory blocks allocation; never treat unknown data as a free slot. */
async function recordsInRoot(root: string): Promise<InstanceRecord[]> {
	const names = await readdir(root);
	const records: InstanceRecord[] = [];
	for (const name of names) {
		if (name === '.lock') continue;
		if (!PROJECT.test(name)) invalidRecord();
		records.push(await readInstanceRecord(join(root, name), name));
	}
	return records;
}

/** Read a consistent snapshot of all reservations. */
export async function listInstanceRecords(workspaceRoot: string): Promise<InstanceRecord[]> {
	return withInstanceLock(workspaceRoot, recordsInRoot);
}

/** Refuse unreadable or malformed Docker snapshots instead of allocating from partial data. */
function validateOccupancy(value: DockerOccupancy): DockerOccupancy {
	if (
		!value ||
		!Array.isArray(value.subnets) ||
		!Array.isArray(value.projects) ||
		!Array.isArray(value.volumeNames) ||
		[value.subnets, value.projects, value.volumeNames].some((list) =>
			list.some((item) => typeof item !== 'string')
		)
	)
		throw new InstanceStoreError('Docker resource snapshot is incomplete');
	return value;
}

/** Revalidate selected source paths at the reservation boundary, including symlinks. */
async function validateSource(repo: string, selection: ComposeSelection): Promise<void> {
	if (
		!selection ||
		!Array.isArray(selection.files) ||
		selection.files.length < 1 ||
		selection.files.length > 8 ||
		!Array.isArray(selection.profiles) ||
		selection.profiles.length > 16
	)
		throw new InstanceStoreError('Invalid Compose selection');
	if (
		selection.profiles.some(
			(name) => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)
		)
	)
		throw new InstanceStoreError('Invalid Compose profile');
	if (selection.tag !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(selection.tag))
		throw new InstanceStoreError('Invalid Compose version');
	const files = selection.files;
	const dirs = new Set<string>();
	const validRelative = (path: unknown): path is string =>
		typeof path === 'string' &&
		path.length > 0 &&
		path.length <= 512 &&
		!isAbsolute(path) &&
		!path.includes('\\') &&
		![...path].some((c) => c.charCodeAt(0) < 32) &&
		!path.split('/').some((part) => !part || part === '.' || part === '..');
	for (const file of files) {
		if (
			!validRelative(file) ||
			file.split('/').length > 2 ||
			!/^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)*\.ya?ml$/.test(file.split('/').at(-1)!)
		)
			throw new InstanceStoreError('Invalid Compose file');
		dirs.add(dirname(file));
	}
	if (dirs.size !== 1 || new Set(files).size !== files.length)
		throw new InstanceStoreError('Invalid Compose file selection');
	if (selection.envFile !== undefined && !validRelative(selection.envFile))
		throw new InstanceStoreError('Invalid environment file');
	for (const file of [...files, ...(selection.envFile ? [selection.envFile] : [])]) {
		let resolved: string;
		try {
			resolved = await realpath(join(repo, file));
		} catch {
			throw new InstanceStoreError('Compose source file is missing or inaccessible');
		}
		const child = relative(repo, resolved);
		if (
			!child ||
			child === '..' ||
			child.startsWith(`..${sep}`) ||
			isAbsolute(child) ||
			!(await lstat(resolved)).isFile()
		)
			throw new InstanceStoreError('Compose source file escapes the repository');
	}
}

/** Hash server-side data without persisting its values. */
export function instanceDigest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Reserve one slot while the live Docker snapshot and records are locked. */
export async function reserveInstance(
	input: ReserveInstanceInput
): Promise<{ record: InstanceRecord; plan: ComposeInstancePlan }> {
	return withInstanceLock(input.workspaceRoot, async (root) => {
		const workspace = dirname(dirname(root));
		const repo = await realpath(input.canonicalRepoPath);
		const child = relative(workspace, repo);
		if (
			repo !== input.canonicalRepoPath ||
			!child ||
			child === '..' ||
			child.startsWith(`..${sep}`) ||
			isAbsolute(child) ||
			!(await lstat(repo)).isDirectory()
		)
			throw new InstanceStoreError('Repository must be a canonical directory inside the workspace');
		await validateSource(repo, input.selection);
		const records = await recordsInRoot(root);
		const occupancy = validateOccupancy(await input.getOccupancy());
		const volumeIdentity = randomBytes(16).toString('hex');
		const pool: InstancePool = {
			...input.pool,
			volumeIdentity,
			occupiedSubnets: [
				...(input.pool?.occupiedSubnets ?? []),
				...occupancy.subnets,
				...records.flatMap((record) => record.subnets)
			],
			occupiedProjects: [
				...(input.pool?.occupiedProjects ?? []),
				...occupancy.projects,
				...records.map((record) => record.project)
			]
		};
		const start = input.slot ?? Math.max(pool.minSlot ?? 1, input.policy?.slots?.min ?? 1);
		const end = input.slot ?? Math.min(pool.maxSlot ?? 254, input.policy?.slots?.max ?? 254);
		for (let slot = start; slot <= end; slot++) {
			if (records.some((record) => record.slot === slot)) continue;
			let plan: ComposeInstancePlan;
			try {
				plan = planComposeInstance(input.resolvedConfig, slot, pool, input.policy);
			} catch (cause) {
				if (
					cause instanceof ComposeInstancePlanError &&
					(cause.message === 'Instance subnet overlaps another subnet' ||
						cause.message === 'Instance project name is already in use')
				)
					continue;
				throw cause;
			}
			const names = Object.values(plan.override.volumes).map((volume) => volume.name);
			if (names.some((name) => typeof name !== 'string' || occupancy.volumeNames.includes(name)))
				throw new InstanceStoreError('Instance volume identity collides with an existing volume');
			const record: InstanceRecord = {
				version: 1,
				project: plan.project,
				slot,
				volumeIdentity,
				sourceDigest: instanceDigest(input.resolvedConfig),
				planDigest: instanceDigest(plan),
				policyDigest: instanceDigest(input.policy ?? null),
				kindDigest: instanceDigest(input.kind),
				state: 'planned',
				createdAt: new Date().toISOString(),
				canonicalRepoPath: input.canonicalRepoPath,
				selection: {
					files: [...input.selection.files],
					profiles: [...input.selection.profiles],
					...(input.selection.envFile ? { envFile: input.selection.envFile } : {}),
					...(input.selection.tag ? { tag: input.selection.tag } : {})
				},
				subnets: plan.addressPlan.subnets.map((item) => item.to)
			};
			const directory = join(root, plan.project);
			// If interrupted before the record is written, the unknown directory blocks allocation.
			await mkdir(directory, { mode: 0o700 });
			await writeInstanceRecord(join(directory, 'instance.json'), record);
			return { record, plan };
		}
		throw new InstanceStoreError('No available instance slot in the selected pool');
	});
}

/** Persist only valid lifecycle transitions while holding the same allocation lock. */
export async function setInstanceState(
	workspaceRoot: string,
	project: string,
	from: InstanceState,
	to: InstanceState
): Promise<InstanceRecord> {
	const allowed: Record<InstanceState, InstanceState[]> = {
		planned: ['failed', 'removing'],
		ready: ['failed', 'removing'],
		failed: ['planned', 'removing'],
		removing: ['removing']
	};
	if (!PROJECT.test(project) || !allowed[from]?.includes(to))
		throw new InstanceStoreError('Invalid instance state transition');
	return withInstanceLock(workspaceRoot, async (root) => {
		const path = join(root, project, 'instance.json');
		const record = await readInstanceRecord(dirname(path), project);
		if (record.state !== from)
			throw new InstanceStoreError('Instance state changed; retry the operation');
		const updated: InstanceRecord = { ...record, state: to };
		await writeInstanceRecord(path, updated);
		return updated;
	});
}

/** Execute preparation under the reservation lock. A failure retains the record and slot. */
export async function prepareReservedInstance(
	workspaceRoot: string,
	project: string,
	prepare: (record: InstanceRecord, directory: string) => Promise<void>
): Promise<InstanceRecord> {
	if (!PROJECT.test(project)) throw new InstanceStoreError('Invalid instance project');
	return withInstanceLock(workspaceRoot, async (root) => {
		const directory = join(root, project);
		const path = join(directory, 'instance.json');
		const record = await readInstanceRecord(directory, project);
		if (record.state !== 'planned')
			throw new InstanceStoreError('Instance is not ready for preparation');
		try {
			await prepare(record, directory);
			const ready: InstanceRecord = { ...record, state: 'ready' };
			await writeInstanceRecord(path, ready);
			return ready;
		} catch (cause) {
			await writeInstanceRecord(path, { ...record, state: 'failed' });
			throw cause;
		}
	});
}

/** Read one record under the lock. */
export async function findInstanceRecord(
	workspaceRoot: string,
	project: string
): Promise<InstanceRecord> {
	if (!PROJECT.test(project)) throw new InstanceStoreError('Invalid instance project');
	return withInstanceLock(workspaceRoot, (root) =>
		readInstanceRecord(join(root, project), project)
	);
}

export interface ReplanInstanceInput {
	workspaceRoot: string;
	project: string;
	resolvedConfig: unknown;
	pool?: InstancePool;
	policy?: KindInstanceConfig;
	kind: KindDescriptor;
	getOccupancy: () => Promise<DockerOccupancy>;
}

/** Recompute a drifted plan on the same slot and volume identity; the result must be prepared again. */
export async function replanInstance(
	input: ReplanInstanceInput
): Promise<{ record: InstanceRecord; plan: ComposeInstancePlan }> {
	if (!PROJECT.test(input.project)) throw new InstanceStoreError('Invalid instance project');
	return withInstanceLock(input.workspaceRoot, async (root) => {
		const directory = join(root, input.project);
		const record = await readInstanceRecord(directory, input.project);
		if (record.state !== 'ready' && record.state !== 'failed')
			throw new InstanceStoreError('Only a ready or failed instance can be planned again');
		const others = (await recordsInRoot(root)).filter((item) => item.project !== record.project);
		const occupancy = validateOccupancy(await input.getOccupancy());
		const own = new Set(record.subnets);
		const plan = planComposeInstance(
			input.resolvedConfig,
			record.slot,
			{
				...input.pool,
				volumeIdentity: record.volumeIdentity,
				occupiedSubnets: [
					...(input.pool?.occupiedSubnets ?? []),
					...occupancy.subnets.filter((item) => !own.has(item)),
					...others.flatMap((item) => item.subnets)
				],
				occupiedProjects: [
					...(input.pool?.occupiedProjects ?? []),
					...others.map((item) => item.project)
				]
			},
			input.policy
		);
		if (plan.project !== record.project)
			throw new InstanceStoreError('The Compose project name changed; create a new instance');
		const updated: InstanceRecord = {
			...record,
			state: 'planned',
			sourceDigest: instanceDigest(input.resolvedConfig),
			planDigest: instanceDigest(plan),
			policyDigest: instanceDigest(input.policy ?? null),
			kindDigest: instanceDigest(input.kind),
			subnets: plan.addressPlan.subnets.map((item) => item.to)
		};
		await writeInstanceRecord(join(directory, 'instance.json'), updated);
		return { record: updated, plan };
	});
}
