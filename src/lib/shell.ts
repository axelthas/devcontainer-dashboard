/** Shell quoting for commands that the terminal server runs with `bash -c`. */

/**
 * Quote one value as a single literal POSIX shell word.
 * Spaces, quotes, `$`, backticks, and other metacharacters keep their literal meaning.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
