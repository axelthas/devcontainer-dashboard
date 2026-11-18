export interface ContainerData {
	id: string;
	name: string;
	projectName: string;
	state: 'running' | 'exited' | 'created' | string;
	isDevcontainer: boolean;
	ports: Record<string, string>;
	/** Published addresses for display; service authorization always re-inspects Docker. */
	portBindings?: PublishedPortBinding[];
	image: string;
	localWorkspacePath?: string;
	/** Absolute host path of the devcontainer.json the container was built from */
	devcontainerConfigFile?: string;
	/** Path the workspace is mounted at inside the container */
	containerWorkspaceFolder?: string;
	/**
	 * Effective remote user from the `devcontainer.metadata` label: the last `remoteUser`,
	 * else the last `containerUser`. Undefined: the container's default user applies.
	 */
	remoteUser?: string;
	/** Metadata property that supplied `remoteUser` */
	remoteUserSource?: 'remoteUser' | 'containerUser';
	/** Set when the metadata names a user that cannot be used; container commands are then disabled */
	remoteUserError?: string;
	composeProject?: string;
	/** Docker networks of the container, sorted by name. Empty or missing when unknown. */
	networks?: ContainerNetwork[];
	/** Networks and seats declared in devcontainer.json under customizations.devcontainer-dashboard */
	networkPresets?: NetworkPreset[];
}

/** Web-service protocol per container port: built-in defaults plus `--gateway-ports`. */
export type ServicePortPolicy = Record<string, 'http' | 'https' | 'off'>;

/**
 * How the dashboard opens a web port: a Tailscale HTTPS origin, the same-origin gateway,
 * or a direct `http://host:port` URL.
 */
export type ServiceAccess = 'https' | 'gateway' | 'direct';

/** One published Docker host binding, preserving transport and address family. */
export interface PublishedPortBinding {
	containerPort: string;
	hostPort: string;
	hostIp: string;
	protocol: string;
}

/** One network endpoint of a container. */
export interface ContainerNetwork {
	name: string;
	/** Current IPv4 address. Empty while the container is stopped. */
	ip: string;
	/** Static IPv4 address from the endpoint configuration. Docker keeps it while the container is stopped. */
	configuredIp?: string;
	/** Network aliases other than the container ID */
	aliases: string[];
}

/** A network that a devcontainer project declares, with optional seats (hostname and address). */
export interface NetworkPreset {
	network: string;
	seats: { hostname: string; ip?: string }[];
}

/** One container on a user-defined network, running or stopped. */
export interface NetworkEndpoint {
	/** Short (12 character) container ID */
	containerId: string;
	containerName: string;
	state: string;
	isDevcontainer: boolean;
	/** Current address, else the configured static address, else empty */
	ip: string;
	aliases: string[];
	/** Name that other nodes use: the first alias, else the Compose service, else the container name */
	hostname: string;
	composeProject?: string;
}

/** What the network drawer opens on: a devcontainer, and optionally a network and a seat. */
export interface NetworkDrawerTarget {
	containerId: string;
	network?: string;
	seatIp?: string;
}

/** A user-defined Docker network. The dashboard never lists bridge, host, or none. */
export interface NetworkData {
	name: string;
	driver: string;
	/** First IPv4 subnet of the network IPAM configuration */
	subnet?: string;
	gateway?: string;
	/** Compose projects that created the network or have containers on it */
	projects: string[];
	endpoints: NetworkEndpoint[];
}

