/**
 * Remove a whole Compose sandbox through the Docker API, found by its project label.
 * Removal keeps volumes, images, and source files. A project network that a container
 * outside the project is attached to stays; DevHarbour never disconnects it.
 * The preview returns a token; removal recomputes the preview and requires the same token.
 */
import { createHash } from 'node:crypto';
import { sandboxVersion } from '../imageReference.js';
import { reserveProjectRemoval } from './composeRuns.js';
import type { RemovalResult, SandboxRemovalPreview } from '../types.js';

const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
const SANDBOX_TAG_LABEL = 'devcontainer-dashboard.sandbox.tag';
/** Compose project names: lowercase letters, digits, dashes, and underscores. */
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const STOP_TIMEOUT_SECONDS = 10;

/** Expected input failures; the route maps them to 400. */
export class RemovalInputError extends Error {}
/** No container or network has the project label; the route maps this to 404. */
export class RemovalNotFoundError extends Error {}
/** The resources changed after the preview; the route maps this to 409. */
export class RemovalStaleError extends Error {}

/** The Docker operations that removal needs, so tests can replace them. */
export interface RemovalDocker {
	listContainers(options: { all: boolean; filters: { label: string[] } }): Promise<
		{
			Id: string;
			Names?: string[];
			State?: string;
			Image?: string;
			Labels?: Record<string, string>;
		}[]
	>;
	listNetworks(options: {
		filters: { label: string[] };
	}): Promise<{ Id: string; Name: string; Labels?: Record<string, string> }[]>;
	inspectNetwork(id: string): Promise<{ Containers?: Record<string, { Name?: string }> }>;
	listVolumes(options: { filters: { label: string[] } }): Promise<{ Name: string }[]>;
	stopContainer(id: string, seconds: number): Promise<void>;
	removeContainer(id: string): Promise<void>;
	removeNetwork(id: string): Promise<void>;
}

/** Validate a project name before it reaches a label filter. */
export function validProject(value: unknown): string {
	if (typeof value !== 'string' || !PROJECT_PATTERN.test(value)) {
		throw new RemovalInputError('Project must be a Compose project name');
	}
	return value;
}

/** Digest of the resource set; equal sets give equal tokens, in any order. */
function resourceToken(preview: Omit<SandboxRemovalPreview, 'token'>): string {
	const identity = {
		containers: preview.containers.map((item) => item.id).sort(),
		networks: preview.networks
			.map((item) => `${item.id}:${[...item.attached].sort().join(',')}`)
			.sort()
	};
	return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32);
}

