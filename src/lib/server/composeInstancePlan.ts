/** Plan instance changes from normalized Compose JSON. Never return raw Compose data. */
import { isIP } from 'node:net';
import {
	contains,
	formatIPv4,
	ipv4,
	ipv4Range,
	overlaps,
	type IPv4Range
} from './composeInstanceAddresses.js';
import type { KindInstanceConfig } from './kindDescriptor.js';

const RESOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SLOT_TEMPLATE = /^(?:\d{1,3}\.){2}\{slot\}\.\d{1,3}\/\d{1,2}$/;
const DEFAULT_SUBNET = '10.231.{slot}.0/24';

type Entry = Record<string, unknown>;
type Replacement = { value: unknown; replace: true };
interface SubnetMapping {
	network: string;
	from: string;
	to: string;
	source: IPv4Range;
	target: IPv4Range;
}
interface PortOverride {
	target: number;
	protocol: 'tcp' | 'udp' | 'sctp';
	host_ip: '127.0.0.1';
}

export interface ComposeInstancePlan {
	project: string;
	slot: number;
	addressPlan: {
		subnets: Pick<SubnetMapping, 'network' | 'from' | 'to'>[];
		services: {
			service: string;
			addresses: Record<string, string>;
			containerName?: string;
			loopbackPorts: PortOverride[];
		}[];
	};
	/** Original static Compose service IPv4 addresses and their instance addresses. */
	endpointAddresses: Record<string, string>;
	/** Structured server-only overlay; the writer emits replacement nodes with !override. */
	override: {
		networks: Record<string, Entry>;
		services: Record<string, Entry>;
		volumes: Record<string, Entry>;
	};
	/** Safe diagnostics only. Do not log the resolved configuration. */
	warnings: string[];
}

export interface InstancePool {
	defaultSubnet?: string;
	minSlot?: number;
	maxSlot?: number;
	/** IPv4 networks reserved by the operator, Docker, or other instance records. */
	occupiedSubnets?: string[];
	occupiedProjects?: string[];
	/** Stable random identity for managed volume names; never reuse when a slot is reused. */
	volumeIdentity?: string;
}

export class ComposeInstancePlanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ComposeInstancePlanError';
	}
}

/** Report the type of failure, not untrusted config values. */
function refuse(message: string): never {
	throw new ComposeInstancePlanError(message);
}

/** Narrow canonical Compose objects without interpreting arbitrary nested data. */
function record(value: unknown): Entry {
	if (value === undefined) return {};
	if (!value || typeof value !== 'object' || Array.isArray(value))
		refuse('Expected a normalized Compose object');
	return value as Entry;
}

/** Require safe logical keys before they can enter an override or a generated name. */
function entries(value: unknown): [string, unknown][] {
	const result = Object.entries(record(value));
	if (result.some(([key]) => !RESOURCE_KEY.test(key))) refuse('Unsupported Compose resource key');
	return result;
}

/** Require a CIDR that the allocator can compare and remap. */
function range(value: unknown): IPv4Range {
	const result = typeof value === 'string' ? ipv4Range(value) : undefined;
	return result ?? refuse('Instance networking requires canonical IPv4 CIDRs');
}

/** Mark a field as replaced, not merged with the source. */
function replace(value: unknown): Replacement {
	return { value, replace: true };
}

/** Generate a specific instance project name. Never alter the original project. */
function projectName(base: unknown, slot: number): string {
	if (typeof base !== 'string' || !PROJECT_NAME.test(base))
		refuse('Unsupported Compose project name');
	const name = `${base}-i${slot}`;
	if (!PROJECT_NAME.test(name)) refuse('Instance project name is too long');
	return name;
}

/** Enforce both operator and repository bounds if both are present. */
function checkSlot(slot: number, pool: InstancePool, policy?: KindInstanceConfig): void {
	const min = pool.minSlot ?? policy?.slots?.min ?? 1;
	const max = pool.maxSlot ?? policy?.slots?.max ?? 254;
	if (
		![slot, min, max].every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ||
		slot < min ||
		slot > max ||
		(policy?.slots && (slot < policy.slots.min || slot > policy.slots.max))
	)
		refuse('Slot is outside the instance pool');
}

