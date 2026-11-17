/**
 * Effective remote user of a devcontainer, read from its `devcontainer.metadata` label.
 * The Dev Containers CLI writes this label when it creates the container. The label lists
 * the image metadata, the Features, and devcontainer.json in that order; a later entry
 * overrides an earlier one. This is the same user that VS Code uses for the container.
 */
import type { ContainerData, NetworkPreset } from '$lib/types';
import {
	DEFAULT_NETWORKS,
	HOSTNAME_PATTERN,
	NETWORK_NAME_PATTERN,
	parseIPv4
} from '$lib/networkRules';

/** A plain user name or numeric id, with an optional group: `vscode`, `1000`, `1000:1000`. */
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})?$/;

export type RemoteUserFields = Pick<
	ContainerData,
	'remoteUser' | 'remoteUserSource' | 'remoteUserError'
>;

/** Accept only values that `docker exec --user` takes literally. */
function plainUser(value: unknown): value is string {
	return typeof value === 'string' && USER_PATTERN.test(value);
}

/** Resolve localEnv tokens once as literal text, without shell expansion or value logging. */
function resolveUser(
	property: 'remoteUser' | 'containerUser',
	value: unknown,
	env: Record<string, string | undefined>
): RemoteUserFields {
	if (typeof value !== 'string') {
		return { remoteUserError: `${property} in the devcontainer metadata must be a string` };
	}
	let missing: string | undefined;
	const resolved = value.replace(
		/\$\{localEnv:([^:{}]+)(?::([^{}]*))?\}/g,
		(_token, name: string, fallback: string | undefined) => {
			const replacement = Object.hasOwn(env, name) ? env[name] : undefined;
			if (replacement !== undefined) return replacement;
			if (fallback !== undefined) return fallback;
			missing ??= name;
			return '';
		}
	);
	if (missing) {
		return {
			remoteUserError: `${property}: localEnv variable ${missing} is not set in the dashboard environment`
		};
	}
	if (!plainUser(resolved)) {
		return {
			remoteUserError: `${property} in the devcontainer metadata does not resolve to a plain user name`
		};
	}
	return { remoteUser: resolved, remoteUserSource: property };
}

/**
 * Return the last `remoteUser`, else the last `containerUser`. Return no user when the
 * container has no metadata label: the container's default user then applies.
 * Resolve `${localEnv:VAR}` from the dashboard environment before validating the user.
 * An unset variable can supply `${localEnv:VAR:default}`. Missing or invalid values
 * return an error so callers never run as another user. Substituted values are not
 * expanded again and are never included in error messages.
 */
export function resolveRemoteUser(
	labels: Record<string, string> | undefined,
	env: Record<string, string | undefined> = process.env
): RemoteUserFields {
	const raw = labels?.['devcontainer.metadata'];
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { remoteUserError: 'The devcontainer metadata label is not valid JSON' };
	}
	let remoteUser: unknown;
	let containerUser: unknown;
	for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
		if (!entry || typeof entry !== 'object') continue;
		const record = entry as Record<string, unknown>;
		if (record.remoteUser !== undefined) remoteUser = record.remoteUser;
		if (record.containerUser !== undefined) containerUser = record.containerUser;
	}
	if (remoteUser !== undefined) return resolveUser('remoteUser', remoteUser, env);
	if (containerUser !== undefined) return resolveUser('containerUser', containerUser, env);
	return {};
}

/** Bounds for declared networks, so a large label cannot flood the dashboard. */
const MAX_PRESET_NETWORKS = 20;
const MAX_PRESET_SEATS = 100;

/** Return the value as a plain object, or undefined. */
function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Keep one declared seat when its hostname and optional address are valid. */
function presetSeat(value: unknown): NetworkPreset['seats'] {
	const seat = objectValue(value);
	const hostname = seat?.hostname;
	const ip = seat?.ip;
	if (typeof hostname !== 'string' || !HOSTNAME_PATTERN.test(hostname)) return [];
	if (ip !== undefined && (typeof ip !== 'string' || parseIPv4(ip) === null)) return [];
	return [{ hostname, ...(ip ? { ip } : {}) }];
}

/**
 * Return the networks and seats that devcontainer.json declares under
 * `customizations["devcontainer-dashboard"].networks`, read from the metadata label.
 * A later metadata entry replaces an earlier declaration of the same network.
 * Invalid networks and seats are skipped; default networks are never declared.
 */
export function resolveNetworkPresets(labels: Record<string, string> | undefined): NetworkPreset[] {
	const raw = labels?.['devcontainer.metadata'];
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const byNetwork = new Map<string, NetworkPreset>();
	for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
		const customizations = objectValue(objectValue(entry)?.customizations);
		const networks = objectValue(customizations?.['devcontainer-dashboard'])?.networks;
		if (!Array.isArray(networks)) continue;
		for (const item of networks) {
			const fields = objectValue(item);
			if (!fields) continue;
			const network = fields.network;
			if (typeof network !== 'string' || !NETWORK_NAME_PATTERN.test(network)) continue;
			if (DEFAULT_NETWORKS.has(network)) continue;
			const seats = (Array.isArray(fields.seats) ? fields.seats : [])
				.flatMap(presetSeat)
				.slice(0, MAX_PRESET_SEATS);
			// Delete first, so the latest declaration also takes the latest position.
			byNetwork.delete(network);
			byNetwork.set(network, { network, seats });
		}
	}
	return [...byNetwork.values()].slice(-MAX_PRESET_NETWORKS);
}
