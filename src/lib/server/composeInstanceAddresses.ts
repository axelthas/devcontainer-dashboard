/** IPv4 arithmetic for Compose instance planning. No Docker or filesystem effects. */
export interface IPv4Range {
	start: number;
	end: number;
	prefix: number;
}

/** Parse strict dotted decimal, including rejection of ambiguous leading zeroes. */
export function ipv4(value: string): number | undefined {
	const parts = value.split('.');
	if (
		parts.length !== 4 ||
		parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
	)
		return undefined;
	return parts.reduce((address, part) => address * 256 + Number(part), 0);
}

/** Format a known unsigned IPv4 value. */
export function formatIPv4(value: number): string {
	return [24, 16, 8, 0].map((bits) => (value >>> bits) & 255).join('.');
}

/** Parse a CIDR and reject host bits outside the canonical network address. */
export function ipv4Range(value: string): IPv4Range | undefined {
	const parts = value.split('/');
	if (parts.length !== 2 || !/^(0|[1-9]\d?)$/.test(parts[1])) return undefined;
	const start = ipv4(parts[0]);
	const prefix = Number(parts[1]);
	if (start === undefined || prefix > 32) return undefined;
	const size = 2 ** (32 - prefix);
	if (start % size !== 0) return undefined;
	return { start, end: start + size - 1, prefix };
}

/** Whether two canonical CIDRs share at least one address. */
export function overlaps(a: IPv4Range, b: IPv4Range): boolean {
	return a.start <= b.end && b.start <= a.end;
}

/** Test membership without signed bitwise operations. */
export function contains(range: IPv4Range, address: number): boolean {
	return range.start <= address && address <= range.end;
}
