import { expect, test } from "bun:test";
import { buildScores, parseBunTest, parseTierFile, parseTsc, storiesTier, type Scores } from "./score";

/** The conductor's K2 contract, written out as a check: a scores file is { commit, ts, tiers: { name: { pass, fail, skipped, seconds, costUsd, findings? } }, metrics: { name: { value, better, tolerance? } } }. */
function k2Problems(value: Scores): string[] {
	const bad: string[] = [];
	if (typeof value.commit !== "string" || !value.commit) bad.push("commit");
	if (typeof value.ts !== "number") bad.push("ts");
	for (const [name, tier] of Object.entries(value.tiers)) {
		for (const key of ["pass", "fail", "skipped", "seconds", "costUsd"] as const) if (typeof tier[key] !== "number" || tier[key] < 0) bad.push(`tiers.${name}.${key}`);
		for (const finding of tier.findings ?? []) if (typeof finding.title !== "string") bad.push(`tiers.${name}.findings`);
	}
	for (const [name, metric] of Object.entries(value.metrics)) {
		if (typeof metric.value !== "number") bad.push(`metrics.${name}.value`);
		if (metric.better !== "higher" && metric.better !== "lower") bad.push(`metrics.${name}.better`);
		if (metric.tolerance !== undefined && typeof metric.tolerance !== "number") bad.push(`metrics.${name}.tolerance`);
	}

	return bad;
}

test("bun test output becomes pass, fail and skipped counts", () => {
	expect(parseBunTest("\n 1322 pass\n 3 skip\n 0 fail\nRan 1325 tests across 80 files. [14.2s]", 0, 14.2)).toEqual({ pass: 1322, fail: 0, skipped: 3, seconds: 14.2, costUsd: 0 });
	expect(parseBunTest(" 10 pass\n 2 fail", 1, 1).fail).toBe(2);
	expect(parseBunTest("crash with no counts", 1, 1)).toMatchObject({ pass: 0, fail: 1 });
});

test("a clean typecheck is one pass, a dirty one counts its errors", () => {
	expect(parseTsc("", 0, 8)).toMatchObject({ pass: 1, fail: 0 });
	expect(parseTsc("a.ts(1,1): error TS2322: x\nb.ts(2,2): error TS2304: y", 2, 8)).toMatchObject({ pass: 0, fail: 2 });
	expect(parseTsc("killed", 137, 8).fail).toBe(1);
});

test("a tier file is read, and one that is wrong says why", () => {
	const ok = parseTierFile(JSON.stringify({ name: "t1", pass: 4, fail: 1, metrics: { score: { value: 0.8, better: "higher" }, junk: { value: "x" } } }));
	expect(ok).toEqual({ name: "t1", tier: { pass: 4, fail: 1, skipped: 0, seconds: 0, costUsd: 0 }, metrics: { score: { value: 0.8, better: "higher" } } });
	expect(parseTierFile("{}")).toBe("needs a string `name`");
	expect(parseTierFile('{"name":"x"}')).toBe("needs numbers `pass` and `fail`");
});

test("the UI catalogue's tier.json (named by `tier`, findings a count) is read", () => {
	const ui = parseTierFile('{"tier":"ui","pass":81,"fail":0,"skipped":0,"seconds":0.3,"costUsd":0,"findings":0}');
	expect(ui).toEqual({ name: "ui", tier: { pass: 81, fail: 0, skipped: 0, seconds: 0.3, costUsd: 0 }, metrics: {} });
});

test("the story run's stats become a tier with cost, seconds, a finding per failed story, and two metrics", () => {
	const done = storiesTier({ summary: { costUsd: 1.25, wallSeconds: 300, medianSeconds: 40 }, stories: [{ id: "a", verdict: "PASS" }, { id: "b", verdict: "FAIL", failures: ["icons: 0 of 23 icons placed"] }] });
	expect(done.tier).toMatchObject({ pass: 1, fail: 1, seconds: 300, costUsd: 1.25, findings: [{ key: "story:b", body: expect.stringContaining("icons: 0 of 23 icons placed") }] });
	expect(done.metrics["stories-median-seconds"]).toEqual({ value: 40, better: "lower", tolerance: 5 });
});

test("the scores a quick run builds satisfy K2, with metrics from tier files", () => {
	const scores = buildScores("abc1234", 1_000, [
		{ name: "typecheck", tier: parseTsc("", 0, 8) },
		{ name: "unit", tier: parseBunTest(" 5 pass\n 0 fail", 0, 3) },
		{ name: "t1", tier: { pass: 2, fail: 0, skipped: 0, seconds: 1, costUsd: 0 }, metrics: { "t1-score": { value: 0.9, better: "higher", tolerance: 0.02 } } },
	]);
	expect(k2Problems(scores)).toEqual([]);
	expect(Object.keys(scores.tiers)).toEqual(["typecheck", "unit", "t1"]);
	expect(JSON.parse(JSON.stringify(scores))).toEqual(scores);
});

test("the checker itself refuses a file that is not K2", () => {
	expect(k2Problems({ commit: "", ts: "x", tiers: { u: { pass: -1 } }, metrics: { m: { value: 1, better: "up" } } } as never).length).toBeGreaterThan(3);
});
