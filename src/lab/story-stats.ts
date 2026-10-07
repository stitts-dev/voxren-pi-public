/** Cost and speed numbers for story runs: pure functions over the exchange log and the final screen, so a run can be compared with an older one. */
import { summarizeDoctrine, type DoctrineGrade, type DoctrineSummary } from "./answer-rubric.ts";
import { median, type TurnSummary } from "./story-repeats.ts";
import type { Run } from "./stories.ts";

/** How `voxren_strategy_frame` routed the claims of one answer (src/grounding-judge.ts `ClaimRoute`); claims Jev never judged are in none of them. */
export interface ClaimCounts {
	grounded: number;
	unsupported: number;
	contradicted: number;
	disputed: number;
}

/** One answer, which is one model run of the exchange log: what the coach's own judge made of its claims, and what it cost. */
export interface AnswerStats {
	/** The run's place in the story, from 1: the turn number the per-turn rubric rows use. */
	turn: number;
	/** Undefined when no claim of the answer was judged (no frame call, no key, Jev unreachable). */
	claims?: ClaimCounts;
	/** The coach model's tokens and dollars for this run (the exchange log's `usage`). */
	inputTokens: number;
	outputTokens: number;
	/** Undefined when the log recorded no cache numbers. */
	cacheReadTokens?: number;
	costUsd: number;
	/** Jev input tokens of the System One calls the coach made while answering (its tool results' `inputTokens`); the runner's grading calls are in `doctrine.inputTokens` and the story's totals. */
	jevInputTokens: number;
	/** Jev's doctrine questions on this answer (src/lab/answer-rubric.ts), set by `withDoctrine`. */
	doctrine?: DoctrineSummary;
}

export interface StoryStats {
	id: string;
	verdict: "PASS" | "FAIL";
	/** The gates a FAIL tripped, as `gate: detail`; the score's finding body reads it. */
	failures?: string[];
	seconds: number;
	/** Seconds the model runs took (the exchange log's `ms`). */
	modelSeconds: number;
	slowestTool?: { name: string; ms: number };
	/** Jev's own time, from the `jev-x.y.z · … 295 ms` timings on the cards. */
	jevMs: number;
	/** The coach model: the session sum over the exchange log (`usage.costUsd` of every run), the same definition as Pi's footer. */
	costUsd: number;
	/** Jev input tokens of every System One call the coach made (the `inputTokens` on its tool results) plus the runner's rubric call. The router's call is not recorded by the coach and is not counted. */
	jevInputTokens: number;
	jevUsd: number;
	/** The sonnet taste note: its `total_cost_usd` and token counts from `claude -p --output-format json`. */
	noteUsd: number;
	noteInputTokens: number;
	noteOutputTokens: number;
	/** Model plus Jev plus note. */
	totalUsd: number;
	/** What Pi's footer showed at story end; the runner warns when it differs from costUsd by more than $0.001. */
	footerCostUsd?: number;
	inputTokens: number;
	outputTokens: number;
	/** Prompt-cache tokens the exchange log recorded; undefined when it recorded none (older logs, providers that report none). */
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	turns: number;
	/** Claims the CHECK card found contradicted (undefined when no CHECK card ran). */
	contradicted?: number;
	model: string;
	/** One row per model run: claim counts, tokens, and cost per answer. Undefined in a stats.json from before they were recorded. */
	answers?: AnswerStats[];
	/** The icon gate (src/lab/icon-check.ts), for a story with `gates.icons`: icons the strip should draw, placed in the bytes, blank in the pixels, and not cropped. */
	icons?: { status: "pass" | "fail" | "skipped"; expected: number; placed: number; blank: number; unchecked: number };
}

/** Jev 1.13's published price: $0.042 per million input tokens, output free (https://docs.typesafe.ai/models.md, read 2026-10-04). Change it with the page. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** Total of the `<n> ms` timings on card lines that name a Jev version. */
export function jevMs(screen: string): number {
	let total = 0;
	for (const line of screen.split("\n")) if (/\bjev-\d/.test(line)) for (const match of line.matchAll(/(\d+)\s*ms\b/g)) total += Number(match[1]);
	return total;
}

/** Every numeric `inputTokens` anywhere in a value: what the gateway's `judgment` objects carry for each Jev call. */
export function inputTokensIn(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + inputTokensIn(item), 0);
	if (typeof value !== "object" || value === null) return 0;
	return Object.entries(value).reduce((sum, [key, item]) => sum + (key === "inputTokens" && typeof item === "number" ? item : inputTokensIn(item)), 0);
}

