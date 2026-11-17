import type { ITheme } from '@xterm/xterm';
import type { TerminalViewColors } from './terminalView';

/** Nord colours shared by the interactive terminal and the log viewer */
export const TERMINAL_THEME: ITheme = {
	background: '#2e3440',
	foreground: '#d8dee9',
	cursor: '#d8dee9',
	black: '#3b4252',
	red: '#bf616a',
	green: '#a3be8c',
	yellow: '#ebcb8b',
	blue: '#81a1c1',
	magenta: '#b48ead',
	cyan: '#88c0d0',
	white: '#e5e9f0',
	brightBlack: '#4c566a',
	brightRed: '#bf616a',
	brightGreen: '#a3be8c',
	brightYellow: '#ebcb8b',
	brightBlue: '#81a1c1',
	brightMagenta: '#b48ead',
	brightCyan: '#8fbcbb',
	brightWhite: '#eceff4'
};

/** ANSI colors 0-15 in palette order, as xterm.js theme keys. */
export const ANSI_THEME_KEYS = [
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
	'brightBlack',
	'brightRed',
	'brightGreen',
	'brightYellow',
	'brightBlue',
	'brightMagenta',
	'brightCyan',
	'brightWhite'
] as const;

/** The same Nord colours in the engine-independent terminal view format. */
export const TERMINAL_COLORS: TerminalViewColors = {
	foreground: TERMINAL_THEME.foreground ?? '#d8dee9',
	background: TERMINAL_THEME.background ?? '#2e3440',
	cursor: TERMINAL_THEME.cursor ?? '#d8dee9',
	palette: ANSI_THEME_KEYS.map((key) => TERMINAL_THEME[key] ?? '#d8dee9')
};

export const TERMINAL_FONT_FAMILY = '"Cascadia Code", "Fira Code", monospace';
