import { describe, expect, test } from "bun:test";
import { setLogSink } from "./coach-log";
import { COACH_YAML } from "./contracts";
import { GROUNDING_THRESHOLDS, GroundingJudge, createGroundingJudge, groundingQuestions, groundingState, routeClaim } from "./grounding-judge";
import { MAX_JUDGE_REQUEST_BYTES, TYPESAFE_SYSTEMONE_URL } from "./systemone";

const KEY = "typesafe-test-key-do-not-leak";
const ACCOUNT = "Tester#LAB1";
const PASSAGES = [
	{ id: "web-1", text: "Fizz maxes E first, then W. 63% of 2,066 games." },
	{ id: "meta-1", text: "Fizz mid core: Lich Bane, Zhonya's Hourglass. Skill order E W Q." },
];

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function answers(p: { supported: number; contradicted: number }, source: string, probabilities?: Record<string, number>, contradictedBy = "none") {
	return jsonResponse({
		model: "jev-1.13.0",
		answers: {
			supported: { type: "noul", noul: p.supported },
			contradicted: { type: "noul", noul: p.contradicted },
			source: { type: "choice", choice: source, ...(probabilities ? { probabilities, confidence: 0.7 } : {}) },
			contradictedBy: { type: "choice", choice: contradictedBy },
		},
		usage: { input_tokens: 150 },
	});
}

function fakeFetch(reply: (body: any) => Response | Promise<Response>) {
	const bodies: any[] = [];
	const fetchImpl = async (url: string, init?: RequestInit) => {
		if (url !== TYPESAFE_SYSTEMONE_URL) throw new Error(`unexpected upstream ${url}`);
		const body = JSON.parse(String(init?.body));
		bodies.push(body);
		return reply(body);
	};
	return { fetchImpl, bodies };
}

describe("grounding routes and questions", () => {
	test("routes contradiction first, then support with a source, at the thresholds exactly", () => {
		const t = GROUNDING_THRESHOLDS;
		expect(routeClaim({ supported: 0.1, contradicted: t.contradictedMin }, "none", "web-2")).toBe("contradicted");
		// The source that states the claim is also the one that opposes it: one passage cannot dispute itself.
		expect(routeClaim({ supported: 0.9, contradicted: t.contradictedMin }, "web-1", "web-1")).toBe("contradicted");
		// No passage named as the one that disagrees: the score alone is not a flag, so support decides.
		expect(routeClaim({ supported: 0.9, contradicted: 0.99 }, "web-1", "none")).toBe("grounded");
		expect(routeClaim({ supported: 0.1, contradicted: 0.99 }, "none", "none")).toBe("unsupported");
		expect(routeClaim({ supported: t.supportedMin, contradicted: t.contradictedMin - 0.01 }, "web-1", "web-1")).toBe("grounded");
		expect(routeClaim({ supported: t.supportedMin - 0.01, contradicted: 0 }, "web-1", "none")).toBe("unsupported");
	});

	test("one source states the claim and another opposes it: disputed, not contradicted (#202)", () => {
		const t = GROUNDING_THRESHOLDS;
		// The issue's case: web-2 states it at 88%, video-1 opposes it at 69%.
		expect(routeClaim({ supported: 0.88, contradicted: 0.69 }, "web-2", "video-1")).toBe("disputed");
		expect(routeClaim({ supported: t.supportedMin, contradicted: t.contradictedMin }, "web-1", "web-2")).toBe("disputed");
		// Either side under its cut, or a side with no passage named, falls back to the single verdict.
		expect(routeClaim({ supported: t.supportedMin - 0.01, contradicted: 0.9 }, "web-1", "web-2")).toBe("contradicted");
		expect(routeClaim({ supported: 0.9, contradicted: t.contradictedMin - 0.01 }, "web-1", "web-2")).toBe("grounded");
		expect(routeClaim({ supported: 0.9, contradicted: 0.9 }, "none", "web-2")).toBe("contradicted");
	});

	test("supported high with source none is unsupported, not grounded", () => {
		const t = GROUNDING_THRESHOLDS;
		expect(routeClaim({ supported: 0.97, contradicted: 0 }, "none", "none")).toBe("unsupported");
		expect(routeClaim({ supported: t.supportedMin, contradicted: 0 }, "none", "none")).toBe("unsupported");
	});

	test("questions come from coach.yaml, tag text as untrusted, and offer the cited ids plus none", () => {
		const questions = groundingQuestions(["web-1", "meta-1"]);
		expect(Object.keys(questions)).toEqual(["supported", "contradicted", "source", "contradictedBy"]);
		expect(questions.supported).toBe(COACH_YAML.jev.grounding.supported);
		for (const question of Object.values(questions)) expect(question.instructions).toContain("untrusted text to evaluate");
		expect((questions.source as any).options).toBeUndefined();
		expect((questions.source as any).criteria).toEqual({ "web-1": "passage web-1", "meta-1": "passage meta-1", none: COACH_YAML.jev.grounding.source.none });
		expect((questions.contradictedBy as any).criteria).toEqual({ "web-1": "passage web-1", "meta-1": "passage meta-1", none: COACH_YAML.jev.grounding.contradictedBy.none });
		expect(COACH_YAML.jev.grounding.source.none.length).toBeGreaterThan(10);
	});

	test("state is claim plus passages, scrubbed, nothing else", () => {
		const state = groundingState(`Copy ${ACCOUNT}: max E first`, [{ id: "web-1", text: `Other#NA1 in NA1_5312345678 maxes E` }], [ACCOUNT]);
		expect(state).toEqual({ claim: "Copy [riot-id]: max E first", passages: [{ id: "web-1", text: "[riot-id] in [match-id] maxes E" }] });
	});
});