/** Reject overlap with original, managed and live Docker ranges. Ignore known IPv6 ranges. */
function checkOverlap(mappings: SubnetMapping[], occupied: IPv4Range[]): void {
	for (const [index, mapping] of mappings.entries()) {
		if (
			occupied.some((used) => overlaps(mapping.target, used)) ||
			mappings.some(
				(other, position) =>
					position !== index &&
					(overlaps(mapping.target, other.target) || overlaps(mapping.source, other.source))
			)
		)
			refuse('Instance subnet overlaps another subnet');
	}
}

/** Move one host address while preserving its offset within the source CIDR. */
function remapHost(value: unknown, mapping: SubnetMapping): string {
	const address = typeof value === 'string' ? ipv4(value) : undefined;
	if (address === undefined || !contains(mapping.source, address))
		refuse('Static address is outside its source subnet');
	return formatIPv4(mapping.target.start + address - mapping.source.start);
}

/** Move IPAM fields without copying unrelated provider options into the override. */
function remapIpam(entry: Entry, mapping: SubnetMapping): Entry {
	const result: Entry = { subnet: mapping.to };
	if (entry.gateway !== undefined) result.gateway = remapHost(entry.gateway, mapping);
	if (entry.ip_range !== undefined) {
		const child = range(entry.ip_range);
		if (!contains(mapping.source, child.start) || !contains(mapping.source, child.end))
			refuse('IPAM range is outside its source subnet');
		result.ip_range = `${formatIPv4(mapping.target.start + child.start - mapping.source.start)}/${child.prefix}`;
	}
	if (entry.aux_addresses !== undefined)
		result.aux_addresses = Object.fromEntries(
			entries(entry.aux_addresses).map(([key, address]) => [key, remapHost(address, mapping)])
		);
	return result;
}

/** Allocate one template per network with explicit IPv4 IPAM; external conversion is explicit. */
function planNetworks(
	config: Entry,
	slot: number,
	project: string,
	pool: InstancePool,
	policy?: KindInstanceConfig
) {
	const networks: Record<string, Entry> = Object.create(null);
	const mappings: SubnetMapping[] = [];
	const original: IPv4Range[] = [];
	const shared = new Set<string>();
	for (const [key, value] of entries(config.networks)) {
		const definition = record(value);
		const setting = policy?.networks?.[key];
		const external = definition.external === true;
		const data = record(definition.ipam);
		const blocks = data.config ?? [];
		if (!Array.isArray(blocks)) refuse('Expected normalized Compose IPAM');
		for (const block of blocks) {
			const subnet = record(block).subnet;
			if (typeof subnet === 'string' && !subnet.includes(':')) original.push(range(subnet));
		}
		if (external && !setting?.perInstance) {
			shared.add(key);
			continue;
		}
		if (
			(definition.driver !== undefined && definition.driver !== 'bridge') ||
			(data.driver !== undefined && data.driver !== 'default') ||
			Object.keys(record(data.options)).length
		)
			refuse('Instance networking requires bridge networks');
		if (definition.enable_ipv6 === true || definition.enable_ipv4 === false)
			refuse('Instance networking requires IPv4-only managed networks');
		if (external && !setting?.subnet)
			refuse('Per-instance external networks require a subnet template');
		if (blocks.length > 1) refuse('A managed network can have only one explicit subnet');
		const override: Entry = { name: `${project}_${key}`, ...(external ? { external: false } : {}) };
		if (blocks.length || setting?.subnet) {
			const template = setting?.subnet ?? pool.defaultSubnet ?? DEFAULT_SUBNET;
			if (!SLOT_TEMPLATE.test(template)) refuse('Invalid instance subnet template');
			const to = template.replace('{slot}', String(slot));
			const target = range(to);
			if (blocks.length) {
				const block = record(blocks[0]);
				const from = block.subnet;
				const source = range(from);
				if (source.prefix !== target.prefix)
					refuse('Instance and source subnet prefixes must match');
				const mapping = { network: key, from: from as string, to, source, target };
				mappings.push(mapping);
				override.ipam = replace({ config: [remapIpam(block, mapping)] });
			} else {
				// A new network has no source range to rewrite but still reserves its subnet.
				mappings.push({ network: key, from: '', to, source: target, target });
				override.ipam = replace({ config: [{ subnet: to }] });
			}
		}
		networks[key] = override;
	}
	const occupied = (pool.occupiedSubnets ?? []).filter((value) => !value.includes(':')).map(range);
	checkOverlap(
		mappings.filter(({ from }) => from),
		[...original, ...occupied]
	);
	for (const item of mappings.filter(({ from }) => !from)) {
		if (
			[...original, ...occupied].some((used) => overlaps(item.target, used)) ||
			mappings.some((other) => other !== item && overlaps(item.target, other.target))
		)
			refuse('Instance subnet overlaps another subnet');
	}
	return { networks, mappings, shared };
}

