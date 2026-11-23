/**
 * State of the mobile interface: one instance per mobile layout, shared by every screen
 * through context. It reads the same API routes as the desktop page and applies the same
 * rules; only the presentation differs. Screens never poll on their own.
 */
import { getContext, setContext } from 'svelte';
import { resolve } from '$app/paths';
import { SvelteMap } from 'svelte/reactivity';
import { errorMessage, latestRequest, requestJson } from '$lib/requests';
import { generateId } from '$lib/index';
import type { TerminalStart } from '$lib/terminalCreation';
import type {
	ContainerData,
	LocalWorkspaceData,
	NetworkData,
	RepositoryData,
	ServiceAccess,
	ServicePortPolicy,
	TerminalSession
} from '$lib/types';

/** Data that the mobile layout's server load provides for the first render. */
export interface MobileInitialData {
	containers: ContainerData[];
	hostname: string;
	workspaces: LocalWorkspaceData[];
	workspaceRoot: string;
	vscodeSshHost: string;
	serviceProxyEnabled: boolean;
	servicePorts: ServicePortPolicy;
	serviceAccess: ServiceAccess;
}

/** One Compose project and its containers, as the Services tab lists them. */
export interface ComposeStack {
	name: string;
	containers: ContainerData[];
	running: number;
}

/** Storage keys shared with the desktop page, so both interfaces keep one preference. */
export const THEME_KEY = 'devcontainer-dashboard-theme';
export const SSH_HOST_KEY = 'devcontainer-dashboard-vscode-ssh-host';

