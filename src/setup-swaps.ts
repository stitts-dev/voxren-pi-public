import { bareItem } from "./build-lines";
import { logEvent } from "./coach-log";

/**
 * The /pick answer's Setup row ("Setup: <page choice> to <your choice>, because <enemy and ability>", one or two swaps)
 * checked in code, because prompt wording could not stop a no-op swap or a target that is no Data Dragon name (#367).
 * `resolve` maps a rune, shard, summoner spell, or item name to its Data Dragon name (`knownNames` in icons.ts), or
 * undefined for a name Data Dragon lacks; with no resolver (tables not loaded) only the shape and a literal repeat are checked.
 */
export type ResolveName = (name: string) => string | undefined;
export type SwapVerdict = "ok" | "same" | "unknown-target" | "unparsed";
export interface Swap {
	text: string;
	from: string;
	to: string;
	verdict: SwapVerdict;
}

/** The row an answer labels "Setup:"; the label with its list or bold marks is group 1, the swaps group 2. */
const SETUP_ROW = /^([ \t]*(?:[-*•][ \t]+)?(?:\*\*)?Setup[ \t]*:(?:\*\*)?[ \t]*)(.*)$/i;
const SWAP = /^(.+?)\s+to\s+(.+?)(?:\s*,|\s+because\b|\s+[-—–]\s|$)/i;

const clean = (name: string) => bareItem(name.replace(/[*_`"“”.]/g, "").replace(/\s+(?:shard|rune)$/i, "").trim());
const squeezed = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Each swap in a Setup row's text (the part after the label), classified. A swap is cut at ";" or a sentence end. */
export function setupSwaps(rowText: string, resolve?: ResolveName): Swap[] {
	return rowText
		.replace(/[’‘]/g, "'")
		.split(/;|(?<=[.!?])\s+(?=[A-Z])/)
		.map((part) => part.trim())
		.filter(Boolean)
		.map((text): Swap => {
			const match = SWAP.exec(text);
			if (!match) return { text, from: "", to: "", verdict: "unparsed" };
			const [from, to] = [clean(match[1]), clean(match[2])];
			const [a, b] = resolve ? [resolve(from), resolve(to)] : [squeezed(from), squeezed(to)];
			const verdict: SwapVerdict = b === undefined ? "unknown-target" : a === b ? "same" : "ok";
			return { text, from, to, verdict };
		});
}

/** True when this turn's voxren_meta_research text (`page`) mentions `swap`'s target: measured only, never enforced. */
export function pageBacked(swap: Swap, page: string): boolean {
	return swap.to !== "" && squeezed(page).includes(squeezed(swap.to));
}

const logged = new Set<string>();

/**
 * The answer with each invalid swap dropped from its Setup row, and the whole row dropped when none is left. Each drop is
 * logged once with its reason. `pendingLast` leaves the last line, still being written, as it is.
 */
export function gateSetupRows(markdown: string, resolve?: ResolveName, pendingLast = false, onDrop?: (swap: Swap, rowDropped: boolean) => void): string {
	const lines = markdown.split("\n");
	return lines
		.flatMap((line, index) => {
			const row = SETUP_ROW.exec(line);
			if (!row || (pendingLast && index === lines.length - 1)) return [line];
			const swaps = setupSwaps(row[2], resolve);
			const kept = swaps.filter((swap) => swap.verdict === "ok");
			for (const swap of swaps.filter((swap) => swap.verdict !== "ok")) {
				onDrop?.(swap, kept.length === 0);
				if (logged.has(swap.text)) continue;
				if (logged.size > 200) logged.clear();
				logged.add(swap.text);
				logEvent("info", "setup-swaps", "swap-dropped", { reason: swap.verdict, swap: swap.text, rowDropped: kept.length === 0 });
			}
			if (kept.length === swaps.length) return [line];
			return kept.length ? [row[1] + kept.map((swap) => swap.text).join("; ")] : [];
		})
		.join("\n");
}
