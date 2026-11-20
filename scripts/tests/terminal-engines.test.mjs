/**
 * Dependency-free checks for terminal engine identifiers and preferences (#42).
 * Run on Node.js 22.13+: npm run test:terminal-engines
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	DEFAULT_TERMINAL_ENGINE,
	TERMINAL_ENGINES,
	TERMINAL_ENGINE_IDS,
	isTerminalEngineId,
	readTerminalEnginePreference
} from '../../src/lib/terminalView.ts';

test('keeps xterm.js as the default', () => {
	assert.equal(DEFAULT_TERMINAL_ENGINE, 'xterm');
	assert.equal(readTerminalEnginePreference(undefined), 'xterm');
});

test('offers xterm.js, both Wraith profiles, and wterm', () => {
	assert.deepEqual(TERMINAL_ENGINE_IDS, ['xterm', 'wraith', 'wraith-native', 'wterm']);
	assert.equal(new Set(TERMINAL_ENGINE_IDS).size, TERMINAL_ENGINE_IDS.length);
});

test('describes every engine with a distinct label and a hint', () => {
	assert.deepEqual(Object.keys(TERMINAL_ENGINES).sort(), [...TERMINAL_ENGINE_IDS].sort());
	const labels = new Set();
	for (const engine of TERMINAL_ENGINE_IDS) {
		const info = TERMINAL_ENGINES[engine];
		for (const field of ['label', 'hint'])
			assert.ok(info[field].trim().length > 0, `${engine} needs a ${field}`);
		labels.add(info.label);
	}
	assert.equal(labels.size, TERMINAL_ENGINE_IDS.length, 'labels must be distinguishable');
});

test('preserves each exact engine preference', () => {
	for (const engine of TERMINAL_ENGINE_IDS) {
		assert.equal(isTerminalEngineId(engine), true);
		assert.equal(readTerminalEnginePreference(engine), engine);
	}
});

test('rejects malformed and unknown preference values', () => {
	for (const value of [
		undefined,
		null,
		'',
		'XTERM',
		' wraith ',
		'ghostty',
		'wraith_native',
		'__proto__',
		'constructor',
		0,
		false,
		[],
		['wterm'],
		{ engine: 'wterm' }
	]) {
		assert.equal(isTerminalEngineId(value), false);
		assert.equal(readTerminalEnginePreference(value), 'xterm');
	}
});

test('does not coerce objects into engine identifiers', () => {
	const value = {
		toString() {
			throw new Error('Preference validation must not coerce objects');
		}
	};
	assert.equal(isTerminalEngineId(value), false);
	assert.equal(readTerminalEnginePreference(value), 'xterm');
});