/** Remap normalized Compose list or map forms without collapsing duplicate hosts. */
function extraHosts(
	value: unknown,
	endpoints: Record<string, string>
): Entry | string[] | undefined {
	if (value === undefined || !Object.keys(endpoints).length) return undefined;
	let changed = false;
	function remap(address: unknown): string {
		if (typeof address !== 'string') refuse('Unsupported extra_hosts address');
		const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
		if (bare !== 'host-gateway' && !isIP(bare)) refuse('Unsupported extra_hosts address');
		const next = endpoints[bare] ?? address;
		changed ||= next !== address;
		return next;
	}
	const result = Array.isArray(value)
		? value.map((entry: unknown) => {
				if (typeof entry !== 'string') refuse('Unsupported extra_hosts entry');
				const parsed = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,127})[=:](.+)$/.exec(entry);
				if (!parsed) refuse('Unsupported extra_hosts entry');
				return `${parsed[1]}=${remap(parsed[2])}`;
			})
		: Object.fromEntries(
				entries(value).map(([host, address]) => [
					host,
					Array.isArray(address) ? address.map(remap) : remap(address)
				])
			);
	return changed ? result : undefined;
}

/** Replace every published mapping with a Docker-allocated, loopback-only mapping. */
function planPorts(value: unknown): PortOverride[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) refuse('Expected normalized Compose ports');
	const ports = new Map<string, PortOverride>();
	for (const entry of value) {
		const port = record(entry);
		const target = port.target;
		const protocol = port.protocol ?? 'tcp';
		if (
			typeof target !== 'number' ||
			!Number.isInteger(target) ||
			target < 1 ||
			target > 65535 ||
			(protocol !== 'tcp' && protocol !== 'udp' && protocol !== 'sctp') ||
			(port.mode !== undefined && port.mode !== 'ingress' && port.mode !== 'host')
		)
			refuse('Unsupported Compose port mapping');
		ports.set(`${target}/${protocol}`, { target, protocol, host_ip: '127.0.0.1' });
	}
	return [...ports.values()];
}

/** Only address-shaped environment fields produce a value-free warning. */
function hasSourceAddress(value: unknown, mappings: SubnetMapping[]): boolean {
	return (
		typeof value === 'string' &&
		[...value.matchAll(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g)].some(([candidate]) => {
			const address = ipv4(candidate);
			return (
				address !== undefined &&
				mappings.some(({ from, source }) => from && contains(source, address))
			);
		})
	);
}