export interface RepositoryData {
	name: string;
	path: string;
	hasDevcontainer: boolean;
	/** Relative paths to each devcontainer.json found in the repo (e.g. '.devcontainer/rocky8/devcontainer.json') */
	devcontainerConfigs: string[];
	isRunning: boolean;
	currentBranch?: string;
	/** Current tag when HEAD is detached on a tag */
	currentTag?: string;
	/** Matched container ID (short) when a container exists for this repo */
	containerId?: string;
	/** Container state when a container exists (e.g. 'running', 'exited') */
	containerState?: string;
	/** Port mappings from the matched container */
	containerPorts?: Record<string, string>;
	/** Active devcontainer build session for this repo */
	buildSession?: {
		id: string;
		status: 'running' | 'success' | 'failed';
		startedAt: string;
		/** True when the output of a failed build is kept as a log */
		hasLog?: boolean;
	};
	/**
	 * Compose files at the repository root and one directory deep, relative to `path`.
	 * Hidden directories such as `.devcontainer/` are not scanned.
	 */
	composeFiles?: string[];
	/** Newest Compose operation for this repo */
	composeRun?: ComposeRunData;
}

/** One tracked Compose lifecycle operation. */
export interface ComposeRunData {
	id: string;
	action: 'build' | 'up' | 'up-build' | 'stop';
	status: 'running' | 'success' | 'failed';
	startedAt: string;
	/** Selected files, in merge order, relative to the repository */
	files: string[];
	/** True when the output of a failed run is kept as a log */
	hasLog?: boolean;
}

/** Non-secret structure of one resolved Compose service. */
export interface ComposeServiceSummary {
	name: string;
	image?: string;
	hasBuild: boolean;
	profiles: string[];
	ports: { target: string; published?: string; protocol: string; hostIp?: string }[];
	networks: string[];
	containerName?: string;
}

/** One network of the resolved configuration. External networks must already exist. */
export interface ComposeNetworkSummary {
	key: string;
	name: string;
	external: boolean;
	subnet?: string;
}

/** One existing container of the resolved project name. */
export interface ComposeStackContainer {
	/** Short (12 character) container ID */
	id: string;
	name: string;
	service: string;
	state: string;
	/** `com.docker.compose.project.working_dir` label, when present */
	workingDir?: string;
}

/** Result of resolving one Compose selection and comparing it with live Docker state. */
export interface ComposeInspection {
	projectName: string;
	/** Absolute project directory used for relative paths and the default `.env` */
	projectDirectory: string;
	selection: { files: string[]; envFile?: string; profiles: string[] };
	services: ComposeServiceSummary[];
	networks: ComposeNetworkSummary[];
	/** Compose warnings, for example unset variables */
	warnings: string[];
	/**
	 * `none`: no containers of this project exist. `this`: all belong to this project directory.
	 * `other`: some belong to another working directory; the dashboard refuses actions.
	 */
	ownership: 'none' | 'this' | 'other';
	containers: ComposeStackContainer[];
	otherWorkingDirs: string[];
}

export interface LocalWorkspaceData {
	id: string;
	name: string;
	path: string;
	repos: RepositoryData[];
	solutionMetadata?: SolutionMetadata;
	buildSession?: {
		id: string;
		status: 'running' | 'success' | 'failed';
		startedAt: string;
		/** True when the output of a failed bootstrap run is kept as a log */
		hasLog?: boolean;
	};
}

export interface SolutionMetadata {
	solution: string;
	config_repo: string;
	projects: string[];
	tag: string;
	shellconf: boolean;
	nobackup: boolean;
	bootstrap_version: string;
}

export interface BootstrapToolInfo {
	installed: boolean;
	currentBranch?: string;
	availableBranches?: string[];
	remoteBranches?: string[];
	version?: string;
	repoPath: string;
}

export interface BootstrapProvider {
	id: string;
	name: string;
	repoPath: string;
	commands: {
		update: string;
		rerun: string;
		version?: string;
	};
	metadataFile?: string;
}

export interface BootstrapPreset {
	id: string;
	name: string;
	command: string;
	interactive?: boolean;
	/** Which form fields to display. Omit to show all fields. */
	fields?: Array<'command' | 'destDir'>;
}

export interface TerminalSession {
	id: string;
	name: string;
	command?: string;
	cwd?: string;
	startedAt?: string;
	status?: 'running' | 'exited';
}
