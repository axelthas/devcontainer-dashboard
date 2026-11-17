/** Regressions for reading the remote user from the devcontainer.metadata label. */
import { describe, expect, it } from 'vitest';
import { resolveRemoteUser } from './devcontainerMetadata';

/** Build container labels with one metadata label. */
const labels = (metadata: unknown) => ({ 'devcontainer.metadata': JSON.stringify(metadata) });

describe('resolveRemoteUser', () => {
	it('uses the last remoteUser, so devcontainer.json overrides image metadata', () => {
		expect(
			resolveRemoteUser(
				labels([{ remoteUser: 'root' }, { id: 'feature' }, { remoteUser: 'vscode' }])
			)
		).toEqual({ remoteUser: 'vscode', remoteUserSource: 'remoteUser' });
	});

	it('falls back to containerUser when no remoteUser is set', () => {
		expect(resolveRemoteUser(labels([{ containerUser: 'node' }, {}]))).toEqual({
			remoteUser: 'node',
			remoteUserSource: 'containerUser'
		});
	});

	it('accepts a single metadata object and numeric ids with a group', () => {
		expect(resolveRemoteUser(labels({ remoteUser: '1000:1000' }))).toEqual({
			remoteUser: '1000:1000',
			remoteUserSource: 'remoteUser'
		});
	});

	it('returns no user when the container has no metadata', () => {
		expect(resolveRemoteUser({})).toEqual({});
		expect(resolveRemoteUser(undefined)).toEqual({});
		expect(resolveRemoteUser(labels([{ customizations: {} }]))).toEqual({});
	});

	it.each(['${localEnv:USER}', 'a b', '-u', "o'brien", ''])(
		'rejects %j instead of running as another user',
		(user) => {
			const result = resolveRemoteUser(labels([{ remoteUser: user }]));
			expect(result.remoteUser).toBeUndefined();
			expect(result.remoteUserError).toContain('remoteUser');
		}
	);

	it('does not fall back to containerUser when remoteUser is unusable', () => {
		const result = resolveRemoteUser(
			labels([{ containerUser: 'node', remoteUser: '${localEnv:USER}' }])
		);
		expect(result).toEqual({ remoteUserError: expect.stringContaining('remoteUser') });
	});

	it('reports a malformed label', () => {
		expect(resolveRemoteUser({ 'devcontainer.metadata': '{' })).toEqual({
			remoteUserError: 'The devcontainer metadata label is not valid JSON'
		});
	});
});
