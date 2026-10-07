import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { COACH_YAML } from "./contracts";
import { setLogSink } from "./coach-log";
import { HOSTED_SEARCH_PROVIDERS, createHostedSearch, hostedSearchPrompt, onDomains, parseHostedSearch } from "./hosted-search";
import { createPiWorker, piEntry, workerArgs, workerModel, type WorkerRequest } from "./pi-worker";
import voxrenWorker, { withHostedSearch } from "./worker-extension";

/** A child process that records what it was started with and what was written to its stdin, and is finished by the test. */
function fakeChild() {
	const child = new EventEmitter() as any;
	child.stdout = new EventEmitter();
	child.written = "";
	child.stdinEnded = false;
	child.killed = false;
	child.stdin = { on() {}, end: (text?: string) => ((child.written += text ?? ""), (child.stdinEnded = true)) };
	child.kill = () => (child.killed = true);
	return child;
}

function fakeSpawn() {
	const started: Array<{ command: string; args: string[]; env: Record<string, string | undefined>; child: any }> = [];
	const spawn = (command: string, args: string[], options: { env: Record<string, string | undefined> }) => {
		const child = fakeChild();
		started.push({ command, args, env: options.env, child });
		return child;
	};
	return { started, spawn: spawn as any };
}

describe("worker extension", () => {
	test("adds the hosted search tool to a Responses request and leaves any other request alone", () => {
		expect(withHostedSearch({ model: "m", input: [], tools: [{ type: "function", name: "x" }] })).toEqual({ model: "m", input: [], tools: [{ type: "function", name: "x" }, { type: "web_search" }] });
		expect(withHostedSearch({ model: "m", input: [] })).toEqual({ model: "m", input: [], tools: [{ type: "web_search" }] });
		const chat = { model: "m", messages: [] };
		expect(withHostedSearch(chat)).toBe(chat);
		expect(withHostedSearch(undefined)).toBeUndefined();
	});

	test("hooks the provider request only when the worker was started for a search", () => {
		const events: string[] = [];
		const pi = { on: (event: string) => events.push(event) };
		const before = process.env.VOXREN_WORKER_HOSTED_SEARCH;
		try {
			process.env.VOXREN_WORKER_HOSTED_SEARCH = "";
			voxrenWorker(pi as any);
			// Every worker reports its usage; only a search worker also changes the provider request.
			expect(events).toEqual(["message_end"]);
			events.length = 0;
			process.env.VOXREN_WORKER_HOSTED_SEARCH = "1";
			voxrenWorker(pi as any);
			expect(events).toEqual(["message_end", "before_provider_request"]);
		} finally {
			if (before === undefined) delete process.env.VOXREN_WORKER_HOSTED_SEARCH;
			else process.env.VOXREN_WORKER_HOSTED_SEARCH = before;
		}
	});
});

