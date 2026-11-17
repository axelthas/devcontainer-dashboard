/**
 * Docker network operations for devcontainers: list user-defined networks, connect a running
 * devcontainer, and disconnect it. The rules live in `$lib/networkRules`; this module
 * inspects live Docker state, runs the planned steps through the Docker API, and reports.
 *
 * The server calls the Docker API directly. Nothing runs `docker` or `sudo` in a container,
 * except the optional `hostname` command, which runs as root through `docker exec`.
 */
import docker from '$lib/server/docker';
import { buildNetworkData, containerNetworks } from '$lib/server/networkData';
import {
	addressProblem,
	DEFAULT_NETWORKS,
	NETWORK_NAME_PATTERN,
	planConnect,
	planDisconnect,
	stepCommand,
	type ConnectRequest,
	type NetworkChangeResult,
	type NetworkStep
} from '$lib/networkRules';
import type { NetworkData } from '$lib/types';

/** A request failure with an HTTP status and a message for the operator. */
export class NetworkRequestError extends Error {
	readonly status: 400 | 404 | 409 | 502 | 503;
	constructor(status: 400 | 404 | 409 | 502 | 503, message: string) {
		super(message);
		this.name = 'NetworkRequestError';
		this.status = status;
	}
}

/** Container IDs as the dashboard sends them: 12 to 64 lowercase hex characters. */
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/;
/** Upper bound for `hostname` in the container. */
const HOSTNAME_TIMEOUT_MS = 10_000;

let writes: Promise<unknown> = Promise.resolve();

/** Run network writes one at a time, so two requests cannot claim the same address. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
	const next = writes.then(work, work);
	writes = next.catch(() => undefined);
	return next;
}

/** List user-defined networks with every container on them. */
export async function listNetworkData(): Promise<NetworkData[]> {
	try {
		const [networks, containers] = await Promise.all([
			docker.listNetworks(),
			docker.listContainers({ all: true })
		]);
		return buildNetworkData(networks, containers);
	} catch {
		throw new NetworkRequestError(503, 'Could not read Docker networks. Check the Docker socket.');
	}
}

/** Inspect a devcontainer and refuse containers that the dashboard must not rewire. */
async function inspectDevcontainer(id: string) {
	if (!CONTAINER_ID_PATTERN.test(id)) throw new NetworkRequestError(400, 'Invalid container ID');
	let info;
	try {
		info = await docker.getContainer(id).inspect();
	} catch {
		throw new NetworkRequestError(
			404,
			'Container is missing or cannot be inspected. Refresh the dashboard.'
		);
	}
	if (!info.Config?.Labels?.['devcontainer.local_folder']) {
		throw new NetworkRequestError(400, 'Only devcontainers can change networks from the dashboard');
	}
	const mode = info.HostConfig?.NetworkMode ?? '';
	if (mode === 'host' || mode === 'none' || mode.startsWith('container:')) {
		throw new NetworkRequestError(409, `The container uses network mode ${mode}`);
	}
	return info;
}

/** Run the steps in order. Stop at the first failure and report what already changed. */
async function runSteps(id: string, name: string, steps: NetworkStep[]): Promise<string[]> {
	const completed: string[] = [];
	for (const step of steps) {
		const command = stepCommand(step, name);
		try {
			const network = docker.getNetwork(step.network);
			if (step.action === 'connect') {
				await network.connect({
					Container: id,
					EndpointConfig: {
						...(step.ip ? { IPAMConfig: { IPv4Address: step.ip } } : {}),
						...(step.alias ? { Aliases: [step.alias] } : {})
					}
				});
			} else {
				await network.disconnect({ Container: id, Force: false });
			}
			completed.push(command);
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message.slice(0, 300) : 'Unknown Docker error';
			const done = completed.length
				? ` Completed before the failure: ${completed.join('; ')}.`
				: ' Nothing changed.';
			throw new NetworkRequestError(
				502,
				`${command} failed: ${reason}.${done} Refresh the dashboard to see the current networks.`
			);
		}
	}
	return completed;
}

/**
 * Set the container hostname as root. This needs CAP_SYS_ADMIN, so a failure is reported
 * and never fails the connect: the network alias works without it.
 */
async function setContainerHostname(
	id: string,
	hostname: string
): Promise<NonNullable<NetworkChangeResult['hostname']>> {
	const unavailable = 'The network alias still works.';
	try {
		const exec = await docker.getContainer(id).exec({
			Cmd: ['hostname', hostname],
			User: '0',
			AttachStdout: true,
			AttachStderr: true
		});
		const stream = await exec.start({ hijack: true, stdin: false });
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				stream.destroy();
				resolve();
			}, HOSTNAME_TIMEOUT_MS);
			const finish = () => {
				clearTimeout(timer);
				resolve();
			};
			stream.on('end', finish);
			stream.on('close', finish);
			stream.on('error', finish);
			stream.resume();
		});
		const { ExitCode } = await exec.inspect();
		if (ExitCode === 0) return { status: 'set' };
		return {
			status: 'failed',
			message: `hostname exited with code ${ExitCode ?? 'unknown'}. The container may lack CAP_SYS_ADMIN. ${unavailable}`
		};
	} catch {
		return { status: 'failed', message: `Could not run hostname in the container. ${unavailable}` };
	}
}

/** Connect a running devcontainer to an existing network, as the request describes. */
export function connectContainerNetwork(
	id: string,
	request: ConnectRequest
): Promise<NetworkChangeResult> {
	return serialized(async () => {
		const info = await inspectDevcontainer(id);
		if (!info.State?.Running) {
			throw new NetworkRequestError(409, 'Start the container before you connect it to a network');
		}
		const network = (await listNetworkData()).find((entry) => entry.name === request.network);
		if (!network) {
			throw new NetworkRequestError(
				404,
				`Network ${request.network} does not exist. The dashboard does not create networks.`
			);
		}
		if (request.ip) {
			const problem = addressProblem(network, request.ip, info.Id);
			if (problem) throw new NetworkRequestError(409, `${request.ip}: ${problem}`);
		}
		const name = info.Name.replace(/^\//, '');
		const steps = planConnect(containerNetworks(info.NetworkSettings?.Networks), request);
		const completed = await runSteps(info.Id, name, steps);
		const hostname =
			request.setHostname && request.alias
				? await setContainerHostname(info.Id, request.alias)
				: undefined;
		const after = await docker.getContainer(info.Id).inspect();
		return {
			steps: completed,
			networks: containerNetworks(after.NetworkSettings?.Networks),
			...(hostname ? { hostname } : {})
		};
	});
}

/** Disconnect a devcontainer from a network. Leaving the last network connects bridge first. */
export function disconnectContainerNetwork(
	id: string,
	networkName: string
): Promise<NetworkChangeResult> {
	return serialized(async () => {
		if (!NETWORK_NAME_PATTERN.test(networkName) || DEFAULT_NETWORKS.has(networkName)) {
			throw new NetworkRequestError(400, 'The dashboard only disconnects user-defined networks');
		}
		const info = await inspectDevcontainer(id);
		const current = containerNetworks(info.NetworkSettings?.Networks);
		const steps = planDisconnect(current, networkName);
		if (steps.length === 0) {
			throw new NetworkRequestError(404, `The container is not connected to ${networkName}`);
		}
		const completed = await runSteps(info.Id, info.Name.replace(/^\//, ''), steps);
		const after = await docker.getContainer(info.Id).inspect();
		return { steps: completed, networks: containerNetworks(after.NetworkSettings?.Networks) };
	});
}
