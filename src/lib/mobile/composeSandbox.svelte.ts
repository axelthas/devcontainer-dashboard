/**
 * Compose sandbox state for the mobile sandbox screens. It applies the rules of the desktop
 * ComposeSandboxPanel with the same helpers, endpoints and storage keys:
 * - Start never pulls; Pull and Pull and start are the only actions that use the registry.
 * - Actions need a check of exactly the current selection, and a stack that belongs here.
 * - The service selection is saved as an exclusion list per sandbox kind.
 * The server validates every selection again; this state only proposes it.
 * Construct it during component initialisation: it owns effects.
 */
import { getContext, setContext, untrack } from 'svelte';
import { errorMessage, latestRequest, requestJson } from '$lib/requests';
import {
	COMPOSE_ACTION_LABELS,
	COMPOSE_ACTIONS,
	composeActionCommand,
	composeDirectory,
	composeLogsCommand,
	composeQuery,
	composeSandboxKind,
	defaultComposeSelection,
	parseProfiles,
	shellCommand,
	withDependencies,
	type ComposeAction,
	type ComposeSelection
} from '$lib/composeCommands';
import { IMAGE_TAG_PATTERN, sandboxVersion } from '$lib/imageReference';
import type {
	ComposeInspection,
	ComposeRunData,
	ComposeTagListing,
	RepositoryData
} from '$lib/types';

export const SELECTION_STORAGE_KEY = 'devcontainer-dashboard-compose-selections';
export const SERVICE_STORAGE_KEY = 'devcontainer-dashboard-compose-services';

interface StoredSelection {
	files: string[];
	envFile: string;
	profiles: string;
	tag?: string;
}

/** Read all saved selections; storage errors mean no saved selection. */
function readStoredSelections(): Record<string, StoredSelection> {
	try {
		return JSON.parse(localStorage.getItem(SELECTION_STORAGE_KEY) ?? '{}') as Record<
			string,
			StoredSelection
		>;
	} catch {
		return {};
	}
}

/** Read the excluded services of every sandbox kind. */
function readExcludedServices(): Record<string, string[]> {
	try {
		const value = JSON.parse(localStorage.getItem(SERVICE_STORAGE_KEY) ?? '{}');
		return value && typeof value === 'object' ? (value as Record<string, string[]>) : {};
	} catch {
		return {};
	}
}

/** The storage key that other clones of the same repository fall back to. */
function nameKey(name: string): string {
	return `name:${name}`;
}

/** Name the action of a run, with its services when it ran on a subset. */
export function runLabel(run: ComposeRunData): string {
	const label = `${COMPOSE_ACTION_LABELS[run.action]}${run.tag ? ` ${run.tag}` : ''}`;
	const after = run.after ? ' after Pull' : '';
	const services = run.services ?? [];
	return services.length > 0 ? `${label}${after}: ${services.join(', ')}` : `${label}${after}`;
}

export interface SandboxOptions {
	repo: () => RepositoryData;
	/** Refresh the repository row, which carries the Compose run. */
	onRefresh: () => Promise<void>;
	/** Refresh Docker services after a process exits. */
	onRefreshContainers: () => Promise<void>;
}

export class ComposeSandbox {
	readonly #options: SandboxOptions;
	selectedFiles = $state<string[]>([]);
	envFile = $state('');
	profilesText = $state('');
	tagText = $state('');
	excludedByKind = $state<Record<string, string[]>>({});

	inspection = $state<ComposeInspection | null>(null);
	inspectedKey = $state('');
	inspecting = $state(false);
	inspectError = $state('');
	actionError = $state('');
	starting = $state<string | null>(null);

	tagListing = $state<ComposeTagListing | null>(null);
	tagListingKey = $state('');
	tagsLoading = $state(false);
	tagsError = $state('');

	readonly #reads = latestRequest();
	readonly #tagReads = latestRequest();
	#disposed = false;

	get repo(): RepositoryData {
		return this.#options.repo();
	}

