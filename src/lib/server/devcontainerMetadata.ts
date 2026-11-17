/**
 * Effective remote user of a devcontainer, read from its `devcontainer.metadata` label.
 * The Dev Containers CLI writes this label when it creates the container. The label lists
 * the image metadata, the Features, and devcontainer.json in that order; a later entry
 * overrides an earlier one. This is the same user that VS Code uses for the container.
 */
import type { ContainerData } from '$lib/types';

/** A plain user name or numeric id, with an optional group: `vscode`, `1000`, `1000:1000`. */
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})?$/;

export type RemoteUserFields = Pick<
	ContainerData,
	'remoteUser' | 'remoteUserSource' | 'remoteUserError'
>;

/** Accept only values that `docker exec --user` takes literally. */
function plainUser(value: unknown): value is string {
	return typeof value === 'string' && USER_PATTERN.test(value);
}

/** Describe a rejected value without echoing an unbounded label. */
function rejected(property: string, value: unknown): RemoteUserFields {
	const shown = typeof value === 'string' ? JSON.stringify(value.slice(0, 64)) : typeof value;
	return {
		remoteUserError: `${property} ${shown} in the devcontainer metadata is not a plain user name`
	};
}

/**
 * Return the last `remoteUser`, else the last `containerUser`. Return no user when the
 * container has no metadata label: the container's default user then applies.
 * Return an error when the metadata names a user that cannot be used literally, for
 * example an unresolved `${localEnv:USER}`, so callers never run as another user.
 */
export function resolveRemoteUser(labels: Record<string, string> | undefined): RemoteUserFields {
	const raw = labels?.['devcontainer.metadata'];
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { remoteUserError: 'The devcontainer metadata label is not valid JSON' };
	}
	let remoteUser: unknown;
	let containerUser: unknown;
	for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
		if (!entry || typeof entry !== 'object') continue;
		const record = entry as Record<string, unknown>;
		if (record.remoteUser !== undefined) remoteUser = record.remoteUser;
		if (record.containerUser !== undefined) containerUser = record.containerUser;
	}
	if (remoteUser !== undefined)
		return plainUser(remoteUser)
			? { remoteUser, remoteUserSource: 'remoteUser' }
			: rejected('remoteUser', remoteUser);
	if (containerUser !== undefined)
		return plainUser(containerUser)
			? { remoteUser: containerUser, remoteUserSource: 'containerUser' }
			: rejected('containerUser', containerUser);
	return {};
}
