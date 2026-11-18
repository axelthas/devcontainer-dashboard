/**
 * Browser-only launch of a container web service. Service chips and the Services menu
 * use this function, so both open the same viewer identity.
 */
import { serviceViewerHref } from '$lib/serviceTargets';

export interface ServiceLaunchTarget {
	containerPort: string;
	hostPort: string;
	label: string;
	containerName?: string;
	projectName?: string;
	workspacePath?: string;
	allPorts?: Record<string, string>;
	containerId?: string;
	serviceProxyEnabled?: boolean;
}

/** Open one service in a new window. Call it synchronously from a click handler. */
export function openContainerService(target: ServiceLaunchTarget): void {
	const {
		containerPort,
		hostPort,
		label,
		containerName,
		projectName,
		workspacePath,
		allPorts,
		containerId,
		serviceProxyEnabled
	} = target;
	// Gateway mode: launch by validated container identity so the viewer can verify the target.
	if (serviceProxyEnabled && containerId) {
		window.open(
			serviceViewerHref({
				containerId,
				containerPort,
				label,
				...(projectName ? { projectName } : {}),
				...(containerName ? { containerName } : {}),
				...(workspacePath ? { workspacePath } : {}),
				...(allPorts && Object.keys(allPorts).length > 1 ? { allPorts } : {})
			}),
			'_blank'
		);
		return;
	}
	// Legacy mode: raw URL, with metadata params for named containers.
	const serviceHostname = window.location.hostname;
	const serviceUrl = `http://${serviceHostname}:${hostPort}`;
	if (containerName || projectName) {
		const params = new URLSearchParams({
			url: serviceUrl,
			label,
			...(projectName ? { project: projectName } : {}),
			...(containerName ? { container: containerName } : {}),
			...(workspacePath ? { path: workspacePath } : {}),
			...(allPorts && Object.keys(allPorts).length > 1
				? { ports: JSON.stringify(allPorts), hostname: serviceHostname }
				: {})
		});
		window.open(`/service?${params}`, '_blank');
	} else {
		window.open(serviceUrl, '_blank');
	}
}
