import { describe, expect, test } from "bun:test";
import type { Exchange } from "../exchange-log";
import { buildCassette, createCassetteGateway, replayDelay, scrubText } from "./cassette.ts";

const response = { version: "1", operation: "meta.matchup", data: { rows: ["Ahri W is up at 6"] }, evidence: [] };
const run = {
	ts: "2026-10-04T00:00:00.000Z",
	prompt: "p",
	reasoning: ["think one", "think two"],
	turns: [
		{ text: "", toolCalls: ["voxren_meta_research", "voxren_meta_research"] },
		{ text: "Lane: hold", toolCalls: [] },
	],
	answer: "Lane: hold",
	ms: 1000,
	usage: { input: 0, output: 0, costUsd: 0, turns: 2 },
	tools: [
		{ name: "voxren_meta_research", args: { champion: "Ahri" }, ms: 400, ok: true, result: { operation: "meta.matchup", response } },
		{ name: "voxren_meta_research", args: { champion: "Katarina" }, ms: 5000, ok: false, result: "failed" },
	],
} as unknown as Exchange;

describe("buildCassette", () => {
	const cassette = buildCassette("c", [run]);
	test("keeps the turns in order, thinking by turn when the counts match", () => {
		expect(cassette.turns.map((turn) => [turn.thinking, turn.text, turn.calls.length])).toEqual([[["think one"], "", 2], [["think two"], "Lane: hold", 0]]);
		expect(cassette.turns[0].calls.map((call) => call.args)).toEqual([{ champion: "Ahri" }, { champion: "Katarina" }]);
	});
	test("keeps a tool result only when the call succeeded", () => expect(cassette.tools.map((tool) => tool.args)).toEqual([{ champion: "Ahri" }]));
	test("scrubs Riot IDs, keys, and machine paths", () => {
		const home = ["", "Users", "someone"].join("/");
		const queryKey = Array(3).fill("fixture").join("-");
		const bearerKey = Array(3).fill("bearer").join("-");
		const dirty = { ...run, answer: "x", turns: [{ text: `Faker#KR1 at ${home}/voxren/x?api_key=${queryKey} Bearer ${bearerKey}`, toolCalls: [] }], tools: [], reasoning: [] } as unknown as Exchange;
		const text = JSON.stringify(buildCassette("c", [dirty], [home]));
		for (const leak of ["Faker#KR1", home, queryKey, bearerKey]) expect(text).not.toContain(leak);
		expect(scrubText("RGAPI-0123456789abcdef0123")).toBe("[redacted]");
	});
});

describe("createCassetteGateway", () => {
	test("answers a recorded call, after the scaled delay, and refuses one it never recorded", async () => {
		const waits: number[] = [];
		const gateway = createCassetteGateway(buildCassette("c", [run]), async (ms) => void waits.push(ms));
		expect((await gateway.call("meta.matchup", { champion: "Ahri" })).data).toEqual(response.data);
		expect(waits).toEqual([40]);
		await expect(gateway.call("meta.matchup", { champion: "Zed" })).rejects.toThrow();
	});
	test("recorded tool time is a tenth, at most 1.5 s", () => {
		expect(replayDelay(400)).toBe(40);
		expect(replayDelay(60_000)).toBe(1500);
	});
});
