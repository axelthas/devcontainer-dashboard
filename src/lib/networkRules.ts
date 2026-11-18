/**
 * Rules for connecting a devcontainer to an existing Docker network.
 *
 * The server enforces these rules and the browser uses the same functions to preview the
 * Docker calls. Every function is pure: no Docker, no DOM, no storage.
 *
 * Safety rules:
 * - Only existing user-defined networks. The dashboard never creates a network.
 * - Connect before disconnect, so a failed step never leaves the container without a network.
 * - Leaving the last network connects `bridge` first.
 * - An address held by a running container or by any devcontainer is refused.
 */
import type { ContainerNetwork, NetworkData, NetworkEndpoint, NetworkPreset } from '$lib/types';

/** Docker's built-in networks. They are never connect targets. */
export const DEFAULT_NETWORKS: ReadonlySet<string> = new Set(['bridge', 'host', 'none']);

/** Docker network names: an alphanumeric first character, then letters, digits, `_`, `.`, `-`. */
export const NETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** A DNS hostname in lowercase: labels of letters, digits, and hyphens, joined by dots. */
export const HOSTNAME_PATTERN =
	/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A validated connect request, as the browser sends it and the server accepts it. */
export interface ConnectRequest {
	network: string;
	/** Static IPv4 address. Omit to let Docker assign one. */
	ip?: string;
	/** Network alias; also the hostname when `setHostname` is true */
	alias?: string;
	/** Disconnect every other network after the connect succeeds */
	onlyNetwork: boolean;
	/** Run `hostname <alias>` as root in the container after the connect */
	setHostname: boolean;
}

/** One Docker API call of a plan. */
export interface NetworkStep {
	action: 'connect' | 'disconnect';
	network: string;
	ip?: string;
	alias?: string;
}

/** What the server reports after a network change. */
export interface NetworkChangeResult {
	/** The Docker calls that ran, as CLI equivalents, in order */
	steps: string[];
	/** The container's networks after the change */
	networks: ContainerNetwork[];
	/** Result of `hostname`, when it was requested */
	hostname?: { status: 'set' | 'failed'; message?: string };
}

/** A hostname and address that a sandbox node or a devcontainer can hold. */
export interface NetworkSeat {
	hostname: string;
	ip: string;
	/** The sandbox container that owns the seat. Missing for a seat from devcontainer.json. */
	node?: NetworkEndpoint;
	source: 'sandbox' | 'devcontainer.json';
}

export interface SeatStatus {
	free: boolean;
	text: string;
	holder?: NetworkEndpoint;
}

/** Parse dotted-quad IPv4 text without leading zeros. Return the 32-bit value, or null. */
export function parseIPv4(value: string): number | null {
	const parts = value.split('.');
	if (parts.length !== 4) return null;
	let result = 0;
	for (const part of parts) {
		if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		result = result * 256 + octet;
	}
	return result;
}

/** Parse an IPv4 CIDR subnet. Return the first and the last address, or null. */
export function parseSubnet(cidr: string): { first: number; last: number } | null {
	const parts = cidr.split('/');
	if (parts.length !== 2 || !/^\d{1,2}$/.test(parts[1])) return null;
	const bits = Number(parts[1]);
	const base = parseIPv4(parts[0]);
	if (base === null || bits > 32) return null;
	// Arithmetic instead of bit operators: JavaScript bit operators are signed 32-bit.
	const size = 2 ** (32 - bits);
	const first = Math.floor(base / size) * size;
	return { first, last: first + size - 1 };
}

/** True when two container IDs name the same container. Short IDs are prefixes of long IDs. */
export function sameContainer(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	return a.startsWith(b) || b.startsWith(a);
}

/**
 * Return the endpoint that blocks an address. A running container holds its address.
 * A devcontainer holds its address in any state, because it claims the address again on start.
 */
export function addressHolder(
	network: Pick<NetworkData, 'endpoints'>,
	ip: string,
	selfId?: string
): NetworkEndpoint | undefined {
	return network.endpoints.find(
		(endpoint) =>
			endpoint.ip === ip &&
			!sameContainer(endpoint.containerId, selfId) &&
			(endpoint.state === 'running' || endpoint.isDevcontainer)
	);
}

/** Return why a static address cannot be used on a network, or null when it can. */
export function addressProblem(
	network: Pick<NetworkData, 'subnet' | 'gateway' | 'endpoints'>,
	ip: string,
	selfId?: string
): string | null {
	const value = parseIPv4(ip);
	if (value === null) return 'Not an IPv4 address';
	const range = network.subnet ? parseSubnet(network.subnet) : null;
	if (!range) return 'This network has no IPv4 subnet, so it cannot take a static address';
	if (value < range.first || value > range.last) return `Outside ${network.subnet}`;
	// /31 and /32 networks have no network or broadcast address.
	if (range.last - range.first > 1 && (value === range.first || value === range.last))
		return 'Network or broadcast address';
	if (ip === network.gateway) return 'Gateway address';
	const holder = addressHolder(network, ip, selfId);
	if (holder)
		return `Held by ${holder.containerName}${holder.state === 'running' ? ' (running)' : ''}`;
	return null;
}

/** Seats of a network: sandbox containers with an address, then declared seats, by address. */
export function networkSeats(network: NetworkData, presets: NetworkPreset[] = []): NetworkSeat[] {
	const seats: NetworkSeat[] = network.endpoints
		.filter((endpoint) => !endpoint.isDevcontainer && endpoint.ip)
		.map((endpoint) => ({
			hostname: endpoint.hostname,
			ip: endpoint.ip,
			node: endpoint,
			source: 'sandbox' as const
		}));
	for (const preset of presets) {
		if (preset.network !== network.name) continue;
		for (const seat of preset.seats) {
			if (!seat.ip || seats.some((known) => known.ip === seat.ip)) continue;
			seats.push({ hostname: seat.hostname, ip: seat.ip, source: 'devcontainer.json' });
		}
	}
	return seats.sort((a, b) => (parseIPv4(a.ip) ?? 0) - (parseIPv4(b.ip) ?? 0));
}

