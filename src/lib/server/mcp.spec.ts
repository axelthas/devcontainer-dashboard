import { describe, expect, it } from 'vitest';
import { findHarnessEndpoints } from '$lib/harness';
import type { PolarisInstance } from '$lib/types';
import { handleMcpRequest, type McpInventory } from './mcp';

const instance: PolarisInstance = {
	id: 'polaris-mcp-58',
	type: 'polaris-ice',
	subnet: '192.168.108.0/24',
	managedByDashboard: false,
	currentMode: 'training',
	containers: [
		{
			id: 'abc',
			name: '/polaris-ice-app1-asd-a',
			projectName: 'polaris-ice-app1-asd-a',
			state: 'running',
			isDevcontainer: false,
			image: 'registry.example.com/polaris-ice-sandbox-polaris-asd:mcp-26.0.58',
			ipAddress: '192.168.108.121',
			ports: { '6904': '32793', '5904': '32792', '19777': '32800' },
			harnesses: findHarnessEndpoints(
				[{ PrivatePort: 19777, PublicPort: 32800, IP: '127.0.0.1', Type: 'tcp' }],
				'192.168.108.121'
			)
		},
		{
			id: 'def',
			name: '/polaris-ice-fdp-a',
			projectName: 'polaris-ice-fdp-a',
			state: 'exited',
			isDevcontainer: false,
			image: 'registry.example.com/polaris-ice-sandbox-polaris-fdp:26.0.58',
			ports: {}
		}
	]
};

const inventory: McpInventory = {
	listInstances: async () => [instance],
	listSources: async () => [
		{
			type: 'polaris-ice',
			tags: ['26.0.58', 'mcp-26.0.58'],
			allServices: ['fdp-a'],
			defaultServices: ['fdp-a']
		}
	]
};

function post(body: unknown, headers: Record<string, string> = {}, sshJump?: string) {
	return handleMcpRequest(
		new Request('http://203.0.113.14:3000/mcp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2025-06-18',
				...headers
			},
			body: JSON.stringify(body)
		}),
		inventory,
		sshJump
	);
}

async function callTool(name: string, args: Record<string, unknown> = {}, sshJump?: string) {
	const response = await post(
		{
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name, arguments: args }
		},
		{},
		sshJump
	);
	const { result } = await response.json();
	return { isError: result.isError, data: JSON.parse(result.content[0].text) };
}

describe('MCP endpoint', () => {
	it('answers initialize without creating a session', async () => {
		const response = await post({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'test', version: '1' }
			}
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('mcp-session-id')).toBeNull();
		const { result } = await response.json();
		expect(result.serverInfo.name).toBe('polaris-dashboard');
		expect(result.capabilities.tools).toBeDefined();
	});

	it('exposes only read-only tools', async () => {
		const response = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
		const { result } = await response.json();
		expect(result.tools.map((t: { name: string }) => t.name)).toEqual([
			'list_instances',
			'get_instance',
			'list_sources'
		]);
		for (const tool of result.tools) expect(tool.annotations.readOnlyHint).toBe(true);
	});

	it('lists harness addresses using the host of the request', async () => {
		const { data } = await callTool('list_instances');
		expect(data.instances[0]).toMatchObject({
			id: 'polaris-mcp-58',
			containersRunning: 1,
			containersTotal: 2,
			mode: 'training'
		});
		expect(data.instances[0].harnesses).toEqual([
			{
				kind: 'asd',
				label: 'ASD',
				container: 'polaris-ice-app1-asd-a',
				state: 'running',
				address: '203.0.113.14:32800',
				containerAddress: '192.168.108.121:19777',
				hostBinding: '127.0.0.1',
				loopbackOnly: true,
				livenessMethod: 'get_header_info'
			}
		]);
	});

	it('returns container services without repeating the harness port', async () => {
		const { data } = await callTool('get_instance', { id: 'polaris-mcp-58' });
		expect(data.containers[0].services).toEqual({
			novnc: 'http://203.0.113.14:32793',
			vnc: '203.0.113.14:32792'
		});
		expect(data.containers[1]).toMatchObject({ state: 'exited', ip: null, services: {} });
	});

	it('gives SSH and log commands through the configured hops', async () => {
		const { data } = await callTool(
			'get_instance',
			{ id: 'polaris-mcp-58' },
			'bastion.example,user@203.0.113.14'
		);
		expect(data.containers[0].access).toEqual({
			ssh: 'ssh -J bastion.example,user@203.0.113.14 -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o HostKeyAlias=polaris-mcp-58.polaris-ice-app1-asd-a root@192.168.108.121',
			dockerExec:
				'ssh -J bastion.example -o BatchMode=yes user@203.0.113.14 docker exec polaris-ice-app1-asd-a',
			dockerLogs:
				'ssh -J bastion.example -o BatchMode=yes user@203.0.113.14 docker logs --tail 200 polaris-ice-app1-asd-a'
		});
		expect(data.logNotes.application).toContain('/var/log/polaris/');
	});

	it('omits the jump for a single hop', async () => {
		const { data } = await callTool('get_instance', { id: 'polaris-mcp-58' }, 'user@server');
		expect(data.containers[0].access.dockerExec).toBe(
			'ssh -o BatchMode=yes user@server docker exec polaris-ice-app1-asd-a'
		);
	});

	it('gives commands for the server itself when no hops are configured', async () => {
		const { data } = await callTool('get_instance', { id: 'polaris-mcp-58' });
		expect(data.containers[0].access.ssh).toMatch(
			/^ssh -o BatchMode=yes .* root@192\.168\.108\.121$/
		);
		expect(data.containers[0].access.dockerExec).toBe('docker exec polaris-ice-app1-asd-a');
	});

	it('gives no commands for a stopped container', async () => {
		const { data } = await callTool('get_instance', { id: 'polaris-mcp-58' }, 'user@server');
		expect(data.containers[1].access).toBeNull();
	});

	it('points agents at logs and SSH when they connect', async () => {
		const response = await post({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'test', version: '1' }
			}
		});
		const { result } = await response.json();
		expect(result.instructions).toMatch(/SSH/);
		expect(result.instructions).toMatch(/logs/);
	});

	it('reports an unknown instance as a tool error that names the known ones', async () => {
		const { isError, data } = await callTool('get_instance', { id: 'nope' });
		expect(isError).toBe(true);
		expect(data.error).toContain('polaris-mcp-58');
	});

	it('separates harness tags from tags a new instance can use', async () => {
		const { data } = await callTool('list_sources');
		expect(data.sources[0]).toMatchObject({ tags: ['26.0.58'], harnessTags: ['mcp-26.0.58'] });
	});

	it('rejects a request from another site', async () => {
		const response = await post(
			{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
			{ Origin: 'http://attacker.example' }
		);
		expect(response.status).toBe(403);
	});

	it('accepts a same-origin request', async () => {
		const response = await post(
			{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
			{ Origin: 'http://203.0.113.14:3000' }
		);
		expect(response.status).toBe(200);
	});
});
