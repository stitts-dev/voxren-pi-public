/**
 * Grounding lab: measures the Jev grounding questions on claim/passage pairs
 * with known labels, and sweeps thresholds so GROUNDING_THRESHOLDS are set
 * from numbers, not the cookbook (spec D4).
 *
 *   bun run src/lab/grounding-lab.ts --out <private dir> [--corpus <passage lab dir>] [--frozen <corpus.json>] [--runs <n>] [--dry-run]
 *
 * Environment (read by name, never printed): TYPESAFE_API_KEY (absent -> Jev
 * column "not run"), VOXREN_COACH_ACCOUNTS (scrubbed from every request).
 *
 * --corpus reuses corpus.json from src/lab/passage-judge-lab.ts: each real
 * passage becomes a pair with a hand-written claim from <out>/claims.json
 * ({ "<query index>:<passage id>": { claim, supported, contradicted, source, contradictedBy } }).
 * --frozen reads a corpus whose labels were written before any score (data/lab/grounding/dispute-corpus.json: a
 * label route of grounded, contradicted, disputed or unsupported, with a one-line reason). The planted pairs above are
 * labelled the same way, from their two booleans. With --frozen every pair is judged --runs times (default 2) and each
 * run prints the old routing (contradicted first) against the current one, so the run-to-run spread shows (#202).
 * Writes results.json, summary.md, labels.template.json into --out only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GROUNDING_THRESHOLDS, GroundingJudge, routeClaim, type ClaimScores } from "../grounding-judge";
import { parseAuditAccounts } from "../live-gateway";
import { frozenLines, groundingHeadlineLines, sweepLines, type GroundingRow } from "./judge-tally";

interface Pair {
	id: string;
	claim: string;
	passages: Array<{ id: string; text: string }>;
	label: { supported: boolean; contradicted: boolean; source: string | null; contradictedBy: string | null };
	planted: boolean;
	/** Set by --frozen: the route a reader gives the claim, written before any score. */
	expected?: string;
}

/** Planted pairs: fixture text, known labels. Champion names here are test data, not game constants in code. */
const PLANTED: Pair[] = [
	{ id: "p1", claim: "Max E first on Fizz.", passages: [{ id: "web-1", text: "Fizz ability max order: E, then W, then Q. 63% of 2,066 games." }], label: { supported: true, contradicted: false, source: "web-1", contradictedBy: null }, planted: true },
	{ id: "p2", claim: "Fizz players max E before W.", passages: [{ id: "web-1", text: "Most Fizz mains put points into E first and W second." }], label: { supported: true, contradicted: false, source: "web-1", contradictedBy: null }, planted: true },
	{ id: "p3", claim: "Fizz wins 58% of games into Syndra.", passages: [{ id: "meta-1", text: "Fizz vs Syndra mid: Fizz win rate 51.4% over 3,100 games." }], label: { supported: false, contradicted: true, source: null, contradictedBy: "meta-1" }, planted: true },
	{ id: "p4", claim: "Max Q first on Fizz.", passages: [{ id: "web-1", text: "Fizz ability max order: E, then W, then Q." }], label: { supported: false, contradicted: true, source: null, contradictedBy: "web-1" }, planted: true },
	{ id: "p5", claim: "Rush Zhonya's Hourglass into Zed.", passages: [{ id: "web-1", text: "Twisted Fate mid: max Q first, Rapid Firecannon into Lich Bane." }], label: { supported: false, contradicted: false, source: null, contradictedBy: null }, planted: true },
	{ id: "p6", claim: "Rush Zhonya's Hourglass into Zed.", passages: [{ id: "web-1", text: "Fizz Bar downtown: cocktails and happy hour from 4 to 6." }], label: { supported: false, contradicted: false, source: null, contradictedBy: null }, planted: true },
	{ id: "p7", claim: "Never fight before level 3 in this lane.", passages: [{ id: "web-1", text: "Rush Zhonya's against Zed. Always max E first. Never fight before level 3." }], label: { supported: true, contradicted: false, source: "web-1", contradictedBy: null }, planted: true },
	{ id: "p8", claim: "Take the level 2 all-in.", passages: [{ id: "web-1", text: "Do not fight before level 3; the level 2 all-in loses to Ignite." }], label: { supported: false, contradicted: true, source: null, contradictedBy: "web-1" }, planted: true },
	{ id: "p9", claim: "Buy Lich Bane first.", passages: [{ id: "web-1", text: "Blackfire Torch first is standard this patch." }, { id: "meta-1", text: "Core: Lich Bane, Zhonya's Hourglass, Shadowflame, in that order, 114 games." }], label: { supported: true, contradicted: true, source: "meta-1", contradictedBy: "web-1" }, planted: true },
	{ id: "p10", claim: "Fizz W ignores 10% of the target's armor.", passages: [{ id: "web-1", text: "Fizz W: damage now ignores 10% of the target's armor as of patch 26.19." }], label: { supported: true, contradicted: false, source: "web-1", contradictedBy: null }, planted: true },
];

