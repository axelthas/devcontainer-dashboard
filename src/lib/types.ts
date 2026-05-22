export interface ContainerData {
	id: string;
	name: string;
	projectName: string;
	state: 'running' | 'exited' | 'created' | string;
	isDevcontainer: boolean;
	ports: Record<string, string>;
	image: string;
	localWorkspacePath?: string;
	composeProject?: string;
}

export interface RepositoryData {
	name: string;
	path: string;
	hasDevcontainer: boolean;
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
}

export interface TerminalSession {
	id: string;
	name: string;
}
