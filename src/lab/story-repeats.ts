/** Repeats of one story: per-turn aggregation of Jev's rubric grades. Pure. Strict pass is a report number, never part of a story verdict. */
import type { Grade } from "./answer-rubric.ts";

/** A rubric answer at or over this counts as a flag (the thresholds fitted for intro and hedges on the frozen corpus, docs/jev.md). */
export const FLAG_AT = { intro: 0.5, hedges: 0.7, unsourced: 0.5 };
/** Strict pass wants every repeat's quality at least this (issue #117). */
export const STRICT_QUALITY = 3;

export interface TurnSummary {
	turn: number;
	/** One quality per repeat, null where there was no score (no Jev key, no answer, a short repeat). */
	qualities: (number | null)[];
	medianQuality: number | null;
	flags: { intro: number; hedges: number; unsourced: number };
	/** Every repeat scored, quality >= the threshold, no flag; null when any repeat has no score. */
	strictPass: boolean | null;
	/** The first repeat's answer to this turn, kept so a later run can word-diff against it. */
	answer?: string;
}

export function median(values: number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const flagged = (grade: Grade) => ({ intro: grade.has_intro_or_closing >= FLAG_AT.intro, hedges: grade.hedges >= FLAG_AT.hedges, unsourced: grade.unsourced_number >= FLAG_AT.unsourced });

/** `repeats[r][t]` is repeat r's grade for model turn t (null: not scored). */
export function aggregateTurns(repeats: (Grade | null)[][], minQuality = STRICT_QUALITY): TurnSummary[] {
	const count = Math.max(0, ...repeats.map((grades) => grades.length));
	return Array.from({ length: count }, (_, t) => {
		const grades = repeats.map((r) => r[t] ?? null);
		const scored = grades.filter((g): g is Grade => g !== null);
		const flags = { intro: 0, hedges: 0, unsourced: 0 };
		for (const g of scored) for (const [k, on] of Object.entries(flagged(g))) if (on) flags[k as keyof typeof flags]++;
		const allScored = scored.length === grades.length && scored.length > 0;
		return {
			turn: t + 1,
			qualities: grades.map((g) => g?.quality ?? null),
			medianQuality: median(scored.map((g) => g.quality)),
			flags,
			strictPass: allScored ? scored.every((g) => g.quality >= minQuality) && !flags.intro && !flags.hedges && !flags.unsourced : null,
		};
	});
}
