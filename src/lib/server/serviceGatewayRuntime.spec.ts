import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerInspection } from './serviceGateway';

vi.mock('$lib/server/docker', () => ({
	default: { getContainer: vi.fn() }
}));

const { describeServiceTarget, isServiceProxyEnabled, resolveServicePorts } =
	await import('./serviceGatewayRuntime');
const docker = (await import('$lib/server/docker')).default as {
	getContainer: (id: string) => { inspect: () => Promise<ContainerInspection> };
};

function inspection(id: string, changes: Partial<ContainerInspection> = {}): ContainerInspection {
	return {
		Id: id,
		State: { Running: true },
		NetworkSettings: {
			Ports: { '9001/tcp': [{ HostIp: '0.0.0.0', HostPort: '32771' }] },
			Networks: { bridge: { IPAddress: '172.17.0.5' } }
		},
		...changes
	};
}

const SHORT_ID = 'abcdef123456';
const FULL_ID = `${SHORT_ID}${'a'.repeat(52)}`;

beforeEach(() => {
	process.env.SERVICE_PROXY_ENABLED = '1';
	delete process.env.SERVICE_PROXY_PORTS;
	vi.mocked(docker.getContainer).mockClear();
});

afterEach(() => {
	delete process.env.SERVICE_PROXY_ENABLED;
	delete process.env.SERVICE_PROXY_PORTS;
});

describe('isServiceProxyEnabled', () => {
	it('is enabled only by the exact opt-in value', () => {
		process.env.SERVICE_PROXY_ENABLED = '1';
		expect(isServiceProxyEnabled()).toBe(true);
		process.env.SERVICE_PROXY_ENABLED = 'true';
		expect(isServiceProxyEnabled()).toBe(false);
		delete process.env.SERVICE_PROXY_ENABLED;
		expect(isServiceProxyEnabled()).toBe(false);
	});
});

describe('resolveServicePorts', () => {
	it('keeps the built-in defaults without configuration', () => {
		expect(resolveServicePorts()['9001']).toBe('http');
		expect(resolveServicePorts()['443']).toBe('https');
		expect(resolveServicePorts()['5432']).toBeUndefined();
	});

	it('overrides defaults, adds ports, and disables with off', () => {
		process.env.SERVICE_PROXY_PORTS = '9001:HTTPS,8443:https,8080:off';
		const ports = resolveServicePorts();
		expect(ports['9001']).toBe('https');
		expect(ports['8443']).toBe('https');
		expect(ports['8080']).toBe('off');
		expect(ports['80']).toBe('http');
	});

	it('rejects malformed or out-of-range entries', () => {
		process.env.SERVICE_PROXY_PORTS = '9001:ftp';
		expect(() => resolveServicePorts()).toThrow(/SERVICE_PROXY_PORTS/);
		process.env.SERVICE_PROXY_PORTS = '99999:http';
		expect(() => resolveServicePorts()).toThrow(/SERVICE_PROXY_PORTS/);
		process.env.SERVICE_PROXY_PORTS = '9001';
		expect(() => resolveServicePorts()).toThrow(/SERVICE_PROXY_PORTS/);
	});
});

describe('describeServiceTarget', () => {
	it('reports the disabled gateway before touching Docker', async () => {
		delete process.env.SERVICE_PROXY_ENABLED;
		await expect(describeServiceTarget(SHORT_ID, '9001')).resolves.toEqual({
			status: 'proxy-disabled'
		});
		expect(docker.getContainer).not.toHaveBeenCalled();
	});

	it('rejects ports outside the protocol allowlist without touching Docker', async () => {
		await expect(describeServiceTarget(SHORT_ID, '5432')).resolves.toEqual({
			status: 'port-not-allowed'
		});
		expect(docker.getContainer).not.toHaveBeenCalled();
	});

	it('honors the environment policy override', async () => {
		process.env.SERVICE_PROXY_PORTS = '5432:off,9443:https';
		await expect(describeServiceTarget(SHORT_ID, '5432')).resolves.toEqual({
			status: 'port-not-allowed'
		});
		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () =>
				Promise.resolve(
					inspection(FULL_ID, {
						NetworkSettings: {
							Ports: {
								'9443/tcp': [{ HostIp: '[IP_ADDRESS]', HostPort: '32771' }],
								'9001/tcp': [{ HostIp: '[IP_ADDRESS]', HostPort: '32771' }]
							},
							Networks: { bridge: { IPAddress: '[IP_ADDRESS]' } }
						}
					})
				)
		}));
		await expect(describeServiceTarget(SHORT_ID, '9443')).resolves.toEqual({
			status: 'ok',
			protocol: 'https',
			publishedHostPort: 32771
		});
	});

	it('validates a running container by id prefix and published TCP binding', async () => {
		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () => Promise.resolve(inspection(FULL_ID))
		}));
		await expect(describeServiceTarget(SHORT_ID, '9001')).resolves.toEqual({
			status: 'ok',
			protocol: 'http',
			publishedHostPort: 32771
		});
		expect(docker.getContainer).toHaveBeenCalledWith(SHORT_ID);
	});

	it('maps inspect failures, mismatched ids, stopped state, and missing bindings', async () => {
		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () => Promise.reject(new Error('no such container'))
		}));
		await expect(describeServiceTarget(SHORT_ID, '9001')).resolves.toEqual({
			status: 'unknown-container'
		});

		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () =>
				Promise.resolve(
					inspection('ffffffffffff0000000000000000000000000000000000000000000000000000')
				)
		}));
		await expect(describeServiceTarget(SHORT_ID, '9001')).resolves.toEqual({
			status: 'unknown-container'
		});

		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () => Promise.resolve(inspection(FULL_ID, { State: { Running: false } }))
		}));
		await expect(describeServiceTarget(SHORT_ID, '9001')).resolves.toEqual({
			status: 'not-running'
		});

		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () =>
				Promise.resolve(
					inspection(FULL_ID, {
						NetworkSettings: { Ports: {}, Networks: { bridge: { IPAddress: '172.17.0.5' } } }
					})
				)
		}));
		await expect(describeServiceTarget(SHORT_ID, '9001')).resolves.toEqual({
			status: 'no-published-binding'
		});
	});
});
