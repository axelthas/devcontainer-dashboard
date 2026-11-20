/**
 * Local image lookup for Compose inspection. A missing image is null, not an error,
 * because Start refuses to run a registry service whose image is not on this host.
 */
import type { ImageInfo } from './composeSandbox.js';

/** The part of the Docker client that image lookup needs. */
export interface ImageClient {
	getImage(name: string): { inspect(): Promise<{ RepoDigests?: string[] }> };
}

/** Inspect one image by reference; return its first repository digest, or null when missing. */
export async function localImageInfo(
	docker: ImageClient,
	reference: string
): Promise<ImageInfo | null> {
	try {
		const info = await docker.getImage(reference).inspect();
		const digest = info.RepoDigests?.[0];
		return digest ? { digest } : {};
	} catch {
		return null;
	}
}
