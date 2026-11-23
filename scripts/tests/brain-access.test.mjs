/**
 * Grant lifecycle, reach analysis and end-to-end tool regressions for Brain access.
 * Run: node --experimental-strip-types --test scripts/tests/brain-access.test.mjs
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { execStream, fakeDocker, loadBrain, runningContainer, target } from './brain-harness.mjs';

const ID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
let brain;
before(async () => {
	brain = await loadBrain();
});
after(() => brain.cleanup());
beforeEach(() => brain.state.resetBrainStateForTesting());

/** A fake client whose command execs print `output` and exit with 0. */
function install(containers) {
	const docker = fakeDocker(containers, (options) => {
		const stream = execStream();
		if (options.Cmd[3] === 'dashboard-brain') {
			setImmediate(() => {
				stream.push(Buffer.from('\u001eddb-pgid:77\u001ehello\r\n'));
				stream.push(null);
			});
		} else setImmediate(() => stream.push(null));
		return { stream, inspect: async () => ({ Running: false, ExitCode: 0 }) };
	});
	brain.state.resetBrainStateForTesting(docker);
	return docker;
}

/** Call a tool and parse its structured result. */
async function call(name, args) {
	const result = await brain.tools.callTool(name, args);
	return { result, data: result.structuredContent };
}

test('grants validate duration, uniqueness and expiry', () => {
	const { createGrant, pruneExpiredGrants } = brain.access;
	assert.throws(() => createGrant(target(ID), 30), /Choose/);
	const grant = createGrant(target(ID), 15, 1_000);
	assert.equal(grant.expiresAt, 1_000 + 15 * 60_000);
	assert.throws(() => createGrant(target(ID), 60, 2_000), /already has access/);
	pruneExpiredGrants(grant.expiresAt);
	assert.equal(brain.state.brainState.grants.size, 0);
	assert.deepEqual(
		brain.state.brainState.audit.map((entry) => entry.tool),
		['grant', 'revoke']
	);
});

test('a restarted, stopped or replaced container ends the grant', async () => {
	const containers = new Map([[ID, runningContainer(ID)]]);
	install(containers);
	const grant = brain.access.createGrant(target(ID), 60);
	assert.equal((await brain.access.liveGrant(grant.id)).id, grant.id);
	containers.set(ID, runningContainer(ID, '2026-11-18T21:00:00.000000000Z'));
	await assert.rejects(brain.access.liveGrant(grant.id), /Access ended/);
	assert.equal(brain.state.brainState.grants.size, 0);
	const second = brain.access.createGrant(
		target(ID, { startedAt: '2026-11-18T21:00:00.000000000Z' }),
		60
	);
	containers.delete(ID);
	await brain.access.reconcileGrants();
	assert.equal(brain.state.brainState.grants.has(second.id), false);
});

test('Brain lists only granted targets and runs commands only in them', async () => {
	install(
		new Map([
			[ID, runningContainer(ID)],
			[OTHER, runningContainer(OTHER)]
		])
	);
	const grant = brain.access.createGrant(target(ID, { composeService: 'fdp' }), 60);
	const listed = await call('list_targets', {});
	assert.deepEqual(
		listed.data.targets.map((item) => [item.target_id, item.name, item.compose_service]),
		[[grant.id, 'sample', 'fdp']]
	);
	const ran = await call('execute', {
		target_id: grant.id,
		command: 'echo greeting',
		goal: 'Greet the operator.',
		wait_seconds: 1
	});
	assert.equal(ran.data.status, 'exited');
	assert.equal(ran.data.exit_code, 0);
	assert.equal(ran.data.output, 'hello\n');
	const read = await call('read_output', { execution_id: ran.data.execution_id, cursor: 2 });
	assert.equal(read.data.output, 'llo\n');
	const refused = await call('execute', {
		target_id: OTHER,
		command: 'id',
		goal: 'Show the user.'
	});
	assert.equal(refused.result.isError, true);
	assert.match(refused.result.content[0].text, /Call list_targets/);
	const audit = brain.state.brainState.audit;
	assert.deepEqual(audit.at(-1).outcome, 'denied');
	// Commands are audited; their output is not.
	assert.equal(audit.at(-3).detail, 'echo greeting');
	// Each call links to its command, so the dashboard shows it there.
	assert.equal(audit.at(-3).goal, 'Greet the operator.');
	assert.equal(audit.at(-3).executionId, ran.data.execution_id);
	assert.equal(audit.at(-2).executionId, ran.data.execution_id);
	assert.equal(audit.at(-1).goal, 'Show the user.');
	assert.equal(audit.at(-1).executionId, undefined);
	const view = brain.access.brainStatus().executions.find((e) => e.id === ran.data.execution_id);
	assert.equal(view.goal, 'Greet the operator.');
	assert.ok(audit.every((entry) => !JSON.stringify(entry).includes('hello')));
});

