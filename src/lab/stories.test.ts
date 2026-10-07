import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { COACH_YAML } from "../contracts.ts";
import { checkAnswer } from "./answer-rubric.ts";
import { SystemOneClient } from "../systemone.ts";
import { answerNotFailures, filterBySplit, judge, storiesFor, toolFailures, KEY_BYTES, loadStories, RANK_TIERS, rubricFailure, validateStory, type Run, type Story } from "./stories.ts";

const story = (gates: Story["gates"] = {}, steps: Story["steps"] = [{ send: "/matchup Ahri" }, { idle: true }]): Story => ({ id: "t", title: "t", steps, gates });
const ok: Run[] = [{ command: "matchup", tools: [{ name: "voxren_meta_research", ok: true }], answer: "Trade: step in" }];
const gates = (failures: ReturnType<typeof judge>) => failures.map((failure) => failure.gate);

describe("judge", () => {
	test("passes a clean screen", () => {
		expect(judge(story({ expect: ["Trade"] }), "Trade: step in at 3\nBuy: Rod", ok, 100)).toEqual([]);
	});
	test("catches an HTML entity in a skill-order line (made-up screen)", () => {
		const failures = judge(story(), "Skills: Q &gt; E &gt; W", ok, 100);
		expect(gates(failures)).toEqual(["entity"]);
		expect(failures[0].detail).toContain("Q &gt; E &gt; W");
	});
	test("catches every entity form", () => {
		for (const text of ["a &lt; b", "a &amp; b", "&quot;x&quot;", "&#39;x"]) expect(gates(judge(story(), text, ok, 100))).toContain("entity");
	});
	test("catches raw escape text and control characters", () => {
		expect(gates(judge(story(), "row \\u001b[0m", ok, 100))).toEqual(["escape"]);
		expect(gates(judge(story(), "row \x07", ok, 100))).toEqual(["escape"]);
	});
	test("catches a line one column too wide", () => {
		expect(judge(story(), "x".repeat(100), ok, 100)).toEqual([]);
		const failures = judge(story(), `ok\n${"x".repeat(101)}`, ok, 100);
		expect(gates(failures)).toEqual(["width"]);
	});
	test("counts a wide character as two columns", () => {
		expect(gates(judge(story(), "漢".repeat(51), ok, 100))).toEqual(["width"]);
	});
	test("absentInAnswer reads the last run's answer only", () => {
		const runs = [{ tools: [], answer: "Katarina plan" }, { tools: [], answer: "Ahri patch" }] as Run[];
		expect(judge(story({ absentInAnswer: ["Katarina"] }), "Katarina", runs, 100)).toEqual([]);
		expect(gates(judge(story({ absentInAnswer: ["Ahri"] }), "", runs, 100))).toEqual(["absentInAnswer"]);
	});

	test("catches a missing expect and a present absent", () => {
		expect(gates(judge(story({ expect: ["Fights"], absent: ["Sure"] }), "Sure, here", ok, 100)).sort()).toEqual(["absent", "expect"]);
	});
	test("catches a failed tool, and allows it on an error-path story", () => {
		const failed: Run[] = [{ tools: [{ name: "voxren_meta_research", ok: false }] }];
		expect(gates(judge(story(), "x", failed, 100))).toEqual(["tool-failed"]);
		expect(judge(story({ allowFailedTools: true }), "x", failed, 100)).toEqual([]);
	});
	test("a failed call a later call to the same tool recovered does not fail the story", () => {
		const retried: Run[] = [{ tools: [{ name: "voxren_strategy_frame", ok: false }, { name: "voxren_game_facts", ok: true }, { name: "voxren_strategy_frame", ok: true }] }];
		expect(judge(story({ tools: ["voxren_strategy_frame"] }), "x", retried, 100)).toEqual([]);
		expect(toolFailures(retried)).toEqual({ failed: [], recovered: ["voxren_strategy_frame"] });
	});
	test("a failure after the last success, or with no success, still fails", () => {
		const after: Run[] = [{ tools: [{ name: "a", ok: true }, { name: "a", ok: false }] }];
		expect(gates(judge(story(), "x", after, 100))).toEqual(["tool-failed"]);
		const other: Run[] = [{ tools: [{ name: "a", ok: false }, { name: "b", ok: true }] }];
		expect(gates(judge(story({ tools: ["a"] }), "x", other, 100)).sort()).toEqual(["tool-failed", "tools"]);
	});
	test("catches a required tool that never ran", () => {
		expect(gates(judge(story({ tools: ["voxren_game_facts"] }), "x", ok, 100))).toEqual(["tools"]);
	});
	test("counts runs by command", () => {
		const auto: Run[] = Array.from({ length: 4 }, () => ({ command: "draft:auto", tools: [] }));
		expect(gates(judge(story({ runs: { command: "draft", min: 1, max: 3 } }), "x", auto, 100))).toEqual(["runs"]);
		expect(judge(story({ runs: { command: "draft", min: 1, max: 3 } }), "x", auto.slice(0, 2), 100)).toEqual([]);
	});
	test("a story that waited on a model turn needs a run in the log", () => {
		expect(gates(judge(story(), "x", [], 100))).toEqual(["turn"]);
	});
	test("a panel story with no model turn skips the model-turn gates but keeps the width gate", () => {
		const panel = story({}, [{ wait: "COMMAND TREE" }]);
		expect(judge(panel, "a &gt; b", [], 100)).toEqual([]);
		expect(gates(judge(panel, "x".repeat(101), [], 100))).toEqual(["width"]);
	});
});

