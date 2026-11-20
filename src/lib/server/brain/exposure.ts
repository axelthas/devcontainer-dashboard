/**
 * What shell access to a container also reaches. A grant gives arbitrary commands as the
 * container user, so mounts, sockets and privileges matter more than the container itself.
 * Only names and paths are reported, never environment values.
 */
import type { BrainExposure } from '../../brainTypes.js';

/** The `docker inspect` fields that the analysis reads. */
export interface ExposureInspect {
	Config?: { User?: string; Env?: string[] | null };
	HostConfig?: {
		Privileged?: boolean;
		PidMode?: string;
		NetworkMode?: string;
		CapAdd?: string[] | null;
	};
	Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean }[];
}

const RUNTIME_SOCKET = /(^|\/)(docker|podman|containerd)\.sock$/;
const CREDENTIAL_PATH = /(^|\/)\.(ssh|aws|azure|kube|docker|gnupg|config\/gcloud|config\/gh)(\/|$)/;
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
const DANGEROUS_CAPABILITIES = new Set([
	'ALL',
	'SYS_ADMIN',
	'SYS_MODULE',
	'SYS_PTRACE',
	'SYS_RAWIO',
	'DAC_READ_SEARCH',
	'NET_ADMIN'
]);
const ORDER = { danger: 0, warning: 1, info: 2 };

/** True for root by name or numeric ID, and for an empty (default) user. */
export function isRootUser(user: string): boolean {
	const name = user.split(':')[0];
	return name === '' || name === 'root' || name === '0';
}

/** True when the operator must explicitly accept the listed risks. */
export function requiresAcceptance(exposure: BrainExposure[]): boolean {
	return exposure.some((item) => item.level === 'danger');
}

/** List at most three values, then a count. */
function summary(values: string[]): string {
	const unique = [...new Set(values)];
	return unique.length > 3
		? `${unique.slice(0, 3).join(', ')} and ${unique.length - 3} more`
		: unique.join(', ');
}

/** Classify what commands as `user` inside this container can reach. Danger comes first. */
export function analyzeExposure(info: ExposureInspect, user: string): BrainExposure[] {
	const exposure: BrainExposure[] = [];
	const mounts = info.Mounts ?? [];
	const host = info.HostConfig ?? {};

	const sockets = mounts.filter(
		(mount) =>
			RUNTIME_SOCKET.test(mount.Source ?? '') || RUNTIME_SOCKET.test(mount.Destination ?? '')
	);
	if (sockets.length)
		exposure.push({
			level: 'danger',
			message: `Container runtime socket mounted (${summary(sockets.map((m) => m.Destination ?? m.Source ?? ''))}): commands can control every container on this host`
		});
	if (host.Privileged)
		exposure.push({
			level: 'danger',
			message: 'Privileged container: commands can reach host devices and kernel interfaces'
		});
	if (host.PidMode === 'host')
		exposure.push({ level: 'danger', message: 'Shares the host process namespace' });
	const capabilities = (host.CapAdd ?? [])
		.map((capability) => capability.toUpperCase().replace(/^CAP_/, ''))
		.filter((capability) => DANGEROUS_CAPABILITIES.has(capability));
	if (capabilities.length)
		exposure.push({ level: 'danger', message: `Added capabilities: ${summary(capabilities)}` });
	if (mounts.some((mount) => mount.Type === 'bind' && mount.Source === '/'))
		exposure.push({ level: 'danger', message: 'The host root filesystem is mounted' });

	if (host.NetworkMode === 'host')
		exposure.push({
			level: 'warning',
			message: 'Shares the host network: commands can reach services on host loopback'
		});
	if (isRootUser(user))
		exposure.push({ level: 'warning', message: 'Commands run as root inside the container' });
	const credentials = mounts.filter(
		(mount) =>
			CREDENTIAL_PATH.test(mount.Source ?? '') || CREDENTIAL_PATH.test(mount.Destination ?? '')
	);
	if (credentials.length)
		exposure.push({
			level: 'warning',
			message: `Credential folders mounted: ${summary(credentials.map((m) => m.Destination ?? m.Source ?? ''))}`
		});
	const names = (info.Config?.Env ?? []).map((entry) => entry.split('=')[0]);
	if (names.includes('SSH_AUTH_SOCK'))
		exposure.push({ level: 'warning', message: 'SSH agent forwarded' });
	const secrets = names.filter((name) => SECRET_NAME.test(name));
	if (secrets.length)
		exposure.push({
			level: 'warning',
			message: `Credential-like environment variables: ${summary(secrets)}`
		});

	const writable = mounts.filter(
		(mount) =>
			mount.Type === 'bind' &&
			mount.RW !== false &&
			!sockets.includes(mount) &&
			mount.Source !== '/'
	);
	if (writable.length)
		exposure.push({
			level: 'info',
			message: `Writable host folders: ${summary(writable.map((m) => m.Destination ?? ''))}`
		});

	return exposure.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}
