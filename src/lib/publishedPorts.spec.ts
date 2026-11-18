import { describe, expect, it } from 'vitest';
import {
	addressExposure,
	containerExposure,
	copyAddress,
	displayAddress,
	foldBindings,
	webProtocol
} from './publishedPorts';

const binding = (containerPort: string, hostPort: string, hostIp: string, protocol = 'tcp') => ({
	containerPort,
	hostPort,
	hostIp,
	protocol
});

describe('foldBindings', () => {
	it('folds IPv4 and IPv6 bindings of one port into one line, sorted by port', () => {
		expect(
			foldBindings([
				binding('9001', '32802', '0.0.0.0'),
				binding('5904', '32800', '0.0.0.0'),
				binding('5904', '32800', '::'),
				binding('9001', '32802', '::')
			])
		).toEqual([
			{
				containerPort: '5904',
				protocol: 'tcp',
				hostPort: '32800',
				addresses: ['0.0.0.0', '::'],
				exposure: 'all'
			},
			{
				containerPort: '9001',
				protocol: 'tcp',
				hostPort: '32802',
				addresses: ['0.0.0.0', '::'],
				exposure: 'all'
			}
		]);
	});

	it('keeps different host ports and transports apart', () => {
		const folded = foldBindings([
			binding('53', '1053', '0.0.0.0', 'udp'),
			binding('53', '1053', '0.0.0.0'),
			binding('8080', '18080', '0.0.0.0'),
			binding('8080', '18081', '::')
		]);
		expect(folded.map((port) => `${port.containerPort}/${port.protocol}:${port.hostPort}`)).toEqual(
			['53/tcp:1053', '53/udp:1053', '8080/tcp:18080', '8080/tcp:18081']
		);
	});

	it('returns no lines for a container without bindings', () => {
		expect(foldBindings(undefined)).toEqual([]);
	});
});

describe('exposure', () => {
	it('reports the widest exposure', () => {
		expect(addressExposure(['127.0.0.1', '::1'])).toBe('loopback');
		expect(addressExposure(['127.0.0.1', '0.0.0.0'])).toBe('all');
		expect(addressExposure(['192.168.1.10'])).toBe('specific');
		expect(addressExposure([''])).toBe('default');
		expect(containerExposure(undefined)).toBeNull();
		expect(
			containerExposure([binding('3306', '33306', '127.0.0.1'), binding('80', '8080', '::')])
		).toBe('all');
	});
});

describe('webProtocol', () => {
	it('uses only the service port policy and never treats UDP as web', () => {
		const policy = { '6904': 'http', '8443': 'https', '8080': 'off' } as const;
		expect(webProtocol(policy, '6904')).toBe('http');
		expect(webProtocol(policy, '8443')).toBe('https');
		expect(webProtocol(policy, '8080')).toBeNull();
		expect(webProtocol(policy, '5904')).toBeNull();
		expect(webProtocol(policy, '6904', 'udp')).toBeNull();
	});
});

describe('addresses', () => {
	it('displays and copies the address a client can use', () => {
		expect(displayAddress('::')).toBe('[::]');
		expect(displayAddress('')).toBe('*');
		const [wild] = foldBindings([
			binding('5904', '32800', '0.0.0.0'),
			binding('5904', '32800', '::')
		]);
		expect(copyAddress(wild, 'devbox.example.ts.net')).toBe('devbox.example.ts.net:32800');
		const [local] = foldBindings([binding('3306', '33306', '127.0.0.1')]);
		expect(copyAddress(local, 'devbox.example.ts.net')).toBe('127.0.0.1:33306');
		const [six] = foldBindings([binding('3306', '33306', '::1')]);
		expect(copyAddress(six, 'devbox')).toBe('[::1]:33306');
		const [lan] = foldBindings([binding('80', '8080', '192.168.1.10')]);
		expect(copyAddress(lan, 'devbox')).toBe('192.168.1.10:8080');
	});
});
