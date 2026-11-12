/** A reconnect must not restart a command whose creation was already attempted. */
import { afterEach, expect, it, vi } from 'vitest';
import { ensureTerminal } from './terminalCreation';

afterEach(() => vi.unstubAllGlobals());

it('deduplicates explicit creation across concurrent viewers', async () => {
	const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response('{}', { status: 201 }));
	vi.stubGlobal('fetch', fetcher);
	await Promise.all([ensureTerminal({ id: 'creation-test', name: 'Shell' }), ensureTerminal({ id: 'creation-test', name: 'Shell' })]);
	expect(fetcher).toHaveBeenCalledTimes(2);
	await ensureTerminal({ id: 'creation-test', name: 'Shell' });
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it('does not recreate a missing server-owned run', async () => {
	const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
	vi.stubGlobal('fetch', fetcher);
	await expect(ensureTerminal({ id: 'missing-build' })).rejects.toThrow('Start a new run explicitly');
	expect(fetcher).toHaveBeenCalledTimes(1);
});
