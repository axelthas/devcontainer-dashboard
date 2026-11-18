/** Map Brain access failures to SvelteKit HTTP errors with their display-safe messages. */
import { error, isHttpError } from '@sveltejs/kit';
import { BrainAccessError } from './access.js';
import { BrainExecutionError } from './executions.js';

export function brainHttpError(cause: unknown): never {
	if (cause instanceof BrainAccessError || cause instanceof BrainExecutionError)
		throw error(cause.status, cause.message);
	if (isHttpError(cause)) throw cause;
	console.error('[brain] request failed', cause);
	throw error(500, 'Brain access request failed. Check Docker and retry.');
}
