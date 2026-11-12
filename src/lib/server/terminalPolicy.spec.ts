/** Resource policy regressions independent of native PTY timing. */
import { expect, it } from 'vitest';
import { appendOutput, terminalLimits } from './terminalPolicy';

it('caps a single oversized chunk and preserves its tail', () => {
	const buffer: string[] = [];
	expect(appendOutput(buffer, '123456789', 4)).toBe(4);
	expect(buffer.join('')).toBe('6789');
	expect(appendOutput(buffer, 'ab', 4)).toBe(4);
	expect(buffer.join('')).toBe('89ab');
});

it('permits an empty global replay budget for an evicted session', () => {
	const buffer = ['abc'];
	expect(appendOutput(buffer, '', 0)).toBe(0);
	expect(buffer.join('')).toBe('');
});

it('keeps running-session timeouts disabled unless explicitly configured', () => {
	expect(terminalLimits({}).idleMs).toBe(0);
	expect(terminalLimits({}).lifetimeMs).toBe(0);
	expect(() => terminalLimits({ TERMINAL_MAX_SESSIONS: '-1' })).toThrow();
	expect(() => terminalLimits({ TERMINAL_MAX_VIEWERS: 'Infinity' })).toThrow();
});