describe("pi worker", () => {
	test("only Pi's own entry script is ever started again", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-entry-"));
		for (const name of ["pi", "cli.js", "coach.test.ts"]) writeFileSync(join(dir, name), "");
		expect(piEntry(join(dir, "pi"))).toBe(join(dir, "pi"));
		expect(piEntry(join(dir, "cli.js"))).toBe(join(dir, "cli.js"));
		expect(piEntry(join(dir, "coach.test.ts"))).toBeUndefined();
		expect(piEntry(join(dir, "missing", "pi"))).toBeUndefined();
		expect(piEntry(undefined)).toBeUndefined();
		// This test run is not a Pi run, so there is no worker to make.
		expect(createPiWorker({})).toBeUndefined();
	});

	test("runs a plain one-shot Pi: no coach extension, no tools, no session, the tier's model, the launch's provider", () => {
		const request: WorkerRequest = { prompt: "Summarise.", system: "Be brief.", tier: "standard" };
		const args = workerArgs("/opt/pi", {}, request);
		expect(args[0]).toBe("/opt/pi");
		expect(args).toContain("--no-extensions");
		expect(args[args.indexOf("--extension") + 1]).toEndWith("worker-extension.ts");
		for (const flag of ["--no-builtin-tools", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-session"]) expect(args).toContain(flag);
		expect(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 6)).toEqual(["--provider", COACH_YAML.agent.provider, "--model", COACH_YAML.agent.tiers.standard.model, "--thinking", COACH_YAML.agent.tiers.standard.thinking]);
		expect(args.slice(-4)).toEqual(["--system-prompt", "Be brief.", "--print", "Summarise."]);
		// A launch that pinned its provider, model, or thinking level pins the worker too.
		expect(workerModel({ VOXREN_COACH_PROVIDER: "anthropic", VOXREN_COACH_MODEL: "claude-x", VOXREN_COACH_THINKING: "high" }, "quick")).toEqual({ provider: "anthropic", model: "claude-x", thinking: "high" });
		expect(workerArgs("/opt/pi", {}, { prompt: "p" })).not.toContain("--system-prompt");
	});

	test("material goes in on stdin, the answer comes back from stdout, and the search flag reaches the child's environment", async () => {
		const { started, spawn } = fakeSpawn();
		const worker = createPiWorker({ PATH: "/bin", PI_CODING_AGENT_DIR: "/home/pi-agent" }, { spawn, entry: "/opt/pi", execPath: "/usr/bin/node" })!;
		const pending = worker({ prompt: "Distil.", material: "a long transcript", hostedSearch: true });
		const { command, env, child } = started[0];
		expect(command).toBe("/usr/bin/node");
		expect(env).toMatchObject({ PATH: "/bin", PI_CODING_AGENT_DIR: "/home/pi-agent", VOXREN_WORKER_HOSTED_SEARCH: "1" });
		expect(child.written).toBe("a long transcript");
		expect(child.stdinEnded).toBe(true);
		child.stdout.emit("data", Buffer.from("first "));
		child.stdout.emit("data", Buffer.from("second"));
		child.emit("close", 0);
		expect(await pending).toBe("first second");

		// No material: stdin is still closed, or print mode would wait on it. No search: the flag is empty.
		const plain = worker({ prompt: "Hi." });
		expect(started[1].child.stdinEnded).toBe(true);
		expect(started[1].env.VOXREN_WORKER_HOSTED_SEARCH).toBe("");
		started[1].child.emit("close", 0);
		expect(await plain).toBe("");
	});

	test("a failed, slow, cancelled, or runaway worker is an error and the child is killed", async () => {
		const { started, spawn } = fakeSpawn();
		const worker = createPiWorker({}, { spawn, entry: "/opt/pi", execPath: "node" })!;

		const failed = worker({ prompt: "p" });
		started[0].child.emit("close", 1);
		await expect(failed).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });

		const slow = worker({ prompt: "p", timeoutMs: 5 });
		await expect(slow).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
		expect(started[1].child.killed).toBe(true);

		const controller = new AbortController();
		const cancelled = worker({ prompt: "p", signal: controller.signal });
		controller.abort();
		await expect(cancelled).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
		expect(started[2].child.killed).toBe(true);

		const runaway = worker({ prompt: "p" });
		started[3].child.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1));
		await expect(runaway).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
		expect(started[3].child.killed).toBe(true);

		const unstartable = worker({ prompt: "p" });
		started[4].child.emit("error", new Error("ENOENT"));
		await expect(unstartable).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
	});
});

