/**
 * A small in-memory log of decisions, shown by "Copy PDF preview debug info"
 * so behaviour on the user's device can be seen without a debugger. Nothing
 * is written to disk or sent anywhere.
 */
const MAX_LINES = 80;
const lines: string[] = [];

export function debugNote(message: string): void {
	lines.push(`${new Date().toISOString().slice(11, 23)} ${message}`);
	if (lines.length > MAX_LINES) lines.shift();
}

export function debugLines(): string[] {
	return [...lines];
}
