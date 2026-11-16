/** AI launch identities are separate from conversations, which applications create on first send. */
export type AiTool = 'opencode' | 'openchamber';
export type AiRequest = { launch: string; path: string; tool: AiTool };

/** Window identities are filenames, terminal IDs and URL parameters. */
export function validAiId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(value);
}
