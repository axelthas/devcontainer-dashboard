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

/** Resolve localEnv tokens once as literal text, without shell expansion or value logging. */
function resolveUser(
	property: 'remoteUser' | 'containerUser',
	value: unknown,
	env: Record<string, string | undefined>
): RemoteUserFields {
	if (typeof value !== 'string') {
		return { remoteUserError: `${property} in the devcontainer metadata must be a string` };
	}
	let missing: string | undefined;
	const resolved = value.replace(
		/\$\{localEnv:([^:{}]+)(?::([^{}]*))?\}/g,
		(_token, name: string, fallback: string | undefined) => {
			const replacement = Object.hasOwn(env, name) ? env[name] : undefined;
			if (replacement !== undefined) return replacement;
			if (fallback !== undefined) return fallback;
			missing ??= name;
			return '';
		}
	);
	if (missing) {
		return {
			remoteUserError: `${property}: localEnv variable ${missing} is not set in the dashboard environment`
		};
	}
	if (!plainUser(resolved)) {
		return {
			remoteUserError: `${property} in the devcontainer metadata does not resolve to a plain user name`
		};
	}
	return { remoteUser: resolved, remoteUserSource: property };
}

/**
 * Return the last `remoteUser`, else the last `containerUser`. Return no user when the
 * container has no metadata label: the container's default user then applies.
 * Resolve `${localEnv:VAR}` from the dashboard environment before validating the user.
 * An unset variable can supply `${localEnv:VAR:default}`. Missing or invalid values
 * return an error so callers never run as another user. Substituted values are not
 * expanded again and are never included in error messages.
 */
export function resolveRemoteUser(
	labels: Record<string, string> | undefined,
	env: Record<string, string | undefined> = process.env
): RemoteUserFields {
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
	if (remoteUser !== undefined) return resolveUser('remoteUser', remoteUser, env);
	if (containerUser !== undefined) return resolveUser('containerUser', containerUser, env);
	return {};
}
