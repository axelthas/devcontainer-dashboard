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
}

export interface LocalWorkspaceData {
	id: string;
	name: string;
	path: string;
	repos: RepositoryData[];
	solutionMetadata?: SolutionMetadata;
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
}

export interface TerminalSession {
	id: string;
	name: string;
}
