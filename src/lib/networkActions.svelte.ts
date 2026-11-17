/**
 * Network disconnect and reconnect for one devcontainer, shared by its row chips and its
 * ⋯ menu. Connect with choices goes through the network drawer instead.
 */
import type { ContainerData } from '$lib/types';
import type { ConnectRequest } from '$lib/networkRules';
import { connectNetwork, disconnectNetwork, disconnectQuestion } from '$lib/networkClient';
import { networkMemory, type SavedConnection } from '$lib/networkMemory.svelte';
import { errorMessage, RequestError } from '$lib/requests';

export interface NetworkActionOptions {
	container: ContainerData;
	onRefresh: () => Promise<void>;
	/** Open the network drawer, for example when a saved address is taken */
	onConnectNetwork?: (container: ContainerData, network?: string, seatIp?: string) => void;
}

export class NetworkActions {
	/** Network that a request is changing now, or empty */
	working = $state('');
	failure = $state('');
	readonly #options: () => NetworkActionOptions;

	/** Read options through a getter, so component props stay reactive. */
	constructor(options: () => NetworkActionOptions) {
		this.#options = options;
	}

	/** Refresh after a change; a failed refresh does not hide that the change happened. */
	async #refresh(): Promise<void> {
		try {
			await this.#options().onRefresh();
		} catch (cause) {
			this.failure = `The network changed, but the status may be outdated. ${errorMessage(cause)}`;
		}
	}

	/** Ask first, then disconnect. The question lists the exact Docker calls. */
	async disconnect(network: string): Promise<void> {
		const { container } = this.#options();
		if (this.working || !confirm(disconnectQuestion(container, network))) return;
		this.working = network;
		this.failure = '';
		try {
			await disconnectNetwork(container.id, network);
			networkMemory.forget(container, network);
			await this.#refresh();
		} catch (cause) {
			this.failure = errorMessage(cause);
		} finally {
			this.working = '';
		}
	}

	/**
	 * Reconnect a rebuilt container with its saved address and alias. A conflict (409) needs a
	 * choice, so the drawer opens on that network instead of a retry.
	 */
	async reconnect(saved: SavedConnection): Promise<void> {
		const { container, onConnectNetwork } = this.#options();
		if (this.working) return;
		const request: ConnectRequest = {
			network: saved.network,
			...(saved.ip ? { ip: saved.ip } : {}),
			...(saved.alias ? { alias: saved.alias } : {}),
			onlyNetwork: false,
			setHostname: saved.setHostname && Boolean(saved.alias)
		};
		this.working = saved.network;
		this.failure = '';
		try {
			await connectNetwork(container.id, request);
			const { network, ip, alias, setHostname } = saved;
			networkMemory.remember(container, { network, ip, alias, setHostname });
			await this.#refresh();
		} catch (cause) {
			this.failure = errorMessage(cause);
			if (cause instanceof RequestError && cause.status === 409)
				onConnectNetwork?.(container, saved.network);
		} finally {
			this.working = '';
		}
	}
}