/** Generate an instance plan from Compose JSON, without reading files or allocating resources. */
export function planComposeInstance(
	raw: unknown,
	slot: number,
	pool: InstancePool = {},
	policy?: KindInstanceConfig
): ComposeInstancePlan {
	checkSlot(slot, pool, policy);
	const config = record(raw);
	const project = projectName(config.name, slot);
	if (pool.occupiedProjects?.includes(project)) refuse('Instance project name is already in use');
	const { networks, mappings, shared } = planNetworks(config, slot, project, pool, policy);
	const services: Record<string, Entry> = Object.create(null);
	const volumes: Record<string, Entry> = Object.create(null);
	const endpointAddresses: Record<string, string> = Object.create(null);
	const serviceEntries = entries(config.services);
	const servicePlans: ComposeInstancePlan['addressPlan']['services'] = [];
	const warnings: string[] = [];
	for (const [key, data] of entries(config.volumes)) {
		if (record(data).external !== true) {
			if (!pool.volumeIdentity || !/^[0-9a-f]{32}$/.test(pool.volumeIdentity))
				refuse('A unique instance volume identity is required');
			volumes[key] = { name: `devharbour_${pool.volumeIdentity}_${key}` };
		}
	}
	for (const [key, data] of serviceEntries) {
		const service = record(data);
		if (
			service.network_mode !== undefined &&
			service.network_mode !== 'none' &&
			!(typeof service.network_mode === 'string' && service.network_mode.startsWith('service:'))
		)
			refuse('The service uses a network namespace outside the Compose project');
		const override: Entry = {};
		const addresses: Record<string, string> = Object.create(null);
		const attachments: Record<string, Entry> = Object.create(null);
		const oldName = service.container_name;
		let containerName: string | undefined;
		if (oldName !== undefined) {
			if (typeof oldName !== 'string' || !RESOURCE_KEY.test(oldName))
				refuse('Unsupported fixed container name');
			containerName = `${project}-${key}`;
			override.container_name = containerName;
		}
		for (const [network, data] of entries(service.networks)) {
			const attachment = record(data ?? undefined);
			if (attachment.ipv6_address !== undefined)
				refuse('Static IPv6 addresses are not supported in instances');
			const mapping = mappings.find((entry) => entry.network === network && entry.from);
			const patch: Entry = {};
			if (attachment.ipv4_address !== undefined) {
				if (!mapping) refuse('A fixed address needs a remappable subnet on its instance network');
				addresses[network] = remapHost(attachment.ipv4_address, mapping);
				patch.ipv4_address = addresses[network];
				endpointAddresses[attachment.ipv4_address as string] = addresses[network];
			}
			if (typeof oldName === 'string' && !shared.has(network)) patch.aliases = [oldName];
			if (Object.keys(patch).length) attachments[network] = patch;
		}
		if (Object.keys(attachments).length) override.networks = attachments;
		const loopbackPorts = planPorts(service.ports);
		if (loopbackPorts.length) override.ports = replace(loopbackPorts);
		for (const [name, value] of Object.entries(record(service.environment))) {
			if (/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && hasSourceAddress(value, mappings))
				warnings.push(`Environment variable ${name} may refer to a source address`);
		}
		if (
			Array.isArray(service.volumes) &&
			service.volumes.some(
				(mount) => record(mount).type === 'bind' && record(mount).read_only !== true
			)
		)
			warnings.push('A writable bind mount may share files between instances');
		if (Object.keys(override).length) services[key] = override;
		servicePlans.push({
			service: key,
			addresses,
			...(containerName ? { containerName } : {}),
			loopbackPorts
		});
	}
	// A service can refer to an endpoint declared later in the Compose file.
	for (const [key, data] of serviceEntries) {
		const hosts = extraHosts(record(data).extra_hosts, endpointAddresses);
		if (hosts) (services[key] ??= {}).extra_hosts = replace(hosts);
	}
	return {
		project,
		slot,
		endpointAddresses,
		addressPlan: {
			subnets: mappings.map(({ network, from, to }) => ({ network, from, to })),
			services: servicePlans
		},
		override: { networks, services, volumes },
		warnings: [...new Set(warnings)].slice(0, 50)
	};
}