describe("rubricFailure", () => {
	test("with no mark the score is report-only and never fails a story", () => {
		expect(rubricFailure(0, undefined)).toBeUndefined();
	});
	test("with a mark, a score under it fails and a score at it passes", () => {
		expect(rubricFailure(2.9, 3)?.gate).toBe("rubric");
		expect(rubricFailure(3, 3)).toBeUndefined();
	});
});

describe("story files", () => {
	const stories = loadStories(join(import.meta.dir, "..", "..", "data", "lab", "stories"));
	test("every file is valid and ids are unique", () => {
		expect(stories.length).toBeGreaterThanOrEqual(20);
		expect(new Set(stories.map((entry) => entry.id)).size).toBe(stories.length);
	});
	test("the validator names what is wrong", () => {
		expect(validateStory({ id: "x", title: "t", steps: [{ send: "a", key: "esc" }], gates: {} }, "x.json")[0]).toContain("exactly one");
		expect(validateStory({ id: "x", title: "t", steps: [{ key: "f5" }], gates: {} }, "x.json")[0]).toContain("key must be one of");
		expect(validateStory({ id: "y", title: "t", steps: [{ idle: true }], gates: {} }, "x.json")[0]).toContain("must match the file name");
		expect(validateStory({ id: "x", title: "t", steps: [{ idle: true }], gates: { maxSeconds: -1 }, extra: 1 }, "x.json").length).toBe(2);
	});
});

describe("split, tier, applies", () => {
	const raw = { id: "t", title: "t", steps: [{ send: "/x" }], gates: {} };
	test("a story with each field is valid, and one with none (a file from before) still is", () => {
		expect(validateStory({ ...raw, split: "holdout", tier: "gold", applies: ["names_tradeoff"] }, "t.json")).toEqual([]);
		expect(validateStory({ ...raw, split: "train" }, "t.json")).toEqual([]);
		expect(validateStory(raw, "t.json")).toEqual([]);
	});
	test("noJevKey is a boolean or absent", () => {
		expect(validateStory({ ...raw, noJevKey: true }, "t.json")).toEqual([]);
		expect(validateStory({ ...raw, noJevKey: "yes" }, "t.json")).toEqual(["t.json: noJevKey must be a boolean"]);
	});
	test("every rank in the ladder is a valid tier", () => {
		for (const tier of ["iron", "bronze", "silver", "gold", "platinum", "emerald", "diamond", "master", "grandmaster", "challenger"]) expect(validateStory({ ...raw, tier }, "t.json")).toEqual([]);
	});
	test("a bad split is rejected", () => {
		expect(validateStory({ ...raw, split: "dev" }, "t.json")).toEqual(["t.json: split must be train or holdout"]);
		expect(validateStory({ ...raw, split: "all" }, "t.json")).toHaveLength(1);
	});
	test("a bad tier is rejected", () => {
		expect(validateStory({ ...raw, tier: "Gold" }, "t.json")[0]).toContain("tier must be one of");
		expect(validateStory({ ...raw, tier: "wood" }, "t.json")).toHaveLength(1);
		expect(validateStory({ ...raw, tier: 3 }, "t.json")).toHaveLength(1);
	});
	test("a bad applies is rejected", () => {
		expect(validateStory({ ...raw, applies: "names_tradeoff" }, "t.json")).toEqual(["t.json: applies must be a list of non-empty strings"]);
		expect(validateStory({ ...raw, applies: [""] }, "t.json")).toHaveLength(1);
		expect(validateStory({ ...raw, applies: [3] }, "t.json")).toHaveLength(1);
	});
});