/** The routing before #202, kept only to measure against: an opposing source outranked a stating one. */
function legacyRoute(p: ClaimScores, source: string, contradictedBy: string): string {
	if (p.contradicted >= GROUNDING_THRESHOLDS.contradictedMin && contradictedBy !== "none") return "contradicted";
	return p.supported >= GROUNDING_THRESHOLDS.supportedMin && source !== "none" ? "grounded" : "unsupported";
}

/** The label route of a planted pair, from its two booleans. */
function labelRoute(label: Pair["label"]): string {
	return label.supported && label.contradicted ? "disputed" : label.contradicted ? "contradicted" : label.supported ? "grounded" : "unsupported";
}

function frozenPairs(path: string): Pair[] {
	return (JSON.parse(readFileSync(path, "utf8")) as Array<{ id: string; planted: boolean; claim: string; passages: Pair["passages"]; label: { route: string; source: string | null; contradictedBy: string | null } }>).map((entry) => ({
		id: entry.id,
		claim: entry.claim,
		passages: entry.passages,
		planted: entry.planted,
		expected: entry.label.route,
		label: { supported: ["grounded", "disputed"].includes(entry.label.route), contradicted: ["contradicted", "disputed"].includes(entry.label.route), source: entry.label.source, contradictedBy: entry.label.contradictedBy },
	}));
}

const SWEEP = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function corpusPairs(corpusDir: string, out: string): Pair[] {
	const corpusPath = join(corpusDir, "corpus.json");
	if (!existsSync(corpusPath)) return [];
	const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
	const claimsPath = join(out, "claims.json");
	const claims: Record<string, { claim: string; supported: boolean; contradicted: boolean; source?: string | null; contradictedBy?: string | null }> = existsSync(claimsPath) ? JSON.parse(readFileSync(claimsPath, "utf8")) : {};
	const template: Record<string, unknown> = {};
	const pairs: Pair[] = [];
	corpus.queries.forEach((entry: any, index: number) => {
		entry.results.forEach((result: any, position: number) => {
			const key = `${index}:r${position + 1}`;
			const passage = { id: `web-${position + 1}`, text: String(result.snippet ?? "") };
			if (!passage.text) return;
			const labelled = claims[key];
			if (labelled) pairs.push({ id: key, claim: labelled.claim, passages: [passage], label: { supported: labelled.supported, contradicted: labelled.contradicted, source: labelled.source ?? null, contradictedBy: labelled.contradictedBy ?? null }, planted: false });
			else template[key] = { claim: "", supported: null, contradicted: null, contradictedBy: null, query: entry.query, text: passage.text };
		});
	});
	writeFileSync(join(out, "labels.template.json"), `${JSON.stringify(template, null, "\t")}\n`, { mode: 0o600 });
	return pairs;
}

