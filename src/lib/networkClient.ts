/** Browser requests for devcontainer network changes. Writes are never retried. */
import { requestJson } from '$lib/requests';
import {
	planDisconnect,
	stepCommand,
	type ConnectRequest,
	type NetworkChangeResult
} from '$lib/networkRules';
import type { ContainerData } from '$lib/types';

/** Connect a devcontainer as the request describes. */
export function connectNetwork(containerId: string, request: ConnectRequest) {
	return requestJson<NetworkChangeResult>(
		`/api/containers/${encodeURIComponent(containerId)}/networks`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request)
		}
	);
}

/** Disconnect a devcontainer from one network. */
export function disconnectNetwork(containerId: string, network: string) {
	return requestJson<NetworkChangeResult>(
		`/api/containers/${encodeURIComponent(containerId)}/networks/${encodeURIComponent(network)}`,
		{ method: 'DELETE' }
	);
}

/** The confirmation text for a disconnect: what drops, and the exact Docker calls. */
export function disconnectQuestion(container: ContainerData, network: string): string {
	const steps = planDisconnect(container.networks ?? [], network).map((step) =>
		stepCommand(step, container.name)
	);
	return [
		`Disconnect ${container.name.replace(/^\//, '')} from ${network}?`,
		'Open sessions to nodes on this network drop.',
		'',
		...steps
	].join('\n');
}