describe("filterBySplit", () => {
	const story = (id: string, split?: Story["split"]): Story => ({ id, title: id, steps: [{ send: "/x" }], gates: {}, ...(split && { split }) });
	const stories = [story("old"), story("a", "train"), story("b", "holdout")];
	const ids = (list: Story[]) => list.map((entry) => entry.id);
	test("train keeps the stories marked train and those with no split", () => {
		expect(ids(filterBySplit(stories, "train"))).toEqual(["old", "a"]);
	});
	test("holdout keeps only the stories marked holdout", () => {
		expect(ids(filterBySplit(stories, "holdout"))).toEqual(["b"]);
	});
	test("all keeps every story", () => {
		expect(ids(filterBySplit(stories, "all"))).toEqual(["old", "a", "b"]);
	});
	test("with no choice the split is train", () => {
		expect(ids(filterBySplit(stories))).toEqual(["old", "a"]);
	});
});

describe("storiesFor", () => {
	const story = (id: string, split?: Story["split"]): Story => ({ id, title: id, steps: [{ send: "/x" }], gates: {}, ...(split && { split }) });
	const stories = [story("old"), story("a", "train"), story("b", "holdout")];
	const ids = (list: Story[]) => list.map((entry) => entry.id);
	test("no --only and no --split gives train", () => {
		expect(ids(storiesFor(stories))).toEqual(["old", "a"]);
	});
	test("--split alone is the split, as filterBySplit", () => {
		expect(ids(storiesFor(stories, "holdout"))).toEqual(["b"]);
		expect(ids(storiesFor(stories, "all"))).toEqual(["old", "a", "b"]);
	});
	test("--only with no --split reaches a holdout story", () => {
		expect(ids(storiesFor(stories, undefined, ["b"]))).toEqual(["b"]);
		expect(ids(storiesFor(stories, undefined, ["old", "b"]))).toEqual(["old", "b"]);
	});
	test("--only with --split train refuses a holdout story", () => {
		expect(storiesFor(stories, "train", ["b"])).toEqual([]);
		expect(ids(storiesFor(stories, "train", ["a", "b"]))).toEqual(["a"]);
	});
	test("--only with --split holdout refuses a train story", () => {
		expect(storiesFor(stories, "holdout", ["a"])).toEqual([]);
	});
	test("--only names no story that exists: nothing", () => {
		expect(storiesFor(stories, undefined, ["nope"])).toEqual([]);
	});
});

describe("key steps", () => {
	test("ctrl+o is a valid key and types ^O", () => {
		expect(validateStory({ id: "x", title: "t", steps: [{ key: "ctrl+o" }], gates: {} }, "x.json")).toEqual([]);
		expect(KEY_BYTES["ctrl+o"]).toBe("\x0f");
	});
});

