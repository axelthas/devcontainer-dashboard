import { error, json } from '@sveltejs/kit';
import { readOutput, setController, stopExecution } from '$lib/server/brain/executions';
import { commandOutput } from '$lib/server/brain/shells';
import { brainHttpError } from '$lib/server/brain/http';
import { brainState, recordAudit } from '$lib/server/brain/state';
import type { BrainOutputView } from '$lib/brainTypes';
import type { RequestHandler } from './$types';

/**
 * Read retained output from an absolute cursor; the operator can read ended grants too.
 * With `command`, read only the output of that shell command, as plain text.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const execution = brainState.executions.get(params.id);
	if (!execution) throw error(404, 'The command is no longer retained.');
	const raw = url.searchParams.get('cursor');
	if (raw !== null && !/^\d{1,15}$/.test(raw)) throw error(400, 'Invalid cursor');
	const cursor = raw === null ? undefined : Number(raw);
	const headers = { 'Cache-Control': 'no-store' };
	const commandId = url.searchParams.get('command');
	if (commandId === null) return json(readOutput(execution, cursor), { headers });
	const command = execution.shell?.history.find((candidate) => candidate.id === commandId);
	if (!command) throw error(404, 'The shell command is no longer retained.');
	const page = commandOutput(execution, command, cursor);
	const view: BrainOutputView = {
		executionId: execution.id,
		...page,
		status: command.status,
		exitCode: command.exitCode
	};
	return json(view, { headers });
};

/** Stop one command and report whether the stop was confirmed. */
export const DELETE: RequestHandler = async ({ params }) => {
	try {
		return json({ status: await stopExecution(params.id, 'Stopped by the operator') });
	} catch (cause) {
		brainHttpError(cause);
	}
};

/**
 * Take control of the terminal (`{"controller":"operator"}`) or hand it back to Brain
 * (`{"controller":"brain"}`). The audit log records the change, never the typed input.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Expected a JSON body');
	}
	const controller = (body as { controller?: unknown } | null)?.controller;
	if (controller !== 'operator' && controller !== 'brain')
		throw error(400, 'controller must be "operator" or "brain"');
	try {
		const state = setController(params.id, controller);
		const execution = brainState.executions.get(params.id);
		recordAudit({
			tool: controller === 'operator' ? 'take_control' : 'hand_back',
			target: execution?.containerName,
			detail: execution?.command ?? params.id,
			outcome: 'ok'
		});
		return json(state);
	} catch (cause) {
		brainHttpError(cause);
	}
};
