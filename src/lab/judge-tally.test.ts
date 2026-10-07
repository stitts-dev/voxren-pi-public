import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLogSink } from "../coach-log";
import type { CommandRoute } from "../command-router";
import { ROUTE_SWITCH_P, routePrompt, type RouteInput, type RouteJudge } from "../model-router";
import { JudgeFailure, type AskResult } from "../systemone";
import {
	frozenCounts,
	frozenLines,
	groundingHeadlineLines,
	labRow,
	passageTallies,
	passageTallyLines,
	phaseAccuracyLines,
	recordProbabilities,
	routeRow,
	sweepLines,
	writeRouteRows,
	type FrozenRow,
	type LabRow,
	type GroundingRow,
	type PassageRow,
} from "./judge-tally";

setLogSink(() => {});

/** Real rows R1-R4 are scored; R5 has no label and R6 no Jev verdict, so neither counts. Planted rows P1, P2. Thresholds: relevant 0.45, support 0.55. */
const PASSAGES: PassageRow[] = [
	{ planted: false, label: { relevant: true, support: true }, jev: { p: { relevant: 0.9, support: 0.9 } } },
	{ planted: false, label: { relevant: true, support: false }, jev: { p: { relevant: 0.9, support: 0.8 } } },
	{ planted: false, label: { relevant: false, support: false }, jev: { p: { relevant: 0.1, support: 0.1 } } },
	{ planted: false, label: { relevant: true, support: true }, jev: { p: { relevant: 0.2, support: 0.2 } } },
	{ planted: false, label: null, jev: { p: { relevant: 0.9, support: 0.9 } } },
	{ planted: false, label: { relevant: false, support: false }, jev: null },
	{ planted: true, label: { relevant: true, support: false }, jev: { p: { relevant: 0.9, support: 0.9 } } },
	{ planted: true, label: { relevant: false, support: false }, jev: { p: { relevant: 0.9, support: 0.1 } } },
];

describe("passageTallies", () => {
	test("real, planted and combined are scored apart, on the rows that have both a label and a verdict", () => {
		const { combined, real, planted } = passageTallies(PASSAGES);
		expect(real.relevant).toEqual({ n: 4, tp: 2, fp: 0, fn: 1, tn: 1, precision: 1, recall: 2 / 3 });
		expect(real.support).toEqual({ n: 4, tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5 });
		expect(planted.relevant).toEqual({ n: 2, tp: 1, fp: 1, fn: 0, tn: 0, precision: 0.5, recall: 1 });
		expect(planted.support).toEqual({ n: 2, tp: 0, fp: 1, fn: 0, tn: 1, precision: 0, recall: null });
		expect(combined.relevant).toEqual({ n: 6, tp: 3, fp: 1, fn: 1, tn: 1, precision: 0.75, recall: 0.75 });
		expect(combined.support).toEqual({ n: 6, tp: 1, fp: 2, fn: 1, tn: 2, precision: 1 / 3, recall: 0.5 });
	});

	test("the combined lines read as before, with a real line and a planted line under each", () => {
		expect(passageTallyLines(PASSAGES)).toEqual([
			"- Relevance vs labels (6): precision 75%, recall 75%, false drops 1.",
			"  - real (4): precision 100%, recall 67%, false drops 1.",
			"  - planted (2): precision 50%, recall 100%, false drops 0.",
			"- Support vs labels (6): precision 33%, recall 50%.",
			"  - real (4): precision 50%, recall 50%.",
			"  - planted (2): precision 0%, recall n/a.",
		]);
	});

	test("with no planted rows the planted line is empty, not a crash", () => {
		const lines = passageTallyLines(PASSAGES.filter((row) => !row.planted));
		expect(lines[0]).toBe("- Relevance vs labels (4): precision 100%, recall 67%, false drops 1.");
		expect(lines[2]).toBe("  - planted (0): precision n/a, recall n/a, false drops 0.");
	});
});

/** Real: g1, g2. Planted: g3 (wrong source), g4 (a source where none exists), g5. */
const CLAIMS: GroundingRow[] = [
	{ planted: false, label: { supported: true, contradicted: false, source: "web-1", contradictedBy: null }, p: { supported: 0.9, contradicted: 0.1 }, source: "web-1", contradictedBy: null },
	{ planted: false, label: { supported: false, contradicted: true, source: null, contradictedBy: "web-1" }, p: { supported: 0.2, contradicted: 0.8 }, source: null, contradictedBy: "web-1" },
	{ planted: true, label: { supported: true, contradicted: false, source: "web-1", contradictedBy: null }, p: { supported: 0.8, contradicted: 0.1 }, source: "web-2", contradictedBy: null },
	{ planted: true, label: { supported: false, contradicted: false, source: null, contradictedBy: null }, p: { supported: 0.7, contradicted: 0.1 }, source: "web-1", contradictedBy: null },
	{ planted: true, label: { supported: false, contradicted: true, source: null, contradictedBy: "web-1" }, p: { supported: 0.1, contradicted: 0.9 }, source: null, contradictedBy: "web-1" },
];

