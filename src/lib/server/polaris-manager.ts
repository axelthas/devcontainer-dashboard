/**
 * Polaris Instance Manager
 *
 * Handles multi-instance Polaris sandbox lifecycle:
 *  - Instance registry (read/write JSON)
 *  - Subnet allocation per new instance
 *  - docker-compose.yml generation with correct subnet/IPs/container-names
 *  - Hosts-file generation per mode (training/playback/testing/operational)
 *  - orion-environmental.json generation
 *  - Stack start/stop via `docker compose`
 *  - Mode switching via docker exec + supervisorctl
 *
 * ── Mount paths required inside the dashboard container ───────────────────────
 *  /polaris-source/polaris-ice  ← polaris-ice repo (read-only)
 *  /polaris-source/polaris-qkt  ← polaris-qkt repo (read-only)
 *  /polaris-instances           ← writable dir for generated instance files
 *
 * ── Required env vars ─────────────────────────────────────────────────────────
 *  POLARIS_INSTANCES_DIR          (default: /polaris-instances)
 *  POLARIS_INSTANCES_HOST_PATH    host-side absolute path to the same dir
 *                                 (needed so generated bind-mounts in compose
 *                                  resolve correctly on the host)
 *  POLARIS_<TYPE>_SOURCE           source repo mount per type, e.g.:
 *    POLARIS_ICE_SOURCE             (default: /polaris-source/polaris-ice)
 *    POLARIS_QKT_SOURCE             (default: /polaris-source/polaris-qkt)
 *    POLARIS_MAG_SOURCE             (default: /polaris-source/polaris-mag)
 *  ORION_ENVIRONMENTAL_JSON_PATH  container-side path for orion-environmental.json
 *                                 (default: /usr/share/polaris/config/orion-environmental.json)
 *  POLARIS_IMAGE_REGISTRY         registry prefix of the sandbox images, e.g. registry.example.com
 *                                 (needed to read hosts files from a polaris-mag image)
 *  POLARIS_VARIANTS_FILE          per-variant addressing (default: /data/polaris-variants.json);
 *                                 see polaris-variants.example.json
 */

import { cpSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import docker from './docker';
import type { ContainerData, PolarisInstance, PolarisType, PolarisRegistryEntry } from '$lib/types';

// ── Configuration ─────────────────────────────────────────────────────────────

const INSTANCES_DIR = process.env.POLARIS_INSTANCES_DIR ?? '/polaris-instances';
/** Host-side path to the same directory (for bind-mount paths in generated compose) */
const INSTANCES_HOST_PATH = process.env.POLARIS_INSTANCES_HOST_PATH ?? INSTANCES_DIR;
const REGISTRY_FILE = join(INSTANCES_DIR, 'registry.json');
/** Stores currentMode for ALL instances (managed + external) across restarts. */
const MODES_FILE = join(INSTANCES_DIR, 'modes.json');

/**
 * Build source directory map from all POLARIS_*_SOURCE env vars.
 * e.g. POLARIS_ICE_SOURCE → 'polaris-ice', POLARIS_MAG_SOURCE → 'polaris-mag'
 * Falls back to well-known defaults for ice and qkt.
 */
function buildSourceDirs(): Record<PolarisType, string> {
	const result: Record<PolarisType, string> = {
		'polaris-ice': process.env.POLARIS_ICE_SOURCE ?? '/polaris-source/polaris-ice',
		'polaris-qkt': process.env.POLARIS_QKT_SOURCE ?? '/polaris-source/polaris-qkt'
	};
	for (const [key, val] of Object.entries(process.env)) {
		if (key.startsWith('POLARIS_') && key.endsWith('_SOURCE') && val) {
			// POLARIS_MAG_SOURCE → 'polaris-mag'
			const middle = key
				.slice('POLARIS_'.length, -'_SOURCE'.length)
				.toLowerCase()
				.replace(/_/g, '-');
			const type = `polaris-${middle}` as PolarisType;
			result[type] = val;
		}
	}
	return result;
}

/** Base subnet third-octet for polaris-ice. Instance 1 = 108, next = 109, etc. */
const ICE_SUBNET_PREFIX = '192.168';

// ── Default service profiles ──────────────────────────────────────────────────
//
// These define which compose services are started by default for each type.
// "Support" services (mysql, tatoo) are always started automatically by compose
// via `depends_on`, so they don't need to be listed here.
// Edit this map to change the defaults, or override per-instance via the UI.

const DEFAULT_SERVICE_PROFILES: Record<string, string[]> = {
	// stm-a and orion are required: in training mode the FDP-side services need Orion's simulated
	// clock, otherwise they stay "not primary" and the ASD gets no workstation or sector.
	'polaris-ice': [
		'fdp-a',
		'sdp-a',
		'cdr-a',
		'sns-a',
		'stm-a',
		'app1-asd-a',
		'atm1',
		'pdp-a',
		'orion'
	],
	'polaris-mag': ['fdp-a', 'cdr-a', 'cp01', 'mnt-smc-a', 'pdp'],
	'polaris-qkt': [] // all services (qkt has a small fixed set)
};
const ICE_ORIGINAL_OCTET = 108;

/** Container path for orion-environmental.json. Customisable via env var. */
const ORION_JSON_CONTAINER_PATH =
	process.env.ORION_ENVIRONMENTAL_JSON_PATH ?? '/usr/share/polaris/config/orion-environmental.json';

// ── Variant addressing (operator configuration) ───────────────────────────────

/**
 * Addressing that a variant's images and compose file bake in. It belongs to the deployment, not
 * to this code, so it is read from POLARIS_VARIANTS_FILE: a JSON object keyed by variant type.
 */
export interface PolarisVariantConfig {
	/** Subnet reported for an instance whose address is not known yet, e.g. "10.0.1.0/24" */
	fallbackSubnet?: string;
	/**
	 * Address prefixes rewritten for a new instance, e.g. { "172.31.1.": "192.168.{octet}." }.
	 * Applied to the primary network's addresses and to hosts files read from the image.
	 */
	ipRewrites?: Record<string, string>;
}

const IP_PREFIX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.$/;
const SUBNET = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;

/** Reads the configuration of one variant. A missing or invalid file means no configuration. */
export function loadVariantConfig(type: PolarisType): PolarisVariantConfig {
	const file = process.env.POLARIS_VARIANTS_FILE ?? '/data/polaris-variants.json';
	if (!existsSync(file)) return {};
	let raw: unknown;
	try {
		raw = (JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>)?.[type];
	} catch (err) {
		console.warn(`[polaris] Ignoring unreadable ${file}:`, err);
		return {};
	}
	if (!raw || typeof raw !== 'object') return {};
	const { fallbackSubnet, ipRewrites } = raw as Record<string, unknown>;
	const config: PolarisVariantConfig = {};
	if (typeof fallbackSubnet === 'string' && SUBNET.test(fallbackSubnet)) {
		config.fallbackSubnet = fallbackSubnet;
	}
	if (ipRewrites && typeof ipRewrites === 'object') {
		config.ipRewrites = Object.fromEntries(
			Object.entries(ipRewrites).filter(
				([from, to]) => IP_PREFIX.test(from) && typeof to === 'string'
			)
		);
	}
	return config;
}

/** Applies a variant's ipRewrites to text, with {octet} replaced by the instance octet. */
export function applyIpRewrites(text: string, type: PolarisType, octet: number): string {
	let result = text;
	for (const [from, to] of Object.entries(loadVariantConfig(type).ipRewrites ?? {})) {
		// Not preceded by a digit or dot: 172.31.1. must not match inside 10.172.31.1.5
		const pattern = new RegExp(`(?<![\\d.])${from.replace(/\./g, '\\.')}`, 'g');
		result = result.replace(pattern, to.replace(/\{octet\}/g, String(octet)));
	}
	return result;
}

// ── Registry helpers ──────────────────────────────────────────────────────────

interface Registry {
	instances: PolarisRegistryEntry[];
}

function readRegistry(): Registry {
	if (!existsSync(REGISTRY_FILE)) return { instances: [] };
	try {
		return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
	} catch {
		return { instances: [] };
	}
}

function saveRegistry(registry: Registry): void {
	mkdirSync(INSTANCES_DIR, { recursive: true });
	writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
}

// ── Mode cache (persists currentMode for ALL instances) ───────────────────────

function readModesCache(): Record<string, string> {
	if (!existsSync(MODES_FILE)) return {};
	try {
		return JSON.parse(readFileSync(MODES_FILE, 'utf-8'));
	} catch {
		return {};
	}
}

function writeModesCache(cache: Record<string, string>): void {
	mkdirSync(INSTANCES_DIR, { recursive: true });
	writeFileSync(MODES_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

// ── Polaris container detection ───────────────────────────────────────────────

/**
 * Detects any polaris-* variant by checking (in order):
 *  1. The Docker Compose project label — most reliable when containers were
 *     started with `docker compose`.
 *  2. The container name prefix (e.g. `polaris-mag-cp01` → `polaris-mag`).
 *  3. The image name (e.g. `<registry>/polaris-mag-sandbox-*` → `polaris-mag`).
 */
export function getPolarisType(
	name: string,
	composeProject?: string,
	image?: string
): PolarisType | null {
	// 1. Compose project label is the most authoritative
	if (composeProject?.match(/^polaris-/)) return composeProject;

	const nameClean = (name ?? '').replace(/^\//, '').toLowerCase();

	// 2. Container name prefix: polaris-<variant>-<service>
	const nameMatch = nameClean.match(/^(polaris-[a-z0-9]+)-/);
	if (nameMatch) return nameMatch[1];

	// 3. orion/tatoo sidecars: orion-<variant>[-mysql|-test] → polaris-<variant>
	//    e.g. orion-qkt-mysql → polaris-qkt, orion-ice → polaris-ice,
	//         orion-test-qkt (polaris-qkt test container) → polaris-qkt
	const orionTestMatch = nameClean.match(/^orion-test-([a-z0-9]+)/);
	if (orionTestMatch) return `polaris-${orionTestMatch[1]}`;
	const orionMatch = nameClean.match(/^(?:orion|tatoo)-([a-z0-9]+)/);
	if (orionMatch && orionMatch[1] !== 'mysql') return `polaris-${orionMatch[1]}`;

	// 4. Image: <registry>/polaris-<variant>-sandbox-*
	const imgMatch = (image ?? '').match(/\/?(polaris-[a-z0-9]+)-sandbox-/);
	if (imgMatch) return imgMatch[1];

	return null;
}

// ── Instance discovery ────────────────────────────────────────────────────────

export function groupIntoInstances(containers: ContainerData[]): PolarisInstance[] {
	const groups = new Map<string, { type: PolarisType; ctrs: ContainerData[] }>();

	for (const c of containers) {
		const type = getPolarisType(c.name, c.composeProject, c.image);
		if (!type) continue;

		// Skip standalone containers not managed by docker compose.
		// A Polaris instance is always a compose stack; lone containers (e.g. pulled
		// for testing) would end up in a fake "*-default" group which is misleading.
		if (!c.composeProject) continue;

		const key = c.composeProject;
		if (!groups.has(key)) groups.set(key, { type, ctrs: [] });
		groups.get(key)!.ctrs.push(c);
	}

	const registry = readRegistry();
	const modesCache = readModesCache();
	const result: PolarisInstance[] = [];

	for (const [projectId, { type, ctrs }] of groups) {
		const registryEntry = registry.instances.find((e) => e.id === projectId);
		const composeFile = ctrs[0].composeConfigFiles ?? registryEntry?.composeFile;
		const workingDir = ctrs[0].composeWorkingDir ?? registryEntry?.instanceDir;

		result.push({
			id: projectId,
			type,
			subnet: resolveSubnet(type, projectId, registryEntry, ctrs),
			instanceDir: registryEntry?.instanceDir,
			composeFile,
			workingDir,
			managedByDashboard: !!registryEntry,
			containers: ctrs,
			currentMode: (modesCache[projectId] ?? registryEntry?.currentMode) as
				| import('$lib/types').PolarisMode
				| undefined,
			services: registryEntry?.services,
			novncMode: registryEntry?.novncMode
		});
	}

	// Include registry entries with no running containers (stopped stacks)
	for (const entry of registry.instances) {
		if (!result.find((r) => r.id === entry.id)) {
			result.push({
				id: entry.id,
				type: entry.type,
				subnet: `${ICE_SUBNET_PREFIX}.${entry.subnetOctet}.0/24`,
				instanceDir: entry.instanceDir,
				composeFile: entry.composeFile,
				workingDir: entry.instanceDir,
				managedByDashboard: true,
				containers: [],
				currentMode: (modesCache[entry.id] ?? entry.currentMode) as
					| import('$lib/types').PolarisMode
					| undefined,
				services: entry.services,
				novncMode: entry.novncMode
			});
		}
	}

	return result;
}

function resolveSubnet(
	type: PolarisType,
	projectId: string,
	registryEntry?: PolarisRegistryEntry,
	containers: ContainerData[] = []
): string {
	if (registryEntry) return `${ICE_SUBNET_PREFIX}.${registryEntry.subnetOctet}.0/24`;
	// The address of a running container is the truth; everything below is a guess.
	const ip = containers.find((c) => c.ipAddress)?.ipAddress;
	if (ip) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
	const fallback = loadVariantConfig(type).fallbackSubnet;
	if (fallback) return fallback;
	// Heuristic: if project id ends with a number, use that as octet
	const m = projectId.match(/(\d+)$/);
	if (m) return `${ICE_SUBNET_PREFIX}.${m[1]}.0/24`;
	return `${ICE_SUBNET_PREFIX}.${ICE_ORIGINAL_OCTET}.0/24`;
}

// ── Subnet allocation ─────────────────────────────────────────────────────────

async function allocateSubnetOctet(): Promise<number> {
	const usedOctets = new Set<number>();
	usedOctets.add(ICE_ORIGINAL_OCTET); // 108 is always taken by the original instance

	// Scan existing Docker networks for 192.168.x.0/24 subnets
	try {
		const networks = await docker.listNetworks();
		for (const net of networks) {
			const configs = (net as { IPAM?: { Config?: { Subnet?: string }[] } }).IPAM?.Config ?? [];
			for (const cfg of configs) {
				const m = cfg.Subnet?.match(/192\.168\.(\d+)\./);
				if (m) usedOctets.add(parseInt(m[1]));
			}
		}
	} catch {
		// Non-fatal; worst-case we pick a conflicting octet which compose will reject
	}

	// Also check registry entries
	for (const entry of readRegistry().instances) {
		usedOctets.add(entry.subnetOctet);
	}

	for (let octet = ICE_ORIGINAL_OCTET; octet <= 200; octet++) {
		if (!usedOctets.has(octet)) return octet;
	}
	throw new Error('No available subnet octet in 192.168.108-200 range');
}

// ── Hosts-file generation ─────────────────────────────────────────────────────

/**
 * Rewrites a Polaris hosts file for a new subnet octet.
 * - Replaces all `192.168.108.` IPs with `192.168.{newOctet}.`
 * - Removes the `orion-mysql` alias from the orion line (prevents Docker DNS
 *   from overriding the alias and misdirecting MySQL traffic to the wrong container)
 */
function rewriteHostsFile(source: string, newOctet: number): string {
	let result = source.replace(/192\.168\.\d+\./g, `${ICE_SUBNET_PREFIX}.${newOctet}.`);

	// Remove problematic `orion-mysql` alias from any hosts line
	result = result.replace(/^([\d.]+\s+\S+\s+.*?)\borion-mysql\b(.*?)$/gm, (_, pre, post) =>
		(pre + post).replace(/\s{2,}/g, '  ').trimEnd()
	);

	return result;
}

/**
 * Rewrites a hosts file read from a polaris-mag image for a new instance octet, using the
 * variant's ipRewrites from POLARIS_VARIANTS_FILE. Addresses without a rule are left untouched.
 */
function rewriteHostsFileMag(source: string, octet: number): string {
	return applyIpRewrites(source, 'polaris-mag', octet);
}

// ── orion-environmental.json generation ──────────────────────────────────────

function rewriteOrionEnvironmental(source: string, newOctet: number): string {
	// Rewrite all 192.168.108.x references to new subnet
	return source.replace(/192\.168\.\d+\./g, `${ICE_SUBNET_PREFIX}.${newOctet}.`);
}

// ── docker-compose.yml generation ────────────────────────────────────────────

/**
 * Volume mounts injected into every non-mysql service in the generated compose.
 * They override the baked-in hosts files so that:
 *  1. add_hosts.sh at startup reads the correct subnet-specific training hosts
 *  2. ansible mode-switch playbooks read correct subnet-specific hosts for all modes
 *
 * ICE: hosts-{mode} + hosts-training.ops (4 modes, no sub-variants)
 * MAG: hosts-{mode} + hosts-{mode}.{offline,online,contingency} + post-install .offline
 */
function buildHostsVolumes(instanceDirOnHost: string, type?: string): string[] {
	const hd = `${instanceDirOnHost}/hosts-files`;
	const pps = '/polaris-post-install/post-install-scripts';
	const ansible = '/opt/polaris/config/current/roles/common/files';

	if (type === 'polaris-mag') {
		const modes = ['training', 'playback', 'testing'] as const;
		const variants = ['', '.offline', '.online', '.contingency'] as const;
		const mounts: string[] = [];
		for (const mode of modes) {
			for (const variant of variants) {
				mounts.push(`${hd}/hosts-${mode}${variant}:${ansible}/hosts-${mode}${variant}:ro`);
			}
		}
		// post-install add_hosts.sh uses this file to set /etc/hosts on startup
		mounts.push(`${hd}/hosts-training.offline:${pps}/hosts-training.offline:ro`);
		return mounts;
	}

	// ICE (default)
	return [
		`${hd}/hosts-training.ops:${pps}/hosts-training.ops:ro`,
		`${hd}/hosts-training:${ansible}/hosts-training:ro`,
		`${hd}/hosts-playback:${ansible}/hosts-playback:ro`,
		`${hd}/hosts-testing:${ansible}/hosts-testing:ro`,
		`${hd}/hosts-operational:${ansible}/hosts-operational:ro`
	];
}

/**
 * Binds a compose short-form port to localhost. A container-only port ("5904/tcp") needs an empty
 * host-port field: "127.0.0.1:5904/tcp" would make compose read 127.0.0.1 as the host port.
 */
export function bindPortToLoopback(port: string): string {
	if (/^0\.0\.0\.0:/.test(port)) return port.replace(/^0\.0\.0\.0:/, '127.0.0.1:');
	if (/^\d+\.\d+\.\d+\.\d+:/.test(port)) return port;
	if (/^\d+(-\d+)?(\/\w+)?$/.test(port)) return `127.0.0.1::${port}`;
	return `127.0.0.1:${port}`;
}

/** Matches a relative bind source, plain ("./x:/y") or as a variable default ("${X:-./x}:/y"). */
const RELATIVE_BIND_SOURCE = /^(\$\{[A-Za-z_][A-Za-z0-9_]*:-)?\.\/([^:}]*)/;

/**
 * Makes a relative bind source absolute on the host. Compose runs inside the dashboard container,
 * so left as is it resolves against the container path, which the Docker daemon then creates on
 * the host instead of using the instance directory.
 */
export function absolutizeBindMount(volume: string, instanceDirOnHost: string): string {
	return volume.replace(
		RELATIVE_BIND_SOURCE,
		(_match, prefix: string | undefined, path: string) =>
			`${prefix ?? ''}${instanceDirOnHost}/${path}`
	);
}

/** Copies what the relative bind sources point at into the instance directory. */
function materializeRelativeMounts(doc: ComposeDoc, sourceDir: string, instanceDir: string): void {
	for (const svc of Object.values(doc.services ?? {})) {
		for (const volume of svc?.volumes ?? []) {
			if (typeof volume !== 'string') continue;
			const path = volume.match(RELATIVE_BIND_SOURCE)?.[2];
			if (!path) continue;
			const source = join(sourceDir, path);
			const target = join(instanceDir, path);
			if (existsSync(source)) cpSync(source, target, { recursive: true, dereference: true });
			else mkdirSync(target, { recursive: true });
		}
	}
}

type ComposeService = {
	container_name?: string;
	networks?: Record<string, { ipv4_address?: string; aliases?: string[] } | null>;
	extra_hosts?: string[];
	volumes?: string[];
	[key: string]: unknown;
};

type ComposeDoc = {
	version?: string;
	networks?: Record<string, unknown>;
	services?: Record<string, ComposeService>;
	[key: string]: unknown;
};

function transformComposeDoc(
	doc: ComposeDoc,
	octet: number,
	instanceId: string,
	instanceDirOnHost: string,
	tag?: string,
	type?: string
): ComposeDoc {
	const compose = structuredClone(doc) as ComposeDoc;

	// Remove YAML anchor definitions (already inlined by parser)
	for (const key of Object.keys(compose)) {
		if (key.startsWith('x-')) delete (compose as Record<string, unknown>)[key];
	}

	// Pin image tag if requested (replaces ${TAG:-latest} / ${TAG} variable syntax)
	if (tag) {
		const services = (compose.services ?? {}) as Record<string, ComposeService>;
		for (const svc of Object.values(services)) {
			if (svc?.image && typeof svc.image === 'string') {
				svc.image = svc.image.replace(/:\$\{TAG(?::-[^}]*)?\}/g, `:${tag}`);
			}
		}
	}

	// 1. Build per-network transformation table
	//    Primary polaris network → polaris-net-{octet} at 192.168.{octet}.0/24
	//    Other internal networks with explicit subnets → 10.{octet}.{3rdOctet}.0/24
	//    An external primary network is de-externalised and gets the same treatment
	type NetInfo = {
		newName: string;
		newSubnet: string;
		newGateway: string;
		remapIp: (ip: string) => string;
	};
	const netInfoMap = new Map<string, NetInfo>();

	const allNets = (compose.networks ?? {}) as Record<string, Record<string, unknown>>;
	const primaryNetName = Object.keys(allNets).find((n) => n.includes('polaris')) ?? '';
	const newNetworkName = `polaris-net-${octet}`;

	for (const [netName, rawDef] of Object.entries(allNets)) {
		const nd = rawDef as Record<string, unknown>;
		const ipam = nd.ipam as
			| { driver?: string; config?: { subnet?: string; gateway?: string }[] }
			| undefined;
		const oldSubnet: string = ipam?.config?.[0]?.subnet ?? '';

		if (netName === primaryNetName) {
			// Primary polaris network: rename, de-externalise, assign 192.168.{octet}.0/24
			delete nd.external;
			delete nd.name;
			nd.ipam = {
				driver: 'default',
				config: [
					{
						subnet: `${ICE_SUBNET_PREFIX}.${octet}.0/24`,
						gateway: `${ICE_SUBNET_PREFIX}.${octet}.254`
					}
				]
			};
			allNets[newNetworkName] = nd;
			delete allNets[netName];
			netInfoMap.set(netName, {
				newName: newNetworkName,
				newSubnet: `${ICE_SUBNET_PREFIX}.${octet}.0/24`,
				newGateway: `${ICE_SUBNET_PREFIX}.${octet}.254`,
				// 192.168.X.Y → 192.168.{octet}.Y, then the variant's own ipRewrites
				remapIp: (ip) =>
					applyIpRewrites(
						ip.replace(/192\.168\.\d+\./g, `${ICE_SUBNET_PREFIX}.${octet}.`),
						type ?? '',
						octet
					)
			});
		} else if (oldSubnet && !nd.external) {
			// Additional internal network with explicit subnet: remap to 10.{octet}.{3rdOctet}.0/24
			const m = oldSubnet.match(/^(\d+)\.(\d+)\.(\d+)\.\d+\/\d+$/);
			if (m) {
				const thirdOctet = m[3];
				const oldPrefix = `${m[1]}.${m[2]}.${m[3]}.`;
				const newSubnet = `10.${octet}.${thirdOctet}.0/24`;
				const newGateway = `10.${octet}.${thirdOctet}.254`;
				// Update the network IPAM in place (keep name — already project-scoped)
				if (ipam) {
					ipam.config = [{ subnet: newSubnet, gateway: newGateway }];
				}
				const oldPrefixEscaped = oldPrefix.replace(/\./g, '\\.');
				const oldPrefixRe = new RegExp(oldPrefixEscaped, 'g');
				netInfoMap.set(netName, {
					newName: netName,
					newSubnet,
					newGateway,
					remapIp: (ip) => ip.replace(oldPrefixRe, `10.${octet}.${thirdOctet}.`)
				});
			}
		}
		// External networks that are NOT the primary polaris network are left as-is
	}
	compose.networks = allNets;

	// 2. Transform each service
	const services = (compose.services ?? {}) as Record<string, ComposeService>;
	const needsHostsMounts = type === 'polaris-ice' || type === 'polaris-mag';
	// Mount only the hosts files that were generated: not every release ships every mode, and the
	// Docker daemon would create a directory for a missing source, which then fails to mount.
	const generatedHostsDir = join(INSTANCES_DIR, instanceId, 'hosts-files');
	const hostsVolumes = needsHostsMounts
		? buildHostsVolumes(instanceDirOnHost, type).filter((volume) =>
				existsSync(join(generatedHostsDir, basename(volume.split(':')[0])))
			)
		: [];

	for (const [serviceName, svc] of Object.entries(services)) {
		// Never pull images from remote registry – images must be present locally
		svc.pull_policy = 'never';

		// Bind all ports to localhost only (never expose on 0.0.0.0)
		if (svc.ports) {
			svc.ports = (svc.ports as (string | Record<string, unknown>)[]).map((p) => {
				if (typeof p === 'string') return bindPortToLoopback(p);
				// Long-form object: { target, published, host_ip, protocol }
				if (!p.host_ip || p.host_ip === '0.0.0.0') p.host_ip = '127.0.0.1';
				return p;
			});
		}

		// Rename container
		if (svc.container_name) {
			svc.container_name = svc.container_name
				.replace(/^polaris-ice-/, `polaris-ice-${octet}-`)
				.replace(/^orion-ice(-|$)/, (_match, sep: string) => `orion-ice-${octet}${sep}`);
		}

		// Update ALL network references (rename primary + remap IPs for all transformed nets)
		if (svc.networks) {
			for (const [oldNetName, netInfo] of netInfoMap) {
				if (!(oldNetName in svc.networks)) continue;
				const netCfg = svc.networks[oldNetName];
				if (netCfg?.ipv4_address) {
					netCfg.ipv4_address = netInfo.remapIp(netCfg.ipv4_address);
				}
				if (netInfo.newName !== oldNetName) {
					svc.networks[netInfo.newName] = netCfg;
					delete svc.networks[oldNetName];
				}
			}
		}

		// Update extra_hosts IPs (apply all remapping functions in order)
		if (svc.extra_hosts) {
			svc.extra_hosts = svc.extra_hosts.map((h: string) => {
				for (const [, netInfo] of netInfoMap) h = netInfo.remapIp(h);
				return h;
			});
		}

		if (svc.volumes) {
			svc.volumes = svc.volumes.map((v) =>
				typeof v === 'string' ? absolutizeBindMount(v, instanceDirOnHost) : v
			);
		}

		if (needsHostsMounts) {
			// Add hosts-file bind-mounts to all non-mysql/non-tatoo services.
			// The host-side files are generated by createInstance with correct per-instance IPs.
			const isSupport =
				serviceName.includes('mysql') ||
				svc.container_name?.includes('mysql') ||
				serviceName === 'orion-mysql' ||
				serviceName === 'tatoo';

			if (!isSupport) {
				svc.volumes = [...(svc.volumes ?? []), ...hostsVolumes];

				// orion container (ICE only) also gets the rewritten orion-environmental.json
				if (type === 'polaris-ice' && serviceName === 'orion') {
					svc.volumes.push(
						`${instanceDirOnHost}/orion/orion-environmental.json:${ORION_JSON_CONTAINER_PATH}:ro`
					);
				}
			}
		}

		services[serviceName] = svc;
	}
	compose.services = services;

	return compose;
}

// ── MAG hosts-file generation ─────────────────────────────────────────────────

/** Registry prefix of the sandbox images, from POLARIS_IMAGE_REGISTRY (no trailing slash). */
function sandboxImageRegistry(): string {
	const registry = process.env.POLARIS_IMAGE_REGISTRY?.trim().replace(/\/+$/, '');
	if (!registry) {
		throw new Error(
			'POLARIS_IMAGE_REGISTRY is not set: it names the registry of the local polaris-mag images, ' +
				'which hold the hosts files of a new instance.'
		);
	}
	return registry;
}

/**
 * Extracts all hosts-* files from the polaris-mag Docker image, rewrites their addresses with
 * the variant's ipRewrites (see rewriteHostsFileMag) and writes them to {instanceDir}/hosts-files/.
 *
 * We use a short-lived "create-only" container (no start) to docker-cp files out,
 * then remove it immediately.  This avoids needing a mounted source git repo and
 * ensures the files exactly match the image content.
 */
async function generateMagHostsFiles(
	instanceDir: string,
	tag: string,
	octet: number
): Promise<void> {
	// Use the lightest MAG image (polaris-asd / cp01) — all images share the same hosts files.
	const image = `${sandboxImageRegistry()}/polaris-mag-sandbox-polaris-asd:${tag}`;
	const ansibleDir = '/opt/polaris/config/current/roles/common/files';
	const ppsDir = '/polaris-post-install/post-install-scripts';
	const hostsDir = join(instanceDir, 'hosts-files');

	// Files to extract and their source paths inside the image
	const modes = ['training', 'playback', 'testing'] as const;
	const variants = ['', '.offline', '.online', '.contingency'] as const;

	const filesToExtract: Array<{ containerPath: string; destName: string }> = [];
	for (const mode of modes) {
		for (const variant of variants) {
			filesToExtract.push({
				containerPath: `${ansibleDir}/hosts-${mode}${variant}`,
				destName: `hosts-${mode}${variant}`
			});
		}
	}
	// post-install add_hosts.sh startup file
	filesToExtract.push({
		containerPath: `${ppsDir}/hosts-training.offline`,
		destName: 'hosts-training.offline' // same name, already in the list — will be overwritten (same content)
	});

	// Create a stopped container to copy files from
	const container = await docker.createContainer({ Image: image, Cmd: ['true'] });
	try {
		for (const { containerPath, destName } of filesToExtract) {
			try {
				const stream = await container.getArchive({ path: containerPath });
				const content = await extractFileFromTar(stream, basename(containerPath));
				if (content !== null) {
					const rewritten = rewriteHostsFileMag(content, octet);
					writeFileSync(join(hostsDir, destName), rewritten, 'utf-8');
				}
			} catch {
				// File might not exist in some image variants — skip silently
			}
		}
	} finally {
		await container.remove({ force: true }).catch(() => {
			/* best-effort cleanup */
		});
	}
}

/**
 * Extracts a single file from a tar archive stream (as returned by container.getArchive).
 * Buffers the entire tar, then locates the requested filename.
 * Returns the file content as a UTF-8 string, or null if not found.
 */
function extractFileFromTar(
	stream: NodeJS.ReadableStream,
	filename: string
): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('data', (chunk: Buffer) => chunks.push(chunk));
		stream.on('error', reject);
		stream.on('end', () => {
			try {
				const tar = Buffer.concat(chunks);
				let offset = 0;
				while (offset + 512 <= tar.length) {
					const header = tar.slice(offset, offset + 512);
					// All-zero block = end-of-archive
					if (header.every((b) => b === 0)) break;

					const name = header.slice(0, 100).toString('utf8').replace(/\0/g, '').trim();
					const sizeStr = header.slice(124, 136).toString('utf8').replace(/\0/g, '').trim();
					const size = parseInt(sizeStr, 8) || 0;
					const typeFlag = header[156];

					offset += 512; // move past header

					const baseName = name.split('/').pop() ?? name;
					if (
						typeFlag !== 53 /* not a directory */ &&
						size > 0 &&
						(baseName === filename || name === filename || name.endsWith(`/${filename}`))
					) {
						resolve(tar.slice(offset, offset + size).toString('utf-8'));
						return;
					}

					// Advance past data blocks (rounded up to 512-byte boundary)
					offset += Math.ceil(size / 512) * 512;
				}
				resolve(null);
			} catch (err) {
				reject(err);
			}
		});
	});
}

