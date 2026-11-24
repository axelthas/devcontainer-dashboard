import type { HarnessEndpoint } from './harness';

export interface ContainerData {
	id: string;
	name: string;
	projectName: string;
	state: 'running' | 'exited' | 'created' | string;
	isDevcontainer: boolean;
	ports: Record<string, string>;
	image: string;
	localWorkspacePath?: string;
	/** Absolute host path of the devcontainer.json the container was built from */
	devcontainerConfigFile?: string;
	/** Path the workspace is mounted at inside the container */
	containerWorkspaceFolder?: string;
	composeProject?: string;
	composeWorkingDir?: string;
	composeConfigFiles?: string;
	/** Address on the container's first network; only set while it is running */
	ipAddress?: string;
	/** Test harnesses the container's image declares; only known while it is running */
	harnesses?: HarnessEndpoint[];
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

export type PolarisMode = 'training' | 'playback' | 'testing' | 'operational';
/** Any polaris-* variant, e.g. 'polaris-ice', 'polaris-qkt', 'polaris-mag' */
export type PolarisType = string;

export interface PolarisRegistryEntry {
	id: string;
	type: PolarisType;
	subnetOctet: number;
	instanceDir: string;
	composeFile: string;
	createdAt: string;
	currentMode?: PolarisMode;
	/** Subset of compose services to start (undefined = start all). */
	services?: string[];
	/** 'nginx' (default) opens NoVNC via nginx subdomain; 'local' opens directly via host port. */
	novncMode?: 'nginx' | 'local';
}

export interface PolarisInstance {
	id: string;
	type: PolarisType;
	subnet: string;
	instanceDir?: string;
	composeFile?: string;
	workingDir?: string;
	managedByDashboard: boolean;
	containers: ContainerData[];
	currentMode?: PolarisMode;
	/** Services configured to start for this instance. */
	services?: string[];
	/** 'nginx' (default) opens NoVNC via nginx subdomain; 'local' opens directly via host port. */
	novncMode?: 'nginx' | 'local';
}