describe("groundingHeadlineLines", () => {
	test("source and contradicting-source choice, combined as before, then real and planted", () => {
		expect(groundingHeadlineLines(CLAIMS)).toEqual([
			"- Source choice correct: 1 of 2 pairs with a labelled source; picked a source when none exists: 1.",
			"  - real claims: 1 of 1 pairs with a labelled source; picked a source when none exists: 0.",
			"  - planted claims: 0 of 1 pairs with a labelled source; picked a source when none exists: 1.",
			"- Contradicting-source choice correct: 2 of 2 pairs with a labelled contradicting source; picked one when none exists: 0.",
			"  - real claims: 1 of 1 pairs with a labelled contradicting source; picked one when none exists: 0.",
			"  - planted claims: 1 of 1 pairs with a labelled contradicting source; picked one when none exists: 0.",
		]);
	});
});

describe("sweepLines", () => {
	test("one table over all claims as before, then one over real claims and one over planted claims", () => {
		const header = ["| threshold | supported precision | supported recall | contradicted precision | contradicted recall |", "|---|---|---|---|---|"];
		expect(sweepLines(CLAIMS, [0.5])).toEqual([
			"",
			"## Threshold sweep",
			"",
			...header,
			"| 0.5 | 67% | 100% | 100% | 100% |",
			"",
			"### Real claims (2)",
			"",
			...header,
			"| 0.5 | 100% | 100% | 100% | 100% |",
			"",
			"### Planted claims (3)",
			"",
			...header,
			"| 0.5 | 50% | 100% | 100% | 100% |",
		]);
	});

	test("a set with no real claims says so instead of printing an empty table", () => {
		const lines = sweepLines(CLAIMS.filter((row) => row.planted), [0.5]);
		expect(lines).toContain("### Real claims (0)");
		expect(lines[lines.indexOf("### Real claims (0)") + 2]).toBe("None.");
	});
});

/** New route: f2, f3 and f4 are real misses (f4 a real false claim shown grounded), f6 and f7 planted misses. */
const FROZEN: FrozenRow[] = [
	{ planted: false, expected: "grounded", p: { supported: 0.9, contradicted: 0.1 }, source: "web-1", contradictedBy: "none", oldRoute: "grounded", newRoute: "grounded" },
	{ planted: false, expected: "unsupported", p: { supported: 0.7, contradicted: 0.8 }, source: "web-1", contradictedBy: "web-2", oldRoute: "contradicted", newRoute: "contradicted" },
	{ planted: false, expected: "disputed", p: { supported: 0.9, contradicted: 0.1 }, source: "web-1", contradictedBy: "none", oldRoute: "grounded", newRoute: "grounded" },
	{ planted: false, expected: "unsupported", p: { supported: 0.9, contradicted: 0.1 }, source: "web-1", contradictedBy: "none", oldRoute: "grounded", newRoute: "grounded" },
	{ planted: true, expected: "contradicted", p: { supported: 0.1, contradicted: 0.9 }, source: "none", contradictedBy: "web-1", oldRoute: "contradicted", newRoute: "contradicted" },
	{ planted: true, expected: "unsupported", p: { supported: 0.9, contradicted: 0.1 }, source: "web-1", contradictedBy: "none", oldRoute: "grounded", newRoute: "grounded" },
	{ planted: true, expected: "disputed", p: { supported: 0.9, contradicted: 0.1 }, source: "web-1", contradictedBy: "none", oldRoute: "grounded", newRoute: "grounded" },
	{ planted: true, expected: "grounded", p: { supported: 0.9, contradicted: 0.1 }, source: "web-1", contradictedBy: "none", oldRoute: "unsupported", newRoute: "grounded" },
];

