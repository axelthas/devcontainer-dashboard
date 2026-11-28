/** Map dashboard bind-mount paths to Docker host paths using inspected mount metadata. */
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

interface Mount {
	Type?: string;
	Source?: string;
	Destination?: string;
}

/** The longest matching destination wins; named volumes and ambiguous paths are refused. */
export function instanceHostPath(path: string, mounts: Mount[]): string | undefined {
	if (!isAbsolute(path) || path !== normalize(path)) return undefined;
	const candidates = mounts
		.filter((mount) => {
			if (typeof mount.Destination !== 'string' || !isAbsolute(mount.Destination)) return false;
			const dest = resolve(mount.Destination);
			const child = relative(dest, path);
			return (
				child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
			);
		})
		.sort((a, b) => b.Destination!.length - a.Destination!.length);
	const mount = candidates[0];
	if (
		!mount ||
		mount.Type !== 'bind' ||
		typeof mount.Source !== 'string' ||
		!isAbsolute(mount.Source) ||
		!mount.Destination
	)
		return undefined;
	if (candidates[1]?.Destination === mount.Destination && candidates[1]?.Source !== mount.Source)
		return undefined;
	return join(resolve(mount.Source), relative(resolve(mount.Destination), path));
}
