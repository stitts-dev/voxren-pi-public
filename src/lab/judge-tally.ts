/**
 * The tallies and rows of the three judge labs (`route-lab.ts`, which also tallies command picks, `passage-judge-lab.ts`, `grounding-lab.ts`), as pure functions so a test can run them on fixed
 * rows. Real rows (drawn from live use) and planted rows (made up with a known answer) are always scored apart as well as together: a planted row is easy by
 * construction, so a combined number alone overstates how a judge does on real text.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRoute } from "../command-router";
import { COMMAND_PHASES, TIER_NAMES, type CommandPhase, type TierName } from "../contracts";
import { GROUNDING_THRESHOLDS, type ClaimScores } from "../grounding-judge";
import { ROUTE_SWITCH_P, type Route, type RouteJudge } from "../model-router";
import { PASSAGE_THRESHOLDS } from "../passage-judge";
import { choiceProbabilities } from "../systemone";

export function tally(rows: Array<{ predicted: boolean; actual: boolean }>) {
	const tp = rows.filter((row) => row.predicted && row.actual).length;
	const fp = rows.filter((row) => row.predicted && !row.actual).length;
	const fn = rows.filter((row) => !row.predicted && row.actual).length;
	const tn = rows.length - tp - fp - fn;
	return { n: rows.length, tp, fp, fn, tn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null };
}

export function pct(value: number | null): string {
	return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

export interface Split<T> {
	combined: T;
	real: T;
	planted: T;
}

/** Measures all rows, the real ones, and the planted ones. */
export function splitRows<R extends { planted: boolean }, T>(rows: R[], measure: (rows: R[]) => T): Split<T> {
	return { combined: measure(rows), real: measure(rows.filter((row) => !row.planted)), planted: measure(rows.filter((row) => row.planted)) };
}

// Passage lab

export interface PassageRow {
	planted: boolean;
	label: { relevant: boolean; support: boolean } | null;
	/** The route is the lab's own column, not read by a tally. */
	jev: { route?: string; p: { relevant: number; support: number } } | null;
}

/** Relevance and support against the labels, on the rows that have both a label and a Jev verdict, at the passage screen's own cuts. */
export function passageTallies(rows: PassageRow[]) {
	const scored = rows.filter((row): row is PassageRow & { label: NonNullable<PassageRow["label"]>; jev: NonNullable<PassageRow["jev"]> } => row.label !== null && row.jev !== null);
	return splitRows(scored, (part) => ({
		relevant: tally(part.map((row) => ({ predicted: row.jev.p.relevant >= PASSAGE_THRESHOLDS.relevantMin, actual: row.label.relevant }))),
		support: tally(part.map((row) => ({ predicted: row.jev.p.support >= PASSAGE_THRESHOLDS.supportMin, actual: row.label.support }))),
	}));
}

type PassageTally = ReturnType<typeof tally>;
const relevanceBody = (t: PassageTally) => `precision ${pct(t.precision)}, recall ${pct(t.recall)}, false drops ${t.fn}.`;
const supportBody = (t: PassageTally) => `precision ${pct(t.precision)}, recall ${pct(t.recall)}.`;

/** The two summary lines the lab always printed (all rows), each followed by a real line and a planted line. */
export function passageTallyLines(rows: PassageRow[]): string[] {
	const { combined, real, planted } = passageTallies(rows);
	return [
		`- Relevance vs labels (${combined.relevant.n}): ${relevanceBody(combined.relevant)}`,
		`  - real (${real.relevant.n}): ${relevanceBody(real.relevant)}`,
		`  - planted (${planted.relevant.n}): ${relevanceBody(planted.relevant)}`,
		`- Support vs labels (${combined.support.n}): ${supportBody(combined.support)}`,
		`  - real (${real.support.n}): ${supportBody(real.support)}`,
		`  - planted (${planted.support.n}): ${supportBody(planted.support)}`,
	];
}

// Grounding lab

export interface GroundingRow {
	planted: boolean;
	label: { supported: boolean; contradicted: boolean; source: string | null; contradictedBy: string | null };
	p: ClaimScores;
	source: string | null;
	contradictedBy: string | null;
}

function sourceChoice(rows: GroundingRow[]) {
	const withSource = rows.filter((row) => row.label.source !== null);
	const withOpposer = rows.filter((row) => row.label.contradictedBy !== null);
	return {
		source: { right: withSource.filter((row) => row.source === row.label.source).length, of: withSource.length, spurious: rows.filter((row) => row.label.source === null && row.source !== null).length },
		opposer: { right: withOpposer.filter((row) => row.contradictedBy === row.label.contradictedBy).length, of: withOpposer.length, spurious: rows.filter((row) => row.label.contradictedBy === null && row.contradictedBy !== null).length },
	};
}