const POLL_MS = 5000;
const ACTIVE_POLL_MS = 3000;
const TOAST_MS = 2600;
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** A URL-safe key for a workspace; workspace IDs are base64 of the path. */
export function workspaceKey(workspace: Pick<LocalWorkspaceData, 'id'>): string {
	return workspace.id.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Running containers first, then by project name. */
function byStateThenName(a: ContainerData, b: ContainerData): number {
	const running = Number(b.state === 'running') - Number(a.state === 'running');
	return running || a.projectName.localeCompare(b.projectName);
}

export class MobileDashboard {
	containers = $state<ContainerData[]>([]);
	workspaces = $state<LocalWorkspaceData[]>([]);
	networks = $state<NetworkData[]>([]);
	networkError = $state('');
	sessions = $state<TerminalSession[]>([]);
	containerError = $state('');
	workspaceError = $state('');
	terminalError = $state('');
	/** Clock time of the last successful container read; empty until the first poll answers. */
	lastContainerRead = $state('');
	toastMessage = $state('');
	hostSheetOpen = $state(false);
	newShellOpen = $state(false);
	/** Filters and searches of the list screens, kept while the operator drills down. */
	ui = $state<Record<string, string>>({});
	light = $state(false);
	vscodeSshHost = $state('');
	readonly hostname: string;
	readonly workspaceRoot: string;
	readonly serviceProxyEnabled: boolean;
	readonly servicePorts: ServicePortPolicy;
	readonly serviceAccess: ServiceAccess;
	/** Explicit starts for terminals that this phone opened; the terminal screen sends them once. */
	readonly starts = new SvelteMap<string, TerminalStart>();

	readonly devcontainers = $derived(
		this.containers.filter((c) => c.isDevcontainer).sort(byStateThenName)
	);
	readonly services = $derived(this.containers.filter((c) => !c.isDevcontainer));
	readonly stacks = $derived.by<ComposeStack[]>(() => {
		const groups: Record<string, ContainerData[]> = {};
		for (const container of this.services) {
			if (!container.composeProject) continue;
			(groups[container.composeProject] ??= []).push(container);
		}
		return Object.entries(groups)
			.map(([name, containers]) => ({
				name,
				containers: containers.sort(byStateThenName),
				running: containers.filter((c) => c.state === 'running').length
			}))
			.sort((a, b) => b.running - a.running || a.name.localeCompare(b.name));
	});
	readonly standalone = $derived(
		this.services.filter((c) => !c.composeProject).sort(byStateThenName)
	);
	readonly runningCount = $derived(this.containers.filter((c) => c.state === 'running').length);
	readonly stoppedCount = $derived(this.containers.length - this.runningCount);
	/** Workspaces poll faster while a bootstrap run, build, or Compose run is active. */
	readonly workspacesActive = $derived(
		this.workspaces.some(
			(w) =>
				w.buildSession?.status === 'running' ||
				w.repos.some(
					(r) => r.buildSession?.status === 'running' || r.composeRun?.status === 'running'
				)
		)
	);

	readonly #containerReads = latestRequest();
	readonly #workspaceReads = latestRequest();
	readonly #terminalReads = latestRequest();
	readonly #networkReads = latestRequest();
	#toastTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(data: MobileInitialData) {
		this.containers = data.containers;
		this.workspaces = data.workspaces;
		this.hostname = data.hostname;
		this.workspaceRoot = data.workspaceRoot;
		this.serviceProxyEnabled = data.serviceProxyEnabled;
		this.servicePorts = data.servicePorts;
		this.serviceAccess = data.serviceAccess;
		this.vscodeSshHost = data.vscodeSshHost;
	}

	/** Read the browser preferences that the desktop page also uses. */
	loadPreferences(): void {
		try {
			this.light = localStorage.getItem(THEME_KEY) === 'light';
			const ssh = localStorage.getItem(SSH_HOST_KEY);
			if (ssh !== null) this.vscodeSshHost = ssh;
		} catch {
			// Storage can be unavailable, for example in private windows.
		}
	}

	/** Change the theme for both interfaces in this browser. */
	setLight(light: boolean): void {
		this.light = light;
		try {
			localStorage.setItem(THEME_KEY, light ? 'light' : 'dark');
		} catch {
			// The theme still applies to this page.
		}
	}

	/** Change the SSH host that VS Code links use, for both interfaces in this browser. */
	setSshHost(host: string): void {
		this.vscodeSshHost = host;
		try {
			localStorage.setItem(SSH_HOST_KEY, host);
		} catch {
			// The value still applies to this page.
		}
	}

	/** Show a short message at the top of the screen. */
	toast(message: string): void {
		clearTimeout(this.#toastTimer);
		this.toastMessage = message;
		this.#toastTimer = setTimeout(() => (this.toastMessage = ''), TOAST_MS);
	}

	/**
	 * Poll after completion, never at a fixed rate that can overlap slow requests.
	 * Returns the cleanup function for an effect.
	 */
	start(): () => void {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		let workspaceTimer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			await Promise.allSettled([
				this.refreshContainers(),
				this.refreshSessions(),
				this.refreshNetworks()
			]);
			if (!stopped) timer = setTimeout(poll, POLL_MS);
		};
		const pollWorkspaces = async () => {
			if (this.workspacesActive || this.workspaceError)
				await this.refreshWorkspaces().catch(() => {});
			if (!stopped) workspaceTimer = setTimeout(pollWorkspaces, ACTIVE_POLL_MS);
		};
		void poll();
		workspaceTimer = setTimeout(pollWorkspaces, ACTIVE_POLL_MS);
		return () => {
			stopped = true;
			clearTimeout(timer);
			clearTimeout(workspaceTimer);
			clearTimeout(this.#toastTimer);
			this.#containerReads.cancel();
			this.#workspaceReads.cancel();
			this.#terminalReads.cancel();
			this.#networkReads.cancel();
		};
	}

	async refreshContainers(): Promise<void> {
		try {
			await this.#containerReads.run(
				(signal) => requestJson<ContainerData[]>('/api/containers', { signal }),
				(value) => {
					this.containers = value;
					this.containerError = '';
					this.lastContainerRead = TIME_FORMAT.format(Date.now());
				}
			);
		} catch (cause) {
			this.containerError = errorMessage(cause);
			throw cause;
		}
	}

	async refreshWorkspaces(): Promise<void> {
		try {
			await this.#workspaceReads.run(
				(signal) => requestJson<LocalWorkspaceData[]>('/api/workspaces', { signal }),
				(value) => {
					this.workspaces = value;
					this.workspaceError = '';
				}
			);
		} catch (cause) {
			this.workspaceError = errorMessage(cause);
			throw cause;
		}
	}

	/** Network failures never block container status. */
	async refreshNetworks(): Promise<void> {
		try {
			await this.#networkReads.run(
				(signal) => requestJson<NetworkData[]>('/api/networks', { signal }),
				(value) => {
					this.networks = value;
					this.networkError = '';
				}
			);
		} catch (cause) {
			this.networkError = errorMessage(cause);
		}
	}

	async refreshSessions(): Promise<void> {
		try {
			await this.#terminalReads.run(
				(signal) => requestJson<TerminalSession[]>('/api/terminal/sessions', { signal }),
				(value) => {
					this.sessions = value;
					this.terminalError = '';
				}
			);
		} catch (cause) {
			this.terminalError = errorMessage(cause);
		}
	}

	/** Refresh everything after an action, so every tab agrees. */
	async refreshAll(): Promise<void> {
		await Promise.allSettled([
			this.refreshContainers(),
			this.refreshWorkspaces(),
			this.refreshSessions(),
			this.refreshNetworks()
		]);
	}

	/**
	 * Register an explicit terminal start and return its session ID. The terminal screen
	 * passes the start to the shared creation guard, which never sends a command twice.
	 */
	openTerminal(start: Omit<TerminalStart, 'id'>): string {
		const id = generateId();
		this.starts.set(id, { id, ...start });
		return id;
	}

	/** End a terminal process. Leaving the terminal screen never does this. */
	async endTerminal(id: string): Promise<void> {
		await requestJson('/api/terminal/sessions', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id })
		});
		this.starts.delete(id);
		this.sessions = this.sessions.filter((session) => session.id !== id);
		void this.refreshSessions();
	}

	/** Open a terminal screen for a command: start it, or attach when `start` is omitted. */
	terminalHref(id: string): string {
		return resolve('/mobile/terminals/[id]', { id });
	}

	container(id: string): ContainerData | undefined {
		return this.containers.find((c) => c.id === id);
	}

	workspace(key: string): LocalWorkspaceData | undefined {
		return this.workspaces.find((w) => workspaceKey(w) === key);
	}

	/** The devcontainer of a repository, matched by its local folder as on desktop. */
	repoContainer(repo: Pick<RepositoryData, 'path'>): ContainerData | undefined {
		return this.containers.find((c) => c.isDevcontainer && c.localWorkspacePath === repo.path);
	}

	/** The workspace that holds a local folder, for the container detail. */
	workspaceOf(path: string | undefined): LocalWorkspaceData | undefined {
		if (!path) return undefined;
		return this.workspaces.find((w) => w.repos.some((r) => r.path === path));
	}
}

const KEY = Symbol('mobile-dashboard');

/** Create the layout instance and make it available to every mobile screen. */
export function provideMobileDashboard(data: MobileInitialData): MobileDashboard {
	return setContext(KEY, new MobileDashboard(data));
}

/** The layout instance. Mobile screens render only inside the mobile layout. */
export function useMobileDashboard(): MobileDashboard {
	const dashboard = getContext<MobileDashboard | undefined>(KEY);
	if (!dashboard) throw new Error('Mobile screens need the mobile layout.');
	return dashboard;
}