describe("answerNot", () => {
	test("a yes fails the story, a no passes, a missing answer fails", () => {
		expect(answerNotFailures(["lane"], { lane: 0.5 })[0].gate).toBe("answerNot");
		expect(answerNotFailures(["lane"], { lane: 0.49 })).toEqual([]);
		expect(answerNotFailures(["lane"], {})).toHaveLength(1);
	});
	test("story files accept answerNot lists only", () => {
		const raw = { id: "t", title: "t", steps: [{ send: "/x" }], gates: { answerNot: ["gives_lane_or_matchup_advice"] } };
		expect(validateStory(raw, "t.json")).toEqual([]);
		expect(validateStory({ ...raw, gates: { answerNot: "lane" } }, "t.json")).toHaveLength(1);
	});
	test("checkAnswer asks the coach.yaml question and reads Jev's noul, with a fake Jev", async () => {
		const asked: string[] = [];
		const fake = (noulValue: number) =>
			new SystemOneClient({
				apiKey: "k",
				fetchImpl: async (_url, init) => {
					asked.push(JSON.parse(String(init?.body)).questions.gives_lane_or_matchup_advice.instructions);
					return new Response(JSON.stringify({ model: "jev", usage: { input_tokens: 7 }, answers: { gives_lane_or_matchup_advice: { type: "noul", noul: noulValue } } }));
				},
			});
		const leak = await checkAnswer(fake(0.93), "Lane: trade after Charm", ["gives_lane_or_matchup_advice"]);
		const clean = await checkAnswer(fake(0.04), "Q is up 12 percent", ["gives_lane_or_matchup_advice"]);
		expect(answerNotFailures(["gives_lane_or_matchup_advice"], leak.noul)).toHaveLength(1);
		expect(answerNotFailures(["gives_lane_or_matchup_advice"], clean.noul)).toEqual([]);
		expect(asked[0]).toContain("lane or matchup advice");
	});
});

