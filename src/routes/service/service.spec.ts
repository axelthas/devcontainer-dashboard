import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerInspection } from '$lib/server/serviceGateway';

vi.mock('$lib/server/docker', () => ({
	default: { getContainer: vi.fn() }
}));

const { load } = await import('./+page.server');
const docker = (await import('$lib/server/docker')).default as {
	getContainer: (id: string) => { inspect: () => Promise<ContainerInspection> };
};

const SHORT_ID = 'abcdef123456';
const FULL_ID = `${SHORT_ID}${'a'.repeat(52)}`;

function inspection(changes: Partial<ContainerInspection> = {}): ContainerInspection {
	return {
		Id: FULL_ID,
		State: { Running: true },
		NetworkSettings: {
			Ports: { '9001/tcp': [{ HostIp: '[IP_ADDRESS]', HostPort: '32771' }] },
			Networks: { bridge: { IPAddress: '[IP_ADDRESS]' } }
		},
		...changes
	};
}

function loadEvent(search: string): Parameters<typeof load>[0] {
	return { url: new URL(`http://dashboard.tailnet.ts.net/service${search}`) } as Parameters<
		typeof load
	>[0];
}

interface ViewerData {
	label: string;
	project: string;
	container: string;
	workspacePath: string;
	allPorts: Record<string, string> | null;
	containerId: string | null;
	containerPort: string | null;
	viewer: {
		kind: 'proxy' | 'legacy' | 'unsupported' | 'unavailable' | 'proxy-disabled';
		target?: string;
		directUrl?: string;
		containerId?: string;
		containerPort?: string;
		reason?: string;
	};
}

async function callLoad(search: string): Promise<ViewerData> {
	return (await load(loadEvent(search))) as ViewerData;
}

beforeEach(() => {
	process.env.SERVICE_PROXY_ENABLED = '1';
	delete process.env.SERVICE_PROXY_PORTS;
	vi.mocked(docker.getContainer).mockClear();
});

afterEach(() => {
	delete process.env.SERVICE_PROXY_ENABLED;
	delete process.env.SERVICE_PROXY_PORTS;
});

describe('service viewer load', () => {
	it('keeps the legacy raw-URL contract for non-gateway deployments', async () => {
		delete process.env.SERVICE_PROXY_ENABLED;
		const data = await callLoad(
			'?url=http%3A%2F%2Flocalhost%3A9001&label=Supervisor&container=demo'
		);
		expect(data.viewer).toMatchObject({ kind: 'legacy', target: 'http://localhost:9001' });
		expect(data.viewer.directUrl).toBe('http://localhost:9001');
		expect(data.container).toBe('demo');
	});

	it('asks for a validated identity when none is provided', async () => {
		const data = await callLoad('');
		expect(data.viewer).toMatchObject({ kind: 'unavailable', reason: 'missing-identity' });
	});

	it('reports the disabled gateway for identity links without the opt-in flag', async () => {
		delete process.env.SERVICE_PROXY_ENABLED;
		const data = await callLoad(`?cid=${SHORT_ID}&port=9001`);
		expect(data.viewer).toMatchObject({
			kind: 'proxy-disabled',
			containerId: SHORT_ID,
			containerPort: '9001'
		});
		expect(docker.getContainer).not.toHaveBeenCalled();
	});

	it('embeds verified prefix-capable services through the gateway path proxy', async () => {
		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () => Promise.resolve(inspection())
		}));
		const data = await callLoad(`?cid=${SHORT_ID}&port=9001`);
		expect(data.viewer).toMatchObject({
			kind: 'proxy',
			containerId: SHORT_ID,
			containerPort: '9001',
			target: '/service-proxy/abcdef123456/9001/',
			directUrl: 'http://dashboard.tailnet.ts.net:32771'
		});
	});

	it('steers noVNC WebSocket traffic into the prefix with its query hint', async () => {
		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () =>
				Promise.resolve(
					inspection({
						NetworkSettings: {
							Ports: { '6904/tcp': [{ HostIp: '[IP_ADDRESS]', HostPort: '32772' }] },
							Networks: { bridge: { IPAddress: '[IP_ADDRESS]' } }
						}
					})
				)
		}));
		const data = await callLoad(`?cid=${SHORT_ID}&port=6904`);
		expect(data.viewer).toMatchObject({
			kind: 'proxy',
			target: '/service-proxy/abcdef123456/6904/?path=service-proxy/abcdef123456/6904/websockify'
		});
	});

	it('sends verified root-absolute applications to the explicit unsupported state', async () => {
		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () =>
				Promise.resolve(
					inspection({
						NetworkSettings: {
							Ports: { '4096/tcp': [{ HostIp: '[IP_ADDRESS]', HostPort: '32774' }] },
							Networks: { bridge: { IPAddress: '[IP_ADDRESS]' } }
						}
					})
				)
		}));
		const data = await callLoad(`?cid=${SHORT_ID}&port=4096`);
		expect(data.viewer).toMatchObject({
			kind: 'unsupported',
			directUrl: 'http://dashboard.tailnet.ts.net:32774'
		});
	});

	it('maps stopped or vanished containers to actionable unavailable states', async () => {
		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () => Promise.resolve(inspection({ State: { Running: false } }))
		}));
		const stopped = await callLoad(
			`?cid=${SHORT_ID}&port=9001&ports=${encodeURIComponent(JSON.stringify({ '9001': '32771' }))}`
		);
		expect(stopped.viewer).toMatchObject({
			kind: 'unavailable',
			reason: 'not-running',
			directUrl: 'http://dashboard.tailnet.ts.net:32771'
		});

		vi.mocked(docker.getContainer).mockImplementation(() => ({
			inspect: () => Promise.reject(new Error('no such container'))
		}));
		const gone = await callLoad(`?cid=${SHORT_ID}&port=9001`);
		expect(gone.viewer).toMatchObject({ kind: 'unavailable', reason: 'unknown-container' });
	});

	it('ignores malformed ports metadata instead of trusting it', async () => {
		const data = await callLoad('?ports=not-json&url=http%3A%2F%2Flocalhost%3A9001');
		expect(data.allPorts).toBeNull();
		expect(data.viewer).toMatchObject({ kind: 'legacy', target: 'http://localhost:9001' });
	});
});