/** Adds the runner's own judge costs (the rubric call's Jev tokens, the note's cost) and recomputes the Jev dollars and the total. */
export function withJudgeCosts(stats: StoryStats, extra: { jevInputTokens?: number; noteUsd?: number; noteInputTokens?: number; noteOutputTokens?: number }): StoryStats {
	const jevInputTokens = stats.jevInputTokens + (extra.jevInputTokens ?? 0);
	const noteUsd = round(stats.noteUsd + (extra.noteUsd ?? 0), 4);
	const jevUsd = round(jevInputTokens * JEV_USD_PER_INPUT_TOKEN, 6);
	return { ...stats, jevInputTokens, jevUsd, noteUsd, noteInputTokens: stats.noteInputTokens + (extra.noteInputTokens ?? 0), noteOutputTokens: stats.noteOutputTokens + (extra.noteOutputTokens ?? 0), totalUsd: round(stats.costUsd + jevUsd + noteUsd, 4) };
}

/** The CHECK card's verdict counts from the screen: grounded claims and contradicted ones. Undefined when no CHECK card ran. */
export function groundingSummary(screen: string): { grounded: number; contradicted: number } | undefined {
	const line = screen.split("\n").find((row) => /\bCHECK\b.*\d+ claims?/.test(row));
	if (!line) return undefined;
	return { grounded: Number(/(\d+) grounded/.exec(line)?.[1] ?? 0), contradicted: Number(/(\d+) contradicted/.exec(line)?.[1] ?? 0) };
}

const CLAIM_ROUTES: readonly (keyof ClaimCounts)[] = ["grounded", "unsupported", "contradicted", "disputed"];

/** The routes of every judged claim across a run's `voxren_strategy_frame` results, read from the exchange log (`response.data.claims[].route`). Undefined when no claim was judged: zero would say "checked, nothing found". */
export function claimCounts(tools: Run["tools"]): ClaimCounts | undefined {
	const counts: ClaimCounts = { grounded: 0, unsupported: 0, contradicted: 0, disputed: 0 };
	let judged = 0;
	for (const tool of tools) {
		if (tool.name !== "voxren_strategy_frame" || !tool.ok) continue;
		const claims = (tool.result as { response?: { data?: { claims?: unknown } } } | undefined)?.response?.data?.claims;
		if (!Array.isArray(claims)) continue;
		for (const claim of claims) {
			const route = (claim as { route?: unknown } | null)?.route as keyof ClaimCounts;
			if (CLAIM_ROUTES.includes(route)) {
				counts[route]++;
				judged++;
			}
		}
	}
	return judged ? counts : undefined;
}

/** Claim counts, tokens, and cost for each answer (model run) of an exchange log. */
export function answerStats(exchange: Run[]): AnswerStats[] {
	return exchange.map((run, index) => {
		const claims = claimCounts(run.tools);
		return {
			turn: index + 1,
			...(claims && { claims }),
			inputTokens: run.usage?.input ?? 0,
			outputTokens: run.usage?.output ?? 0,
			...(run.usage?.cacheRead !== undefined && { cacheReadTokens: run.usage.cacheRead }),
			costUsd: round(run.usage?.costUsd ?? 0, 4),
			jevInputTokens: run.tools.reduce((sum, tool) => sum + inputTokensIn(tool.result), 0),
		};
	});
}

/** `grades[i]` is the doctrine grade of answer i (null: not graded); each graded answer gets its summary. */
export function withDoctrine(answers: AnswerStats[], grades: (DoctrineGrade | null)[]): AnswerStats[] {
	return answers.map((answer, index) => {
		const grade = grades[index];
		return grade ? { ...answer, doctrine: summarizeDoctrine(grade) } : answer;
	});
}

/** The report's per-answer table, header and rule. */
export const ANSWER_TABLE = [
	"| story | turn | claims grounded/unsupported/contradicted | model tokens in/out | model $ | Jev tokens (coach + doctrine grading) | doctrine followed | under 0.5: question (rows to edit) | picked |",
	"|---|---|---|---|---|---|---|---|---|",
];

