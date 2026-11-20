/** Fixed, synthetic data for phone layout regressions. No real container or workspace IDs. */
import type { ContainerData, LocalWorkspaceData } from '$lib/types';

export const mobileContainers: ContainerData[] = [
	'tern-framework',
	'polaris-backend-library',
	'polaris-wss'
].map((name, i) => ({
	id: `fixture-dev-${i}`,
	name: ['compassionate_einstein', 'blissful_williams', 'romantic_rosalind'][i],
	projectName: name,
	state: 'running',
	isDevcontainer: true,
	ports: { '3000': '32793', '4096': '32794' },
	portBindings: [
		{ containerPort: '3000', hostPort: '32793', hostIp: '127.0.0.1', protocol: 'tcp' },
		{ containerPort: '4096', hostPort: '32794', hostIp: '127.0.0.1', protocol: 'tcp' }
	],
	image: `vsc-${name}-a-long-build-identifier`,
	localWorkspacePath: `/home/operator/git.workspaces/git.polaris-ice.26.0.63/${name}`,
	containerWorkspaceFolder: `/workspace/${name}`,
	devcontainerConfigFile: `/home/operator/git.workspaces/git.polaris-ice.26.0.63/${name}/.devcontainer/rocky8/devcontainer.json`,
	remoteUser: 'operator',
	remoteUserSource: 'remoteUser',
	networks: [{ name: 'polaris-ice_polaris-net', ip: `192.168.108.${10 + i}`, aliases: [name] }]
}));

export const mobileServices: ContainerData[] = ['atm1', 'atm2'].map((name, i) => ({
	id: `fixture-service-${i}`,
	name: `polaris-ice-${name}`,
	projectName: `polaris-ice-${name}`,
	state: 'exited',
	isDevcontainer: false,
	ports: { '5904': 'dynamic', '6904': 'dynamic', '9001': 'dynamic' },
	portBindings: ['5904', '6904', '9001'].map((port) => ({
		containerPort: port,
		hostPort: 'dynamic',
		hostIp: '',
		protocol: 'tcp'
	})),
	image: `docker.example.invalid/polaris-ice-sandbox:26.0.63`,
	composeProject: 'polaris-ice',
	composeService: name,
	sandboxTag: '26.0.63',
	networks: [
		{
			name: 'polaris-ice_polaris-net',
			ip: '',
			configuredIp: `192.168.108.${36 + i}`,
			aliases: [name]
		}
	]
}));

export const mobileWorkspaces: LocalWorkspaceData[] = [
	'git.feature.sfr-printing-with-cots-printer',
	'git.polaris-ice.26.0.63'
].map((name, i) => ({
	id: `fixture-ws-${i}`,
	name,
	path: `/nonexistent/mobile-fixture/${name}`,
	solutionMetadata: {
		solution: 'polaris-ice',
		config_repo: 'fixture',
		projects: [],
		tag: '26.0.63',
		shellconf: false,
		nobackup: false,
		bootstrap_version: '26.0.56'
	},
	repos: [
		'boca-printer-driver',
		'implementation-proposals',
		'polaris',
		'polaris-asd',
		'polaris-asd-editor'
	].map((repo, j) => ({
		name: repo,
		path: `/nonexistent/mobile-fixture/${name}/${repo}`,
		hasDevcontainer: j !== 1,
		devcontainerConfigs:
			j === 1
				? []
				: ['.devcontainer/rocky8/devcontainer.json', '.devcontainer/rocky9/devcontainer.json'],
		isRunning: false,
		...(j === 1
			? { currentBranch: 'feature/a-very-long-branch-name-to-check-truncation' }
			: { currentTag: ['1.0.0', '', '1.9.36', '2.9.22', '1.5.11'][j] })
	}))
}));