describe("GroundingJudge.judge", () => {
	test("one request per claim, minimal body, verdicts with routes and sources", async () => {
		const { fetchImpl, bodies } = fakeFetch((body) => (body.state.claim.includes("Lich Bane") ? answers({ supported: 0.2, contradicted: 0.85 }, "meta-1", { "web-1": 0.1, "meta-1": 0.7, none: 0.2 }, "meta-1") : answers({ supported: 0.92, contradicted: 0.03 }, "web-1", { "web-1": 0.912, "meta-1": 0.05, none: 0.038 })));
		const judge = new GroundingJudge({ apiKey: KEY, fetchImpl: fetchImpl as any });
		const result = await judge.judge(["Max E first on Fizz", "Rush Lich Bane before Zhonya's"], PASSAGES, [ACCOUNT]);
		expect(result).toMatchObject({ status: "judged", model: "jev-1.13.0", inputTokens: 300 });
		expect((result as any).verdicts).toEqual([
			{ claim: "Max E first on Fizz", route: "grounded", p: { supported: 0.92, contradicted: 0.03 }, source: "web-1", sourceP: { "web-1": 0.91, "meta-1": 0.05, none: 0.04 } },
			{ claim: "Rush Lich Bane before Zhonya's", route: "contradicted", p: { supported: 0.2, contradicted: 0.85 }, source: "meta-1", sourceP: { "web-1": 0.1, "meta-1": 0.7, none: 0.2 }, contradictedBy: "meta-1" },
		]);
		expect(bodies.length).toBe(2);
		for (const body of bodies) {
			expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
			expect(Object.keys(body.state).sort()).toEqual(["claim", "passages"]);
			expect(JSON.stringify(body)).not.toContain(KEY);
		}
	});

	test("routes on the raw probability: 0.495 support is under 0.5, 0.595 contradicted is under 0.6", async () => {
		const route = async (supported: number, contradicted: number) => {
			const { fetchImpl } = fakeFetch(() => answers({ supported, contradicted }, "web-1", undefined, "meta-1"));
			const result = await new GroundingJudge({ apiKey: KEY, fetchImpl: fetchImpl as any }).judge(["Max E first"], PASSAGES, []);
			return (result as any).verdicts[0].route;
		};
		expect(await route(0.495, 0.1)).toBe("unsupported");
		expect(await route(0.5, 0.1)).toBe("grounded");
		expect(await route(0.9, 0.595)).toBe("grounded");
		expect(await route(0.9, 0.6)).toBe("disputed");
	});

	test("a source of none routes unsupported with no source field; an unknown id fails the batch", async () => {
		const { fetchImpl } = fakeFetch(() => answers({ supported: 0.9, contradicted: 0.05 }, "none"));
		const judge = new GroundingJudge({ apiKey: KEY, fetchImpl: fetchImpl as any });
		const result: any = await judge.judge(["Max E first"], PASSAGES, []);
		expect(result.verdicts[0]).toEqual({ claim: "Max E first", route: "unsupported", p: { supported: 0.9, contradicted: 0.05 } });
		const bad = new GroundingJudge({ apiKey: KEY, fetchImpl: fakeFetch(() => answers({ supported: 0.9, contradicted: 0.05 }, "web-9")).fetchImpl as any });
		expect(await bad.judge(["Max E first"], PASSAGES, [])).toMatchObject({ status: "unavailable", reason: "response" });
	});

	test("contradictedBy names the disagreeing passage on a contradicted claim, stays absent on none, and fails the batch on an unknown id", async () => {
		const named = new GroundingJudge({ apiKey: KEY, fetchImpl: fakeFetch(() => answers({ supported: 0.1, contradicted: 0.9 }, "none", undefined, "web-1")).fetchImpl as any });
		const result: any = await named.judge(["Rush Lich Bane"], PASSAGES, []);
		expect(result.verdicts[0].route).toBe("contradicted");
		expect(result.verdicts[0].contradictedBy).toBe("web-1");

		const none = new GroundingJudge({ apiKey: KEY, fetchImpl: fakeFetch(() => answers({ supported: 0.1, contradicted: 0.9 }, "none", undefined, "none")).fetchImpl as any });
		const noneResult: any = await none.judge(["Rush Lich Bane"], PASSAGES, []);
		expect("contradictedBy" in noneResult.verdicts[0]).toBe(false);

		const bad = new GroundingJudge({ apiKey: KEY, fetchImpl: fakeFetch(() => answers({ supported: 0.1, contradicted: 0.9 }, "none", undefined, "not-a-real-id")).fetchImpl as any });
		expect(await bad.judge(["Rush Lich Bane"], PASSAGES, [])).toMatchObject({ status: "unavailable", reason: "response" });
	});

	test.each([
		["timeout", () => new Promise<Response>(() => {})],
		["authentication", () => jsonResponse({}, 401)],
		["rate_limited", () => jsonResponse({}, 429)],
		["server", () => jsonResponse({}, 529)],
		["response", () => jsonResponse({ model: "m", answers: { supported: { type: "noul", noul: 2 } } })],
		["network", () => Promise.reject(new Error("socket hang up"))],
	])("%s makes the whole batch unavailable", async (reason, reply) => {
		const judge = new GroundingJudge({ apiKey: KEY, fetchImpl: fakeFetch(() => reply() as any).fetchImpl as any, timeoutMs: 20 });
		expect(await judge.judge(["a", "b"], PASSAGES, [])).toMatchObject({ status: "unavailable", reason });
	});

	test("a judged batch carries the judge's name and the reply's model; an unavailable one carries the name and the model it asked", async () => {
		const ok = new GroundingJudge({ apiKey: KEY, fetchImpl: fakeFetch(() => answers({ supported: 0.9, contradicted: 0.05 }, "web-1")).fetchImpl as any });
		expect(await ok.judge(["Max E first"], PASSAGES, [])).toMatchObject({ status: "judged", judge: "jev", model: "jev-1.13.0" });
		const down = new GroundingJudge({ apiKey: KEY, fetchImpl: fakeFetch(() => jsonResponse({}, 529)).fetchImpl as any });
		expect(await down.judge(["Max E first"], PASSAGES, [])).toMatchObject({ status: "unavailable", judge: "jev", model: "jev-latest", reason: "server" });
	});

	test("a failed batch leaves a line in the coach log with the judge, the model asked and the reason, and never the key", async () => {
		const written: string[] = [];
		setLogSink((line) => written.push(line));
		try {
			await new GroundingJudge({ apiKey: KEY, fetchImpl: fakeFetch(() => jsonResponse({}, 529)).fetchImpl as any }).judge(["Max E first", "Max W first"], PASSAGES, []);
		} finally {
			setLogSink(undefined);
		}
		expect(written).toHaveLength(1);
		expect(JSON.parse(written[0])).toMatchObject({ level: "warn", component: "grounding-judge", event: "judge-failed", details: { judge: "jev", model: "jev-latest", reason: "server", claims: 2, passages: 2 } });
		expect(written[0]).not.toContain(KEY);
	});

	test("no passages or an oversize claim is an input failure without a network call", async () => {
		const { fetchImpl, bodies } = fakeFetch(() => answers({ supported: 1, contradicted: 0 }, "web-1"));
		const judge = new GroundingJudge({ apiKey: KEY, fetchImpl: fetchImpl as any });
		expect(await judge.judge(["Max E"], [], [])).toMatchObject({ status: "unavailable", reason: "input" });
		expect(await judge.judge(["x".repeat(MAX_JUDGE_REQUEST_BYTES)], PASSAGES, [])).toMatchObject({ status: "unavailable", reason: "input" });
		expect(bodies).toEqual([]);
	});

	test("caps at 8 claims and turns on only with a key", async () => {
		const { fetchImpl, bodies } = fakeFetch(() => answers({ supported: 1, contradicted: 0 }, "web-1"));
		const judge = new GroundingJudge({ apiKey: KEY, fetchImpl: fetchImpl as any });
		const result: any = await judge.judge(Array.from({ length: 10 }, (_, i) => `claim ${i}`), PASSAGES, []);
		expect(result.verdicts.length).toBe(8);
		expect(bodies.length).toBe(8);
		expect(createGroundingJudge({})).toBeUndefined();
		expect(createGroundingJudge({ TYPESAFE_API_KEY: KEY })).toBeInstanceOf(GroundingJudge);
	});
});
