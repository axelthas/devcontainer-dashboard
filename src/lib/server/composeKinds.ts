/** Resolve Compose presentation metadata without promoting labels or heuristics into policy. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseImageReference } from '../imageReference.js';
import type { KindDescriptor } from '../stackKinds/types.js';
import type { ComposeServiceSummary } from '../types.js';
import {
	KindDescriptorError,
	MAX_KIND_BYTES,
	parseKindDescriptor,
	type ValidatedKind
} from './kindDescriptor.js';

export const COMPOSE_KIND_LABEL = 'devcontainer-dashboard.kind';
const DATABASE_IMAGES = new Set(['postgres', 'mysql', 'mariadb', 'redis', 'mongo']);
const WEB_PORTS = new Set(['80', '443', '8080', '8443', '3000']);

/** Read only the top-level extension from either Compose config pass. */
export function composeKindExtension(raw: unknown): unknown {
	return raw && typeof raw === 'object' && Object.hasOwn(raw, 'x-devharbour')
		? (raw as Record<string, unknown>)['x-devharbour']
		: undefined;
}

/** Anchor an operator profile to one checkout and one ordered file selection. */
export function kindProfilePath(
	canonicalRepoPath: string,
	files: string[],
	root = '/data/compose-kind-profiles'
): string {
	const key = createHash('sha256')
		.update(JSON.stringify([canonicalRepoPath, files]))
		.digest('hex');
	return join(root, `${key}.json`);
}

/** Open only a bounded regular operator file, without following file symlinks or blocking on FIFOs. */
export async function readKindProfile(path: string): Promise<unknown> {
	const handle = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
	).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return undefined;
		throw new KindDescriptorError();
	});
	if (!handle) return undefined;
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_KIND_BYTES) throw new KindDescriptorError();
		const buffer = Buffer.alloc(MAX_KIND_BYTES + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset > MAX_KIND_BYTES) throw new KindDescriptorError();
		return JSON.parse(buffer.toString('utf8', 0, offset)) as unknown;
	} catch {
		throw new KindDescriptorError();
	} finally {
		await handle.close();
	}
}

interface KindInput {
	extension: unknown;
	literalExtension: () => Promise<unknown>;
	operatorProfile: () => Promise<unknown>;
	labels: (string | undefined)[];
	services: ComposeServiceSummary[];
}

/** Classify allowlisted built-in label values and common official images for display only. */
function displayKind(input: KindInput): KindDescriptor {
	const kind = input.labels[0];
	if (
		(kind === 'generic' || kind === 'web' || kind === 'database') &&
		input.labels.every((label) => label === kind)
	)
		return { kind, presenter: kind, source: 'label' };
	if (
		input.services.some(({ ports }) =>
			ports.some(
				({ target, published, protocol }) =>
					published !== undefined && protocol === 'tcp' && WEB_PORTS.has(target)
			)
		)
	)
		return { kind: 'web', presenter: 'web', source: 'heuristic' };
	if (
		input.services.some(
			({ image }) =>
				image &&
				DATABASE_IMAGES.has(
					parseImageReference(image).repository.replace(
						/^(?:(?:docker\.io|index\.docker\.io)\/)?library\//,
						''
					)
				)
		)
	)
		return { kind: 'database', presenter: 'database', source: 'heuristic' };
	return { kind: 'generic', presenter: 'generic', source: 'default' };
}

/** A present but invalid declaration cannot fall through and silently select other policy. */
export async function resolveComposeKind(
	input: KindInput
): Promise<{ view: KindDescriptor; declaration?: ValidatedKind }> {
	if (input.extension !== undefined) {
		const literal = await input.literalExtension().catch(() => {
			throw new KindDescriptorError();
		});
		if (!isDeepStrictEqual(input.extension, literal)) throw new KindDescriptorError();
		const declaration = parseKindDescriptor(literal);
		return { declaration, view: { ...declaration.view, source: 'compose' } };
	}
	const profile = await input.operatorProfile();
	if (profile !== undefined) {
		const declaration = parseKindDescriptor(profile);
		return { declaration, view: { ...declaration.view, source: 'operator' } };
	}
	return { view: displayKind(input) };
}
