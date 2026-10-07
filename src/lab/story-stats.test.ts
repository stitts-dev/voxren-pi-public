import { describe, expect, test } from "bun:test";
import { answerRow, answerStats, claimCounts, compareStats, compareTurns, NOISE_FLOOR, splitSummaries, turnCompareHeading, turnCompareLine, unverifiedNote, wordDiff, type StoryTurns, groundingSummary, inputTokensIn, JEV_USD_PER_INPUT_TOKEN, jevMs, runSummary, storyStats, withDoctrine, withJudgeCosts, type StoryStats } from "./story-stats.ts";
import { summarizeDoctrine } from "./answer-rubric.ts";
import type { Run } from "./stories.ts";

const run = (ms: number, costUsd: number, tools: Run["tools"]): Run => ({ ms, model: { id: "m1" }, usage: { input: 100, output: 10, costUsd, turns: 2 }, tools });

describe("storyStats", () => {
	test("sums the exchange log and names the slowest tool", () => {
		const stats = storyStats("a", "PASS", 12.34, [run(5000, 0.01, [{ name: "x", ok: true, ms: 400 }]), run(2500, 0.02, [{ name: "y", ok: true, ms: 900 }])], "");
		expect(stats).toMatchObject({ seconds: 12.3, modelSeconds: 7.5, costUsd: 0.03, inputTokens: 200, outputTokens: 20, turns: 4, model: "m1", slowestTool: { name: "y", ms: 900 } });
	});
	test("a story with no model run has zeros", () => {
		expect(storyStats("a", "PASS", 1, [], "")).toMatchObject({ costUsd: 0, modelSeconds: 0, turns: 0, model: "" });
	});
	test("jevMs adds the timings of card lines that name a Jev version", () => {
		expect(jevMs("  tip screened by jev-1.13.0 · usable · 295 ms\n  checked by jev-1.13.0 · 241 ms\nMETA ✓ 3.6s 400 ms")).toBe(536);
	});
});

describe("runSummary", () => {
	const stat = (id: string, seconds: number, costUsd: number, tool?: number): StoryStats => ({ id, verdict: "PASS", seconds, modelSeconds: 0, jevMs: 0, costUsd, jevInputTokens: 0, jevUsd: 0, noteUsd: 0, noteInputTokens: 0, noteOutputTokens: 0, totalUsd: costUsd, inputTokens: 0, outputTokens: 0, turns: 0, model: "", slowestTool: tool ? { name: `t${tool}`, ms: tool } : undefined });
	test("totals, speed-up, median, p90 and the three slowest tools", () => {
		const all = [stat("a", 10, 0.1, 500), stat("b", 20, 0.2, 900), stat("c", 30, 0.3, 100), stat("d", 40, 0, 700)];
		const summary = runSummary(all, 50);
		expect(summary).toMatchObject({ sumSeconds: 100, speedup: 2, costUsd: 0.6, medianSeconds: 20, p90Seconds: 40 });
		expect(summary.slowestTools.map((tool) => tool.ms)).toEqual([900, 700, 500]);
	});
});

