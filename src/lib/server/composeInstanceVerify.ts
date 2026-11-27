/** Verify the resolved instance config against its planned isolation before use. */
import { isDeepStrictEqual } from 'node:util';
import type { ComposeInstancePlan } from './composeInstancePlan.js';
import type { InstanceMount } from './composeInstanceFiles.js';
import { INSTANCE_LABEL, SLOT_LABEL, VOLUME_IDENTITY_LABEL } from './composeInstanceOverride.js';

/** Never echo a resolved value: it can contain environment data or secrets. */
function fail(): never {
	throw new Error('Resolved instance configuration does not match the approved plan');
}

/** Read known objects only. */
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
	return value as Record<string, unknown>;
}

/** Compare order-independent string lists. */
function sameStrings(a: unknown, b: unknown): boolean {
	return (
		Array.isArray(a) &&
		Array.isArray(b) &&
		a.every((item) => typeof item === 'string') &&
		b.every((item) => typeof item === 'string') &&
		isDeepStrictEqual([...a].sort(), [...b].sort())
	);
}

/** Validate only fields DevHarbour controls and refuse unexpected exposed ports. */
export function verifyInstanceConfig(
	raw: unknown,
	plan: ComposeInstancePlan,
	identity: string,
	mounts: Record<string, InstanceMount[]> = {}
): void {
	const config = object(raw);
	if (config.name !== plan.project) fail();
	const networks = object(config.networks);
	const services = object(config.services);
	const volumes = object(config.volumes ?? {});
	for (const [key, expected] of Object.entries(plan.override.networks)) {
		const actual = object(networks[key]);
		if (actual.name !== expected.name || (expected.external === false && actual.external === true))
			fail();
		if (expected.ipam) {
			const ipam = object(actual.ipam);
			const replacement = object(expected.ipam);
			if (!isDeepStrictEqual(ipam.config, object(replacement.value).config)) fail();
		}
	}
	for (const [key, expected] of Object.entries(plan.override.volumes)) {
		if (object(volumes[key]).name !== expected.name) fail();
	}
	for (const service of plan.addressPlan.services) {
		const actual = object(services[service.service]);
		const labels = object(actual.labels);
		if (
			labels[INSTANCE_LABEL] !== plan.project ||
			labels[SLOT_LABEL] !== String(plan.slot) ||
			labels[VOLUME_IDENTITY_LABEL] !== identity
		)
			fail();
		if (service.containerName && actual.container_name !== service.containerName) fail();
		const attachments = object(actual.networks ?? {});
		for (const [network, address] of Object.entries(service.addresses))
			if (object(attachments[network]).ipv4_address !== address) fail();
		const changes = plan.override.services[service.service] ?? {};
		if (changes.networks) {
			for (const [network, patch] of Object.entries(object(changes.networks))) {
				const aliases = object(patch).aliases;
				if (
					Array.isArray(aliases) &&
					(!Array.isArray(object(attachments[network]).aliases) ||
						aliases.some(
							(alias) => !(object(attachments[network]).aliases as unknown[]).includes(alias)
						))
				)
					fail();
			}
		}
		if (changes.extra_hosts) {
			const expectedHosts = object(changes.extra_hosts).value;
			if (
				!sameStrings(actual.extra_hosts, expectedHosts) &&
				!isDeepStrictEqual(actual.extra_hosts, expectedHosts)
			)
				fail();
		}
		const ports = actual.ports ?? [];
		if (!Array.isArray(ports) || ports.length !== service.loopbackPorts.length) fail();
		for (const expected of service.loopbackPorts) {
			if (
				!ports.some((entry) => {
					const port = object(entry);
					return (
						port.target === expected.target &&
						port.protocol === expected.protocol &&
						port.host_ip === '127.0.0.1' &&
						(port.published === undefined || port.published === '0')
					);
				})
			)
				fail();
		}
		for (const mount of mounts[service.service] ?? []) {
			if (
				!Array.isArray(actual.volumes) ||
				!actual.volumes.some((entry) => {
					const item = object(entry);
					return (
						item.type === 'bind' &&
						item.source === mount.source &&
						item.target === mount.target &&
						item.read_only === true
					);
				})
			)
				fail();
		}
	}
}