// ── Public: create a new instance ────────────────────────────────────────────

export async function createInstance(
	type: PolarisType,
	tag?: string,
	services?: string[]
): Promise<PolarisRegistryEntry> {
	const sourceDir = buildSourceDirs()[type];
	// Fail before allocating anything when the images cannot be named.
	if (type === 'polaris-mag') sandboxImageRegistry();
	if (!existsSync(sourceDir)) {
		throw new Error(
			`Source directory not found: ${sourceDir}. ` +
				`Mount the ${type} repository into the dashboard container at that path.`
		);
	}

	const octet = await allocateSubnetOctet();
	const instanceId = `${type}-${octet}`;
	const instanceDir = join(INSTANCES_DIR, instanceId);
	const instanceDirOnHost = join(INSTANCES_HOST_PATH, instanceId);

	mkdirSync(join(instanceDir, 'hosts-files'), { recursive: true });
	mkdirSync(join(instanceDir, 'orion'), { recursive: true });

	if (type === 'polaris-ice') {
		const hostsSourceDir = join(sourceDir, 'configuration/config/roles/common/files');

		// Generate all mode hosts files
		for (const mode of ['training', 'playback', 'testing', 'operational'] as const) {
			const srcPath = join(hostsSourceDir, `hosts-${mode}.ops`);
			if (existsSync(srcPath)) {
				const modified = rewriteHostsFile(readFileSync(srcPath, 'utf-8'), octet);
				// .ops variant for add_hosts.sh startup
				writeFileSync(join(instanceDir, 'hosts-files', `hosts-${mode}.ops`), modified, 'utf-8');
				// bare name for ansible mode-switch playbooks
				writeFileSync(join(instanceDir, 'hosts-files', `hosts-${mode}`), modified, 'utf-8');
			}
		}

		// orion-environmental.json
		const orionSrc = join(
			sourceDir,
			'configuration/config/roles/orion/files/polaris/config/orion-environmental.json.ops'
		);
		if (existsSync(orionSrc)) {
			const modified = rewriteOrionEnvironmental(readFileSync(orionSrc, 'utf-8'), octet);
			writeFileSync(join(instanceDir, 'orion', 'orion-environmental.json'), modified, 'utf-8');
		}

		// docker-compose.yml
		const sourceCompose = readFileSync(join(sourceDir, 'docker-compose.yml'), 'utf-8');
		// merge: true resolves YAML 1.1 anchor/merge-key syntax
		const parsed = parseYaml(sourceCompose, { merge: true }) as ComposeDoc;
		const transformed = transformComposeDoc(
			parsed,
			octet,
			instanceId,
			instanceDirOnHost,
			tag,
			type
		);
		writeFileSync(
			join(instanceDir, 'docker-compose.yml'),
			stringifyYaml(transformed, { lineWidth: 0 }),
			'utf-8'
		);
	} else if (type === 'polaris-mag') {
		// For polaris-mag: extract baked-in hosts files from the Docker image, rewrite IPs,
		// and write them to hosts-files/ so they can be bind-mounted into containers.
		// This ensures toggle-processes.sh / ansible playbooks see correct per-instance IPs
		// rather than the addresses baked into the image.
		await generateMagHostsFiles(instanceDir, tag ?? 'latest', octet);

		// docker-compose.yml
		const sourceCompose = readFileSync(join(sourceDir, 'docker-compose.yml'), 'utf-8');
		const parsed = parseYaml(sourceCompose, { merge: true }) as ComposeDoc;
		const transformed = transformComposeDoc(
			parsed,
			octet,
			instanceId,
			instanceDirOnHost,
			tag,
			type
		);
		writeFileSync(
			join(instanceDir, 'docker-compose.yml'),
			stringifyYaml(transformed, { lineWidth: 0 }),
			'utf-8'
		);
	} else {
		// For other types (e.g. polaris-qkt): parse and apply transformComposeDoc so that:
		//  - the selected tag is baked in (no ${TAG:-latest} left)
		//  - x- yaml anchors are stripped
		//  - subnet/network/container names are updated if applicable
		const sourceCompose = readFileSync(join(sourceDir, 'docker-compose.yml'), 'utf-8');
		const parsed = parseYaml(sourceCompose, { merge: true }) as ComposeDoc;
		const transformed = transformComposeDoc(
			parsed,
			octet,
			instanceId,
			instanceDirOnHost,
			tag,
			type
		);
		writeFileSync(
			join(instanceDir, 'docker-compose.yml'),
			stringifyYaml(transformed, { lineWidth: 0 }),
			'utf-8'
		);
	}

	materializeRelativeMounts(
		parseYaml(readFileSync(join(sourceDir, 'docker-compose.yml'), 'utf-8'), {
			merge: true
		}) as ComposeDoc,
		sourceDir,
		instanceDir
	);

	const entry: PolarisRegistryEntry = {
		id: instanceId,
		type,
		subnetOctet: octet,
		instanceDir,
		composeFile: join(instanceDir, 'docker-compose.yml'),
		createdAt: new Date().toISOString(),
		services: services && services.length > 0 ? services : undefined
	};

	const registry = readRegistry();
	registry.instances.push(entry);
	saveRegistry(registry);

	return entry;
}