	readonly files = $derived(this.repo.composeFiles ?? []);
	readonly directories = $derived([...new Set(this.files.map(composeDirectory))]);
	readonly directory = $derived(composeDirectory(this.selectedFiles[0] ?? this.files[0] ?? ''));
	readonly directoryFiles = $derived(
		this.files.filter((file) => composeDirectory(file) === this.directory)
	);
	readonly tag = $derived(this.tagText.trim());
	readonly tagValid = $derived(this.tag === '' || IMAGE_TAG_PATTERN.test(this.tag));
	/** The selection without the tag: the tag list reads the Compose files as they are. */
	readonly baseSelection = $derived<ComposeSelection>({
		files: this.selectedFiles,
		profiles: parseProfiles(this.profilesText),
		...(this.envFile.trim() ? { envFile: this.envFile.trim() } : {})
	});
	readonly selection = $derived<ComposeSelection>({
		...this.baseSelection,
		...(this.tag && this.tagValid ? { tag: this.tag } : {})
	});
	readonly selectionKey = $derived(JSON.stringify(this.selection));
	readonly run = $derived(this.repo.composeRun);
	/** Actions need a check of exactly the current selection. */
	readonly fresh = $derived(this.inspection !== null && this.inspectedKey === this.selectionKey);
	readonly blocked = $derived(
		!this.fresh ||
			!this.tagValid ||
			this.inspection?.ownership === 'other' ||
			this.run?.status === 'running' ||
			this.starting !== null
	);
	readonly runningCount = $derived(
		this.inspection?.containers.filter((container) => container.state === 'running').length ?? 0
	);
	readonly sandboxKind = $derived(composeSandboxKind(this.repo.name, this.selectedFiles));
	readonly excluded = $derived(
		Array.isArray(this.excludedByKind[this.sandboxKind])
			? this.excludedByKind[this.sandboxKind]
			: []
	);
	readonly serviceNames = $derived(this.inspection?.services.map((service) => service.name) ?? []);
	/** Services that the operator selected. */
	readonly chosen = $derived(this.serviceNames.filter((name) => !this.excluded.includes(name)));
	/** Selected services plus their transitive depends_on services, in config order. */
	readonly effective = $derived(withDependencies(this.inspection?.services ?? [], this.chosen));
	/** Services that run only because a selected service depends on them. */
	readonly implied = $derived(this.effective.filter((name) => !this.chosen.includes(name)));
	readonly allSelected = $derived(this.effective.length === this.serviceNames.length);
	/** Service arguments for Compose; no arguments means every service. */
	readonly serviceArgs = $derived(this.allSelected ? [] : this.effective);
	/** Running services outside the selection; Build and Start do not change them. */
	readonly runningOutside = $derived(
		this.serviceNames.filter(
			(name) =>
				!this.effective.includes(name) &&
				(this.inspection?.containers ?? []).some(
					(container) => container.service === name && container.state === 'running'
				)
		)
	);
	readonly overrideFile = $derived(this.fresh ? this.inspection?.overrideFile : undefined);
	readonly runningVersion = $derived(
		this.inspection && this.inspection.containers.length > 0
			? sandboxVersion(
					this.inspection.projectName,
					this.inspection.containers.map((container) => ({
						image: container.image ?? '',
						service: container.service,
						sandboxTag: container.sandboxTag
					}))
				)
			: null
	);
	/** Selected registry services whose effective image is not on this host. */
	readonly missingImages = $derived(
		(this.inspection?.services ?? []).filter(
			(service) =>
				service.source === 'registry' &&
				service.imagePresent === false &&
				this.effective.includes(service.name)
		)
	);
	readonly switching = $derived(
		Boolean(
			this.tag &&
			this.runningVersion &&
			this.runningVersion.kind !== 'build' &&
			this.runningVersion.label !== this.tag
		)
	);
	readonly tagListKey = $derived(JSON.stringify([this.baseSelection, this.serviceArgs]));
	readonly listing = $derived(this.tagListingKey === this.tagListKey ? this.tagListing : null);
	readonly listingFailures = $derived(this.listing?.images.filter((image) => image.error) ?? []);
	/** The exact Docker calls of each action, once each. */
	readonly commandPreview = $derived(
		this.selectedFiles.length === 0
			? ''
			: COMPOSE_ACTIONS.filter((action) => action !== 'up-pull')
					.map((action) =>
						shellCommand(
							composeActionCommand(
								this.repo.path,
								this.selection,
								action,
								this.actionServices(action),
								this.overrideFile
							)
						)
					)
					.join('\n')
	);

