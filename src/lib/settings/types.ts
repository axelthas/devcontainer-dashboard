/** Client-safe Settings contract. Secret values never appear in read responses. */
export type SettingValue = string | number | boolean | string[];
export interface ManagedConfig {
	schemaVersion: number;
	instanceName: string;
	restartPolicy: string;
	settings: Record<string, SettingValue>;
	source?: { mode: string; ref?: string; checkout?: string; revision?: string };
}
export interface SettingDefinition {
	type: string;
	title: string;
	description: string;
	default?: SettingValue;
	minimum?: number;
	maximum?: number;
	'x-section': string;
	'x-apply': string;
	'x-web-editable'?: boolean;
}
export interface SettingsSnapshot {
	available: true;
	config: ManagedConfig;
	revision: string;
	schema: { properties: { settings: { properties: Record<string, SettingDefinition> } } };
	path: string;
	pending: boolean;
	appliedAt: number | null;
	appliedUrl: string | null;
	applyCommand: string;
	environment: { name: string; secret: boolean; set: boolean; value?: string }[];
	environmentEditable: boolean;
}
export type SettingsResult = SettingsSnapshot | { available: false; message: string };
export const SECTIONS = [
	{
		id: 'general',
		title: 'General',
		description: 'Name this host and choose the DevHarbour image.'
	},
	{
		id: 'access',
		title: 'Access',
		description: 'Localhost by default. Remote access is always an explicit choice.'
	},
	{
		id: 'host',
		title: 'Host and SSH',
		description: 'Paths and identity belong to the Docker host, not your browser.'
	},
	{
		id: 'env',
		title: 'Devcontainers',
		description:
			'Environment values for managed builds. Existing containers need an explicit rebuild.'
	},
	{
		id: 'ai',
		title: 'AI and MCP',
		description: 'OpenChamber is the AI web interface. MCP agents need individual container grants.'
	},
	{
		id: 'bootstrap',
		title: 'Bootstrap',
		description: 'Startup tools and VS Code connection settings.'
	},
	{
		id: 'file',
		title: 'Config file',
		description: 'One host configuration, shared by the CLI and this page.'
	}
] as const;

/** Redacted persistent operation state, readable after login to a replacement. */
export interface ApplyOperation {
	id: string;
	phase: 'queued' | 'validate' | 'image' | 'recreate' | 'health' | 'succeeded' | 'failed';
	message: string;
	startedAt: number;
	updatedAt: number;
	targetUrl: string;
	previousUrl: string | null;
}
export interface ApplyReview {
	token: string;
	revision: string;
	expiresAt: number;
	requiresExposure: boolean;
	targetUrl: string;
	previousUrl: string | null;
	changes: { key: string; before: unknown; after: unknown }[];
}