// ── Public: remove an instance from registry ─────────────────────────────────

export function removeInstanceFromRegistry(instanceId: string): void {
	const registry = readRegistry();
	registry.instances = registry.instances.filter((e) => e.id !== instanceId);
	saveRegistry(registry);
}

// ── Public: list registry entries ────────────────────────────────────────────

export function listRegistryEntries(): PolarisRegistryEntry[] {
	return readRegistry().instances;
}

/** Persist the current mode for any instance (managed or external). */
export function saveModeToRegistry(instanceId: string, mode: string): void {
	// Always write to modes cache (works for both managed and external instances)
	const cache = readModesCache();
	cache[instanceId] = mode;
	writeModesCache(cache);

	// Also update the registry entry if one exists
	const registry = readRegistry();
	const entry = registry.instances.find((e) => e.id === instanceId);
	if (entry) {
		entry.currentMode = mode as import('$lib/types').PolarisMode;
		saveRegistry(registry);
	}
}

// ── Stack start / stop ───────────────────────────────────────────────────────

function runDockerCompose(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', ['compose', ...args], { cwd });
		let out = '';
		let err = '';
		child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
		child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
		child.on('close', (code) => {
			if (code === 0) resolve(out);
			else reject(new Error(`docker compose ${args[0]} failed (exit ${code}):\n${err}`));
		});
		child.on('error', reject);
	});
}

