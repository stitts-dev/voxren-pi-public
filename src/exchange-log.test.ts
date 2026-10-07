import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExchangeLog, exchangeLogPath } from "./exchange-log";

describe("exchange log", () => {
	test("the path is exchanges.ndjson beside Pi's agent dir, and nothing without a launch", () => {
		expect(exchangeLogPath({ PI_CODING_AGENT_DIR: "C:\\Users\\j\\AppData\\Local\\voxren-coach\\pi-agent" })).toMatch(/voxren-coach[\\/]exchanges\.ndjson$/);
		expect(exchangeLogPath({})).toBeUndefined();
	});

	test("one line per run: command, prompt, every tool with args, timing and details, the answer, tokens and cost", () => {
		let clock = 1_000;
		const lines: string[] = [];
		const log = createExchangeLog("log.ndjson", () => clock, (_path, line) => void lines.push(line));
		log.command("comp", "Champ select, 30s left in phase.\nYour team: MID Fizz (you)", "/comp dive or split?");
		// start() hands back this run's id: the same ISO ts the finished exchange below carries, so
		// coach-log.ts's setLogContext can tie a diagnostic line straight back to this exact line.
		const runId = log.start("Champ select, 30s left in phase.\nYour team: MID Fizz (you)", { systemPrompt: "You are Voxren Coach", toolsAvailable: ["voxren_game_facts", "web_search"] });
		expect(runId).toBe(new Date(1_000).toISOString());
		clock += 100;
		log.toolStart({ toolCallId: "t1", toolName: "voxren_game_facts", args: { champion: "Fizz" } });
		clock += 250;
		log.toolEnd({ toolCallId: "t1", result: { content: [{ type: "text", text: "Fizz E: 16s" }], details: { operation: "game_facts", data: { e: 16 } } }, isError: false });
		log.toolStart({ toolCallId: "t2", toolName: "web_search", args: { query: "x" } });
		clock += 50;
		log.toolEnd({ toolCallId: "t2", result: { content: [{ type: "text", text: "no results" }] }, isError: true });
		clock += 600;
		const messages = [
			{ role: "user", content: "Champ select" },
			{ role: "assistant", content: [{ type: "thinking", thinking: "Need the E cooldown first." }, { type: "toolCall", name: "voxren_game_facts" }], usage: { input: 900, output: 40, cost: { total: 0.01 } }, stopReason: "toolUse" },
			{ role: "assistant", content: [{ type: "text", text: "- Lock Fizz.\n- Max E." }], usage: { input: 1200, output: 80, cost: { total: 0.02 } }, stopReason: "stop" },
		];
		const ctx = { sessionManager: { getSessionId: () => "s-1" }, model: { provider: "openai-codex", id: "gpt-6-astra" } };
		const exchange = log.end(messages, ctx, "medium")!;
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual(exchange);
		expect(exchange).toEqual({
			ts: new Date(1_000).toISOString(),
			sessionId: "s-1",
			model: { provider: "openai-codex", id: "gpt-6-astra" },
			command: "comp",
			input: "/comp dive or split?",
			prompt: "Champ select, 30s left in phase.\nYour team: MID Fizz (you)",
			systemPrompt: "You are Voxren Coach",
			toolsAvailable: ["voxren_game_facts", "web_search"],
			thinkingLevel: "medium",
			reasoning: ["Need the E cooldown first."],
			turns: [
				{ text: "", toolCalls: ["voxren_game_facts"], stopReason: "toolUse", error: undefined },
				{ text: "- Lock Fizz.\n- Max E.", toolCalls: [], stopReason: "stop", error: undefined },
			],
			answer: "- Lock Fizz.\n- Max E.",
			ms: 1_000,
			tools: [
				{ name: "voxren_game_facts", args: { champion: "Fizz" }, ms: 250, ok: true, result: { operation: "game_facts", data: { e: 16 } } },
				{ name: "web_search", args: { query: "x" }, ms: 50, ok: false, result: "no results" },
			],
			usage: { input: 2100, output: 120, costUsd: 0.03, turns: 2 },
		});
		// The command tag and its typed line are consumed by the run they composed: a typed question after it carries no command, and its input is its own prompt.
		log.start("what is Fizz's E called?");
		const typed = log.end([{ role: "assistant", content: [{ type: "text", text: "Playful / Trickster" }] }], {})!;
		expect(typed.command).toBeUndefined();
		expect(typed.input).toBe("what is Fizz's E called?");
		// Nothing is written without a path, and an end without a start is a no-op.
		expect(createExchangeLog(undefined).end([], {})).toBeUndefined();
	});

	test("an auto run (a command with no typed line) carries no input, and does not fall back to its prompt", () => {
		const lines: string[] = [];
		const log = createExchangeLog("log.ndjson", Date.now, (_path, line) => void lines.push(line));
		log.command("draft:auto", "Champ select, 30s left in phase.");
		log.start("Champ select, 30s left in phase.");
		const exchange = log.end([], {})!;
		expect(exchange.command).toBe("draft:auto");
		expect(exchange.input).toBeUndefined();
		expect(JSON.parse(lines[0])).not.toHaveProperty("input"); // usage.input is nested; the line itself has no input key
	});

	test("an aborted reason threads into the written line; a normal end carries none", () => {
		const lines: string[] = [];
		const log = createExchangeLog("log.ndjson", Date.now, (_path, line) => void lines.push(line));
		log.start("q");
		const exchange = log.end([], {}, undefined, "timeout")!;
		expect(exchange.aborted).toBe("timeout");
		expect(JSON.parse(lines[0]).aborted).toBe("timeout");
		log.start("q2");
		expect(log.end([], {})?.aborted).toBeUndefined();
	});

	test("a failing append never reaches the caller", () => {
		const log = createExchangeLog("log.ndjson", Date.now, () => {
			throw new Error("disk full");
		});
		log.start("q");
		expect(() => log.end([], {})).not.toThrow();
	});
	test("the chat route row (a custom message after the prompt) is never the answer and counts no turn", () => {
		const log = createExchangeLog(undefined, () => 0, () => {});
		log.start("what does fizz w do");
		const exchange = log.end(
			[
				{ role: "user", content: "what does fizz w do" },
				{ role: "custom", customType: "voxren-route", content: "route    Jev quick 82% · gpt-6-luna · low", display: true },
				{ role: "assistant", content: [{ type: "text", text: "W empowers his next attacks." }], usage: { input: 10, output: 5 }, stopReason: "stop" },
			],
			{},
			"low",
		)!;
		expect(exchange.answer).toBe("W empowers his next attacks.");
		expect(exchange.turns).toHaveLength(1);
		expect(exchange.usage.turns).toBe(1);
	});
	test("sums cache reads and writes, and leaves them out when the provider reports none", () => {
		const run = (usages: object[]) => {
			const log = createExchangeLog(undefined, () => 0, () => {});
			log.start("q");
			return log.end(usages.map((u) => ({ role: "assistant", content: [{ type: "text", text: "a" }], usage: u, stopReason: "stop" })), {}, "low")!.usage;
		};
		expect(run([{ input: 5, output: 1, cacheRead: 900, cacheWrite: 10 }, { input: 5, output: 1, cacheRead: 100, cacheWrite: 0 }])).toMatchObject({ cacheRead: 1000, cacheWrite: 10 });
		expect(run([{ input: 5, output: 1 }])).not.toHaveProperty("cacheRead");
	});

	test("a provider error and a tool's args never carry a key into the file", () => {
		const path = join(mkdtempSync(join(tmpdir(), "voxren-exchange-")), "exchanges.ndjson");
		const log = createExchangeLog(path);
		log.start("hi");
		log.toolStart({ toolCallId: "t1", toolName: "web_search", args: { url: "https://g.test/v1?key=SECRET123", apiKey: "SECRET123" } });
		log.toolEnd({ toolCallId: "t1", result: {}, isError: false });
		log.end([{ role: "assistant", content: [], errorMessage: "429 from https://generativelanguage.test/v1?key=SECRET123&alt=sse", usage: {} }], {});
		const text = readFileSync(path, "utf8");
		expect(text).not.toContain("SECRET123");
		expect(JSON.parse(text).tools[0].args.url).toBe("https://g.test/v1?key=[redacted]");
		expect(JSON.parse(text).turns[0].error).toContain("alt=sse");
	});

	test("the file rotates to .1 past its cap instead of growing without bound", () => {
		const path = join(mkdtempSync(join(tmpdir(), "voxren-exchange-")), "exchanges.ndjson");
		const log = createExchangeLog(path, Date.now, undefined, 50_000);
		for (let i = 0; i < 10; i++) {
			log.start("x".repeat(30_000), { systemPrompt: "s" });
			log.end([], {});
		}
		expect(existsSync(`${path}.1`)).toBe(true);
		expect(readFileSync(path, "utf8").length).toBeLessThan(100_000);
	});
});
