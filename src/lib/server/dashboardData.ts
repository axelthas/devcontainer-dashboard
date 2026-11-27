/**
 * Dashboard data for the first render of the desktop page and the mobile interface.
 * Both interfaces read the same Docker, workspace and service-gateway state; only their
 * pages differ. Later updates come from the polling API routes.
 */
import { basename } from 'node:path';
import { hostname } from 'node:os';
import docker from './docker';
import {
	loadMergedWorkspaces,
	resolveContainerWorkspaceFolder,
	WORKSPACE_ROOT
} from './workspaces';
import { resolveNetworkPresets, resolveRemoteUser } from './devcontainerMetadata';
import { containerNetworks } from './networkData';
import { publishedBindings } from './publishedBindings';
import { isServiceProxyEnabled, resolveServicePorts } from './serviceGatewayRuntime';
import { isImageTag, SANDBOX_TAG_LABEL } from '$lib/imageReference';
import type { ContainerData, ServiceAccess, ServicePortPolicy } from '$lib/types';

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

/** The effective web-port policy; a malformed SERVICE_PROXY_PORTS hides web actions, not the page. */
function portPolicy(): ServicePortPolicy {
	try {
		return resolveServicePorts();
	} catch (error) {
		console.error('[services]', error instanceof Error ? error.message : 'Invalid port policy');
		return {};
	}
}

/** Read containers, workspaces, and service settings for one page render. */
export async function loadDashboardData() {
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
		const sandboxTag = labels[SANDBOX_TAG_LABEL];
		// Instance labels count only when they name this container's own project.
		const slotText = labels['devcontainer-dashboard.slot'];
		const composeInstanceSlot =
			composeProject &&
			labels['devcontainer-dashboard.instance'] === composeProject &&
			/^\d{1,3}$/.test(slotText ?? '')
				? Number(slotText)
				: undefined;
		const kindText = labels['devcontainer-dashboard.kind'];
		const composeKind = /^[a-z0-9][a-z0-9-]{0,63}$/.test(kindText ?? '') ? kindText : undefined;
		const presenterText = labels['devcontainer-dashboard.presenter'];
		const composePresenter = (['generic', 'web', 'database', 'profile'] as const).find(
			(item) => item === presenterText
		);

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
			portBindings: publishedBindings(c.Ports, inspectMap.get(c.Id)?.HostConfig?.PortBindings),
			image,
			localWorkspacePath,
			devcontainerConfigFile: labels['devcontainer.config_file'] ?? undefined,
			containerWorkspaceFolder: localWorkspacePath
				? resolveContainerWorkspaceFolder(c.Mounts, localWorkspacePath)
				: undefined,
			...resolveRemoteUser(labels),
			composeProject,
			composeService: labels['com.docker.compose.service'] ?? undefined,
			composeWorkingDir: labels['com.docker.compose.project.working_dir'] || undefined,
			sandboxTag: isImageTag(sandboxTag) ? sandboxTag : undefined,
			...(composeInstanceSlot !== undefined ? { composeInstanceSlot } : {}),
			...(composeKind ? { composeKind } : {}),
			...(composePresenter ? { composePresenter } : {}),
			networks: containerNetworks(c.NetworkSettings?.Networks),
			networkPresets: resolveNetworkPresets(labels)
		});
	}

	const raw = process.env.HOST_HOSTNAME ?? hostname();
	const hostName = raw.split('.')[0];
	const vscodeSshHost = process.env.VSCODE_SSH_HOST ?? '';

	const workspaces = await loadMergedWorkspaces();
	// Tailscale origins also serve OpenChamber on 3000; an explicit --gateway-ports value wins.
	const tailscale = Boolean(process.env.TAILSCALE_SOCKET);
	const servicePorts: ServicePortPolicy = {
		...(tailscale ? { '3000': 'http' } : {}),
		...portPolicy()
	};
	const serviceAccess: ServiceAccess = tailscale
		? 'https'
		: isServiceProxyEnabled()
			? 'gateway'
			: 'direct';

	return {
		containers,
		hostname: hostName,
		workspaces,
		workspaceRoot: WORKSPACE_ROOT,
		vscodeSshHost,
		serviceProxyEnabled: isServiceProxyEnabled(),
		servicePorts,
		serviceAccess
	};
}
