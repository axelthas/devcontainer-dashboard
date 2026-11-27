/** Prepare one reserved instance and check its effective Compose configuration. */
import { join } from 'node:path';
import { ipv4Range, overlaps } from './composeInstanceAddresses.js';
import { renderInstanceFiles } from './composeInstanceFiles.js';
import {
	composeInstanceOverrideYaml,
	supportsInstanceOverrides,
	writeInstanceOverride
} from './composeInstanceOverride.js';
import {
	instanceDigest,
	prepareReservedInstance,
	type DockerOccupancy,
	type InstanceRecord
} from './composeInstances.js';
import { verifyInstanceConfig } from './composeInstanceVerify.js';
import type { ComposeInstancePlan } from './composeInstancePlan.js';
import type { KindInstanceConfig } from './kindDescriptor.js';
import type { KindDescriptor } from '../stackKinds/types.js';

export interface PrepareInstanceInput {
	workspaceRoot: string;
	project: string;
	plan: ComposeInstancePlan;
	policy?: KindInstanceConfig;
	kind: KindDescriptor;
	getComposeVersion: () => Promise<string>;
	getSourceConfig: () => Promise<unknown>;
	getOccupancy: () => Promise<DockerOccupancy>;
	hostPath: (path: string) => Promise<string | undefined>;
	checkConfig: (record: InstanceRecord, overridePath: string) => Promise<unknown>;
	/** Set by re-plan: the same instance generation may keep its project, volumes and previous subnets. */
	owned?: { subnets: string[] };
}

/** A new resource appearing after reservation must never be silently adopted. */
function checkLiveResources(
	record: InstanceRecord,
	plan: ComposeInstancePlan,
	snapshot: DockerOccupancy,
	owned?: { subnets: string[] }
): void {
	if (
		!snapshot ||
		!Array.isArray(snapshot.projects) ||
		!Array.isArray(snapshot.subnets) ||
		!Array.isArray(snapshot.volumeNames)
	)
		throw new Error('Docker resource snapshot is incomplete');
	if (!owned && snapshot.projects.includes(record.project))
		throw new Error('Instance project is already in use');
	const planned = record.subnets.map((value) => ipv4Range(value));
	for (const network of snapshot.subnets) {
		if (typeof network !== 'string') throw new Error('Docker resource snapshot is incomplete');
		if (network.includes(':') || owned?.subnets.includes(network)) continue;
		const range = ipv4Range(network);
		if (!range || planned.some((item) => !item || overlaps(item, range)))
			throw new Error('Instance subnet is already in use');
	}
	if (
		!owned &&
		Object.values(plan.override.volumes).some(
			(item) => typeof item.name !== 'string' || snapshot.volumeNames.includes(item.name)
		)
	)
		throw new Error('Instance volume identity is already in use');
}

/** Perform all preparation under the reservation lock; preserve a failed reservation. */
export async function prepareInstance(input: PrepareInstanceInput): Promise<InstanceRecord> {
	return prepareReservedInstance(input.workspaceRoot, input.project, async (record, directory) => {
		if (!supportsInstanceOverrides(await input.getComposeVersion()))
			throw new Error('Compose 2.24.4 or later is required for instances');
		if (
			instanceDigest(input.plan) !== record.planDigest ||
			instanceDigest(input.policy ?? null) !== record.policyDigest ||
			instanceDigest(input.kind) !== record.kindDigest ||
			instanceDigest(await input.getSourceConfig()) !== record.sourceDigest
		)
			throw new Error('The Compose source or instance plan changed; review the plan again');
		checkLiveResources(record, input.plan, await input.getOccupancy(), input.owned);
		const mounts = input.policy?.files?.length
			? await renderInstanceFiles({
					canonicalRepoPath: record.canonicalRepoPath,
					instanceDirectory: directory,
					declarations: input.policy.files,
					plan: input.plan,
					kind: input.kind,
					hostPath: input.hostPath
				})
			: {};
		const override = join(directory, 'override.yaml');
		await writeInstanceOverride(
			override,
			composeInstanceOverrideYaml(input.plan, record.volumeIdentity, mounts)
		);
		verifyInstanceConfig(
			await input.checkConfig(record, override),
			input.plan,
			record.volumeIdentity,
			mounts
		);
		if (instanceDigest(await input.getSourceConfig()) !== record.sourceDigest)
			throw new Error('The Compose source changed during preparation; review the plan again');
	});
}
