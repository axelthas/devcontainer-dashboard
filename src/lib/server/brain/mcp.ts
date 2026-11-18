/**
 * Minimal MCP server over JSON-RPC 2.0: initialize, ping, tools/list and tools/call. The
 * Streamable HTTP transport answers each POST with one JSON response; this server never
 * opens an SSE stream and never sends requests to the client.
 */
import { BRAIN_TOOLS, callTool, type ToolResult } from './tools.js';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = {
	name: 'devcontainer-dashboard',
	title: 'Devcontainer Dashboard',
	version: '0.1.0'
};
const INSTRUCTIONS =
	'This server runs shell commands in containers that the operator granted to you in the Devcontainer Dashboard. Call list_targets first. Use only the listed target_id values, choose the target that matches the task, and ask the user when more than one target could match. Never assume that access to one container implies access to another.';

type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: JsonRpcId;
	result?: unknown;
	error?: { code: number; message: string };
}

type ToolCaller = (name: string, input: unknown) => Promise<ToolResult>;

/** Build a JSON-RPC error response. */
function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Plain object check that rejects arrays and null. */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Handle one JSON-RPC message. Returns null for notifications and client responses, which
 * the transport acknowledges with 202 Accepted.
 */
export async function handleMcpMessage(
	message: unknown,
	call: ToolCaller = callTool
): Promise<JsonRpcResponse | null> {
	if (Array.isArray(message)) return rpcError(null, -32600, 'Batch requests are not supported');
	if (!isObject(message) || message.jsonrpc !== '2.0')
		return rpcError(null, -32600, 'Invalid JSON-RPC message');
	const rawId = message.id;
	const hasId = rawId !== undefined;
	if (hasId && typeof rawId !== 'string' && typeof rawId !== 'number')
		return rpcError(null, -32600, 'Invalid request id');
	const id: JsonRpcId = hasId ? (rawId as string | number) : null;
	if (typeof message.method !== 'string') {
		// A response to a server request; this server sends none.
		if (hasId && ('result' in message || 'error' in message)) return null;
		return rpcError(id, -32600, 'Invalid JSON-RPC message');
	}
	// Notifications (initialized, cancelled) need no reply.
	if (!hasId) return null;
	const params = message.params === undefined ? {} : message.params;
	if (!isObject(params)) return rpcError(id, -32602, 'params must be an object');
	try {
		switch (message.method) {
			case 'initialize': {
				const requested = params.protocolVersion;
				const protocolVersion =
					typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
						? requested
						: SUPPORTED_PROTOCOL_VERSIONS[0];
				return {
					jsonrpc: '2.0',
					id,
					result: {
						protocolVersion,
						capabilities: { tools: { listChanged: false } },
						serverInfo: SERVER_INFO,
						instructions: INSTRUCTIONS
					}
				};
			}
			case 'ping':
				return { jsonrpc: '2.0', id, result: {} };
			case 'tools/list':
				return { jsonrpc: '2.0', id, result: { tools: BRAIN_TOOLS } };
			case 'tools/call': {
				const name = params.name;
				if (typeof name !== 'string' || !BRAIN_TOOLS.some((tool) => tool.name === name))
					return rpcError(id, -32602, `Unknown tool: ${String(name).slice(0, 64)}`);
				return { jsonrpc: '2.0', id, result: await call(name, params.arguments) };
			}
			default:
				return rpcError(id, -32601, 'Method not found');
		}
	} catch (cause) {
		console.error('[brain] MCP request failed', cause);
		return rpcError(id, -32603, 'Internal error');
	}
}
