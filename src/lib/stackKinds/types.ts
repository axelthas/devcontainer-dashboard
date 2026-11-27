/** Public kind metadata. Execution arguments and host paths are server-only. */
export type PresenterId = 'generic' | 'web' | 'database' | 'profile';
export type KindSource = 'compose' | 'operator' | 'label' | 'heuristic' | 'default';
export type ServiceRole = 'app' | 'support';
export type KindEndpoint = {
	port: number;
	label: string;
	protocol: 'http' | 'https' | 'tcp' | 'udp';
};
export type KindGroups = Record<string, string[] | { role: ServiceRole }>;

export interface KindDescriptor {
	kind: string;
	presenter: PresenterId;
	source: KindSource;
	title?: string;
	services?: Record<string, { role?: ServiceRole; endpoints?: KindEndpoint[] }>;
	defaultServices?: string[];
	panels?: string[];
	groups?: KindGroups;
	actions?: {
		id: string;
		label: string;
		options: string[];
		optionLabels?: Record<string, string>;
		confirm: string[];
	}[];
}

/** Show a descriptor label or turn the literal option ID into readable text. */
export function choiceLabel(
	action: NonNullable<KindDescriptor['actions']>[number],
	option: string
): string {
	const label =
		action.optionLabels && Object.hasOwn(action.optionLabels, option)
			? action.optionLabels[option]
			: undefined;
	if (label) return label;
	const prefix = `${action.id}-`;
	const words = (
		option.startsWith(prefix) && option.length > prefix.length
			? option.slice(prefix.length)
			: option
	).replaceAll('-', ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface ChoiceOutcome {
	value: string;
	at: string;
	result: 'ok' | 'partial' | 'failed';
	readBackPassed?: boolean;
	services?: { service: string; result: 'ok' | 'failed' }[];
}
