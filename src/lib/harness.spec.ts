import { describe, expect, it } from 'vitest';
import {
	findHarnessEndpoints,
	harnessAddress,
	isHarnessLoopbackOnly,
	isHarnessPort
} from './harness';

describe('findHarnessEndpoints', () => {
	it('finds a declared, unpublished harness and its address on the sandbox network', () => {
		const [endpoint] = findHarnessEndpoints(
			[
				{ PrivatePort: 19777, Type: 'tcp' },
				{ PrivatePort: 6904, PublicPort: 32793, IP: '0.0.0.0', Type: 'tcp' }
			],
			'192.168.108.121'
		);
		expect(endpoint).toMatchObject({
			kind: 'asd',
			containerAddress: '192.168.108.121:19777',
			livenessMethod: 'get_header_info'
		});
		expect(endpoint.hostPort).toBeUndefined();
	});

	it('returns nothing for a plain sandbox container', () => {
		expect(
			findHarnessEndpoints([{ PrivatePort: 6904, PublicPort: 32793, IP: '0.0.0.0', Type: 'tcp' }])
		).toEqual([]);
		expect(findHarnessEndpoints(undefined)).toEqual([]);
	});

	it('finds both Orion harnesses in port order', () => {
		const endpoints = findHarnessEndpoints([
			{ PrivatePort: 19779, Type: 'tcp' },
			{ PrivatePort: 19778, Type: 'tcp' }
		]);
		expect(endpoints.map((e) => e.kind)).toEqual(['orion-pilot', 'orion-creator']);
	});

	it('prefers the IPv4 binding, whichever order Docker lists them in', () => {
		for (const ports of [
			[
				{ PrivatePort: 9776, PublicPort: 40001, IP: '::', Type: 'tcp' },
				{ PrivatePort: 9776, PublicPort: 40000, IP: '0.0.0.0', Type: 'tcp' }
			],
			[
				{ PrivatePort: 9776, PublicPort: 40000, IP: '0.0.0.0', Type: 'tcp' },
				{ PrivatePort: 9776, PublicPort: 40001, IP: '::', Type: 'tcp' }
			]
		]) {
			expect(findHarnessEndpoints(ports)[0]).toMatchObject({
				hostPort: '40000',
				hostIp: '0.0.0.0'
			});
		}
	});

	it('ignores a UDP port with a harness number', () => {
		expect(findHarnessEndpoints([{ PrivatePort: 9776, Type: 'udp' }])).toEqual([]);
	});
});

describe('harnessAddress', () => {
	const [unpublished] = findHarnessEndpoints(
		[{ PrivatePort: 19777, Type: 'tcp' }],
		'192.168.108.121'
	);
	const [published] = findHarnessEndpoints(
		[{ PrivatePort: 19777, PublicPort: 32800, IP: '127.0.0.1', Type: 'tcp' }],
		'192.168.108.121'
	);

	it('uses the host the client came in on for a published port', () => {
		expect(harnessAddress(published, '203.0.113.14')).toBe('203.0.113.14:32800');
		expect(isHarnessLoopbackOnly(published)).toBe(true);
	});

	it('falls back to the sandbox network address', () => {
		expect(harnessAddress(unpublished, '203.0.113.14')).toBe('192.168.108.121:19777');
		expect(isHarnessLoopbackOnly(unpublished)).toBe(false);
	});
});

describe('isHarnessPort', () => {
	it('accepts strings and numbers', () => {
		expect(isHarnessPort('19778')).toBe(true);
		expect(isHarnessPort(9776)).toBe(true);
		expect(isHarnessPort('6904')).toBe(false);
	});
});
