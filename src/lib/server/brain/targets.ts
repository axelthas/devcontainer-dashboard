/**
 * Resolve what a grant would allow from live Docker state: the container run, the user that
 * commands run as, the default directory, and what the container reaches. The user follows
 * the "Open with" terminal: the devcontainer remote user, else the image user.
 */
import docker from '$lib/server/docker';
import { resolveRemoteUser } from '$lib/server/devcontainerMetadata';
import { resolveContainerWorkspaceFolder } from '$lib/server/workspaces';
import type { BrainTargetPreview } from '$lib/brainTypes';
import { BrainAccessError, type BrainGrantTarget } from './access.js';
import { analyzeExposure } from './exposure.js';

const CONTAINER_ID = /^[a-f0-9]{12,64}$/;

export interface InspectedTarget {
	preview: BrainTargetPreview;
	target: BrainGrantTarget;
}

/** Inspect one running container. Refuse when its user cannot be resolved safely. */
export async function inspectBrainTarget(id: string): Promise<InspectedTarget> {
	if (!CONTAINER_ID.test(id)) throw new BrainAccessError('Invalid container ID', 400);
	let info;
	try {
		info = await docker.getContainer(id).inspect();
	} catch {
		throw new BrainAccessError(
			'Container is missing or cannot be inspected. Refresh the dashboard.',
			404
		);
	}
	if (!info.State?.Running)
		throw new BrainAccessError('Start the container before granting access.', 409);
	const labels = info.Config?.Labels ?? {};
	const remote = resolveRemoteUser(labels);
	if (remote.remoteUserError)
		throw new BrainAccessError(`Cannot resolve the user: ${remote.remoteUserError}`, 409);
	const imageUser = info.Config?.User || undefined;
	const execUser = remote.remoteUser ?? imageUser;
	const user = execUser ?? 'root';
	const userSource = remote.remoteUserSource
		? `${remote.remoteUserSource} in the devcontainer metadata`
		: imageUser
			? 'the image user'
			: 'the container default';
	const localFolder = labels['devcontainer.local_folder'] || undefined;
	const workdir =
		(localFolder ? resolveContainerWorkspaceFolder(info.Mounts, localFolder) : undefined) ??
		(info.Config?.WorkingDir || undefined);
	const target: BrainGrantTarget = {
		containerId: info.Id,
		containerName: info.Name.replace(/^\//, ''),
		kind: localFolder || labels['devcontainer.config_file'] ? 'devcontainer' : 'service',
		startedAt: info.State.StartedAt,
		execUser,
		user,
		userSource,
		workdir,
		composeProject: labels['com.docker.compose.project'] || undefined,
		composeService: labels['com.docker.compose.service'] || undefined,
		localFolder,
		exposure: analyzeExposure(info, user)
	};
	return { target, preview: previewOf(target) };
}

/** The reviewed fields, without the internal exec user value. */
function previewOf(target: BrainGrantTarget): BrainTargetPreview {
	return {
		containerId: target.containerId.slice(0, 12),
		containerName: target.containerName,
		kind: target.kind,
		startedAt: target.startedAt,
		user: target.user,
		userSource: target.userSource,
		workdir: target.workdir,
		composeProject: target.composeProject,
		composeService: target.composeService,
		localFolder: target.localFolder,
		exposure: target.exposure
	};
}
