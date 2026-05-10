import { basename } from 'node:path';
import docker from '$lib/server/docker';
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
		if (Object.keys(ports).length === 0) continue;

		const rawName = c.Names?.[0] ?? c.Id;
		const image = c.Image ?? '';
		const labels = c.Labels ?? {};
		const localWorkspacePath = labels['devcontainer.local_folder'] ?? undefined;
		const projectName = localWorkspacePath ? basename(localWorkspacePath) : cleanProjectName(rawName);

		containers.push({
			id: c.Id.substring(0, 12),
			name: rawName,
			projectName,
			state: c.State ?? 'unknown',
			isDevcontainer: isDevcontainer(rawName, image),
			ports,
			image,
			localWorkspacePath
		});
	}

	return { containers };
};