function getRegistryEntry(instanceId: string): PolarisRegistryEntry {
	const entry = readRegistry().instances.find((e) => e.id === instanceId);
	if (!entry) throw new Error(`Instance "${instanceId}" not found in registry`);
	return entry;
}

export async function startStack(instanceId: string): Promise<void> {
	const entry = getRegistryEntry(instanceId);
	// Build `docker compose up -d [service...]` — run only selected services if set
	const serviceArgs = entry.services && entry.services.length > 0 ? entry.services : [];
	await runDockerCompose(['-f', entry.composeFile, 'up', '-d', ...serviceArgs], entry.instanceDir);

	// After containers are up, kick mode-training in the background.
	// The add_hosts.sh supervisord programme already copies the correct hosts file on
	// start-up, but mode-training must be manually started (known polaris-ice quirk).
	setTimeout(() => {
		triggerModeInStack(instanceId, 'training').catch(() => {
			/* non-fatal */
		});
	}, 35_000);
}

export async function stopStack(instanceId: string): Promise<void> {
	const entry = getRegistryEntry(instanceId);
	await runDockerCompose(['-f', entry.composeFile, 'down'], entry.instanceDir);
}

// ── Mode switching ────────────────────────────────────────────────────────────

const ALLOWED_MODES = ['training', 'playback', 'testing', 'operational'] as const;