/** One answer as a row of ANSWER_TABLE. A dash is "not measured", never zero. */
export function answerRow(id: string, answer: AnswerStats): string {
	const { claims, doctrine } = answer;
	const claimCell = claims ? `${claims.grounded}/${claims.unsupported}/${claims.contradicted}${claims.disputed ? ` (+${claims.disputed} disputed)` : ""}` : "-";
	const failed = doctrine?.failed.map((item) => `${item.question} ${item.followed} (${item.rules.join(", ")})`).join("; ");
	const picked = Object.entries(doctrine?.picked ?? {}).map(([question, option]) => `${question} ${option}`).join(", ");
	return `| ${id} | ${answer.turn} | ${claimCell} | ${answer.inputTokens}/${answer.outputTokens}${answer.cacheReadTokens !== undefined ? ` (${answer.cacheReadTokens} cached)` : ""} | $${answer.costUsd.toFixed(4)} | ${answer.jevInputTokens}${doctrine ? ` + ${doctrine.inputTokens}` : ""} | ${doctrine?.score ?? "-"} | ${failed || "-"} | ${picked || "-"} |`;
}

export function storyStats(id: string, verdict: "PASS" | "FAIL", seconds: number, exchange: Run[], screen: string): StoryStats {
	const tools = exchange.flatMap((run) => run.tools.map((tool) => ({ name: tool.name, ms: tool.ms ?? 0 })));
	const slowest = tools.reduce<{ name: string; ms: number } | undefined>((best, tool) => (!best || tool.ms > best.ms ? tool : best), undefined);
	const costUsd = round(exchange.reduce((sum, run) => sum + (run.usage?.costUsd ?? 0), 0), 4);
	const jevInputTokens = exchange.reduce((sum, run) => sum + run.tools.reduce((inner, tool) => inner + inputTokensIn(tool.result), 0), 0);
	const jevUsd = round(jevInputTokens * JEV_USD_PER_INPUT_TOKEN, 6);
	return {
		id,
		verdict,
		seconds: round(seconds, 1),
		modelSeconds: round(exchange.reduce((sum, run) => sum + (run.ms ?? 0), 0) / 1000, 1),
		slowestTool: slowest,
		jevMs: jevMs(screen),
		costUsd,
		jevInputTokens,
		jevUsd,
		noteUsd: 0,
		noteInputTokens: 0,
		noteOutputTokens: 0,
		totalUsd: round(costUsd + jevUsd, 4),
		inputTokens: exchange.reduce((sum, run) => sum + (run.usage?.input ?? 0), 0),
		outputTokens: exchange.reduce((sum, run) => sum + (run.usage?.output ?? 0), 0),
		...(exchange.some((run) => run.usage?.cacheRead !== undefined) ? { cacheReadTokens: exchange.reduce((sum, run) => sum + (run.usage?.cacheRead ?? 0), 0), cacheWriteTokens: exchange.reduce((sum, run) => sum + (run.usage?.cacheWrite ?? 0), 0) } : {}),
		turns: exchange.reduce((sum, run) => sum + (run.usage?.turns ?? 0), 0),
		model: [...new Set(exchange.map((run) => run.model?.id).filter(Boolean))].join(","),
		answers: answerStats(exchange),
	};
}

