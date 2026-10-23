import { error } from '@sveltejs/kit';
import { readRunLog, toPlainText } from '$lib/server/runLogs';
import type { RequestHandler } from './$types';

const HEADERS = {
	'Content-Type': 'text/plain; charset=utf-8',
	'Cache-Control': 'no-store',
	'X-Content-Type-Options': 'nosniff'
};

// Returns the raw terminal output for the log viewer, or plain text with ?download.
export const GET: RequestHandler = async ({ params, url }) => {
	const log = await readRunLog(params.id);
	if (!log) throw error(404, 'Log not found');

	if (!url.searchParams.has('download')) {
		return new Response(log.output, { headers: HEADERS });
	}

	const date = log.metadata.endedAt.slice(0, 10);
	const fileName = `${log.metadata.name}-${date}.log`.replace(/[^\w.-]+/g, '_');
	return new Response(toPlainText(log.output), {
		headers: { ...HEADERS, 'Content-Disposition': `attachment; filename="${fileName}"` }
	});
};