describe("frozenCounts", () => {
	test("the headline counts are right for real, planted and combined", () => {
		const counts = frozenCounts(FROZEN, "newRoute");
		expect(counts.real).toEqual({ n: 4, right: 1, statedContradicted: 1, opposed: 0, opposedKept: 0, falseGrounded: 1, plantedFalseGrounded: 0, disputeShownGrounded: 1 });
		expect(counts.planted).toEqual({ n: 4, right: 2, statedContradicted: 0, opposed: 1, opposedKept: 1, falseGrounded: 1, plantedFalseGrounded: 1, disputeShownGrounded: 1 });
		expect(counts.combined).toEqual({ n: 8, right: 3, statedContradicted: 1, opposed: 1, opposedKept: 1, falseGrounded: 2, plantedFalseGrounded: 1, disputeShownGrounded: 2 });
	});

	test("the old route is counted on its own column", () => {
		const counts = frozenCounts(FROZEN, "oldRoute");
		expect([counts.real.right, counts.planted.right, counts.combined.right]).toEqual([1, 1, 2]);
	});
});

describe("frozenLines", () => {
	test("the combined line and its misroutes read as before, then a real line, which counts every false claim shown grounded, and a planted line", () => {
		expect(frozenLines("new", 1, FROZEN, "newRoute")).toEqual([
			"- new run 1: 3 of 8 match the label; stated >= 50% with a source and shown contradicted: 1; labelled contradicted kept contradicted: 1 of 1; planted false claims shown grounded: 1; labelled disputed shown grounded (the opposing passage not named): 2.",
			"  - unsupported -> contradicted x1, disputed -> grounded x2, unsupported -> grounded x2",
			"  - real claims: 1 of 4 match the label; stated >= 50% with a source and shown contradicted: 1; labelled contradicted kept contradicted: 0 of 0; false claims shown grounded: 1; labelled disputed shown grounded (the opposing passage not named): 1.",
			"  - planted claims: 2 of 4 match the label; stated >= 50% with a source and shown contradicted: 0; labelled contradicted kept contradicted: 1 of 1; planted false claims shown grounded: 1; labelled disputed shown grounded (the opposing passage not named): 1.",
		]);
	});
});

const BASE: RouteInput = { prompt: "how do i play fizz into syndra", pinned: false, accounts: [], current: { model: "gpt-6-sol", thinking: "medium" } };

/** A route judge that answers with the given probabilities, or throws the given failure. */
function judgeOf(answer: Record<string, number> | JudgeFailure): RouteJudge {
	return {
		model: "jev-latest",
		ask: async (): Promise<AskResult> => {
			if (answer instanceof JudgeFailure) throw answer;
			const choice = Object.entries(answer).sort((a, b) => b[1] - a[1])[0][0];
			return { judge: "jev", model: "jev-1", inputTokens: 10, answers: { route: { type: "choice", choice, probabilities: answer } } };
		},
	};
}

