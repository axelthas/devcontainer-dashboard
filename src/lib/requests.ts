/** Small browser request helpers. Never retry writes: a lost response can hide accepted work. */
export const SESSION_EXPIRED = 'Your session expired. Sign in again.';

export class RequestError extends Error {
	readonly status: number;
	constructor(message: string, status = 0) {
		super(message);
		this.name = 'RequestError';
		this.status = status;
	}
}

/** Keep server messages bounded and use a status fallback for HTML or unreadable bodies. */
async function failureMessage(response: Response): Promise<string> {
	if (response.status === 401) return SESSION_EXPIRED;
	const fallback = `Request failed (${response.status}).`;
	try {
		if (!response.headers.get('content-type')?.includes('application/json')) return fallback;
		const body = await response.json();
		return typeof body?.message === 'string' ? body.message.slice(0, 500) : fallback;
	} catch {
		return fallback;
	}
}

/** Check HTTP failures and explain uncertain outcomes without suggesting an unsafe retry. */
async function checkedResponse(url: string, init: RequestInit): Promise<Response> {
	const read = !init.method || ['GET', 'HEAD'].includes(init.method.toUpperCase());
	// Bound reads, but do not turn a slow write into an invitation to repeat it.
	const signal = read
		? AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)])
		: init.signal;
	try {
		const response = await fetch(url, { cache: 'no-store', ...init, signal });
		if (!response.ok) throw new RequestError(await failureMessage(response), response.status);
		return response;
	} catch (cause) {
		if (init.signal?.aborted || cause instanceof RequestError) throw cause;
		throw new RequestError(
			read
				? 'Connection failed. Check your connection and retry.'
				: 'Connection lost. The operation may have completed. Refresh its status before retrying.'
		);
	}
}

/** Read JSON only after checking the response status. */
export async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
	const response = await checkedResponse(url, init);
	try {
		return await response.json();
	} catch (cause) {
		if (init.signal?.aborted) throw cause;
		throw new RequestError('The server returned an unreadable response. Refresh its status.');
	}
}

/** Read plain-text logs through the same status and authentication handling. */
export async function requestText(url: string, init: RequestInit = {}): Promise<string> {
	const response = await checkedResponse(url, init);
	try {
		return await response.text();
	} catch (cause) {
		if (init.signal?.aborted) throw cause;
		throw new RequestError('Could not read the response. Check your connection and retry.');
	}
}

/** Turn unknown failures into display text. Components render this as text, never HTML. */
export function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : 'Request failed. Please try again.';
}

/** Only the newest read may apply data or report failure, even if abort is ignored. */
export function latestRequest() {
	let generation = 0;
	let controller: AbortController | undefined;

	function cancel() {
		generation++;
		controller?.abort();
		controller = undefined;
	}

	async function run<T>(
		load: (signal: AbortSignal) => Promise<T>,
		apply: (value: T) => void
	): Promise<boolean> {
		cancel();
		const current = generation;
		const active = (controller = new AbortController());
		try {
			const value = await load(active.signal);
			if (current !== generation) return false;
			apply(value);
			return true;
		} catch (cause) {
			if (current !== generation || active.signal.aborted) return false;
			throw cause;
		} finally {
			if (current === generation) controller = undefined;
		}
	}

	return { run, cancel };
}
