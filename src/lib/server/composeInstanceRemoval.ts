/** Preview removal without trusting names or following instance-directory symlinks. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { INSTANCE_LABEL, VOLUME_IDENTITY_LABEL } from './composeInstanceOverride.js';
import type { SandboxRemovalPreview } from '../types.js';
import { readInstanceRecord, withInstanceLock, type InstanceRecord } from './composeInstances.js';
import {
	previewSandboxRemoval,
	RemovalNotFoundError,
	type RemovalDocker
} from './composeRemoval.js';

const PROJECT = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const FILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Ensure files are direct regular files and bind the token to the directory snapshot. */
async function directorySnapshot(directory: string): Promise<string[]> {
	const dir = await open(
		directory,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
	);
	try {
		const parent = `/proc/self/fd/${dir.fd}`;
		const entries = await readdir(parent);
		const result: string[] = [];
		if (!entries.includes('instance.json')) throw new Error('Instance directory is incomplete');
		for (const entry of entries.sort()) {
			if (!['instance.json', 'override.yaml', 'files'].includes(entry))
				throw new Error('Instance directory has unexpected contents');
			if (entry === 'files') {
				const files = await open(
					join(parent, 'files'),
					constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
				);
				try {
					for (const name of (await readdir(`/proc/self/fd/${files.fd}`)).sort()) {
						if (!FILE_ID.test(name)) throw new Error('Instance directory has unexpected contents');
						const handle = await open(
							join(`/proc/self/fd/${files.fd}`, name),
							constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
						);
						try {
							const stat = await handle.stat();
							if (!stat.isFile()) throw new Error('Instance directory has unexpected contents');
							result.push(`files/${name}:${stat.ino}:${stat.size}:${stat.mtimeMs}`);
						} finally {
							await handle.close();
						}
					}
				} finally {
					await files.close();
				}
				continue;
			}
			const handle = await open(
				join(parent, entry),
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
			);
			try {
				const stat = await handle.stat();
				if (!stat.isFile()) throw new Error('Instance directory has unexpected contents');
				result.push(`${entry}:${stat.ino}:${stat.size}:${stat.mtimeMs}`);
			} finally {
				await handle.close();
			}
		}
		return result;
	} finally {
		await dir.close();
	}
}

/** Verify every project container and network belongs to this exact instance generation. */
async function assertOwnership(
	docker: RemovalDocker,
	record: InstanceRecord,
	preview?: SandboxRemovalPreview
): Promise<void> {
	const label = [`com.docker.compose.project=${record.project}`];
	const [containers, networks] = await Promise.all([
		docker.listContainers({ all: true, filters: { label } }),
		docker.listNetworks({ filters: { label } })
	]);
	const actualContainers = containers.map(({ Id }) => Id).sort();
	const actualNetworks = networks.map(({ Id }) => Id).sort();
	if (
		JSON.stringify(actualContainers) !==
			JSON.stringify((preview?.containers.map(({ id }) => id) ?? []).sort()) ||
		JSON.stringify(actualNetworks) !==
			JSON.stringify((preview?.networks.map(({ id }) => id) ?? []).sort())
	)
		throw new Error('The project changed during removal preview');
	for (const resource of [...containers, ...networks]) {
		if (
			resource.Labels?.[INSTANCE_LABEL] !== record.project ||
			resource.Labels?.[VOLUME_IDENTITY_LABEL] !== record.volumeIdentity
		)
			throw new Error('The project has resources that do not belong to this instance');
	}
}

/** Build the preview while holding the instance lock. */
async function previewLocked(docker: RemovalDocker, root: string, project: string) {
	const directory = join(root, project);
	const record = await readInstanceRecord(directory, project);
	const files = await directorySnapshot(directory);
	let sandbox: SandboxRemovalPreview | undefined;
	try {
		sandbox = await previewSandboxRemoval(docker, project);
	} catch (cause) {
		if (!(cause instanceof RemovalNotFoundError)) throw cause;
	}
	await assertOwnership(docker, record, sandbox);
	const token = createHash('sha256')
		.update(
			JSON.stringify({
				project,
				identity: record.volumeIdentity,
				state: record.state,
				files,
				sandboxToken: sandbox?.token ?? null
			})
		)
		.digest('hex');
	return {
		project,
		state: record.state,
		directory,
		files: files.map((item) => item.split(':')[0]),
		containers: sandbox?.containers ?? [],
		networks: sandbox?.networks ?? [],
		volumes: sandbox?.volumes ?? [],
		token
	};
}

/** Include the instance directory even when no containers have ever been created. */
export async function previewInstanceRemoval(
	docker: RemovalDocker,
	workspaceRoot: string,
	project: string
) {
	if (!PROJECT.test(project)) throw new Error('Invalid instance project');
	return withInstanceLock(workspaceRoot, (root) => previewLocked(docker, root, project));
}
