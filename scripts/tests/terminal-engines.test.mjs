/**
 * Dependency-free checks for the terminal engine preference foundation.
 * Run on Node.js 22.13+:
 * node --experimental-strip-types --test scripts/tests/terminal-engines.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	DEFAULT_TERMINAL_ENGINE,
	TERMINAL_ENGINE_IDS,
	isTerminalEngineId,
	readTerminalEnginePreference
} from '../../src/lib/terminalView.ts';

test('keeps xterm as the default during comparison', () => {
	assert.equal(DEFAULT_TERMINAL_ENGINE, 'xterm');
	assert.equal(readTerminalEnginePreference(undefined), 'xterm');
});

test('declares exactly the three requested engine identifiers', () => {
	assert.deepEqual(TERMINAL_ENGINE_IDS, ['xterm', 'wraith', 'wterm']);
	assert.equal(new Set(TERMINAL_ENGINE_IDS).size, TERMINAL_ENGINE_IDS.length);
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
