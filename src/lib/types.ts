export interface ContainerData {
	id: string;
	name: string;
	projectName: string;
	state: 'running' | 'exited' | 'created' | string;
	isDevcontainer: boolean;
	ports: Record<string, string>;
	image: string;
	localWorkspacePath?: string;
}
