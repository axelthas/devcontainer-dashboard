/**
 * Browser terminal view factories for #42: xterm.js, Wraith, and wterm.
 *
 * Each factory loads its engine on demand, mounts only a viewer, and adapts it
 * to the TerminalView contract. No factory opens sockets or starts processes;
 * TerminalTab keeps the dashboard's JSON transport and session lifecycle.
 * Ported from draft PR #44 (adapters follow Wraith source at ae0aa122 and the
 * wterm documentation).
 */
import { ANSI_THEME_KEYS } from './terminalTheme';
import { validTerminalDimensions } from './terminalSizing';
import type {
	TerminalEngineId,
	TerminalView,
	TerminalViewColors,
	TerminalViewDimensions,
	TerminalViewFactory,
	TerminalViewOptions
} from './terminalView';

/** Full terminal reset (RIS). Engines without a reset method clear with it before replay. */
const FULL_RESET = '\x1bc';

/** The xterm.js 6 surface used here, shared by xterm.js and Wraith's xterm profile. */
interface XtermLike {
	readonly cols: number;
	readonly rows: number;
	/** Wraith xterm profile only: resolves false when the DOM fallback is active. */
	readonly webgpuReady?: Promise<boolean>;
	/** Wraith xterm profile only: why the WebGPU renderer is not active. */
	readonly rendererFallbackReason?: string;
	open(parent: HTMLElement): void;
	write(data: string): void;
	reset(): void;
	resize(cols: number, rows: number): void;
	focus(): void;
	dispose(): void;
	loadAddon(addon: unknown): void;
	onData(listener: (data: string) => void): { dispose(): void };
	onResize(listener: (size: TerminalViewDimensions) => void): { dispose(): void };
}
type XtermConstructor = new (options: Record<string, unknown>) => XtermLike;

/** Stop when the viewer was disposed while its engine loaded. */
function throwIfAborted(signal: AbortSignal) {
	if (signal.aborted) throw new DOMException('Terminal viewer disposed', 'AbortError');
}

/** A hidden or detached host is unmeasurable, never a zero-size grid. */
function measurable(element: HTMLElement) {
	if (!element.isConnected) return false;
	const bounds = element.getBoundingClientRect();
	return bounds.width > 0 && bounds.height > 0;
}

/** Normalize asynchronous engine failures for the status line. */
function asError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

/** Convert #rrggbb to the integer RGB form that wterm expects. */
function rgb(color: string) {
	return Number.parseInt(color.slice(1), 16);
}

/** Map view colours to xterm.js theme keys. */
function xtermTheme(colors: TerminalViewColors) {
	const theme: Record<string, string> = {
		foreground: colors.foreground,
		background: colors.background,
		cursor: colors.cursor
	};
	ANSI_THEME_KEYS.forEach((key, index) => {
		const color = colors.palette[index];
		if (color) theme[key] = color;
	});
	return theme;
}

/** Load xterm.js or the Wraith xterm-compatible Terminal and its stylesheet. */
async function loadXterm(engine: 'xterm' | 'wraith'): Promise<XtermConstructor> {
	if (engine === 'xterm') {
		const { Terminal } = await import('@xterm/xterm');
		return Terminal as unknown as XtermConstructor;
	}
	const [{ Terminal }] = await Promise.all([
		import('wraithterm/xterm'),
		import('wraithterm/css/xterm.css')
	]);
	return Terminal as unknown as XtermConstructor;
}

/** Explain why Wraith's xterm profile does not use WebGPU. */
function wraithFallback(reason: string | undefined) {
	const detail = reason ? ` (${reason})` : '';
	return `WebGPU is unavailable${detail}. Wraith uses the DOM renderer.`;
}

/** xterm.js 6 and Wraith's xterm profile share one adapter. */
async function createXtermView(
	engine: 'xterm' | 'wraith',
	element: HTMLElement,
	options: TerminalViewOptions
): Promise<TerminalView> {
	const [Terminal, { FitAddon }] = await Promise.all([
		loadXterm(engine),
		import('@xterm/addon-fit')
	]);
	throwIfAborted(options.signal);
	const terminal = new Terminal({
		theme: xtermTheme(options.colors),
		fontFamily: options.fontFamily,
		fontSize: options.fontSize,
		cursorBlink: true,
		scrollback: options.scrollback
	});
	const fitAddon = new FitAddon();
	const subscriptions: { dispose(): void }[] = [];
	let disposed = false;
	/** Release listeners and the terminal once. */
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		for (const subscription of subscriptions) subscription.dispose();
		terminal.dispose();
	};
	try {
		terminal.loadAddon(fitAddon);
		terminal.open(element);
		subscriptions.push(terminal.onData(options.onData), terminal.onResize(options.onResize));
		// Wraith warms WebGPU asynchronously and keeps xterm's DOM renderer as its fallback.
		const gpu = engine === 'wraith' ? ((await terminal.webgpuReady) ?? false) : false;
		throwIfAborted(options.signal);
		return {
			identity:
				engine === 'xterm'
					? { engine, core: 'xterm.js 6', renderer: 'DOM' }
					: {
							engine,
							core: 'xterm.js 6 (Wraith xterm profile)',
							renderer: gpu ? 'WebGPU' : 'DOM',
							fallback: gpu ? undefined : wraithFallback(terminal.rendererFallbackReason)
						},
			write: (data) => {
				if (!disposed) terminal.write(data);
			},
			reset: () => {
				if (!disposed) terminal.reset();
			},
			async fit() {
				if (disposed || !measurable(element)) return undefined;
				const dimensions = fitAddon.proposeDimensions();
				if (!validTerminalDimensions(dimensions)) return undefined;
				if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows)
					terminal.resize(dimensions.cols, dimensions.rows);
				return { cols: terminal.cols, rows: terminal.rows };
			},
			focus: () => terminal.focus(),
			dispose
		};
	} catch (error) {
		dispose();
		throw error;
	}
}