describe("compareStats", () => {
	const stat = (seconds: number, costUsd: number, extra: Partial<StoryStats> = {}, id = "a"): StoryStats => ({ id, verdict: "PASS", seconds, modelSeconds: 0, jevMs: 0, costUsd, jevInputTokens: 0, jevUsd: 0, noteUsd: 0, noteInputTokens: 0, noteOutputTokens: 0, totalUsd: costUsd, inputTokens: 0, outputTokens: 0, turns: 0, model: "", ...extra });
	/** Repeats of one story: ids a.r1, a.r2, ... */
	const repeats = (make: (i: number) => StoryStats) => [0, 1, 2].map((i) => ({ ...make(i), id: `a.r${i + 1}` }));
	const logged = (input: number, cacheRead: number, costUsd: number) => stat(10, costUsd, { inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: 0 });

	test("a single run on either side is unverified, never flagged", () => {
		for (const [old, now] of [[[stat(10, 0.1)], [stat(30, 0.5)]], [repeats(() => stat(10, 0.1)), [stat(30, 0.5)]], [[stat(10, 0.1)], repeats(() => stat(30, 0.5))]]) {
			const result = compareStats(old, now);
			expect(result.flagged).toEqual([]);
			expect(result.unverified).toEqual(["a"]);
			expect(result.lines[0]).toContain("unverified (1 run)");
		}
	});
	test("a cache-warm run against a cache-cold run is not a regression: total tokens match", () => {
		// The #248 case: usage.input 294 against 10,022 and $0.005 against $0.023, the same 10k-token prompt.
		const warm = repeats((i) => logged(294 + i, 9_700, 0.005));
		const cold = repeats((i) => logged(10_000 + i, 0, 0.023));
		const result = compareStats(warm, cold);
		expect(result.flagged).toEqual([]);
		expect(result.lines[0]).toContain("model tokens");
		expect(result.lines[0]).not.toContain("OVER");
	});
	test("a real 2x cost on repeats is flagged", () => {
		const result = compareStats(repeats((i) => logged(1000 + i, 9000, 0.01)), repeats((i) => logged(2000 + i, 18000, 0.02)));
		expect(result.flagged).toEqual(["a"]);
		expect(result.lines[0]).toContain("OVER 25%: model tokens");
	});
	test("without cache numbers in the log, cost compares on costUsd and says so", () => {
		const result = compareStats(repeats((i) => stat(10, 0.01 + i * 0.0001)), repeats((i) => stat(10, 0.02 + i * 0.0001)));
		expect(result.flagged).toEqual(["a"]);
		expect(result.lines[0]).toContain("model USD");
		expect(result.lines[0]).toContain("no cache reads logged");
	});
	test("a change inside the baseline's own spread is noise, over 25% or not", () => {
		// baseline 10, 20, 30 s: median 20, MAD 10. 26 s is 30% over but 0.6x noise.
		const old = repeats((i) => stat(10 * (i + 1), 0.1));
		expect(compareStats(old, repeats(() => stat(26, 0.1))).flagged).toEqual([]);
		expect(compareStats(old, repeats(() => stat(45, 0.1))).flagged).toEqual(["a"]);
	});
	test("no change over 25%, no flag", () => {
		expect(compareStats(repeats(() => stat(10, 0.1)), repeats(() => stat(12.4, 0.1))).flagged).toEqual([]);
		expect(compareStats(repeats(() => stat(10, 0.1)), repeats(() => stat(12.6, 0.1))).flagged).toEqual(["a"]);
	});
	test("skips a story the old run lacks", () => {
		expect(compareStats([], [stat(10, 0.1)]).lines).toEqual([]);
	});
});

describe("judge costs", () => {
	test("sums every inputTokens in tool results, however deep", () => {
		expect(inputTokensIn([{ judgment: { inputTokens: 700 } }, { a: { b: [{ inputTokens: 300 }] }, inputTokens: "x" }, "text", null])).toBe(1000);
	});
	test("Jev dollars come from the published rate; the rubric call and the note add to the story", () => {
		const base = storyStats("a", "PASS", 1, [{ tools: [{ name: "x", ok: true, result: { judgment: { inputTokens: 1_000_000 } } }], usage: { input: 1, output: 1, costUsd: 0.01, turns: 1 } }], "");
		expect(base.jevUsd).toBeCloseTo(0.042, 6);
		const full = withJudgeCosts(base, { jevInputTokens: 1_000_000, noteUsd: 0.005, noteInputTokens: 900, noteOutputTokens: 40 });
		expect(full.jevInputTokens).toBe(2_000_000);
		expect(full.jevUsd).toBeCloseTo(2_000_000 * JEV_USD_PER_INPUT_TOKEN, 6);
		expect(full.totalUsd).toBeCloseTo(0.01 + 0.084 + 0.005, 4);
	});
	test("a compare flags a part that grew by more than 25% over repeats", () => {
		const make = (usd: number) => [1, 2].map((r) => ({ ...withJudgeCosts(storyStats("a", "PASS", 10, [], ""), { noteUsd: usd }), id: `a.r${r}` }));
		expect(compareStats(make(0.01), make(0.02)).flagged).toEqual(["a"]);
	});
	test("storyStats records cache tokens when the exchange log has them", () => {
		const cached = storyStats("a", "PASS", 1, [{ tools: [], usage: { input: 300, output: 10, costUsd: 0.01, turns: 1, cacheRead: 9000, cacheWrite: 700 } }], "");
		expect(cached).toMatchObject({ inputTokens: 300, cacheReadTokens: 9000, cacheWriteTokens: 700 });
		expect(storyStats("a", "PASS", 1, [run(1, 0.01, [])], "").cacheReadTokens).toBeUndefined();
	});
});