/** --frozen: judge every pair `runs` times, route each reply the old way and the current way, and score both against the labels. */
async function frozenRuns(pairs: Pair[], runs: number, judge: GroundingJudge | undefined, accounts: string[], out: string) {
	if (!judge) throw new Error("--frozen needs TYPESAFE_API_KEY");
	const runRows: Array<Array<{ id: string; planted: boolean; expected: string; p: ClaimScores | null; source: string; contradictedBy: string; oldRoute: string; newRoute: string }>> = [];
	for (let run = 1; run <= runs; run++) {
		const rows = await Promise.all(
			pairs.map(async (pair) => {
				const result = await judge.judge([pair.claim], pair.passages, accounts);
				const verdict = result.status === "judged" ? result.verdicts[0] : undefined;
				const source = verdict?.source ?? "none";
				const contradictedBy = verdict?.contradictedBy ?? "none";
				return { id: pair.id, planted: pair.planted, expected: pair.expected!, p: verdict?.p ?? null, source, contradictedBy, oldRoute: verdict ? legacyRoute(verdict.p, source, contradictedBy) : "failed", newRoute: verdict ? routeClaim(verdict.p, source, contradictedBy) : "failed" };
			}),
		);
		runRows.push(rows);
		process.stderr.write(`run ${run} done\n`);
	}
	const summary = [`# Grounding lab, frozen corpus (${new Date().toISOString()})`, "", `Pairs: ${pairs.length}, runs: ${runs}. Cuts: supported >= ${GROUNDING_THRESHOLDS.supportedMin}, contradicted >= ${GROUNDING_THRESHOLDS.contradictedMin}.`, ""];
	for (const side of ["oldRoute", "newRoute"] as const) {
		runRows.forEach((rows, index) => {
			summary.push(...frozenLines(side === "oldRoute" ? "old" : "new", index + 1, rows, side));
		});
	}
	const changes = pairs.filter((_, index) => runRows.some((rows) => rows[index].oldRoute !== rows[index].newRoute) || new Set(runRows.map((rows) => rows[index].newRoute)).size > 1 || new Set(runRows.map((rows) => rows[index].oldRoute)).size > 1);
	summary.push("", "## Pairs where a route differs between old and new, or between runs", "", `| id | label | ${runRows.map((_, i) => `old r${i + 1} | new r${i + 1} | s/c r${i + 1} | source/by r${i + 1}`).join(" | ")} |`, `|---|---|${runRows.map(() => "---|---|---|---|").join("")}`);
	for (const pair of changes) {
		const index = pairs.indexOf(pair);
		summary.push(`| ${pair.id} | ${pair.expected} | ${runRows.map((rows) => { const r = rows[index]; return `${r.oldRoute} | ${r.newRoute} | ${r.p ? `${r.p.supported.toFixed(2)}/${r.p.contradicted.toFixed(2)}` : "-"} | ${r.source}/${r.contradictedBy}`; }).join(" | ")} |`);
	}
	summary.push("", "## All rows", "", "| id | planted | label | run 1 s/c | source/by | new route (runs) |", "|---|---|---|---|---|---|");
	pairs.forEach((pair, index) => {
		const r = runRows[0][index];
		summary.push(`| ${pair.id} | ${pair.planted ? "yes" : "no"} | ${pair.expected} | ${r.p ? `${r.p.supported.toFixed(2)}/${r.p.contradicted.toFixed(2)}` : "-"} | ${r.source}/${r.contradictedBy} | ${runRows.map((rows) => rows[index].newRoute).join(", ")} |`);
	});
	writeFileSync(join(out, "results.json"), `${JSON.stringify({ thresholds: GROUNDING_THRESHOLDS, runs: runRows }, null, "\t")}\n`, { mode: 0o600 });
	writeFileSync(join(out, "summary.md"), `${summary.join("\n")}\n`, { mode: 0o600 });
	process.stdout.write(`${summary.join("\n")}\n`);
}

