/** Keep browser terminal geometry within the terminal server's resize contract. */
export interface TerminalDimensions {
	cols: number;
	rows: number;
}

/** Hidden or unmeasured panes can produce NaN; JSON would turn those values into null. */
export function validTerminalDimensions(value: unknown): value is TerminalDimensions {
	if (typeof value !== 'object' || value === null) return false;
	const { cols, rows } = value as Partial<TerminalDimensions>;
	return (
		typeof cols === 'number' &&
		typeof rows === 'number' &&
		Number.isInteger(cols) &&
		Number.isInteger(rows) &&
		cols > 0 &&
		rows > 0 &&
		cols <= 1000 &&
		rows <= 1000
	);
}
