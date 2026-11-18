/** Regressions for reading the remote user from the devcontainer.metadata label. */
import { describe, expect, it } from 'vitest';
import { resolveNetworkPresets, resolveRemoteUser } from './devcontainerMetadata';

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

	it.each(['a b', '-u', "o'brien", ''])('rejects %j instead of running as another user', (user) => {
		const result = resolveRemoteUser(labels([{ remoteUser: user }]));
		expect(result.remoteUser).toBeUndefined();
		expect(result.remoteUserError).toContain('remoteUser');
	});

	it('does not fall back to containerUser when remoteUser is unusable', () => {
		const result = resolveRemoteUser(
			labels([{ containerUser: 'node', remoteUser: '${localEnv:USER}' }]),
			{}
		);
		expect(result).toEqual({ remoteUserError: expect.stringContaining('remoteUser') });
	});

	it('reports a malformed label', () => {
		expect(resolveRemoteUser({ 'devcontainer.metadata': '{' })).toEqual({
			remoteUserError: 'The devcontainer metadata label is not valid JSON'
		});
	});

	it('resolves localEnv from the dashboard environment before validating remoteUser', () => {
		expect(resolveRemoteUser(labels({ remoteUser: '${localEnv:USER}' }), { USER: 'axel' })).toEqual(
			{ remoteUser: 'axel', remoteUserSource: 'remoteUser' }
		);
	});

	it('resolves multiple tokens and literal text in containerUser', () => {
		expect(
			resolveRemoteUser(labels({ containerUser: '${localEnv:UID}:${localEnv:GID}' }), {
				UID: '1000',
				GID: '1001'
			})
		).toEqual({ remoteUser: '1000:1001', remoteUserSource: 'containerUser' });
		expect(
			resolveRemoteUser(labels({ remoteUser: 'dev-${localEnv:USER}' }), { USER: 'axel' })
		).toEqual({ remoteUser: 'dev-axel', remoteUserSource: 'remoteUser' });
	});

	it('uses a default only when the variable is unset', () => {
		const metadata = labels({ remoteUser: '${localEnv:USER:vscode}' });
		expect(resolveRemoteUser(metadata, {})).toEqual({
			remoteUser: 'vscode',
			remoteUserSource: 'remoteUser'
		});
		expect(resolveRemoteUser(metadata, { USER: 'axel' }).remoteUser).toBe('axel');
		expect(resolveRemoteUser(metadata, { USER: '' }).remoteUserError).toContain('remoteUser');
	});

	it('reports a missing variable without falling back to another user', () => {
		const result = resolveRemoteUser(
			labels({ remoteUser: '${localEnv:USER}', containerUser: 'root' }),
			{}
		);
		expect(result.remoteUser).toBeUndefined();
		expect(result.remoteUserError).toContain('USER is not set');
	});

	it.each(['bad user', '$(id)', '${localEnv:OTHER}', '', '-root'])(
		'rejects invalid substituted values without exposing them: %j',
		(USER) => {
			const result = resolveRemoteUser(labels({ remoteUser: '${localEnv:USER}' }), { USER });
			expect(result.remoteUser).toBeUndefined();
			expect(result.remoteUserError).toBe(
				'remoteUser in the devcontainer metadata does not resolve to a plain user name'
			);
		}
	);

	it('does not substitute tokens in overridden metadata entries', () => {
		expect(
			resolveRemoteUser(
				labels([{ remoteUser: '${localEnv:MISSING}' }, { remoteUser: 'vscode' }]),
				{}
			)
		).toEqual({ remoteUser: 'vscode', remoteUserSource: 'remoteUser' });
	});
});

describe('resolveNetworkPresets', () => {
	/** Wrap network declarations the way devcontainer.json customizations store them. */
	const declared = (networks: unknown) => ({
		customizations: { 'devcontainer-dashboard': { networks } }
	});

	it('reads declared networks and seats from the metadata label', () => {
		expect(
			resolveNetworkPresets(
				labels([
					{ id: 'feature' },
					declared([
						{
							network: 'keflavik_oplan',
							seats: [{ hostname: 'sim-pilot-1', ip: '192.168.103.140' }, { hostname: 'any' }]
						}
					])
				])
			)
		).toEqual([
			{
				network: 'keflavik_oplan',
				seats: [{ hostname: 'sim-pilot-1', ip: '192.168.103.140' }, { hostname: 'any' }]
			}
		]);
	});

	it('lets a later entry replace a network and skips invalid values', () => {
		expect(
			resolveNetworkPresets(
				labels([
					declared([{ network: 'net', seats: [{ hostname: 'old', ip: '10.0.0.2' }] }]),
					declared([
						{ network: 'bridge' },
						{ network: '../escape' },
						{
							network: 'net',
							seats: [
								{ hostname: 'Bad Host', ip: '10.0.0.3' },
								{ hostname: 'new', ip: '10.0.0.999' },
								{ hostname: 'kept', ip: '10.0.0.4' }
							]
						}
					])
				])
			)
		).toEqual([{ network: 'net', seats: [{ hostname: 'kept', ip: '10.0.0.4' }] }]);
	});

	it('returns no presets without metadata, with invalid JSON, or without the customization', () => {
		expect(resolveNetworkPresets(undefined)).toEqual([]);
		expect(resolveNetworkPresets({ 'devcontainer.metadata': '{' })).toEqual([]);
		expect(resolveNetworkPresets(labels([{ customizations: { vscode: {} } }]))).toEqual([]);
	});
});