describe("hosted search", () => {
	test("the prompt carries the question, the result cap, and only the filters the call set", () => {
		const bare = hostedSearchPrompt({ query: "Fizz vs Ahri matchup", maxResults: 5 });
		expect(bare).toContain("Question: Fizz vs Ahri matchup");
		expect(bare).toContain("Up to 5 results");
		expect(bare).not.toContain("Use only pages");
		expect(bare).not.toContain("{{");
		const scoped = hostedSearchPrompt({ query: "Fizz vs Ahri matchup", domains: ["mobafire.com", "u.gg"], freshnessDays: 30, maxResults: 2 });
		expect(scoped).toContain("Use only pages on these sites: mobafire.com, u.gg.");
		expect(scoped).toContain("Use only pages published or updated in the last 30 days.");
	});

	test("the prompt tells the worker to quote the named champion's own section, or say the page has none", () => {
		const prompt = hostedSearchPrompt({ query: "League of Legends patch 26.19 notes Ahri changes", maxResults: 3 });
		expect(prompt).toContain("lines under that champion's or item's own heading");
		expect(prompt).toContain("The page does not mention <name>.");
		expect(prompt).toContain("Question: League of Legends patch 26.19 notes Ahri changes");
	});

	test("the worker's JSON becomes hits: quotes joined, bad links dropped, escapes stripped, long text clipped", () => {
		const output = [
			"```json",
			JSON.stringify({
				answer: "Dodge Charm with E.\x1b[31m",
				results: [
					{ title: "Fizz guide", url: "https://www.mobafire.com/guide", date: "2026-09-01", quotes: ["Timing on E is key.", "  You win  after level 3. ", "", "third", "fourth is dropped"] },
					{ title: "No link", url: "javascript:alert(1)", quotes: ["x"] },
					{ title: "No host", url: "https://", quotes: ["x"] },
					{ title: "Bare word host", url: "http://localhost/admin", quotes: ["x"] },
					{ title: "Too long to keep whole", url: `https://example.org/${"a".repeat(600)}`, quotes: ["x"] },
					{ title: "No quotes", url: "http://example.org/a" },
					{ title: "Long", url: "https://example.org/long", quotes: ["q".repeat(400)] },
				],
			}),
			"```",
		].join("\n");
		const parsed = parseHostedSearch(output);
		expect(parsed.answer).toBe("Dodge Charm with E.");
		expect(parsed.hits).toEqual([
			{ title: "Fizz guide", url: "https://www.mobafire.com/guide", date: "2026-09-01", snippet: "Timing on E is key. … You win after level 3. … third" },
			{ title: "No quotes", url: "http://example.org/a", date: "", snippet: "" },
			{ title: "Long", url: "https://example.org/long", date: "", snippet: `${"q".repeat(299)}…` },
		]);
	});

	test("results with unusable links log one line with the count and reason, never the links", () => {
		const lines: string[] = [];
		setLogSink((line) => lines.push(line));
		try {
			const out = parseHostedSearch(JSON.stringify({ answer: "a", results: [{ title: "t", url: "/guide/fizz?token=secret", quotes: ["q"] }, { url: "op.gg/x?token=secret" }, { title: "ok", url: "https://op.gg/x", quotes: ["q"] }] }));
			expect(out.hits.map((hit) => hit.title)).toEqual(["ok"]);
		} finally {
			setLogSink(undefined);
		}
		expect(lines).toHaveLength(1);
		const line = JSON.parse(lines[0]);
		expect(line.event).toBe("links-dropped");
		expect(line.details).toMatchObject({ dropped: 2, total: 3 });
		expect(lines[0]).not.toContain("secret");
	});

	test("onDomains: a fully-qualified host, a blank entry, and an IDN entry", () => {
		expect(onDomains("https://www.op.gg./champions", ["op.gg"])).toBe(true);
		expect(onDomains("https://op.gg./champions", ["op.gg."])).toBe(true);
		expect(onDomains("https://evil.com./x", [""])).toBe(false);
		expect(onDomains("https://evil.com/x", ["  "])).toBe(false);
		expect(onDomains("https://bücher.de/x", ["bücher.de"])).toBe(true);
		expect(onDomains("https://www.xn--bcher-kva.de/x", ["Bücher.DE"])).toBe(true);
	});

	test("onDomains: userinfo and lookalike subdomains do not pass for the allowed site", () => {
		expect(onDomains("https://op.gg@evil.example/x", ["op.gg"])).toBe(false);
		expect(onDomains("https://evil.example/op.gg", ["op.gg"])).toBe(false);
		expect(onDomains("https://op.gg.evil.example/x", ["op.gg"])).toBe(false);
		expect(onDomains("https://evil.example@www.op.gg/x", ["op.gg"])).toBe(true);
	});

	test("a hit from a site outside the domain filter is dropped: the filter is enforced, not only asked for", async () => {
		expect(onDomains("https://www.mobafire.com/guide", ["mobafire.com"])).toBe(true);
		expect(onDomains("https://MOBAFIRE.com/guide", ["mobafire.com"])).toBe(true);
		expect(onDomains("https://notmobafire.com/guide", ["mobafire.com"])).toBe(false);
		expect(onDomains("https://mobafire.com.evil.example/guide", ["mobafire.com"])).toBe(false);
		const answer = JSON.stringify({ answer: "a", results: [{ title: "on", url: "https://www.mobafire.com/a", quotes: ["q"] }, { title: "off", url: "https://reddit.com/r/fizzmains", quotes: ["q"] }] });
		const search = createHostedSearch(async () => answer);
		expect((await search({ query: "fizz vs ahri", domains: ["mobafire.com"], maxResults: 5 })).hits.map((hit) => hit.title)).toEqual(["on"]);
		expect((await search({ query: "fizz vs ahri", maxResults: 5 })).hits.map((hit) => hit.title)).toEqual(["on", "off"]);
	});

	test("an answer that is not the asked-for JSON is malformed, never an empty result", () => {
		for (const output of ["I could not search.", "{ not json }", JSON.stringify({ answer: "x" }), JSON.stringify([1, 2])]) {
			let code: unknown;
			try {
				parseHostedSearch(output);
			} catch (error) {
				code = (error as { code?: unknown }).code;
			}
			expect(code).toBe("MALFORMED_RESPONSE");
		}
	});

	test("a brace in the prose around the JSON does not fail the search; a string quotes value is one quote", () => {
		const json = JSON.stringify({ answer: "a", results: [{ title: "t", url: "https://a.gg/x", quotes: ["q"] }] });
		for (const output of [`Sure {as asked}: ${json}`, `${json}\nNote {sources vary}`, `{} ${json}`]) {
			expect(parseHostedSearch(output).hits).toHaveLength(1);
		}
		const inString = JSON.stringify({ answer: "a } {", results: [{ title: "t", url: "https://a.gg/x", quotes: ["q } {"] }] });
		expect(parseHostedSearch(`x {y} ${inString} z`).hits[0]?.snippet).toBe("q } {");
		const stringQuotes = JSON.stringify({ answer: "a", results: [{ title: "t", url: "https://a.gg/x", quotes: "q" }] });
		expect(parseHostedSearch(stringQuotes).hits[0]?.snippet).toBe("q");
	});

	test("a search runs one worker with hosted search on, the quick tier, and the search system prompt", async () => {
		const requests: WorkerRequest[] = [];
		const search = createHostedSearch(async (request) => {
			requests.push(request);
			return JSON.stringify({ answer: "a", results: [{ title: "t", url: "https://example.org", quotes: ["q"] }] });
		});
		const controller = new AbortController();
		const found = await search({ query: "second dragon timing", maxResults: 3 }, controller.signal);
		expect(found).toEqual({ provider: "hosted web search (model provider)", answer: "a", hits: [{ title: "t", url: "https://example.org", date: "", snippet: "q" }] });
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ hostedSearch: true, tier: "quick", system: COACH_YAML.tools.web_search.searchSystem, signal: controller.signal });
		expect(requests[0].prompt).toContain("Question: second dragon timing");
		expect(HOSTED_SEARCH_PROVIDERS.has(COACH_YAML.agent.provider)).toBe(true);
	});

	test("under a domain filter a hit from another site is dropped and the answer, which may rest on it, is blanked", async () => {
		const reply = (urls: string[]) => JSON.stringify({ answer: "Reddit says go Q first.", results: urls.map((url) => ({ title: "t", url, quotes: ["q"] })) });
		const run = (urls: string[], domains?: string[]) => createHostedSearch(async () => reply(urls))({ query: "q", domains, maxResults: 5 });
		const mixed = await run(["https://www.mobafire.com/a", "https://www.reddit.com/b"], ["mobafire.com"]);
		expect(mixed.hits.map((hit) => hit.url)).toEqual(["https://www.mobafire.com/a"]);
		expect(mixed.answer).toBe("");
		expect((await run(["https://www.reddit.com/b"], ["mobafire.com"])).answer).toBe("");
		expect((await run(["https://www.mobafire.com/a"], ["mobafire.com"])).answer).toBe("Reddit says go Q first.");
		expect((await run(["https://www.reddit.com/b"])).answer).toBe("Reddit says go Q first.");
	});
});
