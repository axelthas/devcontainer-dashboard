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
	expect(buffer).toEqual([]);
});

it('keeps repeated zero-budget eviction free of bookkeeping entries', () => {
	const buffer = ['old output', '', ''];
	let length = 0;
	for (let index = 0; index < 10_000; index++)
		length = appendOutput(buffer, index % 2 === 0 ? '' : 'discarded', 0);
	expect(length).toBe(0);
	expect(buffer).toEqual([]);
});

it('does not append empty entries when replay budget remains', () => {
	const buffer = ['retained'];
	let length = 0;
	for (let index = 0; index < 10_000; index++) length = appendOutput(buffer, '', 100);
	expect(length).toBe(8);
	expect(buffer).toEqual(['retained']);
});

it('compacts old empty entries without changing retained output order', () => {
	const buffer = ['', 'ab', '', 'cd', ''];
	expect(appendOutput(buffer, '', 3)).toBe(3);
	expect(buffer).toEqual(['b', 'cd']);
});

it('resumes bounded replay after a session has been fully evicted', () => {
	const buffer = ['old output'];
	expect(appendOutput(buffer, '', 0)).toBe(0);
	expect(appendOutput(buffer, '123456', 4)).toBe(4);
	expect(buffer).toEqual(['3456']);
});

it('bounds old and active buffers during sustained global replay eviction', () => {
	const oldBuffer = ['old output'];
	const activeBuffer: string[] = [];
	let length = 0;
	for (let index = 0; index < 10_000; index++) {
		appendOutput(oldBuffer, '', 0);
		length = appendOutput(activeBuffer, 'x', 4);
	}
	expect(oldBuffer).toEqual([]);
	expect(length).toBe(4);
	expect(activeBuffer).toEqual(['x', 'x', 'x', 'x']);
});

it('keeps running-session timeouts disabled unless explicitly configured', () => {
	expect(terminalLimits({}).idleMs).toBe(0);
	expect(terminalLimits({}).lifetimeMs).toBe(0);
	expect(() => terminalLimits({ TERMINAL_MAX_SESSIONS: '-1' })).toThrow();
	expect(() => terminalLimits({ TERMINAL_MAX_VIEWERS: 'Infinity' })).toThrow();
});