/** The non-frozen headline: which passage the judge named as stating the claim and as opposing it, over all judged claims, then over real and planted. */
export function groundingHeadlineLines(rows: GroundingRow[]): string[] {
	const { combined, real, planted } = splitRows(rows, sourceChoice);
	const source = (c: typeof combined) => `${c.source.right} of ${c.source.of} pairs with a labelled source; picked a source when none exists: ${c.source.spurious}.`;
	const opposer = (c: typeof combined) => `${c.opposer.right} of ${c.opposer.of} pairs with a labelled contradicting source; picked one when none exists: ${c.opposer.spurious}.`;
	return [
		`- Source choice correct: ${source(combined)}`,
		`  - real claims: ${source(real)}`,
		`  - planted claims: ${source(planted)}`,
		`- Contradicting-source choice correct: ${opposer(combined)}`,
		`  - real claims: ${opposer(real)}`,
		`  - planted claims: ${opposer(planted)}`,
	];
}

const SWEEP_HEADER = ["| threshold | supported precision | supported recall | contradicted precision | contradicted recall |", "|---|---|---|---|---|"];

function sweepTable(rows: GroundingRow[], thresholds: readonly number[]): string[] {
	return [
		...SWEEP_HEADER,
		...thresholds.map((threshold) => {
			const s = tally(rows.map((row) => ({ predicted: row.p.supported >= threshold, actual: row.label.supported })));
			const c = tally(rows.map((row) => ({ predicted: row.p.contradicted >= threshold, actual: row.label.contradicted })));
			return `| ${threshold} | ${pct(s.precision)} | ${pct(s.recall)} | ${pct(c.precision)} | ${pct(c.recall)} |`;
		}),
	];
}

/** The threshold sweep over all judged claims as the lab always printed it, then the same table over the real claims and over the planted ones. */
export function sweepLines(rows: GroundingRow[], thresholds: readonly number[]): string[] {
	const { real, planted } = splitRows(rows, (part) => part);
	const section = (title: string, part: GroundingRow[]) => ["", `### ${title} (${part.length})`, "", ...(part.length ? sweepTable(part, thresholds) : ["None."])];
	return ["", "## Threshold sweep", "", ...sweepTable(rows, thresholds), ...section("Real claims", real), ...section("Planted claims", planted)];
}

export interface FrozenRow {
	planted: boolean;
	expected: string;
	p: ClaimScores | null;
	source: string;
	contradictedBy: string;
	oldRoute: string;
	newRoute: string;
}

type RouteColumn = "oldRoute" | "newRoute";

/** One run's headline counts for one routing, over any set of rows. `side` is the column that holds the route. */
function frozenCount(rows: FrozenRow[], side: RouteColumn) {
	const stated = rows.filter((row) => row.p && row.p.supported >= GROUNDING_THRESHOLDS.supportedMin && row.source !== "none");
	const opposed = rows.filter((row) => row.expected === "contradicted");
	const falseShownGrounded = rows.filter((row) => row[side] === "grounded" && ["contradicted", "unsupported"].includes(row.expected));
	return {
		n: rows.length,
		right: rows.filter((row) => row[side] === row.expected).length,
		statedContradicted: stated.filter((row) => row[side] === "contradicted").length,
		opposed: opposed.length,
		opposedKept: opposed.filter((row) => row[side] === "contradicted").length,
		falseGrounded: falseShownGrounded.length,
		plantedFalseGrounded: falseShownGrounded.filter((row) => row.planted).length,
		disputeShownGrounded: rows.filter((row) => row.expected === "disputed" && row[side] === "grounded").length,
	};
}

export function frozenCounts(rows: FrozenRow[], side: RouteColumn) {
	return splitRows(rows, (part) => frozenCount(part, side));
}

