import { basename } from 'node:path';
import { hostname } from 'node:os';
import docker from '$lib/server/docker';
import { loadMergedWorkspaces, WORKSPACE_ROOT } from '$lib/server/workspaces';
import type { ContainerData } from '$lib/types';
import type { PageServerLoad } from './$types';

function cleanProjectName(rawName: string): string {
	return rawName
		.replace(/^\//, '')
		.replace(/^vsc-/, '')
		.replace(/-features-uid$/, '')
		.replace(/-uid$/, '')
		.replace(/-features$/, '')
		.replace(/-[a-f0-9]{64}$/, '');
}

function isDevcontainer(name: string, image: string): boolean {
	const lower = (name + ' ' + image).toLowerCase();
	return lower.includes('vsc-') || lower.includes('devcontainer') || lower.includes('-features');
}

export const load: PageServerLoad = async () => {
	const rawContainers = await docker.listContainers({ all: true });

	// For stopped containers, listContainers returns an empty Ports array.
	// Fetch HostConfig.PortBindings via inspect to get the configured port bindings.
	const inspectResults = await Promise.all(
		rawContainers
			.filter((c) => c.State !== 'running')
			.map((c) => docker.getContainer(c.Id).inspect())
	);
	const inspectMap = new Map(inspectResults.map((info) => [info.Id, info]));

	const containers: ContainerData[] = [];

	for (const c of rawContainers) {
		const ports: Record<string, string> = {};
		if (c.Ports) {
			for (const p of c.Ports) {
				if (p.PublicPort && p.PrivatePort) {
					ports[String(p.PrivatePort)] = String(p.PublicPort);
				}
			}
		}

		// Fallback for stopped containers: read configured bindings from inspect
		if (Object.keys(ports).length === 0 && c.State !== 'running') {
			const info = inspectMap.get(c.Id);
			const bindings = (info?.HostConfig?.PortBindings ?? {}) as Record<
				string,
				Array<{ HostPort?: string }> | null
			>;
			for (const [portProto, hostBindings] of Object.entries(bindings)) {
				const containerPort = portProto.split('/')[0];
				if (!containerPort) continue;
				const hostPort = hostBindings?.[0]?.HostPort;
				ports[containerPort] = hostPort || containerPort;
			}
		}

		const rawName = c.Names?.[0] ?? c.Id;
		const image = c.Image ?? '';
		const labels = c.Labels ?? {};
		const composeProject = labels['com.docker.compose.project'] ?? undefined;

		// Exclude containers with no exposed ports, unless they belong to a compose project
		if (Object.keys(ports).length === 0 && !composeProject) continue;

		const localWorkspacePath = labels['devcontainer.local_folder'] ?? undefined;
		const projectName = localWorkspacePath
			? basename(localWorkspacePath)
			: cleanProjectName(rawName);

		containers.push({
			id: c.Id.substring(0, 12),
			name: rawName,
			projectName,
			state: c.State ?? 'unknown',
			isDevcontainer: isDevcontainer(rawName, image),
			ports,
			image,
			localWorkspacePath,
			composeProject
		});
	}

	const raw = process.env.HOST_HOSTNAME ?? hostname();
	const hostName = raw.split('.')[0];
	const vscodeSshHost = process.env.VSCODE_SSH_HOST ?? '';

	const workspaces = await loadMergedWorkspaces();

	return {
		containers,
		hostname: hostName,
		workspaces,
		workspaceRoot: WORKSPACE_ROOT,
		vscodeSshHost
	};
};
