/** Serialize an instance plan without copying the resolved configuration or secrets. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ComposeInstancePlan } from './composeInstancePlan.js';
import type { InstanceMount } from './composeInstanceFiles.js';

export const INSTANCE_LABEL = 'devcontainer-dashboard.instance';
export const SLOT_LABEL = 'devcontainer-dashboard.slot';
export const VOLUME_IDENTITY_LABEL = 'devcontainer-dashboard.volume-identity';

/** Apply Compose dollar escaping to JSON strings before Compose interpolates YAML. */
function yamlValue(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error('Unsupported instance override value');
	return encoded.replaceAll('$', () => '$$');
}

/** A planner replacement marker must have exactly the two expected properties. */
function replacement(value: unknown): value is { value: unknown; replace: true } {
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length === 2 &&
		'value' in value &&
		'replace' in value &&
		value.replace === true
	);
}

/** Emit only planner output, instance labels and no resolved environment values. */
export function composeInstanceOverrideYaml(
	plan: ComposeInstancePlan,
	volumeIdentity: string,
	mounts: Record<string, InstanceMount[]> = {}
): string {
	if (!/^[a-f0-9]{32}$/.test(volumeIdentity)) throw new Error('Invalid instance volume identity');
	const services: Record<string, Record<string, unknown>> = Object.create(null);
	for (const service of plan.addressPlan.services) {
		services[service.service] = {
			...plan.override.services[service.service],
			...(mounts[service.service]?.length ? { volumes: mounts[service.service] } : {}),
			labels: {
				[INSTANCE_LABEL]: plan.project,
				[SLOT_LABEL]: String(plan.slot),
				[VOLUME_IDENTITY_LABEL]: volumeIdentity
			}
		};
	}
	const sections = { services, networks: plan.override.networks, volumes: plan.override.volumes };
	const lines = ['# Managed by DevHarbour. Do not edit.'];
	for (const [group, resources] of Object.entries(sections)) {
		if (!Object.keys(resources).length) continue;
		lines.push(`${group}:`);
		for (const [name, fields] of Object.entries(resources)) {
			lines.push(`  ${yamlValue(name)}:`);
			for (const [field, value] of Object.entries(fields)) {
				lines.push(
					`    ${field}: ${replacement(value) ? `!override ${yamlValue(value.value)}` : yamlValue(value)}`
				);
			}
		}
	}
	return `${lines.join('\n')}\n`;
}

/** Require Compose v2.24.4 or later, excluding prereleases of the boundary version. */
export function supportsInstanceOverrides(version: string): boolean {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+\s]+))?(?:\+[^\s]+)?\s*$/.exec(version.trim());
	if (!match) return false;
	const [major, minor, patch] = match.slice(1, 4).map(Number);
	if (![major, minor, patch].every(Number.isSafeInteger)) return false;
	return (
		major > 2 ||
		(major === 2 && (minor > 24 || (minor === 24 && (patch > 4 || (patch === 4 && !match[4])))))
	);
}

/** Persist a generated override atomically. The caller owns the reservation lock. */
export async function writeInstanceOverride(
	path: string,
	content: string,
	mode: 0o600 | 0o644 = 0o600
): Promise<void> {
	const temporary = join(dirname(path), `.override-${randomUUID()}.tmp`);
	const file = await open(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		mode
	);
	try {
		await file.writeFile(content, 'utf8');
		await file.sync();
		await file.close();
		await rename(temporary, path);
	} catch (cause) {
		await file.close().catch(() => {});
		await unlink(temporary).catch(() => {});
		throw cause;
	}
}