describe("groundingSummary", () => {
	test("reads the CHECK card's counts", () => {
		expect(groundingSummary("CHECK ✓ 0.3s 7 claims · 6 grounded · 1 contradicted")).toEqual({ grounded: 6, contradicted: 1 });
		expect(groundingSummary("CHECK ✓ 0.1s 8 claims · 8 grounded")).toEqual({ grounded: 8, contradicted: 0 });
		expect(groundingSummary("no card")).toBeUndefined();
	});
});

describe("compareTurns", () => {
	const turn = (qualities: (number | null)[], answer?: string, n = 1) => {
		const scored = qualities.filter((q): q is number => q !== null).sort((a, b) => a - b);
		const mid = scored.length >> 1;
		const medianQuality = scored.length ? (scored.length % 2 ? scored[mid] : (scored[mid - 1] + scored[mid]) / 2) : null;
		return { turn: n, qualities, medianQuality, flags: { intro: 0, hedges: 0, unsourced: 0 }, strictPass: null, answer };
	};
	const story = (...turns: ReturnType<typeof turn>[]): StoryTurns[] => [{ id: "s", repeats: ["s.r1"], turns }];
	const one = (old: StoryTurns[], now: StoryTurns[]) => compareTurns(old, now)[0];

	test("a change of 2x the noise or more is real: improved and regressed", () => {
		// baseline 2, 2.5, 3 -> median 2.5, MAD 0.5
		const base = story(turn([2, 2.5, 3]));
		expect(one(base, story(turn([4, 4, 4])))).toMatchObject({ verdict: "improved", change: 1.5, noise: 0.5, ratio: 3, confidence: "real" });
		expect(one(base, story(turn([1.5, 1.5, 1.5])))).toMatchObject({ verdict: "regressed", change: -1, confidence: "real" });
	});
	test("1x to 2x the noise is marginal, still with a direction", () => {
		const base = story(turn([2, 2.5, 3]));
		expect(one(base, story(turn([3.5, 3.5, 3.5])))).toMatchObject({ verdict: "improved", ratio: 2, confidence: "real" });
		expect(one(base, story(turn([3.25, 3.25, 3.25])))).toMatchObject({ verdict: "improved", ratio: 1.5, confidence: "marginal" });
	});
	test("under 1x the noise is unchanged", () => {
		const base = story(turn([2, 3, 4]));
		expect(one(base, story(turn([3.5, 3.5, 3.5])))).toMatchObject({ verdict: "unchanged", confidence: "noise" });
	});
	test("zero noise: no change is unchanged, any change is marginal (spread unmeasured), never real", () => {
		const base = story(turn([3, 3, 3]));
		expect(one(base, story(turn([3, 3, 3])))).toMatchObject({ verdict: "unchanged", ratio: 0 });
		expect(one(base, story(turn([3.5, 3.5, 3.5])))).toMatchObject({ verdict: "improved", ratio: Infinity, confidence: "unmeasured" });
		expect(turnCompareLine(one(base, story(turn([2, 2, 2]))))).toContain("zero noise, marginal");
	});
	test("an exact 2x change is real whatever the float error: the noise is rounded like the change", () => {
		// baseline 1, 1.3, 1.6: median 1.3, MAD 0.30000000000000004. 1.9 is 0.6 over, exactly 2x, and read 1.9999999999999996x unrounded.
		expect(one(story(turn([1, 1.3, 1.6])), story(turn([1.9, 1.9, 1.9])))).toMatchObject({ verdict: "improved", change: 0.6, noise: 0.3, ratio: 2, confidence: "real" });
	});
	test("a baseline spread under the floor counts as the floor, 0.25: a change under 0.5 is not real", () => {
		const base = story(turn([3, 3.1, 3.2])); // MAD 0.1
		expect(one(base, story(turn([3.6, 3.6, 3.6])))).toMatchObject({ verdict: "improved", change: 0.5, noise: 0.25, ratio: 2, confidence: "real" });
		expect(one(base, story(turn([3.5, 3.5, 3.5])))).toMatchObject({ verdict: "improved", change: 0.4, noise: 0.25, confidence: "marginal" });
		expect(one(base, story(turn([3.3, 3.3, 3.3])))).toMatchObject({ verdict: "unchanged", change: 0.2, confidence: "noise" });
		// The #439 example: baseline 1, 1.1, 1.3 (MAD 0.1) against 1.3 is 0.2, which is under the floor, not 2x anything.
		expect(one(story(turn([1, 1.1, 1.3])), story(turn([1.3, 1.3, 1.3])))).toMatchObject({ verdict: "unchanged", change: 0.2, noise: 0.25 });
	});
	test("a spread over the floor is used as it is", () => {
		expect(one(story(turn([2, 2.5, 3])), story(turn([3, 3, 3])))).toMatchObject({ change: 0.5, noise: 0.5, ratio: 1, confidence: "marginal" });
	});
	test("one scored repeat on the new side is unverified, never rated: it keeps the change and the diff", () => {
		const base = story(turn([2, 2.5, 3], "Take Flash"));
		for (const qualities of [[4], [4, null]]) {
			const row = one(base, story(turn(qualities, "Take Ignite")));
			expect(row).toMatchObject({ verdict: "unverified", change: 1.5, newRepeats: 1, diff: "Take [-Flash-] {+Ignite+}" });
			expect(row.confidence).toBeUndefined();
			expect(row.ratio).toBeUndefined();
			const line = turnCompareLine(row);
			expect(line).toContain("unverified (1 run)");
			expect(line).toContain("median +1.5");
			expect(line).toContain("Take [-Flash-] {+Ignite+}");
			expect(line).toContain("1 repeat cannot be flagged");
			expect(line).toContain("2 or more");
			expect(line).not.toContain("real");
		}
		expect(one(base, story(turn([4, 4])))).toMatchObject({ verdict: "improved", confidence: "real", newRepeats: 2 });
	});
	test("the report heading says the floor, that a MAD of 0 stays 0, and that 2 or more repeats are needed", () => {
		const heading = turnCompareHeading();
		expect(heading).toContain(`raised to ${NOISE_FLOOR} when under it`);
		expect(heading).toContain("a MAD of 0 stays 0 and a change on it reads marginal");
		expect(heading).toContain("1 repeat on the new side is unverified and not rated, 2 or more are needed");
	});
	test("the unverified note names each story and says flagging needs 2 or more repeats on each side, or is empty with none", () => {
		expect(unverifiedNote(["cmd-a", "cmd-b"])).toBe("; unverified (1 run, flagging needs 2 or more repeats on each side): cmd-a, cmd-b");
		expect(unverifiedNote([])).toBe("");
	});
	test("a baseline with fewer than two scored repeats has no noise figure", () => {
		const row = one(story(turn([3, null])), story(turn([4, 4])));
		expect(row).toMatchObject({ verdict: "improved", confidence: "unmeasured" });
		expect(row.noise).toBeUndefined();
	});
	test("unmatched turns and stories are new or gone, unscored turns say so", () => {
		const rows = compareTurns([...story(turn([3, 3], undefined, 1), turn([3, 3], undefined, 2)), { id: "old", repeats: [], turns: [turn([3, 3])] }], [...story(turn([3, 3], undefined, 1), turn([3, 3], undefined, 3)), { id: "fresh", repeats: [], turns: [turn([1, 1])] }]);
		const by = Object.fromEntries(rows.map((r) => [`${r.story}.${r.turn}`, r.verdict]));
		expect(by).toEqual({ "s.1": "unchanged", "s.2": "gone", "s.3": "new", "old.1": "gone", "fresh.1": "new" });
		expect(one(story(turn([null, null])), story(turn([3, 3])))).toMatchObject({ verdict: "unscored" });
	});
	test("carries a word diff of the answer", () => {
		const row = one(story(turn([2, 3, 4], "Take Flash and trade early")), story(turn([4, 4, 4], "Take Ignite and trade early")));
		expect(row.diff).toBe("Take [-Flash-] {+Ignite+} and trade early");
		expect(one(story(turn([3, 3], "same")), story(turn([3, 3], "same"))).diff).toBe("same answer");
	});
});

