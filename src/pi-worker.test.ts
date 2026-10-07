import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { LiveResearchGateway } from "./live-gateway";
import { MAX_CONCURRENT_WORKERS, createPiWorker, measureWorker, type PiWorker } from "./pi-worker";
import { usageReporter } from "./worker-extension";

/** A child that never ends by itself: it records the signals it is sent. */
function fakeSpawn() {
	const children: any[] = [];
	const spawn = (_command: string, _args: string[], options: any) => {
		const child = new EventEmitter() as any;
		child.options = options;
		child.signals = [] as (string | undefined)[];
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = { on() {}, end() {} };
		child.kill = (signal?: string) => {
			child.signals.push(signal);
			return true;
		};
		children.push(child);
		return child;
	};
	return { spawn: spawn as any, children };
}

describe("a worker and its parent", () => {
	test("closing the gateway kills a running worker, hosted search included", async () => {
		const { spawn, children } = fakeSpawn();
		const worker = createPiWorker({}, { entry: "pi", execPath: "node", spawn })!;
		const live = new LiveResearchGateway({ auditAccounts: () => [], worker });
		const running = worker({ prompt: "p", hostedSearch: true }).catch((error) => error);
		expect(children.length).toBe(1);
		await live.close();
		expect(children[0].signals.length).toBeGreaterThan(0);
		expect(await running).toBeInstanceOf(Error);
	});

	test("a worker that ignores the first kill gets SIGKILL after the grace", async () => {
		const { spawn, children } = fakeSpawn();
		const worker = createPiWorker({}, { entry: "pi", execPath: "node", spawn, killGraceMs: 10 })!;
		const running = worker({ prompt: "p" }).catch((error) => error);
		worker.close!();
		await running;
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(children[0].signals).toEqual([undefined, "SIGKILL"]);
	});

	test("the worker is told its parent's pid and a hard deadline", () => {
		const { spawn, children } = fakeSpawn();
		const worker = createPiWorker({}, { entry: "pi", execPath: "node", spawn })!;
		void worker({ prompt: "p" }).catch(() => {});
		expect(children[0].options.env.VOXREN_WORKER_PARENT_PID).toBe(String(process.pid));
		expect(Number(children[0].options.env.VOXREN_WORKER_DEADLINE_MS)).toBeGreaterThan(0);
		worker.close!();
	});
});

describe("how many workers run at once", () => {
	const request = { prompt: "p" };

	test("only MAX_CONCURRENT_WORKERS spawn; each one that ends lets the next start", async () => {
		const { spawn, children } = fakeSpawn();
		const worker = createPiWorker({}, { entry: "pi", execPath: "node", spawn })!;
		const results = Array.from({ length: 6 }, () => worker(request).catch((error) => error));
		expect(children.length).toBe(MAX_CONCURRENT_WORKERS);
		children[0].stdout.emit("data", Buffer.from("one"));
		children[0].emit("close", 0);
		expect(await results[0]).toBe("one");
		expect(children.length).toBe(MAX_CONCURRENT_WORKERS + 1);
		worker.close!();
		await Promise.all(results);
	});

	test("a queued request that is aborted never spawns, and the timeout counts from the spawn", async () => {
		const { spawn, children } = fakeSpawn();
		const worker = createPiWorker({}, { entry: "pi", execPath: "node", spawn })!;
		const first = Array.from({ length: MAX_CONCURRENT_WORKERS }, () => worker({ ...request, timeoutMs: 60 }).catch((error) => error));
		const controller = new AbortController();
		const aborted = worker({ ...request, signal: controller.signal }).catch((error) => error);
		const waiting = worker({ ...request, timeoutMs: 60 }).catch((error) => error);
		controller.abort();
		expect(await aborted).toBeInstanceOf(Error);
		expect(children.length).toBe(MAX_CONCURRENT_WORKERS);
		await Promise.all(first);
		// The slots freed by the timeouts start the waiting one now; its own 60 ms has not begun to run out.
		expect(children.length).toBe(MAX_CONCURRENT_WORKERS + 1);
		children[MAX_CONCURRENT_WORKERS].stdout.emit("data", Buffer.from("late"));
		children[MAX_CONCURRENT_WORKERS].emit("close", 0);
		expect(await waiting).toBe("late");
	});
});

describe("a worker's provider key (#371)", () => {
	// ps eww is how same-user tools read a process's exec-time environment; Windows has no such listing here.
	test.skipIf(process.platform === "win32")("a real child has no key in its environment; the handoff file holds it and is gone once the worker ends", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "worker-handoff-"));
		const key = "sk-ant-FAKE-0000-handoff";
		let listing = "";
		let handoff: Record<string, string> = {};
		const spawn = (_command: string, _args: string[], options: any) => {
			const file = options.env.VOXREN_LAUNCH_SECRETS as string;
			handoff = JSON.parse(readFileSync(file, "utf8"));
			const child = nodeSpawn(process.execPath, ["-e", "setTimeout(() => console.log('done'), 800)"], options);
			listing = execFileSync("ps", ["eww", "-p", String(child.pid)], { encoding: "utf8" });
			return child;
		};
		const worker = createPiWorker({ PI_CODING_AGENT_DIR: agentDir, ANTHROPIC_API_KEY: key, BRAVE_API_KEY: "brave-FAKE" }, { entry: "pi", spawn: spawn as any })!;
		expect(await worker({ prompt: "p" })).toBe("done\n");
		expect(listing).toContain("VOXREN_LAUNCH_SECRETS=");
		expect(listing).not.toContain(key);
		expect(listing).not.toContain("brave-FAKE");
		expect(handoff).toEqual({ ANTHROPIC_API_KEY: key });
		expect(existsSync((listing.match(/VOXREN_LAUNCH_SECRETS=(\S+)/) as RegExpMatchArray)[1])).toBe(false);
	});
});

