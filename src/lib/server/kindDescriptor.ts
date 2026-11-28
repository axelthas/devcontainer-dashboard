/** Validate literal repository or operator kind declarations before any field can be used. */
import type {
	KindDescriptor,
	KindEndpoint,
	PresenterId,
	ServiceRole
} from '../stackKinds/types.js';

export const MAX_KIND_BYTES = 32 * 1024;
export const KIND_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PRESENTERS = ['generic', 'web', 'database', 'profile'] as const;

export class KindDescriptorError extends Error {
	constructor() {
		super('Invalid DevHarbour kind descriptor. Check its schema and use literal values.');
	}
}

export interface KindAction {
	label: string;
	options: string[];
	optionLabels?: Record<string, string>;
	confirm: string[];
	services: string[] | { exceptRole: ServiceRole };
	argv: string[];
	readBack?: string[];
}

export interface KindInstanceConfig {
	slots?: { min: number; max: number };
	networks?: Record<string, { subnet?: string; perInstance?: boolean }>;
	ports?: 'loopback-ephemeral';
	files?: {
		id: string;
		from: { path: string };
		rewrite: 'addresses' | 'subnet-addresses';
		mount: { target: string; services?: string[]; role?: ServiceRole };
	}[];
}

export interface ValidatedKind {
	view: Omit<KindDescriptor, 'source'>;
	instances?: KindInstanceConfig;
	actions?: Record<string, KindAction>;
}

/** Reject without reflecting any value in the error. */
function invalid(): never {
	throw new KindDescriptorError();
}

/** Check a fixed-shape object or a bounded map. */
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
	const entries = Object.keys(value);
	if (entries.length > 128 || (keys && entries.some((key) => !keys.includes(key)))) invalid();
	return value as Record<string, unknown>;
}

/** Accept bounded literal text, never interpolation or control characters. */
function text(value: unknown, max = 128): string {
	if (
		typeof value !== 'string' ||
		!value.length ||
		value.length > max ||
		value.includes('$') ||
		[...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
	)
		invalid();
	return value;
}

/** Validate an identifier against its grammar. */
function id(value: unknown, pattern = KIND_ID): string {
	const name = text(value);
	return pattern.test(name) ? name : invalid();
}

/** Check a small enum value. */
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
	return values.includes(value as T) ? (value as T) : invalid();
}

/** Check range and integer type without coercion. */
function integer(value: unknown, min: number, max: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
		? value
		: invalid();
}

/** Parse a bounded list. */
function list<T>(value: unknown, parse: (item: unknown) => T, max = 64, min = 0): T[] {
	if (!Array.isArray(value) || value.length < min || value.length > max) invalid();
	return value.map(parse);
}

/** Parse a bounded map and create own properties only. */
function map<T>(
	value: unknown,
	key: (name: string) => string,
	parse: (item: unknown) => T
): Record<string, T> {
	return Object.fromEntries(
		Object.entries(object(value)).map(([name, item]) => [key(name), parse(item)])
	);
}

/** Reject ambiguous path components. Symlinks must be checked again when files are used. */
function path(value: unknown, absolute: boolean): string {
	const name = text(value, 512);
	const segments = (absolute ? name.slice(1) : name).split('/');
	if (
		name.startsWith('/') !== absolute ||
		name.includes('\\') ||
		name.includes(':') ||
		segments.some((part) => !part || part === '.' || part === '..')
	)
		invalid();
	return name;
}

/** Parse service presentation fields, not container or Compose execution data. */
function service(value: unknown): { role?: ServiceRole; endpoints?: KindEndpoint[] } {
	const item = object(value, ['role', 'endpoints']);
	return {
		...(item.role !== undefined ? { role: role(item.role) } : {}),
		...(item.endpoints !== undefined
			? {
					endpoints: list(
						item.endpoints,
						(value): KindEndpoint => {
							const endpoint = object(value, ['port', 'label', 'protocol']);
							return {
								port: integer(endpoint.port, 1, 65535),
								label: text(endpoint.label),
								protocol: oneOf(endpoint.protocol, ['http', 'https', 'tcp', 'udp'])
							};
						},
						16
					)
				}
			: {})
	};
}

/** Validate a service role. */
function role(value: unknown): ServiceRole {
	return oneOf(value, ['app', 'support']);
}

/** Validate identifiers referring to named Compose services. */
function services(value: unknown): string[] {
	return list(value, (item) => id(item, KEY), 128, 1);
}

/** Preserve an argv vector, never an option string for a host shell. */
function argv(value: unknown): string[] {
	const args = list(value, (item) => text(item, 512), 32, 1);
	if (
		args[0].startsWith('-') ||
		args[0] === '{option}' ||
		args.some((arg) => arg !== '{option}' && arg.includes('{option}'))
	)
		invalid();
	return args;
}