describe("wordDiff", () => {
	test("shortens a long unchanged run to its edges", () => {
		expect(wordDiff("a b c d e f g h i j", "a b c d e f g h i k")).toBe("a b ... h i [-j-] {+k+}");
	});
});

describe("splitSummaries", () => {
	test("folds repeats, counts passes, flags and contradicted claims, means cost and seconds", () => {
		const mk = (id: string, verdict: "PASS" | "FAIL", seconds: number, totalUsd: number, contradicted?: number): StoryStats => ({ id, verdict, seconds, modelSeconds: 0, jevMs: 0, costUsd: totalUsd, jevInputTokens: 0, jevUsd: 0, noteUsd: 0, noteInputTokens: 0, noteOutputTokens: 0, totalUsd, inputTokens: 0, outputTokens: 0, turns: 0, model: "", contradicted });
		const turns: StoryTurns[] = [{ id: "a", repeats: [], turns: [{ turn: 1, qualities: [], medianQuality: null, flags: { intro: 1, hedges: 0, unsourced: 2 }, strictPass: null }] }];
		const [a, b] = splitSummaries([mk("a.r1", "PASS", 10, 0.1, 1), mk("a.r2", "FAIL", 20, 0.2), mk("b", "PASS", 5, 0.05)], turns);
		expect(a).toEqual({ split: "a", runs: 2, pass: 1, flags: { intro: 1, hedges: 0, unsourced: 2 }, contradicted: 1, meanSeconds: 15, meanUsd: 0.15 });
		expect(b).toMatchObject({ split: "b", runs: 1, meanUsd: 0.05 });
	});
});

