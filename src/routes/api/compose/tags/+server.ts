/**
 * List registry tags for the registry images of a validated Compose selection.
 * Only repositories from the resolved configuration are queried; the browser cannot name
 * a registry. A tag that some selected images lack is reported with those services.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import docker from '$lib/server/docker';
import {
	ComposeConfigError,
	ComposeTargetError,
	ComposeUnavailableError,
	inspectComposeTarget,
	resolveComposeServices,
	resolveComposeTarget
} from '$lib/server/composeSandbox';
import { parseImageReference } from '$lib/imageReference';
import { compareTags, listRegistryTags, RegistryError } from '$lib/server/registryTags';
import type { ComposeTagListing, RegistryImageData } from '$lib/types';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspaces';
const MAX_RETURNED_TAGS = 500;

export const GET: RequestHandler = async ({ url }) => {
	let inspection;
	let selected: string[];
	try {
		// The tag is not part of the listing: list the repositories of the Compose files.
		const target = await resolveComposeTarget(WORKSPACE_ROOT, {
			repoPath: url.searchParams.get('repoPath') ?? undefined,
			files: url.searchParams.getAll('file'),
			envFile: url.searchParams.get('envFile') ?? undefined,
			profiles: url.searchParams.getAll('profile')
		});
		inspection = await inspectComposeTarget(target, (options) => docker.listContainers(options));
		const requested = url.searchParams.getAll('service');
		const available = inspection.services.map((service) => service.name);
		selected = resolveComposeServices(requested.length ? requested : undefined, available);
	} catch (cause) {
		if (cause instanceof ComposeTargetError) throw error(400, cause.message);
		if (cause instanceof ComposeConfigError) throw error(422, cause.message);
		if (cause instanceof ComposeUnavailableError) throw error(503, cause.message);
		throw error(503, 'Could not inspect the Compose configuration. Check Docker availability.');
	}

	// Group the selected registry services by repository; one listing per repository.
	const byRepository = new Map<string, string[]>();
	for (const service of inspection.services) {
		if (service.source !== 'registry' || !service.image) continue;
		if (selected.length > 0 && !selected.includes(service.name)) continue;
		const { repository } = parseImageReference(service.image);
		byRepository.set(repository, [...(byRepository.get(repository) ?? []), service.name]);
	}

	const refresh = url.searchParams.get('refresh') === '1';
	const listed = await Promise.all(
		[...byRepository].map(async ([repository, services]) => {
			try {
				return { repository, services, tags: await listRegistryTags(repository, { refresh }) };
			} catch (cause) {
				const failure =
					cause instanceof RegistryError
						? { kind: cause.kind, message: cause.message }
						: { kind: 'unavailable' as const, message: 'Tag listing failed' };
				return { repository, services, tags: undefined, error: failure };
			}
		})
	);

	// A tag is missing in the services of each listed repository that lacks it.
	// Repositories that could not be listed are unknown, not missing.
	const sets = listed
		.filter((item) => item.tags)
		.map((item) => ({ services: item.services, tags: new Set(item.tags) }));
	const names = new Set(sets.flatMap((item) => [...item.tags]));
	const tags = [...names]
		.sort(compareTags)
		.slice(0, MAX_RETURNED_TAGS)
		.map((name) => ({
			name,
			missingIn: sets.filter((item) => !item.tags.has(name)).flatMap((item) => item.services)
		}));
	const images: RegistryImageData[] = listed.map((item) => ({
		repository: item.repository,
		services: item.services,
		count: item.tags?.length ?? 0,
		...(item.error ? { error: item.error } : {})
	}));
	const body: ComposeTagListing = { images, tags };
	return json(body, { headers: { 'cache-control': 'no-store' } });
};