/** Validate choice execution separately from its public metadata. */
function action(value: unknown): KindAction {
	const item = object(value, [
		'type',
		'label',
		'options',
		'confirm',
		'services',
		'argv',
		'readBack'
	]);
	if (item.type !== 'choice') invalid();
	const entries = list(
		item.options,
		(value) => {
			if (typeof value === 'string') return { value: id(value), label: undefined };
			const option = object(value, ['value', 'label']);
			return { value: id(option.value), label: text(option.label) };
		},
		32,
		1
	);
	const options = entries.map((entry) => entry.value);
	const optionLabels = Object.fromEntries(
		entries.flatMap((entry) => (entry.label === undefined ? [] : [[entry.value, entry.label]]))
	);
	const confirm = item.confirm === undefined ? [] : list(item.confirm, (value) => id(value), 32);
	if (
		new Set(options).size !== options.length ||
		confirm.some((choice) => !options.includes(choice))
	)
		invalid();
	return {
		label: text(item.label),
		options,
		...(Object.keys(optionLabels).length ? { optionLabels } : {}),
		confirm,
		services: Array.isArray(item.services)
			? services(item.services)
			: { exceptRole: role(object(item.services, ['exceptRole']).exceptRole) },
		argv: argv(item.argv),
		...(item.readBack !== undefined ? { readBack: argv(item.readBack) } : {})
	};
}

/** Validate the current IPv4 slot template syntax; the planner checks CIDR semantics. */
function subnetTemplate(value: unknown): string {
	const input = text(value, 64);
	if (!/^(?:\d{1,3}\.){2}\{slot\}\.\d{1,3}\/\d{1,2}$/.test(input)) invalid();
	return input;
}

/** Validate policy declarations and mount shapes. These fields never reach the browser. */
function instanceConfig(value: unknown): KindInstanceConfig {
	const data = object(value, ['slots', 'networks', 'ports', 'files']);
	const result: KindInstanceConfig = {};
	if (data.slots !== undefined) {
		const slots = object(data.slots, ['min', 'max']);
		const min = integer(slots.min, 0, 255);
		result.slots = { min, max: integer(slots.max, min, 255) };
	}
	if (data.networks !== undefined)
		result.networks = map(
			data.networks,
			(key) => id(key, KEY),
			(value) => {
				const network = object(value, ['subnet', 'perInstance']);
				if (network.perInstance !== undefined && typeof network.perInstance !== 'boolean')
					invalid();
				return {
					...(network.subnet !== undefined ? { subnet: subnetTemplate(network.subnet) } : {}),
					...(network.perInstance !== undefined ? { perInstance: network.perInstance } : {})
				};
			}
		);
	if (data.ports !== undefined) result.ports = oneOf(data.ports, ['loopback-ephemeral'] as const);
	if (data.files !== undefined) {
		result.files = list(
			data.files,
			(value) => {
				const file = object(value, ['id', 'from', 'rewrite', 'mount']);
				const mount = object(file.mount, ['target', 'services', 'role']);
				if ((mount.services === undefined) === (mount.role === undefined)) invalid();
				return {
					id: id(file.id),
					from: { path: path(object(file.from, ['path']).path, false) },
					rewrite: oneOf(file.rewrite === undefined ? 'addresses' : file.rewrite, [
						'addresses',
						'subnet-addresses'
					]),
					mount: {
						target: path(mount.target, true),
						...(mount.services !== undefined
							? { services: services(mount.services) }
							: { role: role(mount.role) })
					}
				};
			},
			32
		);
		if (new Set(result.files.map((file) => file.id)).size !== result.files.length) invalid();
	}
	return result;
}

/** Parse one versioned declaration and explicitly project the public fields. */
export function parseKindDescriptor(value: unknown): ValidatedKind {
	if (Buffer.byteLength(JSON.stringify(value) ?? '') > MAX_KIND_BYTES) invalid();
	const item = object(value, [
		'schema',
		'kind',
		'title',
		'presenter',
		'services',
		'defaults',
		'instances',
		'actions',
		'panels',
		'groups'
	]);
	if (item.schema !== 1) invalid();
	const actions =
		item.actions === undefined ? undefined : map(item.actions, (key) => id(key), action);
	const groups =
		item.groups === undefined
			? undefined
			: map(
					item.groups,
					(key) => id(key, KEY),
					(value) =>
						Array.isArray(value) ? services(value) : { role: role(object(value, ['role']).role) }
				);
	const panels =
		item.panels === undefined
			? undefined
			: list(
					item.panels,
					(value) => {
						const panel = text(value);
						if (
							['endpoints', 'addresses', 'urls'].includes(panel) ||
							(panel.startsWith('choice:') && actions && Object.hasOwn(actions, panel.slice(7)))
						)
							return panel;
						return invalid();
					},
					32
				);
	const requested = item.presenter === undefined ? 'generic' : id(item.presenter);
	const presenter: PresenterId = PRESENTERS.find((name) => name === requested) ?? 'generic';
	return {
		view: {
			kind: id(item.kind),
			presenter,
			...(item.title !== undefined ? { title: text(item.title) } : {}),
			...(item.services !== undefined
				? { services: map(item.services, (key) => id(key, KEY), service) }
				: {}),
			...(item.defaults !== undefined
				? { defaultServices: services(object(item.defaults, ['services']).services) }
				: {}),
			...(panels ? { panels } : {}),
			...(groups ? { groups } : {}),
			...(actions
				? {
						actions: Object.entries(actions).map(
							([id, { label, options, optionLabels, confirm }]) => ({
								id,
								label,
								options,
								...(optionLabels ? { optionLabels } : {}),
								confirm
							})
						)
					}
				: {})
		},
		...(actions ? { actions } : {}),
		...(item.instances !== undefined ? { instances: instanceConfig(item.instances) } : {})
	};
}