/** A run's summary under the frozen corpus: the combined line and its misroutes as the lab always printed them, then a real line and a planted line. */
export function frozenLines(name: "old" | "new", run: number, rows: FrozenRow[], side: RouteColumn): string[] {
	const { combined, real, planted } = frozenCounts(rows, side);
	// The combined and planted lines keep the planted-only count they always had; the real line counts every false claim, since it has no planted row to count.
	const body = (c: typeof combined, falseGrounded: string) =>
		`${c.right} of ${c.n} match the label; stated >= 50% with a source and shown contradicted: ${c.statedContradicted}; labelled contradicted kept contradicted: ${c.opposedKept} of ${c.opposed}; ${falseGrounded}; labelled disputed shown grounded (the opposing passage not named): ${c.disputeShownGrounded}.`;
	const plantedClause = (c: typeof combined) => `planted false claims shown grounded: ${c.plantedFalseGrounded}`;
	const confusion = new Map<string, number>();
	for (const row of rows) confusion.set(`${row.expected} -> ${row[side]}`, (confusion.get(`${row.expected} -> ${row[side]}`) ?? 0) + 1);
	return [
		`- ${name} run ${run}: ${body(combined, plantedClause(combined))}`,
		`  - ${[...confusion].filter(([key]) => key.split(" -> ")[0] !== key.split(" -> ")[1]).map(([key, count]) => `${key} x${count}`).join(", ") || "no misroutes"}`,
		`  - real claims: ${body(real, `false claims shown grounded: ${real.falseGrounded}`)}`,
		`  - planted claims: ${body(planted, plantedClause(planted))}`,
	];
}

// Route lab

export interface RouteRow {
	/** The tier the prompt was labelled with. */
	label: TierName;
	prompt: string;
	/** The tier the router ended on. */
	tier: TierName;
	/** Every tier's probability; null when Jev gave none (a failed call). */
	p: Record<TierName, number> | null;
	outcome: "switched" | "held" | "fallback";
	/** The Jev call's time; null when no call was made. */
	ms: number | null;
}

/** Wraps a route judge to keep the last reply's probability for every tier, which `Route` carries only for the winner. `take` returns it once, undefined after a failed call. */
export function recordProbabilities(judge: RouteJudge) {
	let last: Record<string, number> | undefined;
	let calls = 0;
	const recording: RouteJudge = {
		model: judge.model,
		ask: async (state, questions, signal) => {
			const mine = ++calls;
			last = undefined;
			const result = await judge.ask(state, questions, signal);
			// A reply that lands after its call timed out must not stand in for a later prompt's.
			if (mine === calls) last = choiceProbabilities(result.answers.route);
			return result;
		},
	};
	return {
		judge: recording,
		take() {
			const taken = last;
			last = undefined;
			return taken;
		},
	};
}

/** One prompt's row. The lab sets no command tier and no pin, so a route is a switch, a hold, or a fallback. */
export function routeRow(label: TierName, prompt: string, route: Route, probabilities: Record<string, number> | undefined): RouteRow {
	return {
		label,
		prompt,
		tier: route.tier ?? "standard",
		p: probabilities ? (Object.fromEntries(TIER_NAMES.map((tier) => [tier, probabilities[tier] ?? 0])) as Record<TierName, number>) : null,
		outcome: route.source === "jev" ? "switched" : route.source === "held" ? "held" : "fallback",
		ms: route.ms ?? null,
	};
}

export interface LabRow {
	phase: CommandPhase;
	command: string;
	picked: string;
	commandFailed: boolean;
	label: TierName;
	tier: TierName;
	tierFailed: boolean;
}

/** One prompt's command pick and tier grade side by side; a failed call is flagged so a tally can leave it out of its own count. */
export function labRow(entry: { phase: CommandPhase; command: string; label: TierName }, command: CommandRoute, route: Route): LabRow {
	return { phase: entry.phase, command: entry.command, picked: command.command ?? "none", commandFailed: command.failure !== undefined, label: entry.label, tier: route.tier ?? "standard", tierFailed: route.source === "fallback" };
}

/** A markdown table of command and tier accuracy per phase. A failed call is left out of its own count and shown apart. */
export function phaseAccuracyLines(rows: LabRow[]): string[] {
	const line = (name: string, part: LabRow[]) => {
		const commands = part.filter((row) => !row.commandFailed);
		const tiers = part.filter((row) => !row.tierFailed);
		const commandRight = commands.filter((row) => row.picked === row.command).length;
		const tierRight = tiers.filter((row) => row.tier === row.label).length;
		return `| ${name} | ${part.length} | ${commandRight} of ${commands.length} | ${tierRight} of ${tiers.length} | ${part.length - commands.length} | ${part.length - tiers.length} |`;
	};
	return [
		"| phase | prompts | command right | tier right | command calls failed | tier calls failed |",
		"|---|---|---|---|---|---|",
		...COMMAND_PHASES.map((phase) => line(phase, rows.filter((row) => row.phase === phase))),
		line("all", rows),
	];
}

/** Writes `results.json` into `dir` (made if missing) and returns its path. */
export function writeRouteRows(dir: string, rows: RouteRow[], commands?: LabRow[]): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, "results.json");
	writeFileSync(file, `${JSON.stringify({ thresholds: { switchP: ROUTE_SWITCH_P }, rows, ...(commands && { commands }) }, null, "\t")}\n`, { mode: 0o600 });
	return file;
}
