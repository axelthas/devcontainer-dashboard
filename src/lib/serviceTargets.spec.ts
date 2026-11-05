import { describe, expect, it } from 'vitest';
import {
	embedProfile,
	serviceDirectUrl,
	serviceProxyPath,
	serviceViewerHref
} from './serviceTargets';

describe('embedProfile', () => {
	it('treats verified prefix-capable services as prefix-embeddable', () => {
		expect(embedProfile('9001')).toEqual({ mode: 'prefix' });
		expect(embedProfile('6904')).toEqual({ mode: 'prefix', wsPathQuery: 'websockify' });
	});

	it('defaults unknown ports to direct navigation', () => {
		expect(embedProfile('4096')).toEqual({ mode: 'direct' });
		expect(embedProfile('12345')).toEqual({ mode: 'direct' });
	});
});

describe('serviceProxyPath', () => {
	it('returns the gateway prefix path', () => {
		expect(serviceProxyPath('abcdef123456', '9001')).toBe('/service-proxy/abcdef123456/9001/');
	});

	it('appends the WebSocket path hint for prefix apps that derive it from location', () => {
		expect(serviceProxyPath('abcdef123456', '6904')).toBe(
			'/service-proxy/abcdef123456/6904/?path=service-proxy/abcdef123456/6904/websockify'
		);
	});
});

describe('serviceViewerHref', () => {
	it('builds the identity-only href', () => {
		expect(serviceViewerHref({ containerId: 'abcdef123456', containerPort: '9001' })).toBe(
			'/service?cid=abcdef123456&port=9001'
		);
	});

	it('includes metadata and the ports map only when switching is meaningful', () => {
		const href = serviceViewerHref({
			containerId: 'abcdef123456',
			containerPort: '9001',
			label: 'Supervisor',
			projectName: 'demo',
			containerName: 'vsc-demo',
			workspacePath: '/workspaces/demo',
			allPorts: { '9001': '32771', '6904': '32772' }
		});
		const params = new URLSearchParams(href.slice('/service?'.length));
		expect(params.get('cid')).toBe('abcdef123456');
		expect(params.get('port')).toBe('9001');
		expect(params.get('label')).toBe('Supervisor');
		expect(params.get('project')).toBe('demo');
		expect(params.get('container')).toBe('vsc-demo');
		expect(params.get('path')).toBe('/workspaces/demo');
		expect(JSON.parse(params.get('ports') ?? '{}')).toEqual({ '9001': '32771', '6904': '32772' });
	});

	it('omits the ports map when there is nothing to switch between', () => {
		const href = serviceViewerHref({
			containerId: 'abcdef123456',
			containerPort: '9001',
			allPorts: { '9001': '32771' }
		});
		expect(href).toBe('/service?cid=abcdef123456&port=9001');
	});
});

describe('serviceDirectUrl', () => {
	it('builds the best-effort direct HTTP URL', () => {
		expect(serviceDirectUrl('dashboard.tailnet.ts.net', '32771')).toBe(
			'http://dashboard.tailnet.ts.net:32771'
		);
	});
});
