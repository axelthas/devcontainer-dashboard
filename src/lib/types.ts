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
}

export interface LocalWorkspaceData {
	id: string;
	name: string;
	path: string;
	repos: RepositoryData[];
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
