import { describe, expect, test } from "bun:test";
import { USAGE_MARKER, usageReporter, watchParent } from "./worker-extension";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a worker that watches its parent", () => {
	test("exits when the parent pid is no longer alive", async () => {
		let exits = 0;
		const stop = watchParent({ parentPid: 123, deadlineMs: 60_000, pollMs: 5, isAlive: () => false, exit: () => (exits += 1) });
		await wait(30);
		stop();
		expect(exits).toBeGreaterThan(0);
	});

	test("stays while the parent is alive", async () => {
		let exits = 0;
		const stop = watchParent({ parentPid: 123, deadlineMs: 60_000, pollMs: 5, isAlive: () => true, exit: () => (exits += 1) });
		await wait(30);
		stop();
		expect(exits).toBe(0);
	});

	test("exits at its own hard deadline even with the parent alive", async () => {
		let exits = 0;
		const stop = watchParent({ parentPid: 123, deadlineMs: 10, pollMs: 5, isAlive: () => true, exit: () => (exits += 1) });
		await wait(40);
		stop();
		expect(exits).toBeGreaterThan(0);
	});
});

describe("a worker that reports its usage", () => {
	const assistant = (usage: Record<string, unknown> | undefined) => ({ message: { role: "assistant", usage } });
	const lines = () => {
		const written: string[] = [];
		return { written, report: usageReporter((text) => written.push(text)), parsed: () => written.map((line) => JSON.parse(line.slice(USAGE_MARKER.length))) };
	};

	test("each assistant message writes one line with the totals so far, whole numbers and the dollars Pi priced", () => {
		const { report, parsed, written } = lines();
		report(assistant({ input: 100, output: 20, cacheRead: 4, cacheWrite: 1, totalTokens: 125, cost: { total: 0.01 } }));
		report(assistant({ input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { total: 0.005 } }));
		expect(parsed()).toEqual([
			{ input: 100, output: 20, cacheRead: 4, cacheWrite: 1, cost: 0.01 },
			{ input: 150, output: 30, cacheRead: 4, cacheWrite: 1, cost: 0.015 },
		]);
		expect(written.every((line) => line.startsWith(USAGE_MARKER) && line.endsWith("\n"))).toBe(true);
	});

	test("a model Pi has no price for reports tokens and no cost, never a zero dollar figure", () => {
		const { report, parsed } = lines();
		report(assistant({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0 } }));
		expect(parsed()).toEqual([{ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }]);
	});

	test("other messages, and an assistant message with no usage, write nothing", () => {
		const { report, written } = lines();
		report({ message: { role: "user", content: "hi" } });
		report({ message: { role: "toolResult", usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } } });
		report(assistant(undefined));
		report({ message: undefined });
		expect(written).toEqual([]);
	});
});