test('execute requires a goal and starts nothing without one', async () => {
	install(new Map([[ID, runningContainer(ID)]]));
	const grant = brain.access.createGrant(target(ID), 60);
	for (const goal of [undefined, '   ']) {
		const refused = await call('execute', { target_id: grant.id, command: 'id', goal });
		assert.equal(refused.result.isError, true);
		assert.match(refused.result.content[0].text, /goal is required/);
	}
	assert.equal(brain.state.brainState.executions.size, 0);
	assert.equal(brain.state.brainState.audit.at(-1).outcome, 'error');
});

test('intent follows an accepted command, stays per grant, and can be cleared', async () => {
	install(
		new Map([
			[ID, runningContainer(ID)],
			[OTHER, runningContainer(OTHER)]
		])
	);
	const grant = brain.access.createGrant(target(ID), 60);
	const other = brain.access.createGrant(target(OTHER, { containerName: 'other' }), 60);
	const args = { target_id: grant.id, command: 'id', goal: 'Check the user.', wait_seconds: 1 };
	let result = await call('execute', { ...args, intent: '  Review the dashboard  ' });
	assert.equal(result.result.isError, undefined);
	assert.equal(brain.access.grantView(grant).intent, 'Review the dashboard');
	const targets = (await call('list_targets', {})).data.targets;
	assert.equal(targets.find((item) => item.target_id === grant.id).intent, 'Review the dashboard');
	assert.equal(brain.access.grantView(other).intent, undefined);
	result = await call('execute', args);
	assert.equal(result.result.isError, undefined);
	assert.equal(
		brain.access.brainStatus().grants.find((g) => g.id === grant.id).intent,
		'Review the dashboard'
	);
	result = await call('execute', { ...args, goal: ' ', intent: 'Must not replace' });
	assert.equal(result.result.isError, true);
	assert.equal(brain.access.grantView(grant).intent, 'Review the dashboard');
	result = await call('execute', { ...args, intent: 'x'.repeat(201) });
	assert.equal(result.result.isError, true);
	assert.equal(brain.access.grantView(grant).intent, 'Review the dashboard');
	result = await call('execute', { ...args, intent: ' ' });
	assert.equal(result.result.isError, undefined);
	assert.equal(brain.access.grantView(grant).intent, undefined);
});

test('revocation removes access to earlier executions as well', async () => {
	install(new Map([[ID, runningContainer(ID)]]));
	const grant = brain.access.createGrant(target(ID), 60);
	const ran = await call('execute', {
		target_id: grant.id,
		command: 'echo hello',
		goal: 'Print a greeting.',
		wait_seconds: 1
	});
	brain.access.revokeGrant(grant.id, 'Revoked by the operator');
	const read = await call('read_output', { execution_id: ran.data.execution_id });
	assert.equal(read.result.isError, true);
	assert.equal((await call('list_targets', {})).data.targets.length, 0);
});

test('stdin content is never written to the audit log', async () => {
	install(new Map([[ID, runningContainer(ID)]]));
	const grant = brain.access.createGrant(target(ID), 60);
	await call('write_stdin', { execution_id: 'x_missing', input: 'hunter2\n' });
	const entry = brain.state.brainState.audit.at(-1);
	assert.equal(entry.tool, 'write_stdin');
	assert.doesNotMatch(JSON.stringify(entry), /hunter2/);
	assert.ok(grant.id);
});

test('reach analysis flags sockets, privileges, root and credentials', () => {
	const { analyzeExposure, requiresAcceptance } = brain.exposure;
	const exposure = analyzeExposure(
		{
			Config: { Env: ['SSH_AUTH_SOCK=/ssh', 'GITHUB_TOKEN=value', 'PATH=/bin'] },
			HostConfig: { Privileged: true, NetworkMode: 'host', CapAdd: ['CAP_SYS_ADMIN', 'CHOWN'] },
			Mounts: [
				{
					Type: 'bind',
					Source: '/var/run/docker.sock',
					Destination: '/var/run/docker.sock',
					RW: true
				},
				{ Type: 'bind', Source: '/home/axel/.ssh', Destination: '/home/developer/.ssh', RW: false },
				{ Type: 'bind', Source: '/home/axel/work', Destination: '/workspaces', RW: true }
			]
		},
		'root'
	);
	const text = exposure.map((item) => `${item.level}: ${item.message}`).join('\n');
	assert.match(text, /danger: Container runtime socket mounted \(\/var\/run\/docker\.sock\)/);
	assert.match(text, /danger: Privileged/);
	assert.match(text, /danger: Added capabilities: SYS_ADMIN/);
	assert.match(text, /warning: Shares the host network/);
	assert.match(text, /warning: Commands run as root/);
	assert.match(text, /warning: Credential folders mounted: \/home\/developer\/\.ssh/);
	assert.match(text, /warning: SSH agent forwarded/);
	assert.match(text, /warning: Credential-like environment variables: GITHUB_TOKEN/);
	assert.match(text, /info: Writable host folders: \/workspaces/);
	assert.doesNotMatch(text, /value/);
	assert.equal(exposure[0].level, 'danger');
	assert.equal(requiresAcceptance(exposure), true);
	const plain = analyzeExposure({ Mounts: [] }, 'developer');
	assert.deepEqual(plain, []);
	assert.equal(requiresAcceptance(plain), false);
});
