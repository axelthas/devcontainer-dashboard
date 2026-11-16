/**
 * Engine-independent browser-view contract for issue #42.
 *
 * This foundation does not register or load engine implementations. The shared
 * session controller retains ownership of process creation, sockets and retries.
 */

export const TERMINAL_ENGINE_IDS = ['xterm', 'wraith', 'wterm'] as const;
export type TerminalEngineId = (typeof TERMINAL_ENGINE_IDS)[number];
export const DEFAULT_TERMINAL_ENGINE: TerminalEngineId = 'xterm';

/** Accept only exact engine identifiers from a non-sensitive UI preference. */
export function isTerminalEngineId(value: unknown): value is TerminalEngineId {
	return TERMINAL_ENGINE_IDS.some((engine) => engine === value);
}

/** Read a preference only; this is not runtime capability detection or fallback. */
export function readTerminalEnginePreference(value: unknown): TerminalEngineId {
	return isTerminalEngineId(value) ? value : DEFAULT_TERMINAL_ENGINE;
}

export interface TerminalViewDimensions {
	cols: number;
	rows: number;
}

export interface TerminalViewAppearance {
	fontFamily: string;
	fontSize: number;
	theme: Readonly<Record<string, string>>;
}

export interface TerminalViewOptions extends TerminalViewAppearance {
	scrollback: number;
	signal: AbortSignal;
	/** Forward through the controller's active/visible/connected input guard. */
	onData: (data: string) => void;
	/** Forward through the controller's measurable-pane and geometry guards. */
	onResize: (dimensions: TerminalViewDimensions) => void;
}

export interface TerminalView {
	/** Actual initialized configuration, not merely the requested preference. */
	readonly identity: {
		readonly engine: TerminalEngineId;
		readonly core: string;
		readonly renderer: string;
	};
	/** Resolve when output is applied; controllers must preserve write order. */
	write(data: string): Promise<void>;
	/** Clear viewer state before serialized output replay, never the server PTY. */
	reset(): Promise<void>;
	/** Return undefined when layout is not measurable; never invent zero geometry. */
	proposeDimensions(): TerminalViewDimensions | undefined;
	resize(dimensions: TerminalViewDimensions): void;
	focus(): void;
	setAppearance(appearance: TerminalViewAppearance): Promise<void>;
	/** Idempotently release view resources; do not stop or recreate a process. */
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