/** A voxren_strategy_frame tool result as exchanges.ndjson holds it: the gateway response under `response`, one route per claim. */
const frame = (routes: string[], inputTokens = 0): Run["tools"][number] => ({ name: "voxren_strategy_frame", ok: true, result: { operation: "strategy_frame", response: { data: { claims: routes.map((route) => ({ claim: "c", route })), judgment: { status: "judged", inputTokens } } } } });

describe("claimCounts", () => {
	test("counts the routes of every judged claim in the frame calls", () => {
		expect(claimCounts([frame(["grounded", "grounded", "unsupported", "contradicted", "disputed"])])).toEqual({ grounded: 2, unsupported: 1, contradicted: 1, disputed: 1 });
	});
	test("adds up two frames, and passes over other tools", () => {
		expect(claimCounts([frame(["grounded"]), { name: "voxren_game_facts", ok: true, result: { response: { data: { claims: [{ route: "contradicted" }] } } } }, frame(["unsupported", "grounded"])])).toEqual({ grounded: 2, unsupported: 1, contradicted: 0, disputed: 0 });
	});
	test("claims Jev never judged (no key, a timeout) are no counts, not zero counts", () => {
		expect(claimCounts([frame(["not_judged", "not_judged"])])).toBeUndefined();
		expect(claimCounts([frame(["not_judged", "grounded"])])).toEqual({ grounded: 1, unsupported: 0, contradicted: 0, disputed: 0 });
	});
	test("no frame call, a failed one, or a result with no claims list is undefined", () => {
		expect(claimCounts([])).toBeUndefined();
		expect(claimCounts([{ name: "voxren_strategy_frame", ok: false, result: "VALIDATION" }])).toBeUndefined();
		expect(claimCounts([{ name: "voxren_strategy_frame", ok: true, result: { response: { data: {} } } }])).toBeUndefined();
		expect(claimCounts([{ name: "voxren_strategy_frame", ok: true }])).toBeUndefined();
	});
});

