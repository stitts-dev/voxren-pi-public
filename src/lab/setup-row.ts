/** The row an answer labels "Setup:", wherever it sits (a Dodge row can follow it). List, number, and bold markers around the label are ignored. */
export function setupRow(rows: string[]): string | undefined {
	return rows.find((row) => /^[\s\-*•\d.)]*setup\s*\**\s*:/i.test(row));
}

/** The row the draft lab scores as setup: the labelled one, else the last row. A /pick answer labels every row, so an unlabelled one has no setup to score. */
export function scoredSetupRow(rows: string[], command: string): string {
	return setupRow(rows) ?? (command === "pick" ? "" : (rows.at(-1) ?? ""));
}

/** Rune names from Data Dragon's runesReforged.json, longest first so a longer name wins over one it contains. Trees are not runes; stat shards are not in the file. */
export function runeNames(styles: { slots: { runes: { name: string }[] }[] }[]): string[] {
	const names = [...new Set(styles.flatMap((style) => style.slots.flatMap((slot) => slot.runes.map((rune) => rune.name))))];
	return names.sort((a, b) => b.length - a.length);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The rune names (longest first, `names` from `runeNames`) a row mentions, each once. Whole words only, any case, curly quotes read as straight. */
export function runeNamesIn(row: string, names: string[]): string[] {
	let rest = row.replaceAll("’", "'");
	const found: string[] = [];
	for (const name of names) {
		const match = new RegExp(`(?<![\\p{L}\\p{N}])${escape(name.replaceAll("’", "'"))}(?![\\p{L}\\p{N}])`, "iu");
		if (!match.test(rest)) continue;
		found.push(name);
		rest = rest.replace(new RegExp(match.source, "giu"), " ");
	}
	return found;
}