/**
 * Switch all containers of an instance to a given Polaris mode by calling
 * `supervisorctl start mode-<mode>` inside each running container.
 *
 * mysql containers are skipped (they don't have supervisord mode programmes).
 */
export async function switchMode(
	containerIds: string[],
	mode: string,
	instanceId?: string
): Promise<void> {
	if (!(ALLOWED_MODES as readonly string[]).includes(mode)) {
		throw new Error(`Invalid mode "${mode}". Allowed: ${ALLOWED_MODES.join(', ')}`);
	}

	const errors: string[] = [];

	for (const id of containerIds) {
		try {
			const container = docker.getContainer(id);
			const info = await container.inspect();
			if (info.State?.Status !== 'running') continue;
			// Skip mysql containers
			if ((info.Name ?? '').toLowerCase().includes('mysql')) continue;

			const exec = await container.exec({
				Cmd: ['supervisorctl', 'start', `mode-${mode}`],
				AttachStdout: true,
				AttachStderr: true
			});
			// start() returns a stream; just fire it (don't await the completion stream)
			await exec.start({ Detach: true });
		} catch (err) {
			errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (errors.length > 0) {
		console.warn('[polaris-manager] Mode switch partial errors:', errors);
	}

	// Persist mode regardless of individual container errors (best-effort)
	if (instanceId) saveModeToRegistry(instanceId, mode);
}

async function triggerModeInStack(instanceId: string, mode: string): Promise<void> {
	const all = await docker.listContainers({ all: false });
	const ids = all
		.filter((c) => {
			const labels = (c.Labels ?? {}) as Record<string, string>;
			return labels['com.docker.compose.project'] === instanceId;
		})
		.map((c) => c.Id.substring(0, 12));

	if (ids.length > 0) {
		await switchMode(ids, mode, instanceId);
	}
}

// ── Source directory availability ────────────────────────────────────────────

export function getAvailableSources(): Partial<Record<PolarisType, string>> {
	const result: Partial<Record<PolarisType, string>> = {};
	for (const [type, dir] of Object.entries(buildSourceDirs()) as [PolarisType, string][]) {
		if (existsSync(dir) && existsSync(join(dir, 'docker-compose.yml'))) {
			result[type] = dir;
		}
	}
	return result;
}

/**
 * Returns available Docker image tags for a given Polaris source type.
 * Reads image base names from the source docker-compose.yml, then queries
 * local Docker daemon for matching image tags.
 */
export async function getAvailableTagsForSource(type: PolarisType): Promise<string[]> {
	const sources = getAvailableSources();
	const dir = sources[type];
	if (!dir) return [];

	const composePath = join(dir, 'docker-compose.yml');
	if (!existsSync(composePath)) return [];

	try {
		const doc = parseYaml(readFileSync(composePath, 'utf-8'), { merge: true }) as ComposeDoc;
		// Collect image base names, stripping ${TAG:-...} variable placeholders
		const baseImages = new Set<string>();
		for (const svc of Object.values(doc.services ?? {})) {
			if (svc?.image && typeof svc.image === 'string') {
				const base = svc.image.replace(/:\$\{[^}]+\}$/, '').replace(/:[^:/]+$/, '');
				if (base) baseImages.add(base);
			}
		}

		const allImages = await docker.listImages({ all: false });
		const tags = new Set<string>();
		for (const img of allImages) {
			for (const repoTag of (img.RepoTags ?? []) as string[]) {
				const colonIdx = repoTag.lastIndexOf(':');
				if (colonIdx < 0) continue;
				const repo = repoTag.substring(0, colonIdx);
				const tag = repoTag.substring(colonIdx + 1);
				if (baseImages.has(repo) && tag && tag !== '<none>') {
					tags.add(tag);
				}
			}
		}

		// Sort: semver-like tags newest first, 'latest' last
		return [...tags].sort((a, b) => {
			if (a === 'latest') return 1;
			if (b === 'latest') return -1;
			return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
		});
	} catch {
		return [];
	}
}

/**
 * Returns all service names from the source docker-compose.yml for a type,
 * excluding infrastructure-only services (mysql, tatoo).
 */
export function getServicesFromCompose(type: PolarisType): string[] {
	const sources = getAvailableSources();
	const dir = sources[type];
	if (!dir) return [];
	const composePath = join(dir, 'docker-compose.yml');
	if (!existsSync(composePath)) return [];
	try {
		const doc = parseYaml(readFileSync(composePath, 'utf-8'), { merge: true }) as ComposeDoc;
		return Object.keys(doc.services ?? {}).filter((s) => !s.includes('mysql') && s !== 'tatoo');
	} catch {
		return [];
	}
}

/** Returns the default service list for a given type. */
export function getDefaultServices(type: PolarisType): string[] {
	return DEFAULT_SERVICE_PROFILES[type] ?? [];
}

/**
 * Remove a managed instance from the registry.
 * Stops the stack first (best-effort), then deletes all generated files.
 */
export async function deleteInstance(instanceId: string): Promise<void> {
	const entry = readRegistry().instances.find((e) => e.id === instanceId);
	if (!entry) throw new Error(`Instance "${instanceId}" not found in registry`);

	// Stop the stack (ignore errors — containers may already be stopped)
	try {
		await runDockerCompose(['-f', entry.composeFile, 'down'], entry.instanceDir);
	} catch {
		// non-fatal
	}

	// Remove from registry
	const registry = readRegistry();
	registry.instances = registry.instances.filter((e) => e.id !== instanceId);
	saveRegistry(registry);

	// Remove from modes cache
	const cache = readModesCache();
	delete cache[instanceId];
	writeModesCache(cache);

	// Delete generated files directory
	const { rm } = await import('node:fs/promises');
	try {
		await rm(entry.instanceDir, { recursive: true, force: true });
	} catch {
		// non-fatal if dir was already removed
	}
}
