/**
 * Shared default terminal engine for new terminals and OpenCode TUI windows (#42).
 * The value is a non-sensitive UI preference stored only in this browser.
 */
import { browser } from '$app/environment';
import {
	DEFAULT_TERMINAL_ENGINE,
	TERMINAL_ENGINE_STORAGE_KEY,
	readTerminalEnginePreference,
	type TerminalEngineId
} from './terminalView';

/** Read the stored choice. Storage can be unavailable, for example in private windows. */
function loadStoredEngine(): TerminalEngineId {
	if (!browser) return DEFAULT_TERMINAL_ENGINE;
	try {
		return readTerminalEnginePreference(localStorage.getItem(TERMINAL_ENGINE_STORAGE_KEY));
	} catch {
		return DEFAULT_TERMINAL_ENGINE;
	}
}

const preference = $state({ engine: loadStoredEngine() });

/** Return the engine for terminals opened from now on. */
export function defaultTerminalEngine(): TerminalEngineId {
	return preference.engine;
}

/** Change and persist the default. Open terminals keep their own engine. */
export function setDefaultTerminalEngine(engine: TerminalEngineId) {
	preference.engine = engine;
	if (!browser) return;
	try {
		localStorage.setItem(TERMINAL_ENGINE_STORAGE_KEY, engine);
	} catch {
		// The choice still applies to this page when storage is unavailable.
	}
}