describe("a worker run reports its usage", () => {
	const message = (usage: Record<string, unknown>) => ({ message: { role: "assistant", usage } });
	const used = { input: 120, output: 30, cacheRead: 5, cacheWrite: 0, totalTokens: 155, cost: { total: 0.0042 } };

	test("what the worker extension writes to stderr reaches onUsage, and the text still comes back as before", async () => {
		const { spawn, children } = fakeSpawn();
		const worker = createPiWorker({}, { entry: "pi", execPath: "node", spawn })!;
		const seen: unknown[] = [];
		const running = worker({ prompt: "p", onUsage: (usage) => seen.push(usage) });
		// The child's side of the protocol is the extension's own reporter, so the two ends cannot drift apart.
		const report = usageReporter((text) => children[0].stderr.emit("data", Buffer.from(`Pi warning: slow\n${text}`)));
		report(message({ ...used, input: 10, output: 1, cost: { total: 0.0001 } }));
		report(message(used));
		children[0].stdout.emit("data", Buffer.from("answer\n"));
		children[0].emit("close", 0);
		expect(await running).toBe("answer\n");
		expect(seen).toEqual([{ input: 130, output: 31, cacheRead: 10, cacheWrite: 0, cost: 0.0043 }]);
	});

	test("a usage line split across two chunks is read whole", async () => {
		const { spawn, children } = fakeSpawn();
		const worker = createPiWorker({}, { entry: "pi", execPath: "node", spawn })!;
		const seen: unknown[] = [];
		const running = worker({ prompt: "p", onUsage: (usage) => seen.push(usage) });
		let text = "";
		usageReporter((line) => (text += line))(message(used));
		children[0].stderr.emit("data", Buffer.from(text.slice(0, 20)));
		children[0].stderr.emit("data", Buffer.from(text.slice(20)));
		children[0].emit("close", 0);
		await running;
		expect(seen).toEqual([{ input: 120, output: 30, cacheRead: 5, cacheWrite: 0, cost: 0.0042 }]);
	});

	test("a run that fails still reports what it spent; a run that wrote no usage reports nothing", async () => {
		const { spawn, children } = fakeSpawn();
		const worker = createPiWorker({}, { entry: "pi", execPath: "node", spawn })!;
		const seen: unknown[] = [];
		const failed = worker({ prompt: "p", onUsage: (usage) => seen.push(usage) }).catch((error) => error);
		usageReporter((text) => children[0].stderr.emit("data", Buffer.from(text)))(message(used));
		children[0].emit("close", 1);
		expect(await failed).toBeInstanceOf(Error);
		expect(seen).toHaveLength(1);

		const silent = worker({ prompt: "p", onUsage: (usage) => seen.push(usage) });
		children[1].stderr.emit("data", Buffer.from("VOXREN_WORKER_USAGE not json\nsome other warning\n"));
		children[1].emit("close", 0);
		await silent;
		expect(seen).toHaveLength(1);
	});

	test("a caller's onUsage that throws does not break the run", async () => {
		const { spawn, children } = fakeSpawn();
		const worker = createPiWorker({}, { entry: "pi", execPath: "node", spawn })!;
		const running = worker({ prompt: "p", onUsage: () => { throw new Error("caller bug"); } });
		usageReporter((text) => children[0].stderr.emit("data", Buffer.from(text)))(message(used));
		children[0].stdout.emit("data", Buffer.from("ok"));
		children[0].emit("close", 0);
		expect(await running).toBe("ok");
	});
});

describe("measureWorker", () => {
	/** A worker that answers at once and reports the usage the test hands it, one per run. */
	const reporting = (usages: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number } | undefined>): PiWorker => {
		let run = 0;
		return async (request) => {
			const usage = usages[run++];
			if (usage) request.onUsage?.(usage);
			return "answer";
		};
	};

	test("sums every run's usage, counts runs that reported nothing, and take() hands the sum over and starts again", async () => {
		const measured = measureWorker(reporting([{ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01 }, { input: 50, output: 10, cacheRead: 5, cacheWrite: 2, cost: 0.005 }, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }, undefined]));
		for (let run = 0; run < 4; run++) await measured.worker({ prompt: "p" });
		const first = measured.take();
		expect(first).toMatchObject({ runs: 4, reported: 3, input: 157, output: 33, cacheRead: 5, cacheWrite: 2, unpriced: 1 });
		expect(first.cost).toBeCloseTo(0.015, 10);
		const second = measured.take();
		expect(second).toMatchObject({ runs: 0, reported: 0, input: 0, output: 0, unpriced: 0 });
		expect(second.cost).toBeUndefined();
	});

	test("a caller's own onUsage still hears the run", async () => {
		const measured = measureWorker(reporting([{ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }]));
		const heard: unknown[] = [];
		await measured.worker({ prompt: "p", onUsage: (usage) => heard.push(usage) });
		expect(heard).toEqual([{ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }]);
		expect(measured.take().input).toBe(1);
	});
});
