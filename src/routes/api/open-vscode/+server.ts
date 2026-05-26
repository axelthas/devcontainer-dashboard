import { json, error } from '@sveltejs/kit';
import { spawnSync } from 'child_process';
import type { RequestHandler } from './$types';

/**
 * Maps a browser-clickable `vscode://` URL to the arguments for the `code` CLI.
 *
 * vscode://vscode-remote/<scheme>/<path> → code --folder-uri vscode-remote://<scheme>/<path>
 * vscode://ms-vscode-remote.remote-containers/attachToRunningContainer?containerName=X
 *   → code --folder-uri vscode-remote://attached-container+<hex>/<path>
 * vscode://file<path> → code <path>
 */
function resolveCodeArgs(url: string): string[] {
	const withoutWindowId = url.replace(/[?&]windowId=[^&]*/g, '').replace(/[?&]$/, '');

	if (url.startsWith('vscode://vscode-remote/')) {
		const folderUri = withoutWindowId.replace('vscode://vscode-remote/', 'vscode-remote://');
		return ['--folder-uri', folderUri];
	}

	if (url.startsWith('vscode://ms-vscode-remote.remote-containers/attachToRunningContainer')) {
		const parsedUrl = new URL(url);
		const containerName = parsedUrl.searchParams.get('containerName') ?? '';
		const config = JSON.stringify({ containerName });
		const hex = Buffer.from(config).toString('hex');
		return ['--folder-uri', `vscode-remote://attached-container+${hex}/`];
	}

	if (url.startsWith('vscode://file')) {
		const path = withoutWindowId.replace('vscode://file', '');
		return [path];
	}

	throw error(400, 'Unsupported vscode URL scheme');
}

export const POST: RequestHandler = async ({ request }) => {
	let url: unknown;
	try {
		({ url } = await request.json());
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	if (typeof url !== 'string' || !url.startsWith('vscode://')) {
		throw error(400, 'url must be a vscode:// string');
	}

	const args = resolveCodeArgs(url);
	const result = spawnSync('code', args, { encoding: 'utf8' });

	if (result.error) {
		// code CLI not available (e.g. production Docker without VS Code)
		throw error(503, 'code CLI not available');
	}
	if (result.status !== 0) {
		throw error(500, result.stderr?.trim() || 'code exited with non-zero status');
	}

	return json({ ok: true });
};
