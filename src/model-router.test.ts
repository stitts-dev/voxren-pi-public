import { describe, expect, test } from "bun:test";
import { setLogSink } from "./coach-log";
import { ROUTE_PROMPT_CHARS, routePrompt, type RouteInput, type RouteJudge } from "./model-router";
import { JudgeFailure } from "./systemone";

const BASE: RouteInput = { prompt: "what does fizz w do", pinned: false, accounts: ["Player01#NA1"], current: { model: "gpt-6-sol", thinking: "medium" } };

function jev(probabilities: Record<string, number>, pick = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]) {
	const seen: Array<Record<string, unknown>> = [];
	const judge: RouteJudge = {
		model: "jev-latest",
		ask: async (state) => {
			seen.push(state);
			return { judge: "jev", model: "jev-1", inputTokens: 10, answers: { route: { type: "choice", choice: pick, probabilities } } };
		},
	};
	return { judge, seen };
}

describe("routePrompt", () => {
	test("a command tier wins without a Jev call", async () => {
		const { judge, seen } = jev({ quick: 0.9, standard: 0.05, deep: 0.05 });
		expect(await routePrompt({ ...BASE, commandTier: "deep" }, judge)).toEqual({ model: "gpt-6-sol", thinking: "high", source: "command", tier: "deep" });
		expect(seen).toHaveLength(0);
	});
	test("pinned keeps the current model and thinking, ignoring command and Jev", async () => {
		const { judge, seen } = jev({ quick: 0.9, standard: 0.05, deep: 0.05 });
		expect(await routePrompt({ ...BASE, pinned: true, commandTier: "deep", current: { model: "gpt-6-luna", thinking: "low" } }, judge)).toEqual({ model: "gpt-6-luna", thinking: "low", source: "pinned" });
		expect(seen).toHaveLength(0);
	});
	test("no judge falls back to the full standard tier with failure off, even from luna", async () => {
		expect(await routePrompt({ ...BASE, current: { model: "gpt-6-luna", thinking: "low" } }, undefined)).toEqual({ model: "gpt-6-sol", thinking: "medium", source: "fallback", tier: "standard", failure: "off" });
	});
	test("a confident quick grade switches to luna at low thinking", async () => {
		const { judge } = jev({ quick: 0.82, standard: 0.15, deep: 0.03 });
		expect(await routePrompt(BASE, judge)).toEqual({ model: "gpt-6-luna", thinking: "low", source: "jev", tier: "quick", p: 0.82, ms: expect.any(Number), by: "jev-1" });
	});
	test("exactly 0.7 switches", async () => {
		const { judge } = jev({ quick: 0.7, standard: 0.2, deep: 0.1 });
		expect((await routePrompt(BASE, judge)).model).toBe("gpt-6-luna");
	});
	test("an unsure quick grade keeps the current model but still sets low thinking", async () => {
		const { judge } = jev({ quick: 0.55, standard: 0.4, deep: 0.05 });
		expect(await routePrompt(BASE, judge)).toEqual({ model: "gpt-6-sol", thinking: "low", source: "held", tier: "quick", p: 0.55, ms: expect.any(Number), by: "jev-1" });
	});
	for (const reason of ["timeout", "network", "authentication", "rate_limited", "server", "response", "input"] as const) {
		test(`a ${reason} failure keeps the current model at standard's thinking`, async () => {
			const judge: RouteJudge = { model: "jev-latest", ask: async () => { throw new JudgeFailure(reason); } };
			expect(await routePrompt(BASE, judge)).toEqual({ model: "gpt-6-sol", thinking: "medium", source: "fallback", tier: "standard", failure: reason, ms: expect.any(Number), by: "jev-latest" });
			expect(await routePrompt({ ...BASE, current: { model: "gpt-6-luna", thinking: "low" } }, judge)).toEqual({ model: "gpt-6-luna", thinking: "medium", source: "fallback", tier: "standard", failure: reason, ms: expect.any(Number), by: "jev-latest" });
		});
	}
	test("a Jev slower than the deadline is cut off as a timeout", async () => {
		const judge: RouteJudge = { model: "jev-latest", ask: () => new Promise(() => {}) };
		const started = Date.now();
		const route = await routePrompt({ ...BASE, current: { model: "gpt-6-luna", thinking: "low" } }, judge, 50);
		expect(route).toEqual({ model: "gpt-6-luna", thinking: "medium", source: "fallback", tier: "standard", failure: "timeout", ms: expect.any(Number), by: "jev-latest" });
		expect(route.ms).toBeGreaterThanOrEqual(40);
		expect(Date.now() - started).toBeLessThan(1000);
	});
	test("an unknown tier key or missing probabilities is a response failure", async () => {
		expect(await routePrompt(BASE, jev({ trivial: 0.9 }, "trivial").judge)).toMatchObject({ source: "fallback", failure: "response" });
		const bare: RouteJudge = { model: "jev-latest", ask: async () => ({ judge: "jev", model: "jev-1", inputTokens: 1, answers: { route: { type: "choice", choice: "quick" } } }) };
		expect(await routePrompt(BASE, bare)).toMatchObject({ source: "fallback", failure: "response" });
	});
	test("a Riot ID never reaches Jev and a long prompt is cut", async () => {
		const { judge, seen } = jev({ quick: 0.1, standard: 0.8, deep: 0.1 });
		await routePrompt({ ...BASE, prompt: `how did Player01#NA1 play ${"x".repeat(10_000)}` }, judge);
		const sent = String(seen[0].message);
		expect(sent).not.toContain("Player01");
		expect(sent.length).toBe(ROUTE_PROMPT_CHARS);
	});
	test("an empty prompt falls back without a call", async () => {
		const { judge, seen } = jev({ quick: 0.9, standard: 0.05, deep: 0.05 });
		const route = await routePrompt({ ...BASE, prompt: "   " }, judge);
		expect(route).toMatchObject({ source: "fallback", tier: "standard" });
		expect(route.ms).toBeUndefined();
		expect(seen).toHaveLength(0);
	});
	test("the route names the model that graded: the reply's model once it answered, the one asked when the call failed, none without a judge", async () => {
		const other: RouteJudge = { model: "other-latest", ask: async () => ({ judge: "other", model: "other-2.1", inputTokens: 1, answers: { route: { type: "choice", choice: "quick", probabilities: { quick: 0.9, standard: 0.05, deep: 0.05 } } } }) };
		expect((await routePrompt(BASE, other)).by).toBe("other-2.1");
		const down: RouteJudge = { model: "other-latest", ask: async () => { throw new JudgeFailure("server"); } };
		expect((await routePrompt(BASE, down)).by).toBe("other-latest");
		expect((await routePrompt({ ...BASE, prompt: " " }, other)).by).toBe("other-latest");
		expect((await routePrompt(BASE, undefined)).by).toBeUndefined();
		for (const quiet of [await routePrompt({ ...BASE, commandTier: "deep" }, other), await routePrompt({ ...BASE, pinned: true }, other)]) expect(quiet.by).toBeUndefined();
	});
	test("a failed grade leaves a line in the coach log with the model asked and the reason", async () => {
		const written: string[] = [];
		setLogSink((line) => written.push(line));
		try {
			await routePrompt(BASE, { model: "jev-latest", ask: async () => { throw new JudgeFailure("rate_limited"); } });
		} finally {
			setLogSink(undefined);
		}
		expect(written).toHaveLength(1);
		expect(JSON.parse(written[0])).toMatchObject({ level: "warn", component: "model-router", event: "route-failed", details: { judge: "jev-latest", reason: "rate_limited" } });
	});
	test("p and ms: the winning tier's probability and the Jev call's duration; none without a call", async () => {
		const slow: RouteJudge = {
			model: "jev-latest",
			ask: async () => {
				await new Promise((resolve) => setTimeout(resolve, 60));
				return { judge: "jev", model: "jev-1", inputTokens: 1, answers: { route: { type: "choice", choice: "deep", probabilities: { quick: 0.05, standard: 0.2, deep: 0.75 } } } };
			},
		};
		const route = await routePrompt(BASE, slow);
		expect(route).toMatchObject({ source: "jev", tier: "deep", p: 0.75 });
		expect(route.ms).toBeGreaterThanOrEqual(50);
		expect(route.ms).toBeLessThan(1000);
		for (const quiet of [await routePrompt({ ...BASE, commandTier: "deep" }, slow), await routePrompt({ ...BASE, pinned: true }, slow), await routePrompt(BASE, undefined)]) {
			expect(quiet.p).toBeUndefined();
			expect(quiet.ms).toBeUndefined();
		}
	});
});
