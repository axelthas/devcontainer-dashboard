/** Regressions for the shared network rules: validation, conflicts, seats, and step order. */
import { describe, expect, it } from 'vitest';
import type { ContainerNetwork, NetworkData, NetworkEndpoint } from '$lib/types';
import {
	addressProblem,
	networkSeats,
	parseConnectRequest,
	parseIPv4,
	planConnect,
	planDisconnect,
	seatStatus,
	stepCommand
} from './networkRules';

/** Build one endpoint with test defaults. */
function endpoint(fields: Partial<NetworkEndpoint>): NetworkEndpoint {
	return {
		containerId: 'aaaaaaaaaaaa',
		containerName: 'node',
		state: 'running',
		isDevcontainer: false,
		ip: '',
		aliases: [],
		hostname: 'node',
		...fields
	};
}

const sandbox: NetworkData = {
	name: 'keflavik_oplan',
	driver: 'bridge',
	subnet: '192.168.103.0/24',
	gateway: '192.168.103.1',
	projects: ['keflavik'],
	endpoints: [
		endpoint({
			containerId: '111111111111',
			containerName: 'keflavik-app-fdd-2-1',
			ip: '192.168.103.124',
			hostname: 'app-fdd-2'
		}),
		endpoint({
			containerId: '222222222222',
			containerName: 'keflavik-twr-fdd-1-sup-1',
			state: 'exited',
			ip: '192.168.103.101',
			hostname: 'twr-fdd-1-sup'
		}),
		endpoint({
			containerId: '333333333333',
			containerName: 'other_dev',
			state: 'exited',
			isDevcontainer: true,
			ip: '192.168.103.150',
			hostname: 'other'
		})
	]
};

const bridgeOnly: ContainerNetwork[] = [{ name: 'bridge', ip: '172.17.0.4', aliases: [] }];

describe('parseIPv4', () => {
	it.each(['192.168.103.1', '0.0.0.0', '255.255.255.255'])('accepts %s', (ip) => {
		expect(parseIPv4(ip)).not.toBeNull();
	});
	it.each(['192.168.103', '256.1.1.1', '01.2.3.4', '1.2.3.4.5', 'a.b.c.d', ''])(
		'rejects %j',
		(ip) => expect(parseIPv4(ip)).toBeNull()
	);
});

describe('addressProblem', () => {
	it('accepts the address of a stopped sandbox node', () => {
		expect(addressProblem(sandbox, '192.168.103.101')).toBeNull();
	});
	it('names the running container that holds an address', () => {
		expect(addressProblem(sandbox, '192.168.103.124')).toBe(
			'Held by keflavik-app-fdd-2-1 (running)'
		);
	});
	it('treats a stopped devcontainer as a holder, because it claims the address on start', () => {
		expect(addressProblem(sandbox, '192.168.103.150')).toBe('Held by other_dev');
	});
	it('lets a container keep its own address', () => {
		expect(addressProblem(sandbox, '192.168.103.150', '333333333333abcdef')).toBeNull();
	});
	it.each([
		['192.168.104.10', 'Outside 192.168.103.0/24'],
		['192.168.103.0', 'Network or broadcast address'],
		['192.168.103.255', 'Network or broadcast address'],
		['192.168.103.1', 'Gateway address'],
		['192.168.103.1000', 'Not an IPv4 address']
	])('rejects %s', (ip, problem) => expect(addressProblem(sandbox, ip)).toBe(problem));
	it('refuses a static address on a network without an IPv4 subnet', () => {
		expect(addressProblem({ ...sandbox, subnet: undefined }, '192.168.103.20')).toContain(
			'no IPv4 subnet'
		);
	});
});

describe('networkSeats and seatStatus', () => {
	it('lists sandbox nodes and declared seats by address, without duplicates', () => {
		const seats = networkSeats(sandbox, [
			{
				network: 'keflavik_oplan',
				seats: [
					{ hostname: 'twr-fdd-1-sup', ip: '192.168.103.101' },
					{ hostname: 'sim-pilot-1', ip: '192.168.103.140' },
					{ hostname: 'no-address' }
				]
			},
			{ network: 'other', seats: [{ hostname: 'elsewhere', ip: '192.168.103.9' }] }
		]);
		expect(seats.map((seat) => [seat.hostname, seat.source])).toEqual([
			['twr-fdd-1-sup', 'sandbox'],
			['app-fdd-2', 'sandbox'],
			['sim-pilot-1', 'devcontainer.json']
		]);
	});
	it('reports running nodes as taken and stopped nodes as free', () => {
		const [stopped, running] = networkSeats(sandbox);
		expect(seatStatus(sandbox, stopped)).toEqual({ free: true, text: 'node stopped' });
		expect(seatStatus(sandbox, running)).toMatchObject({ free: false, text: 'node running' });
	});
});