describe("applies names real doctrine questions", () => {
	const raw = { id: "t", title: "t", steps: [{ send: "/x" }], gates: {} };
	const questions = Object.keys(COACH_YAML.jev.doctrine);
	test("a name that is a jev.doctrine question in coach.yaml is valid, a choice question too", () => {
		expect(validateStory({ ...raw, applies: ["names_tradeoff", "tier_fit"] }, "t.json")).toEqual([]);
		expect(validateStory({ ...raw, applies: questions }, "t.json")).toEqual([]);
	});
	test("a name that is no jev.doctrine question fails, naming the file, the name and the questions that exist", () => {
		expect(validateStory({ ...raw, applies: ["names_tradeoff", "no_such_question"] }, "t.json")).toEqual([`t.json: applies names "no_such_question", which is no jev.doctrine question in coach.yaml (${questions.join(", ")})`]);
	});
	test("every unknown name is reported", () => {
		expect(validateStory({ ...raw, applies: ["a_b", "names_tradeoff", "c_d"] }, "t.json")).toHaveLength(2);
	});
	test("a rubric question is not a doctrine question", () => {
		expect(validateStory({ ...raw, applies: ["hedges"] }, "t.json")).toHaveLength(1);
		expect(validateStory({ ...raw, applies: ["gives_lane_or_matchup_advice"] }, "t.json")).toHaveLength(1);
	});
	test("the questions to check against can be given, so a new question needs no change here", () => {
		expect(validateStory({ ...raw, applies: ["brand_new"] }, "t.json", ["brand_new"])).toEqual([]);
		expect(validateStory({ ...raw, applies: ["names_tradeoff"] }, "t.json", ["brand_new"])).toHaveLength(1);
	});
	test("a malformed applies is reported once, not once per name", () => {
		expect(validateStory({ ...raw, applies: ["names_tradeoff", ""] }, "t.json")).toEqual(["t.json: applies must be a list of non-empty strings"]);
	});
	test("loadStories refuses a folder holding such a story, naming the file", () => {
		const dir = mkdtempSync(join(tmpdir(), "stories-applies-"));
		try {
			writeFileSync(join(dir, "t.json"), JSON.stringify({ ...raw, applies: ["no_such_question"] }));
			expect(() => loadStories(dir)).toThrow(/t\.json: applies names "no_such_question"/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the story set", () => {
	const root = join(import.meta.dir, "..", "..");
	const stories = loadStories(join(root, "data", "lab", "stories"));
	const sends = stories.flatMap((entry) => entry.steps.flatMap((step) => ("send" in step ? [step.send] : [])));
	test("every story that expects no key sets noJevKey", () => {
		expect(stories.filter((entry) => entry.gates.expect?.includes("no key") && entry.noJevKey !== true).map((entry) => entry.id)).toEqual([]);
	});
	test("every story names its split", () => {
		expect(stories.filter((entry) => entry.split === undefined).map((entry) => entry.id)).toEqual([]);
	});
	test("about forty stories, about three in four of them train", () => {
		expect(stories.length).toBeGreaterThanOrEqual(38);
		expect(stories.length).toBeLessThanOrEqual(44);
		const holdout = filterBySplit(stories, "holdout").length;
		expect(holdout).toBeGreaterThanOrEqual(9);
		expect(holdout).toBeLessThanOrEqual(12);
		expect(filterBySplit(stories, "train").length + holdout).toBe(stories.length);
	});
	test("every rank in the ladder is some story's tier", () => {
		expect(RANK_TIERS.filter((tier) => !stories.some((entry) => entry.tier === tier))).toEqual([]);
	});
	test("the five fixed rubric queries of 2026-09-27 are stories (issue #119)", () => {
		for (const query of ["/matchup Syndra", "/build Zed", "/patch", "how do I stop dying after 15 when ahead", "should I take Ignite or Teleport mid"]) expect(sends).toContain(query);
	});
	test("the six /comp scenarios recorded in #30 are stories that send /comp on their draft", () => {
		const replayed = stories.filter((entry) => entry.steps.some((step) => "send" in step && step.send === "/comp")).map((entry) => entry.replay);
		for (const file of ["s1-malz-velkoz-open-lanes.ndjson", "malz-velkoz-teemo.json", "s3-pyke-picks-early.ndjson", "pyke-picks.json", "s5-jayce-zyra-early-game.ndjson", "zed-support-dive.json"]) expect(replayed).toContain(`data/lab/drafts/${file}`);
	});
	test("at least five stories ask a follow-up question after a ctrl+o turn that came after a first answer", () => {
		const followsUp = (entry: Story) => {
			const at = entry.steps.findIndex((step) => "key" in step && step.key === "ctrl+o");
			return at > 0 && entry.steps.slice(0, at).some((step) => "send" in step) && entry.steps.slice(at).some((step) => "send" in step && !step.send.startsWith("/"));
		};
		expect(stories.filter(followsUp).length).toBeGreaterThanOrEqual(5);
	});
	test("every ctrl+o waits for Pi's own `Tool output: expanded` line, so the expansion is verified, not assumed", () => {
		const waitsAfter = (entry: Story, at: number) => {
			const next = entry.steps[at + 1];
			return next !== undefined && "wait" in next && next.wait === "Tool output: expanded";
		};
		const unchecked = stories.flatMap((entry) => entry.steps.flatMap((step, at) => ("key" in step && step.key === "ctrl+o" && !waitsAfter(entry, at) ? [entry.id] : [])));
		expect(unchecked).toEqual([]);
	});
	test("the holdout is blind to train: no typed line and no replay file is in both splits (a bare /command takes its input from the replay)", () => {
		const inputs = (split: "train" | "holdout") => {
			const own = filterBySplit(stories, split);
			return new Set([...own.flatMap((entry) => entry.steps.flatMap((step) => ("send" in step && !/^\/\w+$/.test(step.send) ? [step.send] : []))), ...own.flatMap((entry) => (entry.replay ? [entry.replay] : []))]);
		};
		const holdout = inputs("holdout");
		expect([...inputs("train")].filter((input) => holdout.has(input))).toEqual([]);
	});
	test("every replay file a story names exists", () => {
		expect(stories.flatMap((entry) => (entry.replay && !existsSync(join(root, entry.replay)) ? [`${entry.id}: ${entry.replay}`] : []))).toEqual([]);
	});
});
