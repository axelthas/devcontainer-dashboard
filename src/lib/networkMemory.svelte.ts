/**
 * Network connections that this browser remembers per devcontainer identity (workspace
 * folder and configuration file). A rebuild makes a new container with a new ID and
 * without these networks; the row then offers Reconnect. Nothing reconnects by itself,
 * because a sandbox node may hold the address again.
 */
import type { ContainerData } from '$lib/types';
import { HOSTNAME_PATTERN, NETWORK_NAME_PATTERN, parseIPv4 } from '$lib/networkRules';

export interface SavedConnection {
	network: string;
	ip?: string;
	alias?: string;
	setHostname: boolean;
	/** ID of the container that had the connection */
	containerId: string;
}

type Identity = Pick<ContainerData, 'id' | 'localWorkspacePath' | 'devcontainerConfigFile'>;

const STORAGE_KEY = 'devcontainer-dashboard-network-memory';
const MAX_IDENTITIES = 50;

/** The stable identity of a devcontainer across rebuilds, or null when a label is missing. */
export function connectionIdentity(container: Identity): string | null {
	const { localWorkspacePath, devcontainerConfigFile } = container;
	return localWorkspacePath && devcontainerConfigFile
		? `${localWorkspacePath}\n${devcontainerConfigFile}`
		: null;
}

/** True for a well-formed saved connection. Storage is user-editable, so check every field. */
function validConnection(entry: unknown): entry is SavedConnection {
	if (!entry || typeof entry !== 'object') return false;
	const fields = entry as Record<string, unknown>;
	if (typeof fields.network !== 'string' || !NETWORK_NAME_PATTERN.test(fields.network))
		return false;
	if (typeof fields.containerId !== 'string' || typeof fields.setHostname !== 'boolean')
		return false;
	if (fields.ip !== undefined && (typeof fields.ip !== 'string' || parseIPv4(fields.ip) === null))
		return false;
	return (
		fields.alias === undefined ||
		(typeof fields.alias === 'string' && HOSTNAME_PATTERN.test(fields.alias))
	);
}

/** Keep only well-formed saved connections from storage. */
function sanitize(value: unknown): Record<string, SavedConnection[]> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const result: Record<string, SavedConnection[]> = {};
	for (const [key, list] of Object.entries(value).slice(-MAX_IDENTITIES)) {
		const kept = Array.isArray(list) ? list.filter(validConnection) : [];
		if (kept.length) result[key] = kept;
	}
	return result;
}

export class NetworkMemory {
	entries = $state<Record<string, SavedConnection[]>>({});

	/** Read storage once in the browser. Call from an effect, never during render. */
	load(): void {
		try {
			this.entries = sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'));
		} catch {
			this.entries = {};
		}
	}

	#save(): void {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
		} catch {
			// Storage can be full or blocked; reconnect offers are a convenience.
		}
	}

	/** Remember a connection for this container, replacing an earlier one on the same network. */
	remember(container: Identity, connection: Omit<SavedConnection, 'containerId'>): void {
		const key = connectionIdentity(container);
		if (!key) return;
		const rest = (this.entries[key] ?? []).filter((entry) => entry.network !== connection.network);
		const saved = { ...connection, containerId: container.id };
		this.entries = { ...this.entries, [key]: [...rest, saved] };
		this.#save();
	}

	/** Forget the connection to one network. */
	forget(container: Identity, network: string): void {
		const key = connectionIdentity(container);
		if (!key || !this.entries[key]) return;
		const rest = this.entries[key].filter((entry) => entry.network !== network);
		const next = { ...this.entries };
		if (rest.length) next[key] = rest;
		else delete next[key];
		this.entries = next;
		this.#save();
	}

	/**
	 * Connections that a rebuilt container lost: saved for another container ID, and not
	 * attached now. A container that lost a network for another reason gets no offer.
	 */
	pending(container: Identity & Pick<ContainerData, 'networks'>): SavedConnection[] {
		const key = connectionIdentity(container);
		if (!key) return [];
		const attached = (container.networks ?? []).map((network) => network.name);
		return (this.entries[key] ?? []).filter(
			(entry) => entry.containerId !== container.id && !attached.includes(entry.network)
		);
	}
}

/** One memory per browser tab, shared by every row. */
export const networkMemory = new NetworkMemory();