describe("route rows", () => {
	async function rowFor(label: "quick" | "standard" | "deep", answer: Record<string, number> | JudgeFailure) {
		const recorded = recordProbabilities(judgeOf(answer));
		const route = await routePrompt(BASE, recorded.judge);
		return routeRow(label, BASE.prompt, route, recorded.take());
	}

	test("a confident grade is a switch, with every tier's probability", async () => {
		expect(await rowFor("standard", { quick: 0.82, standard: 0.15, deep: 0.03 })).toEqual({ label: "standard", prompt: BASE.prompt, tier: "quick", p: { quick: 0.82, standard: 0.15, deep: 0.03 }, outcome: "switched", ms: expect.any(Number) });
	});

	test("an unsure grade is held, and a tier the reply leaves out reads 0", async () => {
		expect(await rowFor("quick", { quick: 0.55, standard: 0.4 })).toEqual({ label: "quick", prompt: BASE.prompt, tier: "quick", p: { quick: 0.55, standard: 0.4, deep: 0 }, outcome: "held", ms: expect.any(Number) });
	});

	test("a failed call is a fallback with no probabilities, and still has its time", async () => {
		expect(await rowFor("deep", new JudgeFailure("server"))).toEqual({ label: "deep", prompt: BASE.prompt, tier: "standard", p: null, outcome: "fallback", ms: expect.any(Number) });
	});

	/** A judge whose first reply is held until `release()` and whose second call fails. */
	function slowThenFailing() {
		let release!: () => void;
		let calls = 0;
		const judge: RouteJudge = {
			model: "jev-latest",
			ask: async () => {
				if (++calls === 1) await new Promise<void>((resolve) => (release = resolve));
				else throw new JudgeFailure("server");
				return { judge: "jev", model: "jev-1", inputTokens: 10, answers: { route: { type: "choice", choice: "quick", probabilities: { quick: 0.9, standard: 0.05, deep: 0.05 } } } };
			},
		};
		return { judge, release: () => release() };
	}
	const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

	test("a late reply from a call that timed out does not land on the next prompt", async () => {
		const slow = slowThenFailing();
		const recorded = recordProbabilities(slow.judge);
		const first = await routePrompt(BASE, recorded.judge, 20);
		expect(first.failure).toBe("timeout");
		expect(recorded.take()).toBeUndefined();
		const second = await routePrompt(BASE, recorded.judge, 20);
		expect(second.failure).toBe("server");
		slow.release();
		await settle();
		expect(recorded.take()).toBeUndefined();
	});

	test("a late reply that lands between two prompts is dropped when the next call starts, so a failed call has no probabilities", async () => {
		const slow = slowThenFailing();
		const recorded = recordProbabilities(slow.judge);
		const first = await routePrompt(BASE, recorded.judge, 20);
		expect(first.failure).toBe("timeout");
		expect(recorded.take()).toBeUndefined();
		slow.release();
		await settle();
		const second = await routePrompt(BASE, recorded.judge, 20);
		expect(second.failure).toBe("server");
		expect(routeRow("deep", BASE.prompt, second, recorded.take()).p).toBeNull();
	});

	test("the rows are written to results.json in the folder, with the switch cut, and the folder is created", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-route-rows-"));
		try {
			const rows = [{ label: "quick" as const, prompt: "what patch are we on", tier: "quick" as const, p: { quick: 1, standard: 0, deep: 0 }, outcome: "switched" as const, ms: 190 }];
			const target = join(dir, "nested", "run");
			const file = writeRouteRows(target, rows);
			expect(file).toBe(join(target, "results.json"));
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ thresholds: { switchP: ROUTE_SWITCH_P }, rows });
			if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("lab rows", () => {
	test("labRow reads the pick and the failures", () => {
		const entry = { phase: "lobby" as const, command: "review", label: "deep" as const };
		expect(labRow(entry, { command: "review", p: 0.9 }, { model: "m", thinking: "high", source: "jev", tier: "deep" })).toEqual({ phase: "lobby", command: "review", picked: "review", commandFailed: false, label: "deep", tier: "deep", tierFailed: false });
		const failed = labRow(entry, { failure: "timeout" } as CommandRoute, { model: "m", thinking: "medium", source: "fallback", tier: "standard" });
		expect(failed).toMatchObject({ picked: "none", commandFailed: true, tierFailed: true });
		expect(labRow(entry, { p: 0.4 }, { model: "m", thinking: "high", source: "jev", tier: "deep" })).toMatchObject({ picked: "none", commandFailed: false });
	});

	test("phaseAccuracyLines", () => {
		const base = { commandFailed: false, tierFailed: false };
		const rows: LabRow[] = [
			{ ...base, phase: "lobby", command: "review", picked: "review", label: "deep", tier: "deep" },
			{ ...base, phase: "lobby", command: "review", picked: "none", label: "quick", tier: "standard" },
			{ ...base, phase: "champSelect", command: "matchup", picked: "matchup", tierFailed: true, label: "standard", tier: "standard" },
			{ ...base, phase: "liveGame", command: "build", picked: "none", commandFailed: true, label: "quick", tier: "quick" },
		];
		expect(phaseAccuracyLines(rows)).toEqual([
			"| phase | prompts | command right | tier right | command calls failed | tier calls failed |",
			"|---|---|---|---|---|---|",
			"| lobby | 2 | 1 of 2 | 1 of 2 | 0 | 0 |",
			"| champSelect | 1 | 1 of 1 | 0 of 0 | 0 | 1 |",
			"| liveGame | 1 | 0 of 0 | 1 of 1 | 1 | 0 |",
			"| all | 4 | 2 of 3 | 2 of 3 | 1 | 1 |",
		]);
	});

	test("results.json carries the command rows only when given", () => {
		const dir = mkdtempSync(join(tmpdir(), "route-rows-"));
		try {
			const labRows: LabRow[] = [{ phase: "lobby", command: "review", picked: "review", commandFailed: false, label: "deep", tier: "deep", tierFailed: false }];
			expect(JSON.parse(readFileSync(writeRouteRows(dir, [], labRows), "utf8"))).toEqual({ thresholds: { switchP: ROUTE_SWITCH_P }, rows: [], commands: labRows });
			expect(JSON.parse(readFileSync(writeRouteRows(dir, []), "utf8"))).toEqual({ thresholds: { switchP: ROUTE_SWITCH_P }, rows: [] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
