/**
 * Engine for new shell tabs (#42): the engine of the most recent switch.
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

/** Return the engine for shell tabs opened from now on. */
export function preferredTerminalEngine(): TerminalEngineId {
	return preference.engine;
}

/** Remember the engine of a switch for new shell tabs. Open tabs keep their own engine. */
export function rememberTerminalEngine(engine: TerminalEngineId) {
	preference.engine = engine;
	if (!browser) return;
	try {
		localStorage.setItem(TERMINAL_ENGINE_STORAGE_KEY, engine);
	} catch {
		// The choice still applies to this page when storage is unavailable.
	}
}