	constructor(options: SandboxOptions) {
		this.#options = options;
		// Restore a saved selection only when its files still exist in the repository.
		untrack(() => {
			const repo = options.repo();
			const available = repo.composeFiles ?? [];
			const all = readStoredSelections();
			const stored = all[repo.path] ?? all[nameKey(repo.name)];
			const files = stored?.files?.filter((file) => available.includes(file)) ?? [];
			this.selectedFiles = files.length > 0 ? files : defaultComposeSelection(available);
			this.envFile = stored?.envFile ?? '';
			this.profilesText = stored?.profiles ?? '';
			// The tag belongs to this clone only: another task workspace starts with no tag.
			this.tagText = all[repo.path]?.tag ?? '';
			this.excludedByKind = readExcludedServices();
		});

		// Save the selection per repository path, and per repository name for other clones.
		$effect(() => {
			const entry: StoredSelection = {
				files: this.selectedFiles,
				envFile: this.envFile,
				profiles: this.profilesText,
				tag: this.tagText
			};
			const repo = untrack(() => this.repo);
			try {
				const all = readStoredSelections();
				all[repo.path] = entry;
				all[nameKey(repo.name)] = entry;
				localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(all));
			} catch {
				// ignore storage errors
			}
		});

		// Resolve the configuration on open and after each selection change.
		$effect(() => {
			const key = this.selectionKey;
			const timer = setTimeout(() => {
				if (key) void this.inspect();
			}, 300);
			return () => clearTimeout(timer);
		});

		// Read the registry tags once per selection, so the version sheet opens with them.
		$effect(() => {
			const key = this.tagListKey;
			if (!key || !this.fresh) return;
			untrack(() => {
				if (!this.listing && !this.tagsLoading) void this.loadTags();
			});
		});

