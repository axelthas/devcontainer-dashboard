/**
 * Read-only MCP server over stateless Streamable HTTP: every POST gets its own server and transport,
 * so nothing has to survive between requests.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { harnessAddress, isHarnessLoopbackOnly, isHarnessPort } from '$lib/harness';
import type { PolarisInstance } from '$lib/types';

export interface McpInventory {
	listInstances(): Promise<PolarisInstance[]>;
	listSources(): Promise<
		{ type: string; tags: string[]; allServices: string[]; defaultServices: string[] }[]
	>;
}

const HARNESS_NOTES = {
	protocol:
		'JSON-RPC 2.0 over TCP: send one JSON object per line, read one JSON object per line. Call livenessMethod to check that a harness is listening.',
	addresses:
		'A published address uses the host this MCP request came in on. A harness with hostBinding 127.0.0.1 is reachable only on that server or through an SSH tunnel to it. Without a published port, address is on the sandbox network, reachable only from the server.',
	safety:
		'Harnesses are unauthenticated and send real commands. Use them only with sandbox and training stacks.'
};

const LOG_NOTES = {
	application:
		'/var/log/polaris/<program>.<yymmdd>.log, one file per program. List them with: ls -t /var/log/polaris',
	processes:
		'/var/log/supervisor/supervisord.log records program starts and crashes. Current state: supervisorctl status',
	provisioning: '/var/log/ansible/ansible.log records configuration and mode switches.',
	containerOutput:
		'Run the dockerLogs command for the container output. It holds little beyond supervisor messages.'
};

const ACCESS_NOTES = {
	usage:
		'Each command in access is complete. Append a remote command to ssh or dockerExec to run it, for example: tail -n 200 /var/log/polaris/<file>. ssh without a remote command opens a root shell.',
	fallback:
		'If ssh is denied, the container does not have your key: use dockerExec, which only needs access to the server. On the server itself, leave out -J and the server hop.',
	safety:
		'You are root in a privileged sandbox container on a host that others may share. Read freely, and change things only when asked.'
};

const SERVER_INSTRUCTIONS =
	'Read-only inventory of Polaris sandbox instances. list_instances gives harness addresses. get_instance adds, per container, the commands to log in over SSH and read logs, with notes on where the logs are. Port numbers change when containers are recreated, so read them here instead of remembering them.';

const SERVICE_NAMES: Record<string, { name: string; web: boolean }> = {
	'5904': { name: 'vnc', web: false },
	'6904': { name: 'novnc', web: true },
	'9001': { name: 'supervisor', web: true }
};

function describeHarnesses(instance: PolarisInstance, hostname: string) {
	return instance.containers.flatMap((container) =>
		(container.harnesses ?? []).map((harness) => ({
			kind: harness.kind,
			label: harness.label,
			container: container.name.replace(/^\//, ''),
			state: container.state,
			address: harnessAddress(harness, hostname) ?? null,
			containerAddress: harness.containerAddress ?? null,
			hostBinding: harness.hostIp ?? null,
			loopbackOnly: isHarnessLoopbackOnly(harness),
			livenessMethod: harness.livenessMethod
		}))
	);
}

function describeInstance(instance: PolarisInstance, hostname: string) {
	return {
		id: instance.id,
		type: instance.type,
		subnet: instance.subnet,
		managedByDashboard: instance.managedByDashboard,
		mode: instance.currentMode ?? null,
		containersRunning: instance.containers.filter((c) => c.state === 'running').length,
		containersTotal: instance.containers.length,
		harnesses: describeHarnesses(instance, hostname)
	};
}

/**
 * Commands to reach a running container through the configured hops, for example
 * "bastion,user@server". The last hop is the Docker host, the only one that can run docker.
 */
function describeAccess(
	instanceId: string,
	name: string,
	ipAddress: string | undefined,
	sshJump: string | undefined
) {
	const hops =
		sshJump
			?.split(',')
			.map((hop) => hop.trim())
			.filter(Boolean) ?? [];
	const jumpTo = (list: string[]) => (list.length ? `-J ${list.join(',')} ` : '');
	const onServer = hops.length
		? `ssh ${jumpTo(hops.slice(0, -1))}-o BatchMode=yes ${hops.at(-1)} `
		: '';
	return {
		// The alias keeps sandbox host keys apart from a local sandbox on the same addresses.
		ssh: ipAddress
			? `ssh ${jumpTo(hops)}-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o HostKeyAlias=${instanceId}.${name} root@${ipAddress}`
			: null,
		dockerExec: `${onServer}docker exec ${name}`,
		dockerLogs: `${onServer}docker logs --tail 200 ${name}`
	};
}