export function percentile(values: number[], fraction: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

export interface RunSummary {
	wallSeconds: number;
	sumSeconds: number;
	/** Sum of story seconds over the wall clock: how much the parallel panes bought. */
	speedup: number;
	costUsd: number;
	modelUsd: number;
	jevUsd: number;
	jevInputTokens: number;
	noteUsd: number;
	medianSeconds: number;
	p90Seconds: number;
	slowestTools: { story: string; name: string; ms: number }[];
}

export function runSummary(stats: StoryStats[], wallSeconds: number): RunSummary {
	const sum = stats.reduce((total, entry) => total + entry.seconds, 0);
	const seconds = stats.map((entry) => entry.seconds);
	return {
		wallSeconds: round(wallSeconds, 1),
		sumSeconds: round(sum, 1),
		speedup: wallSeconds > 0 ? round(sum / wallSeconds, 2) : 0,
		costUsd: round(stats.reduce((total, entry) => total + entry.totalUsd, 0), 4),
		modelUsd: round(stats.reduce((total, entry) => total + entry.costUsd, 0), 4),
		jevUsd: round(stats.reduce((total, entry) => total + entry.jevUsd, 0), 4),
		jevInputTokens: stats.reduce((total, entry) => total + entry.jevInputTokens, 0),
		noteUsd: round(stats.reduce((total, entry) => total + entry.noteUsd, 0), 4),
		medianSeconds: percentile(seconds, 0.5),
		p90Seconds: percentile(seconds, 0.9),
		slowestTools: stats
			.flatMap((entry) => (entry.slowestTool ? [{ story: entry.id, ...entry.slowestTool }] : []))
			.sort((a, b) => b.ms - a.ms)
			.slice(0, 3),
	};
}

/** The model's tokens for one run, cached and uncached: `inputTokens` alone swings about 4x with cache state (#248). Undefined when the log has no cache numbers. */
const totalTokens = (entry: StoryStats): number | undefined => (entry.cacheReadTokens === undefined ? undefined : entry.inputTokens + entry.cacheReadTokens + (entry.cacheWriteTokens ?? 0) + entry.outputTokens);

/** Per-story delta against an older run, repeats folded (`id.r1`, `id.r2` are one story). A part is flagged when its median is more than `limit` over the baseline's and the change is at least 2x the baseline repeats' median absolute deviation, as the rubric quality does. A single run on either side flags nothing: "unverified (1 run)". The model's cost compares on total tokens (cached plus uncached) when both sides logged cache reads, else on costUsd and the line says the cache was not logged. Stories missing from either side are skipped. */
export function compareStats(old: StoryStats[], now: StoryStats[], limit = 0.25): { lines: string[]; flagged: string[]; unverified: string[] } {
	const group = (stats: StoryStats[]) => {
		const groups = new Map<string, StoryStats[]>();
		for (const entry of stats) groups.set(entry.id.replace(/\.r\d+$/, ""), [...(groups.get(entry.id.replace(/\.r\d+$/, "")) ?? []), entry]);
		return groups;
	};
	const before = group(old);
	const lines: string[] = [];
	const flagged: string[] = [];
	const unverified: string[] = [];
	for (const [id, is] of group(now)) {
		const was = before.get(id);
		if (!was) continue;
		const sign = (value: number, places: number) => `${value >= 0 ? "+" : ""}${value.toFixed(places)}`;
		const tokens = was.every((x) => totalTokens(x) !== undefined) && is.every((x) => totalTokens(x) !== undefined);
		const parts: [string, (x: StoryStats) => number, number][] = [
			["s", (x) => x.seconds, 1],
			tokens ? ["model tokens", (x) => totalTokens(x)!, 0] : ["model USD", (x) => x.costUsd, 4],
			["Jev USD", (x) => x.jevUsd ?? 0, 6],
			["note USD", (x) => x.noteUsd ?? 0, 4],
		];
		const single = was.length < 2 || is.length < 2;
		const bad: string[] = [];
		const cells = parts.map(([name, pick, places]) => {
			const b = median(was.map(pick))!;
			const a = median(is.map(pick))!;
			const noise = mad(was.map(pick)) ?? 0;
			if (!single && b > 0 && a > b * (1 + limit) && a - b >= 2 * noise) bad.push(name);
			return `${sign(a - b, places)} ${name}`;
		});
		const note = `${tokens ? "" : "  (model cost is costUsd, no cache reads logged: swings with cache state)"}`;
		lines.push(`${id}: ${cells.join(", ")}${single ? "  unverified (1 run)" : bad.length ? `  OVER 25%: ${bad.join(", ")}` : ""}${note}`);
		if (single) unverified.push(id);
		else if (bad.length) flagged.push(id);
	}
	return { lines, flagged, unverified };
}

/** One story's per-turn aggregates, as stats.json's `turns` holds them. */
export interface StoryTurns {
	id: string;
	repeats: string[];
	turns: TurnSummary[];
}

export interface TurnCompare {
	story: string;
	turn: number;
	verdict: "improved" | "regressed" | "unchanged" | "new" | "gone" | "unscored" | "unverified";
	/** Median quality now minus before. */
	change?: number;
	/** The baseline repeats' median absolute deviation, never under NOISE_FLOOR (a MAD of 0 stays 0: unmeasured). */
	noise?: number;
	/** |change| over noise: infinite on zero noise with a change. */
	ratio?: number;
	confidence?: "real" | "marginal" | "noise" | "unmeasured";
	/** Scored repeats on the new side; under 2 the turn is "unverified" and gets no rating. */
	newRepeats?: number;
	diff?: string;
}

/** The least noise a baseline spread counts for, in quality points (scores move in steps of 0.1): a MAD above 0 and under it, which 3 repeats often give by chance, reads as this (a MAD of 0 stays 0, unmeasured). Chosen by replaying the saved repeat-3 baseline (57 comparisons, each repeat held out against the other two, nothing changed, #439): "real" fired 21 times with no floor, 24 or 20 at 0.1, 12 or 11 at 0.2, 7 or 6 at 0.25 (a MAD of 0 measured as the floor, or kept marginal). 0.25 with MAD 0 kept marginal is the fewest: 6. */
export const NOISE_FLOOR = 0.25;

/** Median absolute deviation of the scored values; undefined with fewer than two, since one repeat has no spread. */
export function mad(values: (number | null)[]): number | undefined {
	const scored = values.filter((v): v is number => v !== null);
	if (scored.length < 2) return undefined;
	const mid = median(scored)!;
	return median(scored.map((v) => Math.abs(v - mid)))!;
}

/** Inline word diff: [-gone-] {+new+}, unchanged words kept; long unchanged runs shortened to their edges. */
export function wordDiff(before: string, after: string): string {
	const a = before.split(/\s+/).filter(Boolean);
	const b = after.split(/\s+/).filter(Boolean);
	const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	const out: string[] = [];
	let same: string[] = [];
	const flush = (last: boolean) => {
		out.push(same.length > 6 && !last ? `${same.slice(0, 2).join(" ")} ... ${same.slice(-2).join(" ")}` : same.length > 6 ? `${same.slice(0, 2).join(" ")} ...` : same.join(" "));
		same = [];
	};
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) same.push(a[i++]), j++;
		else {
			if (same.length) flush(false);
			if (j < b.length && (i === a.length || lcs[i][j + 1] > lcs[i + 1][j])) out.push(`{+${b[j++]}+}`);
			else out.push(`[-${a[i++]}-]`);
		}
	}
	if (same.length) flush(true);
	return out.join(" ");
}