describe('parseConnectRequest', () => {
	it('accepts a seat request and drops empty optional fields', () => {
		expect(
			parseConnectRequest({
				network: 'keflavik_oplan',
				ip: '192.168.103.101',
				alias: 'twr-fdd-1-sup',
				setHostname: true
			})
		).toEqual({
			request: {
				network: 'keflavik_oplan',
				ip: '192.168.103.101',
				alias: 'twr-fdd-1-sup',
				onlyNetwork: false,
				setHostname: true
			}
		});
		expect(parseConnectRequest({ network: 'net', ip: '', alias: '' })).toEqual({
			request: { network: 'net', onlyNetwork: false, setHostname: false }
		});
	});
	it.each([
		[null, 'Expected a JSON object'],
		[{ network: '' }, 'network name'],
		[{ network: '../x' }, 'network name'],
		[{ network: 'bridge' }, 'does not connect containers to bridge'],
		[{ network: 'net', ip: '1.2.3' }, 'IPv4'],
		[{ network: 'net', alias: 'Bad Name' }, 'lowercase hostname'],
		[{ network: 'net', onlyNetwork: 'yes' }, 'onlyNetwork'],
		[{ network: 'net', setHostname: true }, 'needs an alias']
	])('rejects %j', (body, problem) => {
		const result = parseConnectRequest(body);
		expect('error' in result && result.error).toContain(problem);
	});
});

describe('planConnect', () => {
	const request = { network: 'keflavik_oplan', onlyNetwork: false, setHostname: false };

	it('keeps existing networks by default', () => {
		expect(planConnect(bridgeOnly, { ...request, ip: '192.168.103.101', alias: 'twr' })).toEqual(
			[{ action: 'connect', network: 'keflavik_oplan', ip: '192.168.103.101', alias: 'twr' }]
		);
	});
	it('connects first and disconnects the rest when it becomes the only network', () => {
		const current = [...bridgeOnly, { name: 'devtools', ip: '172.30.5.2', aliases: [] }];
		expect(planConnect(current, { ...request, onlyNetwork: true })).toEqual([
			{ action: 'connect', network: 'keflavik_oplan' },
			{ action: 'disconnect', network: 'bridge' },
			{ action: 'disconnect', network: 'devtools' }
		]);
	});
	it('uses bridge as a temporary route to change the address on the only network', () => {
		const current = [{ name: 'keflavik_oplan', ip: '192.168.103.200', aliases: [] }];
		expect(planConnect(current, { ...request, ip: '192.168.103.101' })).toEqual([
			{ action: 'connect', network: 'bridge' },
			{ action: 'disconnect', network: 'keflavik_oplan' },
			{ action: 'connect', network: 'keflavik_oplan', ip: '192.168.103.101' },
			{ action: 'disconnect', network: 'bridge' }
		]);
	});
	it('reconnects in place when another network keeps a route', () => {
		const current = [...bridgeOnly, { name: 'keflavik_oplan', ip: '192.168.103.200', aliases: [] }];
		expect(planConnect(current, request)).toEqual([
			{ action: 'disconnect', network: 'keflavik_oplan' },
			{ action: 'connect', network: 'keflavik_oplan' }
		]);
	});
});

describe('planDisconnect and stepCommand', () => {
	it('connects bridge before it leaves the last network', () => {
		const current = [{ name: 'keflavik_oplan', ip: '192.168.103.101', aliases: [] }];
		expect(planDisconnect(current, 'keflavik_oplan')).toEqual([
			{ action: 'connect', network: 'bridge' },
			{ action: 'disconnect', network: 'keflavik_oplan' }
		]);
	});
	it('only disconnects when another network remains, and plans nothing for a stranger', () => {
		const current = [...bridgeOnly, { name: 'keflavik_oplan', ip: '', aliases: [] }];
		expect(planDisconnect(current, 'keflavik_oplan')).toEqual([
			{ action: 'disconnect', network: 'keflavik_oplan' }
		]);
		expect(planDisconnect(current, 'unknown')).toEqual([]);
	});
	it('prints the CLI equivalent', () => {
		expect(
			stepCommand(
				{ action: 'connect', network: 'keflavik_oplan', ip: '192.168.103.101', alias: 'twr' },
				'/brave_hopper'
			)
		).toBe('docker network connect --ip 192.168.103.101 --alias twr keflavik_oplan brave_hopper');
	});
});
