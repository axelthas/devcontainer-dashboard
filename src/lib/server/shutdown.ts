/** Production shutdown has one owner and a bounded deadline in every deployment mode. */
import type { Server } from 'node:http';
import { shutdownTerminals } from './terminalShutdown.js';

/** Stop accepting HTTP work, terminate local PTYs, then retire owned external listeners. */
export function installShutdown(server: Server, retire?: () => Promise<void>): void {
	let stopping = false;
	async function stop() {
		if (stopping) return;
		stopping = true;
		server.close();
		const deadline = setTimeout(() => process.exit(1), 15_000);
		deadline.unref();
		try { await shutdownTerminals(); await retire?.(); process.exit(0); }
		catch (error) { console.error('Shutdown cleanup incomplete', error); process.exit(1); }
	}
	process.once('SIGTERM', () => void stop());
	process.once('SIGINT', () => void stop());
}
