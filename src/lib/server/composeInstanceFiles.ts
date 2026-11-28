/** Render bounded text files for one instance without running repository scripts. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { contains, formatIPv4, ipv4, ipv4Range } from './composeInstanceAddresses.js';
import { writeInstanceOverride } from './composeInstanceOverride.js';
import type { ComposeInstancePlan } from './composeInstancePlan.js';
import type { KindInstanceConfig } from './kindDescriptor.js';
import type { KindDescriptor } from '../stackKinds/types.js';

const LIMIT = 1024 * 1024;
type FileDeclaration = NonNullable<KindInstanceConfig['files']>[number];
export type InstanceMount = { type: 'bind'; source: string; target: string; read_only: true };

/** Refuse to disclose path or content in errors. */
function invalid(message = 'Instance file is invalid or inaccessible'): never {
	throw new Error(message);
}

/** Ensure a requested file remains a regular file inside the canonical source repository. */
async function sourceFile(repo: string, relativePath: string): Promise<string> {
	if (
		!relativePath ||
		isAbsolute(relativePath) ||
		relativePath.includes('\\') ||
		relativePath.split('/').some((item) => !item || item === '.' || item === '..')
	)
		invalid();
	const path = await realpath(join(repo, relativePath)).catch(() => invalid());
	const child = relative(repo, path);
	if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) invalid();
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
	).catch(() => invalid());
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > LIMIT) invalid();
		const bytes = Buffer.alloc(LIMIT + 1);
		let size = 0;
		while (size < bytes.length) {
			const part = await file.read(bytes, size, bytes.length - size, size);
			if (!part.bytesRead) break;
			size += part.bytesRead;
		}
		if (size > LIMIT || bytes.subarray(0, size).includes(0)) invalid();
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
	} catch {
		return invalid();
	} finally {
		await file.close();
	}
}

/** Rewrite standalone IPv4 tokens. Subnet offsets require explicit opt-in. */
export function rewriteInstanceAddresses(
	text: string,
	plan: ComposeInstancePlan,
	mode: FileDeclaration['rewrite'] = 'addresses'
): string {
	const tokens = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;
	if (mode === 'addresses')
		return text.replace(tokens, (token) => plan.endpointAddresses[token] ?? token);
	const mappings = plan.addressPlan.subnets
		.filter((entry) => entry.from)
		.map((entry) => ({ source: ipv4Range(entry.from), target: ipv4Range(entry.to) }));
	if (
		mappings.some(
			(item) => !item.source || !item.target || item.source.prefix !== item.target.prefix
		)
	)
		invalid('Invalid address plan');
	return text.replace(tokens, (token) => {
		const value = ipv4(token);
		const match =
			value === undefined
				? undefined
				: mappings.find((item) => item.source && contains(item.source, value));
		return match && value !== undefined
			? formatIPv4(match.target!.start + value - match.source!.start)
			: token;
	});
}

/** Resolve a descriptor's explicit service list or role against the actual Compose services. */
function targets(file: FileDeclaration, plan: ComposeInstancePlan, kind: KindDescriptor): string[] {
	const available = plan.addressPlan.services.map((item) => item.service);
	const selected =
		file.mount.services ??
		available.filter((service) => kind.services?.[service]?.role === file.mount.role);
	if (!selected.length || selected.some((service) => !available.includes(service)))
		invalid('Instance file targets do not match the Compose services');
	return [...new Set(selected)];
}

/** Store rendered files privately and return server-only bind specifications. */
export async function renderInstanceFiles(options: {
	canonicalRepoPath: string;
	instanceDirectory: string;
	declarations: FileDeclaration[];
	plan: ComposeInstancePlan;
	kind: KindDescriptor;
	hostPath: (path: string) => Promise<string | undefined>;
}): Promise<Record<string, InstanceMount[]>> {
	const directory = join(options.instanceDirectory, 'files');
	try {
		await mkdir(directory, { mode: 0o700 });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
	}
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) invalid();
	const mounts: Record<string, InstanceMount[]> = Object.create(null);
	const ids = new Set<string>();
	for (const declaration of options.declarations) {
		if (
			!/^[a-z0-9][a-z0-9-]{0,63}$/.test(declaration.id) ||
			ids.has(declaration.id) ||
			!declaration.mount.target.startsWith('/') ||
			declaration.mount.target
				.split('/')
				.slice(1)
				.some((part) => !part || part === '.' || part === '..')
		)
			invalid();
		ids.add(declaration.id);
		const targetServices = targets(declaration, options.plan, options.kind);
		const path = join(directory, declaration.id);
		const source = await options.hostPath(path);
		if (!source || !isAbsolute(source)) invalid('Docker cannot resolve the instance file path');
		const contents = await sourceFile(options.canonicalRepoPath, declaration.from.path);
		await writeInstanceOverride(
			path,
			rewriteInstanceAddresses(contents, options.plan, declaration.rewrite),
			0o644
		);
		for (const service of targetServices) {
			const list = (mounts[service] ??= []);
			if (list.some((mount) => mount.target === declaration.mount.target))
				invalid('Instance file mounts repeat a target');
			list.push({ type: 'bind', source, target: declaration.mount.target, read_only: true });
		}
	}
	return mounts;
}