/** Rubric-quality verdict per turn: the change in median quality against the baseline repeats' noise (MAD, at least NOISE_FLOOR, rounded to 3 places like the change so an exact 2x does not flip on float error). 2x noise or more is real, 1-2x marginal, under 1x noise; zero noise with a change is marginal, since no spread was measured to call it real. A turn with under 2 scored repeats on the new side is unverified and not rated: one run's score is too noisy to call (#439), as in compareStats. */
export function compareTurns(old: StoryTurns[], now: StoryTurns[]): TurnCompare[] {
	const before = new Map(old.map((s) => [s.id, new Map(s.turns.map((t) => [t.turn, t]))]));
	const after = new Map(now.map((s) => [s.id, new Map(s.turns.map((t) => [t.turn, t]))]));
	const rows: TurnCompare[] = [];
	for (const id of new Set([...before.keys(), ...after.keys()])) {
		const was = before.get(id);
		const is = after.get(id);
		for (const turn of [...new Set([...(was?.keys() ?? []), ...(is?.keys() ?? [])])].sort((x, y) => x - y)) {
			const w = was?.get(turn);
			const n = is?.get(turn);
			if (!w || !n) {
				rows.push({ story: id, turn, verdict: w ? "gone" : "new" });
				continue;
			}
			if (w.medianQuality === null || n.medianQuality === null) {
				rows.push({ story: id, turn, verdict: "unscored" });
				continue;
			}
			const change = round(n.medianQuality - w.medianQuality, 3);
			const diff = w.answer && n.answer ? (w.answer === n.answer ? "same answer" : wordDiff(w.answer, n.answer)) : undefined;
			const newRepeats = n.qualities.filter((q) => q !== null).length;
			if (newRepeats < 2) {
				rows.push({ story: id, turn, verdict: "unverified", change, newRepeats, diff });
				continue;
			}
			const spread = mad(w.qualities);
			const noise = spread === undefined || spread === 0 ? spread : round(Math.max(spread, NOISE_FLOOR), 3);
			const ratio = noise === undefined ? undefined : noise === 0 ? (change === 0 ? 0 : Infinity) : Math.abs(change) / noise;
			const confidence = change === 0 ? "noise" : ratio === undefined || noise === 0 ? "unmeasured" : ratio >= 2 ? "real" : ratio >= 1 ? "marginal" : "noise";
			// Unmeasured noise (zero or under two repeats) with a change reads as marginal, never real.
			const verdict = confidence === "noise" ? "unchanged" : change > 0 ? "improved" : "regressed";
			rows.push({ story: id, turn, verdict, change, noise, ratio, confidence, newRepeats, diff });
		}
	}
	return rows;
}

