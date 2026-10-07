/**
 * The build-format lines (coach.yaml's <build> section) in an answer -- Runes, Build, Skills, Swap -- parsed into
 * `BuildLines`. `src/ui.ts` renders them as the build strip; `index.ts`'s markdown transformer and `agent_end`
 * strip them from the answer text and prefetch their icons; `src/lab/draft-lab.ts` and `src/lab/strip-preview.ts`
 * read them too. Pure string parsing: no pi-tui dependency, nothing here about how anything draws.
 */

/** The build-format lines (coach.yaml <build>) in an answer: what the build strip draws, icons first, in their place. */
export interface BuildLines {
	/** The rune page's groups as written: primary, secondary, shards, summoner spells. */
	runes: string[][];
	/** Buy steps in order, each the items bought together ("Doran's Ring", "2 Health Potions"). */
	build: string[][];
	skills: string;
	swaps: string[];
	/** The lines themselves, kept with the strip so a resumed session draws it again. */
	source: string;
}

/** A build-format line; a bullet or a bold label is tolerated. */
const BUILD_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?(Runes|Build|Skills|Swap):(?:\*\*)?[ \t]*(.*?)[ \t]*$/gm;
/** "X instead of Y, into Z" or "X before Y, into Z": the two names a swap is about. No `g` flag, so `.exec()` is safe to call repeatedly from ui.ts and index.ts alike, with no `lastIndex` carried between calls. */
export const SWAP = /^(.+?)\s+(instead of|before|for)\s+(.+?)(,\s*into\s+.*)?$/i;

function splitNames(text: string, separator: RegExp): string[] {
	return text
		.split(separator)
		.map((part) => part.trim().replace(/\.$/, ""))
		.filter(Boolean);
}

/** An item's name without the count or the note a step gives it: "2 Health Potions" is the Health Potions, "Amplifying Tome (first back)" the Amplifying Tome. Every lookup goes through here. */
export function bareItem(name: string): string {
	return name.replace(/\s*\([^)]*\)\s*$/, "").replace(/^\d+\s*[x×]?\s*/i, "").replace(/\s*[x×]\s*\d+$/i, "").trim();
}

/** The answer's runes and build, or undefined when it has neither a Runes nor a Build line. */
export function buildLines(markdown: string): BuildLines | undefined {
	const lines: BuildLines = { runes: [], build: [], skills: "", swaps: [], source: "" };
	const found: string[] = [];
	for (const [line, kind, value] of markdown.matchAll(BUILD_LINE)) {
		found.push(line.trim());
		const text = value.replace(/\.$/, "");
		if (kind === "Runes") lines.runes = splitNames(text, /;/).map((group) => splitNames(group, /,/));
		else if (kind === "Build") lines.build = splitNames(text, /→|->/).map((step) => splitNames(step, /\+/));
		else if (kind === "Skills") lines.skills = text;
		else if (text) lines.swaps.push(text);
	}
	lines.source = found.join("\n");
	return lines.runes.length || lines.build.length ? lines : undefined;
}

/** The answer without its build-format lines, for a terminal that draws the build strip in their place. */
export function withoutBuildLines(markdown: string): string {
	return buildLines(markdown) ? markdown.replace(/^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?(?:Runes|Build|Skills|Swap):.*(?:\r?\n|$)/gm, "").trimEnd() : markdown;
}

/** The names to prefetch icons for: items from the path and the swaps; runes and summoner spells from the page and the swaps. */
export function buildIconNames(lines: BuildLines): { items: string[]; runes: string[] } {
	const swapNames = lines.swaps.flatMap((swap) => {
		const match = SWAP.exec(swap);
		return match ? [bareItem(match[1]), bareItem(match[3])] : [];
	});
	const items = lines.build.flat().flatMap((name) => [bareItem(name), bareItem(name).replace(/s$/, "")]);
	// the strip draws a name or its singular (ui.ts `chip`), so a swap's plural is prefetched as both, like the build path's
	return { items: [...new Set([...items, ...swapNames, ...swapNames.map((name) => name.replace(/s$/, ""))])], runes: [...new Set([...lines.runes.flat().map(bareItem), ...swapNames])] };
}

/** Letters and digits only, lower case: "Doran's Ring" and "dorans ring" are one name. */
const squeezed = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The names in `lines` (runes, shards, summoner spells, items, swaps) that `sources`, the text of this turn's data, never
 * mentions: the coach's own picks rather than something the data recommended. A count or a plural ("2 Health Potions") is
 * found by its single item.
 */
export function unsourcedBuildNames(lines: BuildLines, sources: string): string[] {
	const haystack = squeezed(sources);
	const swapNames = lines.swaps.flatMap((swap) => {
		const match = SWAP.exec(swap);
		return match ? [match[1], match[3]] : [];
	});
	const names = [...new Set([...lines.runes.flat(), ...[...lines.build.flat(), ...swapNames].map(bareItem)])];
	return names.filter((name) => {
		const key = squeezed(name);
		return key !== "" && !haystack.includes(key) && !haystack.includes(key.replace(/s$/, ""));
	});
}

/** True when `line` opens with one of the build-format labels, the same test `buildLines` runs -- for a caller that only needs yes/no per line (src/lab/draft-lab.ts's long-row exemption). A fresh non-global match each call: BUILD_LINE itself is never `.test()`ed directly, since a global regex's `lastIndex` would make repeat calls alternate true/false. */
export function isBuildFormatLine(line: string): boolean {
	return new RegExp(BUILD_LINE.source, "m").test(line);
}