function describeContainers(
	instance: PolarisInstance,
	hostname: string,
	sshJump: string | undefined
) {
	return instance.containers.map((container) => ({
		name: container.name.replace(/^\//, ''),
		state: container.state,
		image: container.image,
		ip: container.ipAddress ?? null,
		access:
			container.state === 'running'
				? describeAccess(
						instance.id,
						container.name.replace(/^\//, ''),
						container.ipAddress,
						sshJump
					)
				: null,
		services: Object.fromEntries(
			Object.entries(container.ports)
				.filter(([containerPort]) => !isHarnessPort(containerPort))
				.map(([containerPort, hostPort]) => {
					const service = SERVICE_NAMES[containerPort];
					const address = `${hostname}:${hostPort}`;
					return [
						service?.name ?? `port-${containerPort}`,
						service?.web ? `http://${address}` : address
					];
				})
		)
	}));
}

function jsonResult(value: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function createMcpServer(
	inventory: McpInventory,
	hostname: string,
	sshJump: string | undefined
): McpServer {
	const server = new McpServer(
		{ name: 'polaris-dashboard', version: '1.1.0' },
		{ instructions: SERVER_INSTRUCTIONS }
	);
	const readOnly = { readOnlyHint: true, openWorldHint: false };

	server.registerTool(
		'list_instances',
		{
			title: 'List Polaris instances',
			description:
				'Lists Polaris instances on this host with their state and the addresses of their test harnesses (ASD, Orion pilot, Orion creator, TAToo).',
			annotations: readOnly
		},
		async () =>
			jsonResult({
				instances: (await inventory.listInstances()).map((i) => describeInstance(i, hostname)),
				harnessNotes: HARNESS_NOTES
			})
	);

	server.registerTool(
		'get_instance',
		{
			title: 'Get a Polaris instance',
			description:
				'Returns one Polaris instance with its containers, their addresses and their VNC, noVNC and supervisor ports, plus the commands to log in to a container over SSH and read its logs.',
			inputSchema: { id: z.string().describe('Instance id from list_instances') },
			annotations: readOnly
		},
		async ({ id }) => {
			const instances = await inventory.listInstances();
			const instance = instances.find((i) => i.id === id);
			if (!instance) {
				const known = instances.map((i) => i.id).join(', ') || 'none';
				return {
					...jsonResult({ error: `Unknown instance "${id}". Known instances: ${known}` }),
					isError: true
				};
			}
			return jsonResult({
				...describeInstance(instance, hostname),
				containers: describeContainers(instance, hostname, sshJump),
				harnessNotes: HARNESS_NOTES,
				logNotes: LOG_NOTES,
				accessNotes: ACCESS_NOTES
			});
		}
	);

	server.registerTool(
		'list_sources',
		{
			title: 'List Polaris sources',
			description:
				'Lists the Polaris source types on this host with their image tags and services. harnessTags are overlay images that carry the test harnesses, which dashboard-created instances cannot use yet.',
			annotations: readOnly
		},
		async () =>
			jsonResult({
				sources: (await inventory.listSources()).map(({ tags, ...source }) => ({
					...source,
					tags: tags.filter((tag) => !tag.startsWith('mcp')),
					harnessTags: tags.filter((tag) => tag.startsWith('mcp'))
				}))
			})
	);

	return server;
}

/** Browsers send Origin; a request from another site must not reach the server (DNS rebinding). */
function isForeignOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	if (!origin) return false;
	try {
		return new URL(origin).host !== new URL(request.url).host;
	} catch {
		return true;
	}
}

export async function handleMcpRequest(
	request: Request,
	inventory: McpInventory,
	sshJump = process.env.POLARIS_SSH_JUMP
): Promise<Response> {
	if (isForeignOrigin(request)) {
		return new Response(JSON.stringify({ message: 'Origin not allowed' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const server = createMcpServer(inventory, new URL(request.url).hostname, sshJump);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	await server.connect(transport);
	return transport.handleRequest(request);
}
