/**
 * Keys that a phone keyboard lacks, and Ctrl as a one-shot modifier. `data` is what a
 * terminal sends for the key, so the key bar uses the same input path as typed keys.
 */
export interface TerminalKey {
	label: string;
	/** Accessible name */
	name: string;
	data: string;
	tone?: 'signal';
}

export const TERMINAL_KEYS: TerminalKey[] = [
	{ label: 'Esc', name: 'Escape', data: '\x1b' },
	{ label: 'Tab', name: 'Tab', data: '\t' },
	{ label: '⌃C', name: 'Control C, interrupt', data: '\x03', tone: 'signal' },
	{ label: '⌃D', name: 'Control D, end of input', data: '\x04', tone: 'signal' },
	{ label: '←', name: 'Arrow left', data: '\x1b[D' },
	{ label: '↑', name: 'Arrow up', data: '\x1b[A' },
	{ label: '↓', name: 'Arrow down', data: '\x1b[B' },
	{ label: '→', name: 'Arrow right', data: '\x1b[C' },
	{ label: '|', name: 'Pipe', data: '|' },
	{ label: '~', name: 'Tilde', data: '~' },
	{ label: '/', name: 'Slash', data: '/' },
	{ label: '-', name: 'Dash', data: '-' }
];

/**
 * The control character for a key pressed while Ctrl is armed: Ctrl+A is 0x01 through
 * Ctrl+Z 0x1a, plus the punctuation that terminals map. Null for keys without one.
 */
export function controlCharacter(key: string): string | null {
	if (key.length !== 1) return null;
	const code = key.toUpperCase().charCodeAt(0);
	if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code - 0x40);
	const punctuation: Record<string, string> = {
		'@': '\x00',
		' ': '\x00',
		'[': '\x1b',
		'\\': '\x1c',
		']': '\x1d',
		'^': '\x1e',
		_: '\x1f',
		'?': '\x7f'
	};
	return punctuation[key] ?? null;
}