export function turnCompareLine(row: TurnCompare): string {
	if (row.change === undefined) return `${row.story} turn ${row.turn}: ${row.verdict}`;
	const sign = row.change >= 0 ? "+" : "";
	const diff = row.diff ? `\n    ${row.diff.length > 500 ? `${row.diff.slice(0, 500)} ...` : row.diff}` : "";
	if (row.verdict === "unverified") return `${row.story} turn ${row.turn}: unverified (${row.newRepeats} run), median ${sign}${row.change}, ${row.newRepeats} repeat cannot be flagged, 2 or more are needed${diff}`;
	const noise = row.noise === undefined ? "noise n/a (under 2 repeats)" : `noise ${row.noise}${row.ratio === Infinity ? ", zero noise" : ` (${row.ratio!.toFixed(1)}x)`}`;
	const conf = row.confidence === "unmeasured" ? "marginal" : row.confidence;
	return `${row.story} turn ${row.turn}: ${row.verdict}, median ${sign}${row.change}, ${noise}, ${conf}${diff}`;
}

/** The report's heading over the per-turn quality lines: the floor, that a MAD of 0 stays 0, and how many repeats the new side needs. */
export function turnCompareHeading(): string {
	return `Per turn, rubric quality against the baseline repeats' noise (MAD, raised to ${NOISE_FLOOR} when under it, but a MAD of 0 stays 0 and a change on it reads marginal; 2x or more real, 1-2x marginal, under 1x noise; a turn with 1 repeat on the new side is unverified and not rated, 2 or more are needed):`;
}

/** The report's tail on the cost and time line for stories compared with one run on a side; empty when there are none. */
export function unverifiedNote(ids: string[]): string {
	return ids.length ? `; unverified (1 run, flagging needs 2 or more repeats on each side): ${ids.join(", ")}` : "";
}

export interface SplitSummary {
	split: string;
	runs: number;
	pass: number;
	/** Rubric flags over the story's repeats: intro/closing, hedges, unsourced numbers. */
	flags: { intro: number; hedges: number; unsourced: number };
	contradicted: number;
	meanSeconds: number;
	meanUsd: number;
}

/** One split is one story with its repeats folded: guard counts, mean cost and mean wall time per run. */
export function splitSummaries(stats: StoryStats[], turns: StoryTurns[]): SplitSummary[] {
	const groups = new Map<string, StoryStats[]>();
	for (const s of stats) groups.set(s.id.replace(/\.r\d+$/, ""), [...(groups.get(s.id.replace(/\.r\d+$/, "")) ?? []), s]);
	return [...groups].map(([split, runs]) => {
		const flags = { intro: 0, hedges: 0, unsourced: 0 };
		for (const t of turns.find((x) => x.id === split)?.turns ?? []) for (const k of Object.keys(flags) as (keyof typeof flags)[]) flags[k] += t.flags[k];
		return {
			split,
			runs: runs.length,
			pass: runs.filter((r) => r.verdict === "PASS").length,
			flags,
			contradicted: runs.reduce((sum, r) => sum + (r.contradicted ?? 0), 0),
			meanSeconds: round(runs.reduce((sum, r) => sum + r.seconds, 0) / runs.length, 1),
			meanUsd: round(runs.reduce((sum, r) => sum + r.totalUsd, 0) / runs.length, 4),
		};
	});
}

export function splitLine(was: SplitSummary | undefined, now: SplitSummary): string {
	const vs = (b: number | undefined, places: number) => (b === undefined ? "" : ` (was ${b.toFixed(places)})`);
	return `${now.split}: ${now.pass}/${now.runs} pass${was ? ` (was ${was.pass}/${was.runs})` : ""}, flags ${now.flags.intro}/${now.flags.hedges}/${now.flags.unsourced}${was ? ` (was ${was.flags.intro}/${was.flags.hedges}/${was.flags.unsourced})` : ""}, contradicted ${now.contradicted}${was ? ` (was ${was.contradicted})` : ""}, $${now.meanUsd.toFixed(4)}/run${vs(was?.meanUsd, 4)}, ${now.meanSeconds}s/run${vs(was?.meanSeconds, 1)}`;
}
