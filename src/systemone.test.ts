import { describe, expect, test } from "bun:test";
import { JudgeFailure, MAX_JUDGE_REQUEST_BYTES, SystemOneClient, TYPESAFE_SYSTEMONE_URL, choice, noul, systemOneBody } from "./systemone";

const KEY = "typesafe-test-key-do-not-leak";
const Q = { yes: { type: "noul" as const, instructions: "Is it?", criteria: { true: "yes", false: "no" } } };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "no failure";
	} catch (error) {
		return error instanceof JudgeFailure ? error.reason : "not a JudgeFailure";
	}
}

describe("systemOneBody", () => {
	test("is model, state, questions and nothing else; over the cap is an input failure", () => {
		const body = JSON.parse(systemOneBody("jev-latest", { a: 1 }, Q));
		expect(body).toEqual({ model: "jev-latest", state: { a: 1 }, questions: Q });
		expect(() => systemOneBody("jev-latest", { a: "x".repeat(MAX_JUDGE_REQUEST_BYTES) }, Q)).toThrow(JudgeFailure);
	});
});

describe("answer parsers", () => {
	test("noul accepts 0..1 and keeps the raw value; anything else is a response failure", () => {
		expect(noul({ type: "noul", noul: 0.456 })).toBe(0.456);
		for (const bad of [undefined, { type: "noul", noul: 1.7 }, { type: "choice", noul: 0.5 }, { type: "noul", noul: "0.5" }]) expect(() => noul(bad)).toThrow(JudgeFailure);
	});
	test("choice accepts only a declared key", () => {
		expect(choice({ type: "choice", choice: "web-1" }, ["web-1", "none"])).toBe("web-1");
		expect(() => choice({ type: "choice", choice: "web-9" }, ["web-1", "none"])).toThrow(JudgeFailure);
		expect(() => choice({ type: "noul", noul: 0.5 }, ["web-1"])).toThrow(JudgeFailure);
	});
});

describe("SystemOneClient.ask", () => {
	test("sends bearer auth, json headers, redirect error, and returns model, tokens, answers", async () => {
		const seen: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = async (url: string, init?: RequestInit) => {
			seen.push({ url, init });
			return jsonResponse({ model: "jev-1.13.0", answers: { yes: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 120 } });
		};
		const client = new SystemOneClient({ apiKey: KEY, fetchImpl: fetchImpl as any });
		const result = await client.ask({ a: 1 }, Q, new AbortController().signal);
		expect(result).toEqual({ judge: "jev", model: "jev-1.13.0", inputTokens: 120, answers: { yes: { type: "noul", noul: 0.9 } } });
		expect(seen[0].url).toBe(TYPESAFE_SYSTEMONE_URL);
		expect(seen[0].init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" } });
		expect(String(seen[0].init?.body)).not.toContain(KEY);
	});

	test("a client with its own name hands that name back with the reply's model; one with no name is jev", async () => {
		const fetchImpl = async () => jsonResponse({ model: "other-2.1", answers: { yes: { type: "noul", noul: 0.9 } } });
		const named = new SystemOneClient({ apiKey: KEY, fetchImpl: fetchImpl as any, name: "other", model: "other-latest" });
		expect(named.name).toBe("other");
		expect(await named.ask({}, Q, new AbortController().signal)).toMatchObject({ judge: "other", model: "other-2.1" });
		expect(new SystemOneClient({ apiKey: KEY }).name).toBe("jev");
	});

	test.each([
		["authentication", () => jsonResponse({}, 401)],
		["authentication", () => jsonResponse({}, 403)],
		["rate_limited", () => jsonResponse({}, 429)],
		["input", () => jsonResponse({ detail: [{ type: "missing", loc: ["body", "questions", "q", "choice", "criteria"] }] }, 422)],
		["input", () => jsonResponse({}, 400)],
		["server", () => jsonResponse({}, 529)],
		["response", () => jsonResponse({ model: "m" })],
		["response", () => new Response("x".repeat(40_000), { status: 200 })],
		["response", () => new Response("not json", { status: 200 })],
		["network", () => Promise.reject(new Error("socket hang up"))],
	])("maps upstream trouble to %s", async (reason, reply) => {
		const client = new SystemOneClient({ apiKey: KEY, fetchImpl: (() => reply()) as any });
		expect(await failure(client.ask({}, Q, new AbortController().signal))).toBe(reason);
	});

	test("an empty key is an authentication failure before any network call", async () => {
		let calls = 0;
		const client = new SystemOneClient({ apiKey: "", fetchImpl: (async () => { calls += 1; return jsonResponse({}); }) as any });
		expect(await failure(client.ask({}, Q, new AbortController().signal))).toBe("authentication");
		expect(calls).toBe(0);
	});

	test("an aborted signal during fetch is a timeout", async () => {
		const abort = new AbortController();
		const client = new SystemOneClient({ apiKey: KEY, fetchImpl: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as any });
		setTimeout(() => abort.abort(), 5);
		expect(await failure(client.ask({}, Q, abort.signal))).toBe("timeout");
	});

	test("an oversized Content-Length fails response without ever reading the body stream", async () => {
		let pullCalls = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pullCalls += 1;
				controller.enqueue(new TextEncoder().encode("x"));
			},
		});
		const response = new Response(stream, { status: 200, headers: { "content-length": String(MAX_JUDGE_REQUEST_BYTES + 100_000) } });
		await Promise.resolve(); // let the stream's own eager startup pull (independent of our code) settle before measuring
		pullCalls = 0;
		const client = new SystemOneClient({ apiKey: KEY, fetchImpl: (async () => response) as any });
		expect(await failure(client.ask({}, Q, new AbortController().signal))).toBe("response");
		expect(pullCalls).toBe(0);
	});

	test("a streamed body with no Content-Length that crosses the cap fails response and cancels the stream", async () => {
		let cancelled = false;
		let pullCalls = 0;
		const chunk = new TextEncoder().encode("x".repeat(20_000));
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pullCalls += 1;
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = new Response(stream, { status: 200 });
		await Promise.resolve(); // settle the stream's own startup pull before measuring reads triggered by our code
		pullCalls = 0;
		const client = new SystemOneClient({ apiKey: KEY, fetchImpl: (async () => response) as any });
		expect(await failure(client.ask({}, Q, new AbortController().signal))).toBe("response");
		expect(cancelled).toBe(true);
		expect(pullCalls).toBeLessThanOrEqual(2);
	});

	test("a normal streamed body under the cap still parses", async () => {
		const payload = JSON.stringify({ model: "jev-1.13.0", answers: { yes: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 10 } });
		const chunk = new TextEncoder().encode(payload);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk);
				controller.close();
			},
		});
		const response = new Response(stream, { status: 200 });
		const client = new SystemOneClient({ apiKey: KEY, fetchImpl: (async () => response) as any });
		const result = await client.ask({}, Q, new AbortController().signal);
		expect(result).toEqual({ judge: "jev", model: "jev-1.13.0", inputTokens: 10, answers: { yes: { type: "noul", noul: 0.5 } } });
	});
});