/** What a seat does now, seen from the container `selfId` (which may keep its own seat). */
export function seatStatus(network: NetworkData, seat: NetworkSeat, selfId?: string): SeatStatus {
	const holder = addressHolder(network, seat.ip, selfId);
	if (holder) {
		return {
			free: false,
			holder,
			text: holder.isDevcontainer ? `${holder.containerName} standing in` : 'node running'
		};
	}
	const own = network.endpoints.some(
		(endpoint) => endpoint.ip === seat.ip && sameContainer(endpoint.containerId, selfId)
	);
	if (own) return { free: true, text: 'current address' };
	if (seat.node) return { free: true, text: 'node stopped' };
	return { free: true, text: 'declared in devcontainer.json' };
}

/** Read an optional string field; empty text counts as missing. */
function optionalText(value: unknown): string | undefined | null {
	if (value === undefined || value === null || value === '') return undefined;
	return typeof value === 'string' ? value : null;
}

/** Validate an untrusted request body. Return the request, or the first problem. */
export function parseConnectRequest(
	body: unknown
): { request: ConnectRequest } | { error: string } {
	if (!body || typeof body !== 'object' || Array.isArray(body))
		return { error: 'Expected a JSON object' };
	const fields = body as Record<string, unknown>;
	const network = fields.network;
	if (typeof network !== 'string' || !NETWORK_NAME_PATTERN.test(network))
		return { error: 'The network name is missing or invalid' };
	if (DEFAULT_NETWORKS.has(network))
		return { error: `The dashboard does not connect containers to ${network}` };
	const ip = optionalText(fields.ip);
	if (ip === null || (ip !== undefined && parseIPv4(ip) === null))
		return { error: 'The IP address must be IPv4 text, for example 172.20.0.10' };
	const alias = optionalText(fields.alias);
	if (alias === null || (alias !== undefined && !HOSTNAME_PATTERN.test(alias)))
		return { error: 'The alias must be a lowercase hostname' };
	for (const flag of ['onlyNetwork', 'setHostname'] as const) {
		if (fields[flag] !== undefined && typeof fields[flag] !== 'boolean')
			return { error: `${flag} must be true or false` };
	}
	if (fields.setHostname === true && !alias)
		return { error: 'Setting the hostname needs an alias' };
	return {
		request: {
			network,
			...(ip ? { ip } : {}),
			...(alias ? { alias } : {}),
			onlyNetwork: fields.onlyNetwork === true,
			setHostname: fields.setHostname === true
		}
	};
}

/**
 * Plan the Docker calls for a connect request. Connect first, then disconnect, so a failure
 * never strands the container. Docker cannot change an endpoint in place: a new address on
 * the same network disconnects and reconnects, with `bridge` as a temporary route when that
 * network is the only one.
 */
export function planConnect(current: ContainerNetwork[], request: ConnectRequest): NetworkStep[] {
	const names = current.map((network) => network.name);
	const sameNetwork = names.includes(request.network);
	const temporaryBridge = sameNetwork && names.length === 1 && !names.includes('bridge');
	const steps: NetworkStep[] = [];
	if (temporaryBridge) steps.push({ action: 'connect', network: 'bridge' });
	if (sameNetwork) steps.push({ action: 'disconnect', network: request.network });
	steps.push({
		action: 'connect',
		network: request.network,
		...(request.ip ? { ip: request.ip } : {}),
		...(request.alias ? { alias: request.alias } : {})
	});
	if (request.onlyNetwork) {
		for (const name of names) {
			if (name !== request.network) steps.push({ action: 'disconnect', network: name });
		}
	}
	if (temporaryBridge) steps.push({ action: 'disconnect', network: 'bridge' });
	return steps;
}

/** Plan a disconnect. Leaving the last network connects `bridge` first. */
export function planDisconnect(current: ContainerNetwork[], network: string): NetworkStep[] {
	if (!current.some((entry) => entry.name === network)) return [];
	const rest = current.filter((entry) => entry.name !== network);
	return [
		...(rest.length === 0 ? [{ action: 'connect' as const, network: 'bridge' }] : []),
		{ action: 'disconnect', network }
	];
}

/** The Docker CLI equivalent of one step, for previews and reports. */
export function stepCommand(step: NetworkStep, containerName: string): string {
	const name = containerName.replace(/^\//, '');
	if (step.action === 'disconnect') return `docker network disconnect ${step.network} ${name}`;
	const options = [
		...(step.ip ? [`--ip ${step.ip}`] : []),
		...(step.alias ? [`--alias ${step.alias}`] : [])
	];
	return ['docker network connect', ...options, step.network, name].join(' ');
}

/** The CLI equivalent of the optional hostname step. */
export function hostnameCommand(containerName: string, alias: string): string {
	return `docker exec -u 0 ${containerName.replace(/^\//, '')} hostname ${alias}`;
}

/** Non-default networks of a container: the ones the dashboard shows as connections. */
export function userNetworks(container: { networks?: ContainerNetwork[] }): ContainerNetwork[] {
	return (container.networks ?? []).filter((network) => !DEFAULT_NETWORKS.has(network.name));
}

/** Last octet of an address, for compact chips: `.101`. */
export function lastOctet(ip: string): string {
	return ip ? `.${ip.split('.').at(-1)}` : '';
}
