import { describe, expect, it } from 'vitest';
import { controlCharacter, TERMINAL_KEYS } from './terminalKeys';

describe('terminal keys', () => {
	it('maps letters in either case', () => {
		expect(controlCharacter('c')).toBe('\x03');
		expect(controlCharacter('C')).toBe('\x03');
		expect(controlCharacter('a')).toBe('\x01');
		expect(controlCharacter('z')).toBe('\x1a');
	});

	it('maps terminal punctuation and refuses the rest', () => {
		expect(controlCharacter('[')).toBe('\x1b');
		expect(controlCharacter(' ')).toBe('\x00');
		expect(controlCharacter('1')).toBeNull();
		expect(controlCharacter('Enter')).toBeNull();
	});

	it('sends the interrupt and end-of-input bytes', () => {
		expect(TERMINAL_KEYS.find((key) => key.label === '⌃C')?.data).toBe('\x03');
		expect(TERMINAL_KEYS.find((key) => key.label === '⌃D')?.data).toBe('\x04');
	});
});