describe("answerStats", () => {
	const logged = (usage: NonNullable<Run["usage"]>, tools: Run["tools"]): Run => ({ model: { id: "m1" }, usage, tools, answer: "a" });
	test("one row per model run: its claim counts, its tokens, its cost, the Jev tokens its tool calls spent", () => {
		const rows = answerStats([
			logged({ input: 100, output: 20, costUsd: 0.01, turns: 2 }, [frame(["grounded", "unsupported"], 700)]),
			logged({ input: 50, output: 9, costUsd: 0.004, turns: 1, cacheRead: 4000, cacheWrite: 10 }, [{ name: "voxren_game_facts", ok: true }]),
		]);
		expect(rows).toEqual([
			{ turn: 1, claims: { grounded: 1, unsupported: 1, contradicted: 0, disputed: 0 }, inputTokens: 100, outputTokens: 20, costUsd: 0.01, jevInputTokens: 700 },
			{ turn: 2, inputTokens: 50, outputTokens: 9, cacheReadTokens: 4000, costUsd: 0.004, jevInputTokens: 0 },
		]);
	});
	test("Jev tokens of an answer are the sum over every tool call that carries them, not the first one's", () => {
		const search: Run["tools"][number] = { name: "web_search", ok: true, result: { response: { data: { judgment: { inputTokens: 400 } } } } };
		const [row] = answerStats([logged({ input: 100, output: 20, costUsd: 0.01, turns: 2 }, [search, frame(["grounded"], 700), { name: "voxren_game_facts", ok: true }])]);
		expect(row.jevInputTokens).toBe(1100);
	});
	test("a run with no usage record counts zeros, and an empty log has no rows", () => {
		expect(answerStats([{ tools: [] }])).toEqual([{ turn: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, jevInputTokens: 0 }]);
		expect(answerStats([])).toEqual([]);
	});
	test("storyStats carries the rows beside its story totals", () => {
		const stats = storyStats("a", "PASS", 1, [logged({ input: 100, output: 20, costUsd: 0.01, turns: 2 }, [frame(["contradicted"], 300)])], "");
		expect(stats.answers).toEqual(answerStats([logged({ input: 100, output: 20, costUsd: 0.01, turns: 2 }, [frame(["contradicted"], 300)])]));
		expect(stats.jevInputTokens).toBe(300);
	});
});

describe("withDoctrine", () => {
	const answers = answerStats([{ tools: [] }, { tools: [] }]);
	test("puts each grade's summary on its own answer, and leaves an unscored one alone", () => {
		const grade = { followed: { names_tradeoff: 0.2, death_as_trade: 0.8 }, picked: { tier_fit: "gold_platinum" }, inputTokens: 640 };
		const rows = withDoctrine(answers, [null, grade]);
		expect(rows[0]).toEqual(answers[0]);
		expect(rows[1].doctrine).toEqual(summarizeDoctrine(grade));
		expect(rows[1].doctrine?.failed).toEqual([{ question: "names_tradeoff", followed: 0.2, rules: ["craft.give-up"] }]);
	});
	test("fewer grades than answers leaves the later answers unscored", () => {
		expect(withDoctrine(answers, []).every((row) => row.doctrine === undefined)).toBe(true);
	});
});

describe("answerRow", () => {
	test("a markdown row: claim counts, tokens, model and Jev cost, then the doctrine score with the rows to edit", () => {
		const grade = { followed: { names_tradeoff: 0.2, death_as_trade: 0.8 }, picked: { tier_fit: "gold_platinum" }, inputTokens: 640 };
		const [row] = withDoctrine([{ turn: 2, claims: { grounded: 3, unsupported: 1, contradicted: 0, disputed: 0 }, inputTokens: 1200, outputTokens: 80, cacheReadTokens: 5000, costUsd: 0.0123, jevInputTokens: 700 }], [grade]);
		expect(answerRow("fizz-mid", row)).toBe("| fizz-mid | 2 | 3/1/0 | 1200/80 (5000 cached) | $0.0123 | 700 + 640 | 0.5 | names_tradeoff 0.2 (craft.give-up) | tier_fit gold_platinum |");
	});
	test("disputed claims are named after the three counts, only when there are some", () => {
		const answer = { turn: 1, inputTokens: 10, outputTokens: 2, costUsd: 0, jevInputTokens: 0 };
		expect(answerRow("x", { ...answer, claims: { grounded: 6, unsupported: 0, contradicted: 0, disputed: 2 } })).toBe("| x | 1 | 6/0/0 (+2 disputed) | 10/2 | $0.0000 | 0 | - | - | - |");
		expect(answerRow("x", { ...answer, claims: { grounded: 6, unsupported: 0, contradicted: 0, disputed: 0 } })).toContain("| 6/0/0 |");
	});
	test("an answer with nothing judged shows dashes, never zeros", () => {
		expect(answerRow("x", { turn: 1, inputTokens: 10, outputTokens: 2, costUsd: 0, jevInputTokens: 0 })).toBe("| x | 1 | - | 10/2 | $0.0000 | 0 | - | - | - |");
	});
});
