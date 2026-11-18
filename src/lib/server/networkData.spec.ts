/** Regressions for building network data from raw Docker listings. */
import { describe, expect, it } from 'vitest';
import { buildNetworkData, containerNetworks } from './networkData';

const keflavikNode = {
	Id: '2222222222223333',
	Names: ['/keflavik-twr-fdd-1-sup-1'],
	Image: 'polaris/twr',
	State: 'exited',
	Labels: {
		'com.docker.compose.project': 'keflavik',
		'com.docker.compose.service': 'twr-fdd-1-sup'
	},
	NetworkSettings: {
		Networks: {
			keflavik_oplan: {
				IPAddress: '',
				IPAMConfig: { IPv4Address: '192.168.103.101' },
				Aliases: null
			}
		}
	}
};

const devcontainer = {
	Id: 'bbbbbbbbbbbbcccc',
	Names: ['/brave_hopper'],
	Image: 'vsc-tas-keflavik-uid',
	State: 'running',
	Labels: { 'devcontainer.local_folder': '/workspaces/git.tas-keflavik/tas-keflavik' },
	NetworkSettings: {
		Networks: {
			bridge: { IPAddress: '172.17.0.4' },
			keflavik_oplan: {
				IPAddress: '192.168.103.140',
				Aliases: ['bbbbbbbbbbbb', 'sim-pilot-1']
			}
		}
	}
};

const networks = [
	{ Name: 'bridge', Driver: 'bridge', IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] } },
	{ Name: 'host', Driver: 'host' },
	{
		Name: 'keflavik_oplan',
		Driver: 'bridge',
		Scope: 'local',
		Labels: { 'com.docker.compose.project': 'keflavik' },
		IPAM: {
			Config: [{ Subnet: 'fd00::/64' }, { Subnet: '192.168.103.0/24', Gateway: '192.168.103.1' }]
		}
	},
	{ Name: 'swarm_net', Driver: 'overlay', Scope: 'swarm' },
	{ Name: 'devtools', Driver: 'bridge', IPAM: { Config: [] } }
];

describe('containerNetworks', () => {
	it('keeps the configured address of a stopped container and drops ID aliases', () => {
		expect(containerNetworks(devcontainer.NetworkSettings.Networks)).toEqual([
			{ name: 'bridge', ip: '172.17.0.4', aliases: [] },
			{ name: 'keflavik_oplan', ip: '192.168.103.140', aliases: ['sim-pilot-1'] }
		]);
		expect(containerNetworks(keflavikNode.NetworkSettings.Networks)).toEqual([
			{ name: 'keflavik_oplan', ip: '', configuredIp: '192.168.103.101', aliases: [] }
		]);
		expect(containerNetworks(null)).toEqual([]);
	});
});

describe('buildNetworkData', () => {
	it('lists user-defined networks with running and stopped endpoints', () => {
		const data = buildNetworkData(networks, [keflavikNode, devcontainer, { Id: 42 }]);
		expect(data.map((network) => network.name)).toEqual(['devtools', 'keflavik_oplan']);
		const sandbox = data[1];
		expect(sandbox).toMatchObject({
			driver: 'bridge',
			subnet: '192.168.103.0/24',
			gateway: '192.168.103.1',
			projects: ['keflavik']
		});
		expect(sandbox.endpoints).toEqual([
			{
				containerId: 'bbbbbbbbbbbb',
				containerName: 'brave_hopper',
				state: 'running',
				isDevcontainer: true,
				ip: '192.168.103.140',
				aliases: ['sim-pilot-1'],
				hostname: 'sim-pilot-1'
			},
			{
				containerId: '222222222222',
				containerName: 'keflavik-twr-fdd-1-sup-1',
				state: 'exited',
				isDevcontainer: false,
				ip: '192.168.103.101',
				aliases: [],
				hostname: 'twr-fdd-1-sup',
				composeProject: 'keflavik'
			}
		]);
		expect(data[0]).toEqual({ name: 'devtools', driver: 'bridge', projects: [], endpoints: [] });
	});
});
