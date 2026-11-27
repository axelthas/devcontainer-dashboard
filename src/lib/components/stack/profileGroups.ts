/** Group profile containers without guessing a Polaris-specific naming scheme. */
import type { ContainerData } from '$lib/types';
import type { KindDescriptor } from '$lib/stackKinds/types';

interface Group {
	id: string;
	label: string;
	members: ContainerData[];
}

/** Name a node by its Compose service when available. */
export function nodeLabel(container: ContainerData): string {
	return container.composeService || container.name.replace(/^\//, '');
}

/** Shorten only fallback group labels, not their matching keys. */
function imageLabel(image: string): string {
	return image.split('/').at(-1)?.split(/[:@]/)[0] || 'Other';
}

/** Prefer explicit groups in descriptor order; then group unmatched nodes by exact image. */
export function profileGroups(containers: ContainerData[], kind: KindDescriptor): Group[] {
	let remaining = [...containers].sort(
		(a, b) => nodeLabel(a).localeCompare(nodeLabel(b)) || a.name.localeCompare(b.name)
	);
	const groups: Group[] = [];
	for (const [label, match] of Object.entries(kind.groups ?? {})) {
		const members = remaining.filter(
			({ composeService }) =>
				composeService &&
				(Array.isArray(match)
					? match.includes(composeService)
					: kind.services?.[composeService]?.role === match.role)
		);
		if (!members.length) continue;
		const ids = new Set(members.map(({ id }) => id));
		remaining = remaining.filter(({ id }) => !ids.has(id));
		groups.push({ id: `group:${label}`, label, members });
	}
	const images = new Map<string, Group>();
	for (const container of remaining) {
		let group = images.get(container.image);
		if (!group) {
			group = { id: `image:${container.image}`, label: imageLabel(container.image), members: [] };
			images.set(container.image, group);
		}
		group.members.push(container);
	}
	return [...groups, ...images.values()];
}
