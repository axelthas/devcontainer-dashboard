/**
 * Engine-independent browser-view contract for switchable terminal engines (#42).
 *
 * A view only renders output and reports input and geometry. TerminalTab keeps
 * process creation, the WebSocket transport, retries, and output replay.
 */

export const TERMINAL_ENGINE_IDS = ['xterm', 'wraith', 'wraith-native', 'wterm'] as const;
export type TerminalEngineId = (typeof TERMINAL_ENGINE_IDS)[number];
export const DEFAULT_TERMINAL_ENGINE: TerminalEngineId = 'xterm';
/** Non-sensitive browser preference: the engine of the most recent switch. */
export const TERMINAL_ENGINE_STORAGE_KEY = 'devcontainer-dashboard-terminal-engine';

export interface TerminalEngineInfo {
	/** Name in the engine switcher. */
	label: string;
	/** Core and renderer, on one short line under the name. */
	hint: string;
}

export const TERMINAL_ENGINES: Readonly<Record<TerminalEngineId, TerminalEngineInfo>> = {
	xterm: { label: 'xterm.js', hint: 'xterm.js 6 · DOM' },
	wraith: { label: 'Wraith', hint: 'xterm.js parser · WebGPU' },
	'wraith-native': { label: 'Wraith native', hint: 'libghostty-vt · WebGPU' },
	wterm: { label: 'wterm', hint: 'Zig/WASM · DOM' }
};

/** Accept only exact engine identifiers from a non-sensitive UI preference. */
export function isTerminalEngineId(value: unknown): value is TerminalEngineId {
	return TERMINAL_ENGINE_IDS.some((engine) => engine === value);
}

/** Read a stored preference. This is not capability detection or fallback. */
export function readTerminalEnginePreference(value: unknown): TerminalEngineId {
	return isTerminalEngineId(value) ? value : DEFAULT_TERMINAL_ENGINE;
}

export interface TerminalViewDimensions {
	cols: number;
	rows: number;
}

export interface TerminalViewColors {
	foreground: string;
	background: string;
	cursor: string;
	/** ANSI colors 0-15 as #rrggbb. */
	palette: readonly string[];
}

export interface TerminalViewOptions {
	fontFamily: string;
	fontSize: number;
	colors: TerminalViewColors;
	scrollback: number;
	/** Aborted when the viewer is disposed while its engine still loads. */
	signal: AbortSignal;
	/** Forward through the controller's active/visible/connected input guard. */
	onData: (data: string) => void;
	/** Forward through the controller's measurable-pane and geometry guards. */
	onResize: (dimensions: TerminalViewDimensions) => void;
	/** Engine failure after mount, such as a lost GPU device or a full input queue. */
	onError: (error: Error) => void;
}

/** Configuration that actually initialized, not only the requested engine. */
export interface TerminalViewIdentity {
	readonly engine: TerminalEngineId;
	readonly core: string;
	readonly renderer: string;
	/** Why the engine runs a fallback renderer. Undefined when it runs as selected. */
	readonly fallback?: string;
}

export interface TerminalView {
	readonly identity: TerminalViewIdentity;
	/** Queue output. Each engine applies successive writes in call order. */
	write(data: string): void;
	/** Clear viewer state before output replay. This never affects the server PTY. */
	reset(): void;
	/** Fit the grid to its host. Resolve with the applied size, or undefined if unmeasurable. */
	fit(): Promise<TerminalViewDimensions | undefined>;
	focus(): void;
	/** Change the text size in place. The caller fits afterwards; the PTY and its output stay. */
	setFontSize(size: number): Promise<void>;
	/** Idempotently release view resources. This never stops or recreates a process. */
	dispose(): void;
}

/**
 * Mount only a browser viewer. A factory must release partial resources on abort
 * or failure and must not create PTYs, attach sockets, or run startup commands.
 */
export type TerminalViewFactory = (
	element: HTMLElement,
	options: TerminalViewOptions
) => Promise<TerminalView>;
