/**
 * Client-safe image reference parsing and sandbox version rules.
 * The server uses these rules to write the version override and to parse registry images.
 * The browser uses the same rules to derive the version chip from live container data.
 */

/** Docker tag grammar: one word character, then up to 127 word characters, dots, or dashes. */
export const IMAGE_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Container label that DevHarbour writes with the sandbox tag. */
export const SANDBOX_TAG_LABEL = 'devcontainer-dashboard.sandbox.tag';

/** Narrow untrusted input to a valid image tag. */
export function isImageTag(value: unknown): value is string {
	return typeof value === 'string' && IMAGE_TAG_PATTERN.test(value);
}

/** One parsed image reference: `repository[:tag][@digest]`. */
export interface ImageReference {
	repository: string;
	tag?: string;
	digest?: string;
}

/**
 * Split an image reference. A colon before the last slash belongs to a registry port,
 * as in `localhost:5000/fdp`, so it never starts a tag.
 */
export function parseImageReference(reference: string): ImageReference {
	let rest = reference.trim();
	let digest: string | undefined;
	const at = rest.indexOf('@');
	if (at >= 0) {
		digest = rest.slice(at + 1);
		rest = rest.slice(0, at);
	}
	const slash = rest.lastIndexOf('/');
	const colon = rest.lastIndexOf(':');
	const base = colon > slash ? rest.slice(0, colon) : rest;
	const tag = colon > slash ? rest.slice(colon + 1) : undefined;
	return { repository: base, ...(tag ? { tag } : {}), ...(digest ? { digest } : {}) };
}

/** Replace the tag and remove any digest: `registry/fdp:1@sha256:...` to `registry/fdp:2`. */
export function withTag(reference: string, tag: string): string {
	return `${parseImageReference(reference).repository}:${tag}`;
}

/** Docker shows an image ID instead of a name when the name no longer points at the image. */
export function isImageId(reference: string): boolean {
	return /^(?:sha256:)?[a-f0-9]{12,64}$/.test(reference);
}

/**
 * Compose names an image that it builds `<project>-<service>` (v2) or
 * `<project>_<service>` (v1), without a registry and without a tag.
 */
export function isLocalBuildImage(project: string, service: string | undefined, image: string) {
	if (!service) return false;
	const { repository, tag } = parseImageReference(image);
	if (tag && tag !== 'latest') return false;
	const name = repository.toLowerCase();
	const base = `${project}`.toLowerCase();
	const svc = service.toLowerCase();
	return name === `${base}-${svc}` || name === `${base}_${svc}`;
}

/** How the version chip reads one Compose project. */
export type SandboxVersionKind = 'tag' | 'mixed' | 'implicit' | 'build' | 'unknown';

/** Version of one service container, for the chip details. */
export interface ServiceVersion {
	service: string;
	/** A tag, `latest`, `local build`, or `unknown` */
	tag: string;
	source: 'label' | 'image' | 'build' | 'unknown';
	/** True when the image reference has no tag, so Docker uses `latest` */
	implicit?: boolean;
}

export interface SandboxVersion {
	kind: SandboxVersionKind;
	label: string;
	services: ServiceVersion[];
}

/** The container fields that the version rules read. */
export interface VersionContainer {
	image: string;
	service?: string;
	sandboxTag?: string;
}

/** Read the version of one container: the DevHarbour label first, then the image reference. */
export function containerVersion(project: string, container: VersionContainer): ServiceVersion {
	const service = container.service ?? '';
	if (isImageTag(container.sandboxTag)) {
		return { service, tag: container.sandboxTag, source: 'label' };
	}
	if (!container.image || isImageId(container.image)) {
		return { service, tag: 'unknown', source: 'unknown' };
	}
	if (isLocalBuildImage(project, container.service, container.image)) {
		return { service, tag: 'local build', source: 'build' };
	}
	const tag = parseImageReference(container.image).tag;
	return tag
		? { service, tag, source: 'image' }
		: { service, tag: 'latest', source: 'image', implicit: true };
}

/**
 * Derive the version chip of a Compose project from its live containers.
 * One tag: the tag. Different values: `mixed`. No tag in any reference: `latest`.
 * Only locally built services: `local build`. Only image IDs: `unknown`.
 */
export function sandboxVersion(project: string, containers: VersionContainer[]): SandboxVersion {
	const services = containers
		.map((container) => containerVersion(project, container))
		.sort((a, b) => a.service.localeCompare(b.service));
	const versioned = services.filter((item) => item.source !== 'build');
	if (versioned.length === 0) {
		const kind = services.length > 0 ? 'build' : 'unknown';
		return { kind, label: kind === 'build' ? 'local build' : 'unknown', services };
	}
	const tags = [...new Set(versioned.map((item) => item.tag))];
	if (tags.length > 1) return { kind: 'mixed', label: 'mixed', services };
	if (tags[0] === 'unknown') return { kind: 'unknown', label: 'unknown', services };
	const implicit = versioned.every((item) => item.implicit);
	return { kind: implicit ? 'implicit' : 'tag', label: tags[0], services };
}
