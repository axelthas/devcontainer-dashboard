/**
 * Unit tests for polaris-manager.ts
 *
 * Covers pure / near-pure functions that do not require a live Docker daemon
 * or a writable filesystem:
 *   - getPolarisType    (pure detection logic)
 *   - getDefaultServices (reads a module-level constant)
 *   - groupIntoInstances (groups ContainerData[] by composeProject;
 *                         reads registry from disk but handles missing file gracefully)
 *   - switchMode        (validates mode string before any docker calls)
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Prevent Dockerode from trying to connect to /var/run/docker.sock during tests.
vi.mock('./docker', () => ({ default: {} }));

import {
	getPolarisType,
	absolutizeBindMount,
	applyIpRewrites,
	loadVariantConfig,
	bindPortToLoopback,
	getDefaultServices,
	groupIntoInstances,
	switchMode
} from './polaris-manager';
import type { ContainerData } from '$lib/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContainer(overrides: Partial<ContainerData> & { name: string }): ContainerData {
	return {
		id: overrides.name.replace(/\//g, '').substring(0, 12),
		projectName: overrides.name,
		state: 'running',
		isDevcontainer: false,
		ports: {},
		image: '',
		...overrides
	};
}

// ── getPolarisType ─────────────────────────────────────────────────────────────

describe('getPolarisType', () => {
	describe('detection via composeProject label', () => {
		it('returns the composeProject when it starts with polaris-', () => {
			expect(getPolarisType('irrelevant', 'polaris-ice-109')).toBe('polaris-ice-109');
			expect(getPolarisType('irrelevant', 'polaris-mag-110')).toBe('polaris-mag-110');
		});

		it('ignores composeProject that does not start with polaris-', () => {
			// Falls through to name-based detection
			expect(getPolarisType('polaris-ice-fdp-a', 'some-other-project')).toBe('polaris-ice');
		});
	});

	describe('detection via container name prefix', () => {
		it('detects polaris-ice containers', () => {
			expect(getPolarisType('polaris-ice-fdp-a')).toBe('polaris-ice');
			expect(getPolarisType('polaris-ice-sdp-a')).toBe('polaris-ice');
			expect(getPolarisType('polaris-ice-atm1')).toBe('polaris-ice');
		});

		it('detects polaris-mag containers', () => {
			expect(getPolarisType('polaris-mag-cp01')).toBe('polaris-mag');
			expect(getPolarisType('polaris-mag-mnt-smc-a')).toBe('polaris-mag');
		});

		it('detects polaris-qkt containers', () => {
			expect(getPolarisType('polaris-qkt-sdp-a')).toBe('polaris-qkt');
		});

		it('strips a leading slash from the container name', () => {
			expect(getPolarisType('/polaris-ice-fdp-a')).toBe('polaris-ice');
			expect(getPolarisType('/polaris-mag-cp01')).toBe('polaris-mag');
		});
	});

	describe('detection via orion / tatoo sidecar naming', () => {
		it('detects orion-test-* as the matching polaris type', () => {
			expect(getPolarisType('orion-test-qkt')).toBe('polaris-qkt');
			expect(getPolarisType('orion-test-ice')).toBe('polaris-ice');
		});

		it('detects orion-<type> sidecars', () => {
			expect(getPolarisType('orion-ice')).toBe('polaris-ice');
			expect(getPolarisType('orion-qkt-test')).toBe('polaris-qkt');
		});

		it('detects tatoo-<type> sidecars', () => {
			expect(getPolarisType('tatoo-ice')).toBe('polaris-ice');
			expect(getPolarisType('tatoo-qkt')).toBe('polaris-qkt');
		});

		it('returns null for orion-mysql (excluded to avoid false grouping)', () => {
			expect(getPolarisType('orion-mysql')).toBeNull();
		});
	});

	describe('detection via image name', () => {
		it('detects polaris type from sandbox image name', () => {
			expect(
				getPolarisType(
					'container-x',
					undefined,
					'registry.example.com/polaris-ice-sandbox-fdp:26.0.21'
				)
			).toBe('polaris-ice');
			expect(
				getPolarisType(
					'container-x',
					undefined,
					'registry.example.com/polaris-mag-sandbox-cp01:latest'
				)
			).toBe('polaris-mag');
		});
	});

	describe('non-polaris containers', () => {
		it('returns null for generic containers', () => {
			expect(getPolarisType('nginx')).toBeNull();
			expect(getPolarisType('postgres')).toBeNull();
			expect(getPolarisType('redis-cache')).toBeNull();
		});

		it('returns null for containers with no matching image', () => {
			expect(getPolarisType('myapp', undefined, 'myregistry/myapp:latest')).toBeNull();
		});
	});

	describe('priority order', () => {
		it('prefers composeProject label over container name', () => {
			// composeProject = polaris-ice-109 wins over the generic name detection
			const result = getPolarisType('polaris-mag-cp01', 'polaris-ice-109');
			expect(result).toBe('polaris-ice-109');
		});
	});
});

// ── getDefaultServices ────────────────────────────────────────────────────────

describe('getDefaultServices', () => {
	it('returns the default ice services', () => {
		const services = getDefaultServices('polaris-ice');
		expect(services).toContain('fdp-a');
		expect(services).toContain('sdp-a');
		expect(services).toContain('cdr-a');
		expect(services).toContain('atm1');
		expect(services.length).toBeGreaterThan(0);
	});

	it('returns the default mag services', () => {
		const services = getDefaultServices('polaris-mag');
		expect(services).toContain('fdp-a');
		expect(services).toContain('cp01');
		expect(services).toContain('mnt-smc-a');
	});

	it('returns an empty list for polaris-qkt (start all)', () => {
		expect(getDefaultServices('polaris-qkt')).toEqual([]);
	});

	it('returns an empty list for unknown types', () => {
		expect(getDefaultServices('polaris-unknown')).toEqual([]);
		expect(getDefaultServices('')).toEqual([]);
	});
});

// ── groupIntoInstances ────────────────────────────────────────────────────────

describe('groupIntoInstances', () => {
	it('returns an empty containers list for no input', () => {
		// The function may still include stopped stacks from the registry.
		// We only assert that no container objects appear in the running groups.
		const result = groupIntoInstances([]);
		expect(Array.isArray(result)).toBe(true);
		for (const inst of result) {
			expect(inst.containers).toHaveLength(0);
		}
	});

	it('ignores containers that are not polaris-related', () => {
		const containers = [
			makeContainer({ name: 'nginx', composeProject: 'webserver' }),
			makeContainer({ name: 'postgres', composeProject: 'webserver' })
		];
		const result = groupIntoInstances(containers);
		const ids = result.map((r) => r.id);
		expect(ids).not.toContain('webserver');
	});

	it('ignores polaris containers without a composeProject (not a compose stack)', () => {
		const containers = [
			makeContainer({ name: 'polaris-ice-fdp-a' }) // no composeProject
		];
		const result = groupIntoInstances(containers);
		// Should not appear in the live groups
		const live = result.filter((r) => r.containers.length > 0);
		expect(live).toHaveLength(0);
	});

	it('groups containers from the same composeProject into one instance', () => {
		const containers = [
			makeContainer({ name: 'polaris-ice-fdp-a', composeProject: 'polaris-ice-109', id: 'aaa111' }),
			makeContainer({ name: 'polaris-ice-sdp-a', composeProject: 'polaris-ice-109', id: 'bbb222' }),
			makeContainer({ name: 'orion-ice-109', composeProject: 'polaris-ice-109', id: 'ccc333' })
		];
		const result = groupIntoInstances(containers);
		const ice109 = result.find((r) => r.id === 'polaris-ice-109');
		expect(ice109).toBeDefined();
		expect(ice109!.containers).toHaveLength(3);
		expect(ice109!.type).toBe('polaris-ice-109');
	});

	it('creates separate instances for different composeProjects', () => {
		const containers = [
			makeContainer({ name: 'polaris-ice-fdp-a', composeProject: 'polaris-ice-109', id: 'aaa111' }),
			makeContainer({ name: 'polaris-ice-fdp-a', composeProject: 'polaris-ice-110', id: 'bbb222' })
		];
		const result = groupIntoInstances(containers);
		const live = result.filter((r) => r.containers.length > 0);
		const ids = live.map((r) => r.id);
		expect(ids).toContain('polaris-ice-109');
		expect(ids).toContain('polaris-ice-110');
	});

	it('sets managedByDashboard=false for instances not in the registry', () => {
		const containers = [
			makeContainer({
				name: 'polaris-ice-fdp-a',
				composeProject: 'polaris-ice-999-not-in-registry',
				id: 'zzz999'
			})
		];
		const result = groupIntoInstances(containers);
		const inst = result.find((r) => r.id === 'polaris-ice-999-not-in-registry');
		expect(inst).toBeDefined();
		expect(inst!.managedByDashboard).toBe(false);
	});

	it('prefers the address of a running container over the project id', () => {
		const instances = groupIntoInstances([
			makeContainer({
				name: '/polaris-ice-fdp-a',
				composeProject: 'polaris-mcp-58',
				ipAddress: '192.168.108.10'
			})
		]);
		expect(instances[0].subnet).toBe('192.168.108.0/24');
	});

	it('resolves subnet heuristically from trailing octet in project id', () => {
		const containers = [
			makeContainer({
				name: 'polaris-ice-fdp-a',
				composeProject: 'polaris-ice-109',
				id: 'sub109aa'
			})
		];
		const result = groupIntoInstances(containers);
		const inst = result.find((r) => r.id === 'polaris-ice-109');
		expect(inst!.subnet).toBe('192.168.109.0/24');
	});
});

// ── switchMode ────────────────────────────────────────────────────────────────

describe('switchMode', () => {
	it('throws for an unrecognised mode', async () => {
		await expect(switchMode([], 'invalid-mode')).rejects.toThrow(
			/Invalid mode "invalid-mode"\. Allowed:/
		);
	});

	it('lists all allowed modes in the error message', async () => {
		await expect(switchMode([], 'foo')).rejects.toThrow(/training.*playback.*testing.*operational/);
	});

	it('resolves without error for empty containerIds and a valid mode', async () => {
		// No docker calls are made when containerIds is empty.
		// No filesystem writes happen when instanceId is omitted.
		await expect(switchMode([], 'training')).resolves.toBeUndefined();
		await expect(switchMode([], 'playback')).resolves.toBeUndefined();
		await expect(switchMode([], 'testing')).resolves.toBeUndefined();
		await expect(switchMode([], 'operational')).resolves.toBeUndefined();
	});
});

// ── Generated compose: ports and bind mounts ──────────────────────────────────

describe('bindPortToLoopback', () => {
	it.each([
		['5904/tcp', '127.0.0.1::5904/tcp'],
		['6904', '127.0.0.1::6904'],
		['8080:80', '127.0.0.1:8080:80'],
		['0.0.0.0:8080:80/tcp', '127.0.0.1:8080:80/tcp'],
		['127.0.0.1:8080:80', '127.0.0.1:8080:80']
	])('%s -> %s', (input, expected) => {
		expect(bindPortToLoopback(input)).toBe(expected);
	});
});

describe('absolutizeBindMount', () => {
	const dir = '/srv/instances/polaris-ice-109';

	it('makes a relative source absolute and keeps target and options', () => {
		expect(absolutizeBindMount('./config/x:/home/x:ro', dir)).toBe(`${dir}/config/x:/home/x:ro`);
	});

	it('rewrites a relative default inside a variable', () => {
		expect(absolutizeBindMount('${RECORD:-./record}:/record', dir)).toBe(
			`\${RECORD:-${dir}/record}:/record`
		);
	});

	it('leaves absolute sources and named volumes alone', () => {
		expect(absolutizeBindMount('/tmp/.X11-unix:/tmp/.X11-unix:rw', dir)).toBe(
			'/tmp/.X11-unix:/tmp/.X11-unix:rw'
		);
		expect(absolutizeBindMount('data:/data', dir)).toBe('data:/data');
	});
});

// ── Variant addressing (POLARIS_VARIANTS_FILE) ────────────────────────────────

describe('variant addressing', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'polaris-variants-'));
		process.env.POLARIS_VARIANTS_FILE = join(dir, 'variants.json');
	});

	afterEach(() => {
		delete process.env.POLARIS_VARIANTS_FILE;
		rmSync(dir, { recursive: true, force: true });
	});

	function writeVariants(value: unknown) {
		writeFileSync(process.env.POLARIS_VARIANTS_FILE!, JSON.stringify(value));
	}

	it('has no configuration without a file', () => {
		expect(loadVariantConfig('polaris-test')).toEqual({});
		expect(applyIpRewrites('172.31.1.5 fdp', 'polaris-test', 110)).toBe('172.31.1.5 fdp');
	});

	it('ignores an unreadable file', () => {
		writeFileSync(process.env.POLARIS_VARIANTS_FILE!, '{ not json');
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(loadVariantConfig('polaris-test')).toEqual({});
	});

	it('rewrites configured prefixes with the instance octet', () => {
		writeVariants({
			'polaris-test': {
				ipRewrites: { '172.31.1.': '192.168.{octet}.', '172.31.41.': '10.{octet}.41.' }
			}
		});
		expect(
			applyIpRewrites('172.31.1.5 fdp\n172.31.41.7 cwp\n8.8.8.8 dns', 'polaris-test', 110)
		).toBe('192.168.110.5 fdp\n10.110.41.7 cwp\n8.8.8.8 dns');
		// A prefix only matches at the start of an address.
		expect(applyIpRewrites('10.172.31.1.5', 'polaris-test', 110)).toBe('10.172.31.1.5');
		expect(applyIpRewrites('172.31.1.5', 'polaris-other', 110)).toBe('172.31.1.5');
	});

	it('drops invalid entries', () => {
		writeVariants({
			'polaris-test': {
				fallbackSubnet: 'not-a-subnet',
				ipRewrites: { '172.31': '192.168.{octet}.', '172.31.2.': 5, '172.31.3.': '10.0.0.' }
			}
		});
		expect(loadVariantConfig('polaris-test')).toEqual({ ipRewrites: { '172.31.3.': '10.0.0.' } });
	});

	it('reports the configured fallback subnet for an instance without addresses', () => {
		writeVariants({ 'polaris-test': { fallbackSubnet: '10.200.1.0/24' } });
		const [instance] = groupIntoInstances([
			makeContainer({ name: 'polaris-test-sdp-a', composeProject: 'polaris-test', state: 'exited' })
		]).filter((r) => r.id === 'polaris-test');
		expect(instance.subnet).toBe('10.200.1.0/24');
	});
});