/** Wraith's native profile: libghostty-vt and WebGPU rendering in a worker. */
async function createWraithNativeView(
	element: HTMLElement,
	options: TerminalViewOptions
): Promise<TerminalView> {
	const { Wraith } = await import('wraithterm');
	throwIfAborted(options.signal);
	// Mount rejects with an explanation when WebGPU or OffscreenCanvas is unavailable.
	const terminal = await Wraith.mount(element, {
		fontSize: options.fontSize,
		scrollback: options.scrollback,
		fit: true,
		theme: {
			foreground: options.colors.foreground,
			background: options.colors.background,
			cursor: options.colors.cursor,
			palette: [...options.colors.palette]
		}
	});
	let disposed = false;
	const subscriptions = [
		terminal.onData(options.onData),
		terminal.onResize(options.onResize),
		terminal.onError((error) => options.onError(asError(error)))
	];
	/** Release listeners, then let Wraith stop its worker and GPU device. */
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		for (const subscription of subscriptions) subscription.dispose();
		void terminal.dispose();
	};
	if (options.signal.aborted) {
		dispose();
		throwIfAborted(options.signal);
	}
	/** Report rejected writes, such as a full input queue, instead of dropping output silently. */
	const report = (error: unknown) => {
		if (!disposed) options.onError(asError(error));
	};
	return {
		identity: {
			engine: 'wraith-native',
			core: 'libghostty-vt (worker)',
			renderer: terminal.adapter ? `WebGPU (${terminal.adapter})` : 'WebGPU'
		},
		write: (data) => {
			if (!disposed) terminal.write(data).catch(report);
		},
		reset: () => {
			if (!disposed) terminal.write(FULL_RESET).catch(report);
		},
		async fit() {
			if (disposed || !measurable(element)) return undefined;
			try {
				terminal.fit();
				// The worker applies the resize before it answers this later flush.
				await terminal.flush();
			} catch {
				return undefined;
			}
			return disposed ? undefined : { cols: terminal.cols, rows: terminal.rows };
		},
		focus: () => terminal.focus(),
		dispose
	};
}

/** Vercel Labs wterm with its built-in Zig/WASM core and DOM renderer. */
async function createWtermView(
	element: HTMLElement,
	options: TerminalViewOptions
): Promise<TerminalView> {
	const [{ WTerm }] = await Promise.all([import('@wterm/dom'), import('@wterm/dom/css')]);
	throwIfAborted(options.signal);
	element.style.setProperty('--term-font-family', options.fontFamily);
	element.style.setProperty('--term-font-size', `${options.fontSize}px`);
	const terminal = new WTerm(element, {
		autoResize: true,
		cursorBlink: true,
		scrollbackLines: options.scrollback,
		onData: options.onData,
		onResize: (cols: number, rows: number) => options.onResize({ cols, rows })
	});
	let disposed = false;
	/** Remove wterm listeners and rows, and the host properties set here. */
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		terminal.destroy();
		element.style.removeProperty('--term-font-family');
		element.style.removeProperty('--term-font-size');
	};
	try {
		const colors = {
			foreground: rgb(options.colors.foreground),
			background: rgb(options.colors.background),
			cursor: rgb(options.colors.cursor),
			palette: options.colors.palette.map(rgb)
		};
		terminal.setThemeColors(colors as Parameters<typeof terminal.setThemeColors>[0]);
		await terminal.init();
		throwIfAborted(options.signal);
	} catch (error) {
		dispose();
		throw error;
	}
	return {
		identity: { engine: 'wterm', core: 'wterm Zig/WASM', renderer: 'DOM' },
		write: (data) => {
			if (!disposed) terminal.write(data);
		},
		reset: () => {
			if (!disposed) terminal.write(FULL_RESET);
		},
		async fit() {
			if (disposed || !measurable(element)) return undefined;
			terminal.fit();
			return { cols: terminal.cols, rows: terminal.rows };
		},
		focus: () => terminal.focus(),
		dispose
	};
}

const FACTORIES: Readonly<Record<TerminalEngineId, TerminalViewFactory>> = {
	xterm: (element, options) => createXtermView('xterm', element, options),
	wraith: (element, options) => createXtermView('wraith', element, options),
	'wraith-native': createWraithNativeView,
	wterm: createWtermView
};

/** Mount the selected engine's viewer. A rejection explains why the engine cannot start. */
export function createTerminalView(
	engine: TerminalEngineId,
	element: HTMLElement,
	options: TerminalViewOptions
): Promise<TerminalView> {
	return FACTORIES[engine](element, options);
}