		$effect(() => () => this.dispose());
	}

	dispose(): void {
		this.#disposed = true;
		this.#reads.cancel();
		this.#tagReads.cancel();
	}

	/** Stop always applies to the whole project; the other actions use the selected services. */
	actionServices(action: ComposeAction): string[] {
		return action === 'stop' ? [] : this.serviceArgs;
	}

	/** Why an action is unavailable, or null when it can run. */
	blocker(action: ComposeAction): string | null {
		if (this.run?.status === 'running') return 'Another sandbox action runs.';
		if (!this.tagValid) return 'The version is not a valid Docker tag.';
		if (!this.fresh)
			return this.inspecting ? 'Checking the configuration…' : 'Check the configuration first.';
		if (this.inspection?.ownership === 'other') return 'The project belongs to another folder.';
		if (action !== 'stop' && this.effective.length === 0) return 'Select at least one service.';
		if (action === 'up' && this.missingImages.length > 0)
			return `Start never pulls. Not on this host: ${this.missingImages.map((s) => s.name).join(', ')}.`;
		return null;
	}

	/** Resolve the current selection; only the newest response may apply. */
	async inspect(): Promise<void> {
		if (this.selectedFiles.length === 0) {
			this.#reads.cancel();
			this.inspection = null;
			this.inspecting = false;
			this.inspectError = 'Select at least one Compose file.';
			return;
		}
		if (!this.tagValid) {
			this.#reads.cancel();
			this.inspection = null;
			this.inspecting = false;
			this.inspectError = 'Version must be a Docker tag: letters, digits, ".", "_" and "-".';
			return;
		}
		const key = this.selectionKey;
		const query = composeQuery(this.repo.path, this.selection);
		this.inspecting = true;
		this.inspectError = '';
		try {
			const applied = await this.#reads.run(
				(signal) => requestJson<ComposeInspection>(`/api/compose?${query}`, { signal }),
				(value) => {
					this.inspection = value;
					this.inspectedKey = key;
				}
			);
			if (applied && !this.#disposed) this.inspecting = false;
		} catch (cause) {
			if (!this.#disposed) {
				this.inspection = null;
				this.inspectError = errorMessage(cause);
				this.inspecting = false;
			}
		}
	}

	/** Load the registry tags of the selected services; only the newest response may apply. */
	async loadTags(refresh = false): Promise<void> {
		if (this.selectedFiles.length === 0) return;
		const key = this.tagListKey;
		const services = this.serviceArgs
			.map((name) => `&service=${encodeURIComponent(name)}`)
			.join('');
		const query = `${composeQuery(this.repo.path, this.baseSelection)}${services}${refresh ? '&refresh=1' : ''}`;
		this.tagsLoading = true;
		this.tagsError = '';
		try {
			const applied = await this.#tagReads.run(
				(signal) => requestJson<ComposeTagListing>(`/api/compose/tags?${query}`, { signal }),
				(value) => {
					this.tagListing = value;
					this.tagListingKey = key;
				}
			);
			if (applied && !this.#disposed) this.tagsLoading = false;
		} catch (cause) {
			if (!this.#disposed) {
				this.tagsError = errorMessage(cause);
				this.tagsLoading = false;
			}
		}
	}

	/** Keep files in discovery order, which is the Compose merge order. */
	toggleFile(file: string): void {
		const next = this.selectedFiles.includes(file)
			? this.selectedFiles.filter((item) => item !== file)
			: [...this.selectedFiles, file];
		this.selectedFiles = this.directoryFiles.filter((item) => next.includes(item));
	}

	/** A new project directory starts with its default selection. */
	selectDirectory(next: string): void {
		this.selectedFiles = defaultComposeSelection(this.files, next);
	}

	/** Save the excluded services of the current kind; read storage again to keep other kinds. */
	#saveExcluded(next: string[]): void {
		const kind = this.sandboxKind;
		const all = Object.fromEntries(
			Object.entries(readExcludedServices()).filter(([other]) => other !== kind)
		);
		if (next.length > 0) all[kind] = next;
		this.excludedByKind = all;
		try {
			localStorage.setItem(SERVICE_STORAGE_KEY, JSON.stringify(all));
		} catch {
			// ignore storage errors
		}
	}

	/** Select or deselect one service. Dependencies follow the selection. */
	toggleService(name: string): void {
		this.#saveExcluded(
			this.excluded.includes(name)
				? this.excluded.filter((item) => item !== name)
				: [...this.excluded, name]
		);
	}

	/** Select or deselect every service. Keep exclusions for services of other profiles. */
	selectAllServices(selected: boolean): void {
		const others = this.excluded.filter((name) => !this.serviceNames.includes(name));
		this.#saveExcluded(selected ? others : [...others, ...this.serviceNames]);
	}

	/** Start one action. The server checks the selection and the live stack again. */
	async start(
		action: ComposeAction,
		services: string[] = this.actionServices(action),
		key: string = action
	): Promise<boolean> {
		if (this.blocked) return false;
		this.starting = key;
		this.actionError = '';
		try {
			await requestJson('/api/compose/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					repoPath: this.repo.path,
					repoName: this.repo.name,
					action,
					...this.selection,
					...(services.length > 0 ? { services } : {})
				})
			});
			await this.#options.onRefresh();
			return true;
		} catch (cause) {
			if (!this.#disposed) this.actionError = errorMessage(cause);
			return false;
		} finally {
			if (!this.#disposed) this.starting = null;
		}
	}

	/** Cancel a running action, or dismiss a finished one and delete its log. */
	async removeRun(id: string): Promise<void> {
		this.actionError = '';
		try {
			await requestJson('/api/compose/run', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			});
			await this.#options.onRefresh();
		} catch (cause) {
			if (!this.#disposed) this.actionError = errorMessage(cause);
		}
	}

	/** Refresh the row, the Docker services, and the stack state after a process exits. */
	runExited(): void {
		void this.#options.onRefresh().catch(() => {});
		void this.#options.onRefreshContainers().catch(() => {});
		void this.inspect();
	}

	/** The command that follows logs of the selected services, or null before a check. */
	logsCommand(): { command: string; name: string; cwd: string } | null {
		if (!this.inspection || !this.fresh) return null;
		return {
			command: shellCommand(
				composeLogsCommand(this.repo.path, this.selection, this.serviceArgs, this.overrideFile)
			),
			name: `Logs ${this.inspection.projectName}`,
			cwd: this.inspection.projectDirectory
		};
	}

	/** Describe the containers of one service. */
	serviceState(service: string): { label: string; running: boolean } {
		const states = (this.inspection?.containers ?? [])
			.filter((container) => container.service === service)
			.map((container) => container.state);
		if (states.length === 0) return { label: 'not created', running: false };
		return { label: states.join(', '), running: states.includes('running') };
	}
}

const KEY = Symbol('compose-sandbox');

/** Share one sandbox state between the sandbox screens of a repository. */
export function provideComposeSandbox(sandbox: ComposeSandbox): ComposeSandbox {
	return setContext(KEY, sandbox);
}

export function useComposeSandbox(): ComposeSandbox {
	const sandbox = getContext<ComposeSandbox | undefined>(KEY);
	if (!sandbox) throw new Error('Sandbox screens need the sandbox layout.');
	return sandbox;
}
