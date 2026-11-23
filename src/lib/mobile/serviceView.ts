/**
 * In-app service viewer of the phone interface. A container web service opens as a
 * DevHarbour screen (`/mobile/services/view`), never as a new window. The query is the
 * query of the desktop viewer, so both share the server contract and its validation.
 */
import type { ServiceLaunchTarget } from '$lib/serviceLaunch';
import { serviceViewerHref } from '$lib/serviceTargets';

/** The route of the phone viewer. */
export const MOBILE_SERVICE_PATH = '/mobile/services/view';

/** Query key of the container ID in legacy links; see `mobileServiceHref`. */
export const CONTAINER_REF = 'cref';

/** At most this many services stay loaded in the viewer; the least recent one goes first. */
export const MAX_LOADED_SERVICES = 3;

/**
 * The phone viewer href for a service. Gateway mode identifies the service by container
 * and port; legacy mode passes the raw host-port URL, as the desktop launch does.
 */
export function mobileServiceHref(
	target: ServiceLaunchTarget,
	hostname: string
): `/mobile/services/view?${string}` {
	const { containerPort, hostPort, label, containerName, projectName, workspacePath } = target;
	if (target.serviceProxyEnabled && target.containerId) {
		const desktop = serviceViewerHref({
			containerId: target.containerId,
			containerPort,
			label,
			...(projectName ? { projectName } : {}),
			...(containerName ? { containerName } : {}),
			...(workspacePath ? { workspacePath } : {}),
			...(target.allPorts ? { allPorts: target.allPorts } : {})
		});
		return `${MOBILE_SERVICE_PATH}?${desktop.slice(desktop.indexOf('?') + 1)}`;
	}
	const search = new URLSearchParams({ url: `http://${hostname}:${hostPort}`, label });
	if (projectName) search.set('project', projectName);
	if (containerName) search.set('container', containerName);
	if (workspacePath) search.set('path', workspacePath);
	// `cid` would select the gateway path on the server. The phone screen reads `cref` and
	// `port` only to find the container and its other services; the server ignores them.
	if (target.containerId) search.set(CONTAINER_REF, target.containerId);
	search.set('port', containerPort);
	return `${MOBILE_SERVICE_PATH}?${search.toString()}`;
}

/** One service page that the viewer keeps loaded. */
export interface LoadedService {
	/** Stable identity: container and port, or the target URL without them */
	id: string;
	src: string;
	title: string;
	/** Increase to load the page again */
	generation: number;
	/** Order of the last use; the lowest one is unloaded first */
	used: number;
}

/**
 * Show `next`: keep it loaded, mark it as the most recent, and unload the least recent
 * services above `limit`. The list order never changes, because moving an iframe in the
 * document loads its page again. A known service keeps its page unless its address changed.
 */
export function keepLoaded(
	loaded: LoadedService[],
	next: Pick<LoadedService, 'id' | 'src' | 'title'>,
	limit = MAX_LOADED_SERVICES
): LoadedService[] {
	const used = Math.max(0, ...loaded.map((entry) => entry.used)) + 1;
	const known = loaded.find((entry) => entry.id === next.id);
	let result = known
		? loaded.map((entry) =>
				entry.id !== next.id
					? entry
					: {
							...entry,
							...next,
							generation: entry.src === next.src ? entry.generation : entry.generation + 1,
							used
						}
			)
		: [...loaded, { ...next, generation: 0, used }];
	while (result.length > Math.max(1, limit)) {
		const oldest = result.reduce((low, entry) => (entry.used < low.used ? entry : low));
		result = result.filter((entry) => entry !== oldest);
	}
	return result;
}

/** Load one service page again, for Reload. */
export function reloadLoaded(loaded: LoadedService[], id: string): LoadedService[] {
	return loaded.map((entry) =>
		entry.id === id ? { ...entry, generation: entry.generation + 1 } : entry
	);
}
