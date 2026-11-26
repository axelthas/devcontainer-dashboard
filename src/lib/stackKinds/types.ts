/** Public kind metadata. Execution arguments and host paths are server-only. */
export type PresenterId = 'generic' | 'web' | 'database' | 'profile';
export type KindSource = 'compose' | 'operator' | 'label' | 'heuristic' | 'default';
export type ServiceRole = 'app' | 'support';
export type KindEndpoint = {
	port: number;
	label: string;
	protocol: 'http' | 'https' | 'tcp' | 'udp';
};
export interface KindDescriptor {
	kind: string;
	presenter: PresenterId;
	source: KindSource;
	title?: string;
	services?: Record<string, { role?: ServiceRole; endpoints?: KindEndpoint[] }>;
	defaultServices?: string[];
	panels?: string[];
	actions?: { id: string; label: string; options: string[]; confirm: string[] }[];
}