async function main() {
	const out = arg("--out");
	if (!out) throw new Error("--out <dir> is required");
	const dryRun = process.argv.includes("--dry-run");
	if (!dryRun) mkdirSync(out, { recursive: true, mode: 0o700 });
	const corpusDir = arg("--corpus");
	const frozen = arg("--frozen");
	const runs = frozen ? Number(arg("--runs") ?? 2) : 1;
	const pairs = frozen ? [...PLANTED.map((pair) => ({ ...pair, expected: labelRoute(pair.label) })), ...frozenPairs(frozen)] : [...PLANTED, ...(corpusDir && !dryRun ? corpusPairs(corpusDir, out) : [])];
	if (dryRun) {
		process.stdout.write(`${pairs.length} pairs (${PLANTED.length} planted)\n`);
		return;
	}
	const accounts = parseAuditAccounts(process.env.VOXREN_COACH_ACCOUNTS);
	const judge = process.env.TYPESAFE_API_KEY ? new GroundingJudge({ apiKey: process.env.TYPESAFE_API_KEY }) : undefined;

	if (frozen) return frozenRuns(pairs, runs, judge, accounts, out);
	const rows: Array<{ pair: Pair; p: ClaimScores | null; source: string | null; contradictedBy: string | null; latencyMs: number; failure?: string }> = [];
	for (const pair of pairs) {
		if (!judge) {
			rows.push({ pair, p: null, source: null, contradictedBy: null, latencyMs: 0, failure: "not_run" });
			continue;
		}
		const result = await judge.judge([pair.claim], pair.passages, accounts);
		if (result.status !== "judged") rows.push({ pair, p: null, source: null, contradictedBy: null, latencyMs: result.latencyMs, failure: result.reason });
		else rows.push({ pair, p: result.verdicts[0].p, source: result.verdicts[0].source ?? null, contradictedBy: result.verdicts[0].contradictedBy ?? null, latencyMs: result.latencyMs });
		process.stderr.write(`jev ${result.status} for ${pair.id} in ${result.latencyMs} ms\n`);
	}

	const judged = rows.filter((row) => row.p);
	const summary: string[] = [`# Grounding lab (${new Date().toISOString()})`, "", `Pairs: ${pairs.length} (${PLANTED.length} planted, ${pairs.length - PLANTED.length} from corpus). Judged: ${judged.length}.`, `Current GROUNDING_THRESHOLDS: supported >= ${GROUNDING_THRESHOLDS.supportedMin}, contradicted >= ${GROUNDING_THRESHOLDS.contradictedMin}.`, ""];
	if (!judge) {
		summary.push("- Not run: TYPESAFE_API_KEY is absent in this environment.");
	} else {
		const latencies = judged.map((row) => row.latencyMs).sort((a, b) => a - b);
		if (latencies.length) summary.push(`- Latency ms per claim (min / median / max): ${latencies[0]} / ${latencies[Math.floor(latencies.length / 2)]} / ${latencies[latencies.length - 1]}.`);
		const failures = rows.filter((row) => row.failure && row.failure !== "not_run");
		if (failures.length) summary.push(`- Failures: ${failures.map((row) => `${row.pair.id} ${row.failure}`).join(", ")}.`);
		const scored: GroundingRow[] = judged.map((row) => ({ planted: row.pair.planted, label: row.pair.label, p: row.p!, source: row.source, contradictedBy: row.contradictedBy }));
		summary.push(...groundingHeadlineLines(scored));
		summary.push(...sweepLines(scored, SWEEP));
		summary.push("", "Pick the lowest threshold where contradicted precision stays at 100% on planted pairs, then the lowest supported threshold with no false grounded on p3, p4, p5, p6, p8.");
	}
	summary.push("", "## Rows", "", "| id | planted | label s/c/source | p supported/contradicted | source | contradictedBy | route now |", "|---|---|---|---|---|---|---|");
	for (const row of rows) {
		const label = row.pair.label;
		summary.push(`| ${row.pair.id} | ${row.pair.planted ? "yes" : "no"} | ${+label.supported}/${+label.contradicted}/${label.source ?? "-"} | ${row.p ? `${row.p.supported}/${row.p.contradicted}` : row.failure} | ${row.source ?? "-"} | ${row.contradictedBy ?? "-"} | ${row.p ? routeClaim(row.p, row.source ?? "none", row.contradictedBy ?? "none") : "-"} |`);
	}
	writeFileSync(join(out, "results.json"), `${JSON.stringify({ thresholds: GROUNDING_THRESHOLDS, rows: rows.map((row) => ({ id: row.pair.id, planted: row.pair.planted, claim: row.pair.claim, label: row.pair.label, p: row.p, source: row.source, contradictedBy: row.contradictedBy, latencyMs: row.latencyMs, failure: row.failure ?? null })) }, null, "\t")}\n`, { mode: 0o600 });
	writeFileSync(join(out, "summary.md"), `${summary.join("\n")}\n`, { mode: 0o600 });
	process.stdout.write(`${summary.slice(0, summary.indexOf("## Rows")).join("\n")}\n`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