/** Read what removal would change and keep, from live Docker state. */
export async function previewSandboxRemoval(
	docker: RemovalDocker,
	project: string
): Promise<SandboxRemovalPreview> {
	const label = [`${PROJECT_LABEL}=${validProject(project)}`];
	const [listed, networks, volumes] = await Promise.all([
		docker.listContainers({ all: true, filters: { label } }),
		docker.listNetworks({ filters: { label } }),
		docker.listVolumes({ filters: { label } })
	]);
	if (listed.length === 0 && networks.length === 0) {
		throw new RemovalNotFoundError(`No sandbox named ${project} on this host`);
	}
	const ids = new Set(listed.map((container) => container.Id));
	const containers = listed
		.map((container) => ({
			id: container.Id,
			name: (container.Names?.[0] ?? container.Id.slice(0, 12)).replace(/^\//, ''),
			service: container.Labels?.[SERVICE_LABEL] ?? '',
			state: container.State ?? 'unknown'
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	const inspected = await Promise.all(
		networks.map(async (network) => {
			const info = await docker.inspectNetwork(network.Id);
			// Endpoints of containers outside the project keep the network.
			const attached = Object.entries(info.Containers ?? {})
				.filter(([id]) => !ids.has(id))
				.map(([id, endpoint]) => endpoint.Name || id.slice(0, 12))
				.sort();
			return { id: network.Id, name: network.Name, attached };
		})
	);
	const version = sandboxVersion(
		project,
		listed.map((container) => ({
			image: container.Image ?? '',
			service: container.Labels?.[SERVICE_LABEL],
			sandboxTag: container.Labels?.[SANDBOX_TAG_LABEL]
		}))
	);
	const source = listed.map((container) => container.Labels?.[WORKING_DIR_LABEL]).find(Boolean);
	const preview = {
		project,
		...(source ? { source } : {}),
		version: listed.length > 0 ? version.label : 'no containers',
		containers,
		networks: inspected.sort((a, b) => a.name.localeCompare(b.name)),
		volumes: volumes.map((volume) => volume.Name).sort()
	};
	return { ...preview, token: resourceToken(preview) };
}

/** Bounded, credential-free failure text from the Docker API. */
function reason(cause: unknown): string {
	const text = cause instanceof Error ? cause.message : 'Docker refused the operation';
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Remove the sandbox if the resources still match the preview token.
 * Containers are stopped with a grace period and removed without volumes. Then project
 * networks without other endpoints are removed. Every resource gets a result.
 */
export async function removeSandbox(
	docker: RemovalDocker,
	project: string,
	token: unknown
): Promise<RemovalResult[]> {
	validProject(project);
	if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) {
		throw new RemovalInputError('A preview token is required');
	}
	const release = reserveProjectRemoval(project);
	try {
		const preview = await previewSandboxRemoval(docker, project);
		if (preview.token !== token) {
			throw new RemovalStaleError('The sandbox changed after the preview. Review it again.');
		}
		const results: RemovalResult[] = await Promise.all(
			preview.containers.map(async (container): Promise<RemovalResult> => {
				try {
					if (container.state === 'running' || container.state === 'paused') {
						// A failed graceful stop falls through to the forced removal below.
						await docker.stopContainer(container.id, STOP_TIMEOUT_SECONDS).catch(() => {});
					}
					await docker.removeContainer(container.id);
					return { kind: 'container', name: container.name, result: 'removed' };
				} catch (cause) {
					return {
						kind: 'container',
						name: container.name,
						result: 'failed',
						reason: reason(cause)
					};
				}
			})
		);
		for (const network of preview.networks) {
			if (network.attached.length > 0) {
				const names = network.attached.join(', ');
				results.push({
					kind: 'network',
					name: network.name,
					result: 'kept',
					reason: `${names} attached`
				});
				continue;
			}
			try {
				await docker.removeNetwork(network.id);
				results.push({ kind: 'network', name: network.name, result: 'removed' });
			} catch (cause) {
				results.push({
					kind: 'network',
					name: network.name,
					result: 'failed',
					reason: reason(cause)
				});
			}
		}
		for (const volume of preview.volumes) {
			results.push({ kind: 'volume', name: volume, result: 'kept', reason: 'volumes are kept' });
		}
		return results;
	} finally {
		release();
	}
}

/** Adapt a dockerode client to the operations that removal needs. */
export function removalDocker(docker: {
	listContainers: RemovalDocker['listContainers'];
	listNetworks(
		options: object
	): Promise<{ Id: string; Name: string; Labels?: Record<string, string> }[]>;
	listVolumes(options: object): Promise<{ Volumes?: { Name: string }[] | null }>;
	getContainer(id: string): {
		stop(options: { t: number }): Promise<unknown>;
		remove(options: { force: boolean; v: boolean }): Promise<unknown>;
	};
	getNetwork(id: string): {
		inspect(): Promise<{ Containers?: Record<string, { Name?: string }> }>;
		remove(): Promise<unknown>;
	};
}): RemovalDocker {
	return {
		listContainers: (options) => docker.listContainers(options),
		listNetworks: (options) => docker.listNetworks(options),
		inspectNetwork: (id) => docker.getNetwork(id).inspect(),
		listVolumes: async (options) => (await docker.listVolumes(options)).Volumes ?? [],
		stopContainer: async (id, seconds) => {
			await docker.getContainer(id).stop({ t: seconds });
		},
		// v: false keeps anonymous volumes as well as named ones.
		removeContainer: async (id) => {
			await docker.getContainer(id).remove({ force: true, v: false });
		},
		removeNetwork: async (id) => {
			await docker.getNetwork(id).remove();
		}
	};
}
