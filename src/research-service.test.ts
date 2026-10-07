import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ResearchServiceError, createResearchService, findOnPath, researchServiceMode, researchStatePath, treeKillCommand } from "./research-service";

/** A checkout with a research-tools folder and a PATH holding a `uv`, both empty files: only their presence is read. */
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "research-service-"));
	const bin = join(dir, "bin");
	const service = join(dir, "services", "research-tools");
	for (const path of [bin, service]) mkdirSync(path, { recursive: true });
	writeFileSync(join(bin, "uv"), "");
	chmodSync(join(bin, "uv"), 0o755);
	writeFileSync(join(service, "pyproject.toml"), "");
	return { dir, bin, service, uv: join(bin, "uv") };
}

function fakeChild() {
	const child = new EventEmitter() as any;
	child.stdinEnded = false;
	child.killed = false;
	child.unrefs = 0;
	child.stdin = { on() {}, end: () => (child.stdinEnded = true), unref: () => (child.unrefs += 1) };
	child.kill = () => (child.killed = true);
	child.unref = () => (child.unrefs += 1);
	return child;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("how a launch reaches the research service", () => {
	test("a URL the player set wins; else a local copy when uv and the service folder exist; else off with the reason", () => {
		const { bin, service, uv } = fixture();
		expect(researchServiceMode({ VOXREN_RESEARCH_URL: " https://tools.example.com/ ", VOXREN_RESEARCH_TOKEN: "t" }, "darwin", service)).toEqual({ kind: "remote", url: "https://tools.example.com" });
		expect(researchServiceMode({ VOXREN_RESEARCH_URL: "tools.example.com", VOXREN_RESEARCH_TOKEN: "t" }, "darwin", service)).toEqual({ kind: "off", reason: "VOXREN_RESEARCH_URL must start with http:// or https://" });
		// A URL with no token is not a working service: every call would be refused, so the tools must not be offered.
		expect(researchServiceMode({ VOXREN_RESEARCH_URL: "https://tools.example.com", VOXREN_RESEARCH_TOKEN: " ", PATH: bin }, "darwin", service)).toEqual({ kind: "off", reason: "set VOXREN_RESEARCH_TOKEN to the token of the service at VOXREN_RESEARCH_URL" });
		expect(researchServiceMode({ PATH: bin }, "darwin", service)).toEqual({ kind: "local", uv });
		expect(researchServiceMode({ PATH: "/nowhere" }, "darwin", service)).toEqual({ kind: "off", reason: "install uv (https://docs.astral.sh/uv/) or set VOXREN_RESEARCH_URL" });
		expect(researchServiceMode({}, "linux", service).kind).toBe("off");
		expect(researchServiceMode({ PATH: bin }, "darwin", join(service, "missing"))).toEqual({ kind: "off", reason: "services/research-tools is missing from this checkout" });
		// Windows is no different: a local copy when uv is on PATH, off with the same reason without it, and a URL still wins.
		expect(researchServiceMode({ PATH: bin }, "win32", service)).toEqual({ kind: "local", uv });
		expect(researchServiceMode({ PATH: join(bin, "missing") }, "win32", service)).toEqual({ kind: "off", reason: "install uv (https://docs.astral.sh/uv/) or set VOXREN_RESEARCH_URL" });
		expect(researchServiceMode({ PATH: bin, VOXREN_RESEARCH_URL: "http://10.0.0.5:8787", VOXREN_RESEARCH_TOKEN: "t" }, "win32", service)).toEqual({ kind: "remote", url: "http://10.0.0.5:8787" });
		expect(createResearchService({ PATH: "/nowhere" }, { serviceDir: service, platform: "darwin" })).toBeUndefined();
	});

	test("findOnPath reads PATH in order and skips empty entries", () => {
		const { bin, uv } = fixture();
		// Built with this machine's own separator and read with its own rules, so the test holds on Windows too.
		expect(findOnPath("uv", ["", "/nowhere", bin].join(delimiter))).toBe(uv);
		expect(findOnPath("uv", undefined)).toBeUndefined();
		expect(findOnPath("nope", bin)).toBeUndefined();
	});
});

describe("a service the player already runs", () => {
	test("calls go to the URL with the token from the environment; nothing is started", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const spawned: unknown[] = [];
		const service = createResearchService(
			{ VOXREN_RESEARCH_URL: "https://tools.example.com/", VOXREN_RESEARCH_TOKEN: " remote-token " },
			{
				fetchImpl: async (url, init) => {
					requests.push({ url, init });
					return json({ videos: [] });
				},
				spawn: (() => spawned.push(1)) as any,
			},
		)!;
		expect(await service.call("/youtube/search", { query: "fizz" })).toEqual({ videos: [] });
		expect(requests[0].url).toBe("https://tools.example.com/youtube/search");
		expect(requests[0].init?.method).toBe("POST");
		expect((requests[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer remote-token");
		expect(JSON.parse(String(requests[0].init?.body))).toEqual({ query: "fizz" });
		expect(spawned).toEqual([]);
	});

	test("a remote service holds its own keys: no Gemini, Brave, or Perplexity key is sent to it, in a header or a body", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const service = createResearchService(
			{ VOXREN_RESEARCH_URL: "https://tools.example.com", VOXREN_RESEARCH_TOKEN: "remote-token", VOXREN_GEMINI_API_KEY: "gemini-secret", BRAVE_API_KEY: "brave-secret", PERPLEXITY_API_KEY: "pplx-secret" },
			{
				fetchImpl: async (url, init) => {
					requests.push({ url, init });
					return json({ videos: [] });
				},
			},
		)!;
		await service.call("/youtube/transcript", { video_id: "aaaaaaaaaaa" });
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests[0])).not.toMatch(/gemini-secret|brave-secret|pplx-secret/);
	});

	test("a call's own timeout replaces the default wait: a slow answer is cut by a short one and comes through a long one", async () => {
		const answersAfter = (ms: number) => (_url: string, init?: RequestInit) =>
			new Promise<Response>((resolve, reject) => {
				const timer = setTimeout(() => resolve(json({ ok: true })), ms);
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new Error("aborted"));
				});
			});
		const service = createResearchService({ VOXREN_RESEARCH_URL: "http://127.0.0.1:9", VOXREN_RESEARCH_TOKEN: "t" }, { fetchImpl: answersAfter(150) as any })!;
		await expect(service.call("/youtube/transcript", {}, undefined, 20)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", serviceCode: "timeout" });
		expect(await service.call("/youtube/transcript", {}, undefined, 5000)).toEqual({ ok: true });
	});

	test("with no timeout argument a call still waits 60 s; with one it waits that long", async () => {
		const service = createResearchService({ VOXREN_RESEARCH_URL: "http://127.0.0.1:9", VOXREN_RESEARCH_TOKEN: "t" }, { fetchImpl: async () => json({ ok: true }) })!;
		const delays: number[] = [];
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
			if (ms) delays.push(ms);
			return (realSetTimeout as any)(handler, ms, ...rest);
		}) as any;
		try {
			await service.call("/web/search", {});
			await service.call("/youtube/transcript", {}, undefined, 240_000);
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
		expect(delays.filter((ms) => ms >= 10_000)).toEqual([60_000, 240_000]);
	});

	/** Runs `run` with the clock's timers watched: the delays of every timer of 10 s or more still pending afterwards. Any left over are cleared. */
	async function pendingLongTimers(run: () => Promise<unknown>): Promise<number[]> {
		const pending = new Map<unknown, number>();
		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
			const id = (realSetTimeout as any)(handler, ms, ...rest);
			if ((ms ?? 0) >= 10_000) pending.set(id, ms as number);
			return id;
		}) as any;
		globalThis.clearTimeout = ((id: unknown) => {
			pending.delete(id);
			return (realClearTimeout as any)(id);
		}) as any;
		try {
			await run().catch(() => {});
		} finally {
			globalThis.setTimeout = realSetTimeout;
			globalThis.clearTimeout = realClearTimeout;
		}
		const left = [...pending.values()];
		for (const id of pending.keys()) realClearTimeout(id as any);
		return left;
	}

	test("a call leaves no long timer pending once it settles, however it ends, so it never holds a finished print-mode run open", async () => {
		const options = { VOXREN_RESEARCH_URL: "http://127.0.0.1:9", VOXREN_RESEARCH_TOKEN: "t" };
		// Like fetch: an already-aborted signal rejects at once.
		const hangsUntilAborted = (_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				if (init?.signal?.aborted) reject(new Error("aborted"));
				else init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const answered = createResearchService(options, { fetchImpl: async () => json({ ok: true }) })!;
		expect(await pendingLongTimers(() => answered.call("/youtube/transcript", {}, undefined, 240_000))).toEqual([]);
		const refused = createResearchService(options, { fetchImpl: async () => json({ detail: { code: "rate_limited", message: "wait" } }, 429) })!;
		expect(await pendingLongTimers(() => refused.call("/youtube/transcript", {}, undefined, 240_000))).toEqual([]);
		const cutOff = createResearchService(options, { fetchImpl: hangsUntilAborted as any })!;
		const controller = new AbortController();
		expect(
			await pendingLongTimers(() => {
				const pending = cutOff.call("/youtube/transcript", {}, controller.signal, 240_000);
				setTimeout(() => controller.abort(), 5);
				return pending;
			}),
		).toEqual([]);
		const already = new AbortController();
		already.abort();
		expect(await pendingLongTimers(() => cutOff.call("/youtube/transcript", {}, already.signal, 240_000))).toEqual([]);
	});

	test("the service's own error codes become tool errors the model can act on", async () => {
		const reply = { current: json({}) };
		const service = createResearchService({ VOXREN_RESEARCH_URL: "http://127.0.0.1:9", VOXREN_RESEARCH_TOKEN: "t" }, { fetchImpl: async () => reply.current })!;
		const cases: Array<[Response, string, string]> = [
			[json({ detail: { code: "rate_limited", message: "wait" } }, 429), "RATE_LIMITED", "rate_limited"],
			[json({ detail: { code: "auth_invalid", message: "no" } }, 401), "CONFIGURATION", "auth_invalid"],
			[json({ detail: { code: "search_unconfigured", message: "no key" } }, 503), "CONFIGURATION", "search_unconfigured"],
			[json({ detail: { code: "url_blocked", message: "private" } }, 422), "VALIDATION", "url_blocked"],
			[json({ detail: [{ loc: ["body", "query"], msg: "too short" }] }, 422), "VALIDATION", "invalid_request"],
			[json({ detail: { code: "not_archived", message: "none" } }, 404), "UPSTREAM_UNAVAILABLE", "not_archived"],
			[json({ detail: "boom" }, 500), "UPSTREAM_UNAVAILABLE", "service_error"],
			[new Response("<html>", { status: 200 }), "MALFORMED_RESPONSE", "not_json"],
		];
		for (const [response, safe, code] of cases) {
			reply.current = response;
			const error = await service.call("/web/read", { url: "https://example.org" }).catch((caught) => caught);
			expect(error).toBeInstanceOf(ResearchServiceError);
			expect([error.code, error.serviceCode]).toEqual([safe, code]);
		}
		const unreachable = createResearchService({ VOXREN_RESEARCH_URL: "http://127.0.0.1:9", VOXREN_RESEARCH_TOKEN: "t" }, { fetchImpl: async () => Promise.reject(new Error("ECONNREFUSED")) })!;
		await expect(unreachable.call("/health", {})).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", serviceCode: "service_unreachable" });
	});

	test("a service error carries the HTTP status and the service's message, so a log line can tell a refused key from no results", async () => {
		const reply = { current: json({}) };
		const service = createResearchService({ VOXREN_RESEARCH_URL: "http://127.0.0.1:9", VOXREN_RESEARCH_TOKEN: "t" }, { fetchImpl: async () => reply.current })!;
		const failure = async (response: Response) => {
			reply.current = response;
			return service.call("/web/search", { query: "second dragon timing" }).catch((caught) => caught);
		};
		const refused = await failure(json({ detail: { code: "search_unavailable", message: "No search provider answered: perplexity HTTP 401." } }, 502));
		expect([refused.serviceCode, refused.status, refused.detail]).toEqual(["search_unavailable", 502, "No search provider answered: perplexity HTTP 401."]);

		// A long message is clipped, never passed whole.
		const long = await failure(json({ detail: { code: "search_unavailable", message: "x".repeat(500) } }, 502));
		expect(long.detail).toBe("x".repeat(200));

		// FastAPI's own 422 sends detail as a list, and a message that is not text is no message: the error still maps, with no detail.
		const listed = await failure(json({ detail: [{ loc: ["body", "query"], msg: "too short" }] }, 422));
		expect([listed.code, listed.serviceCode, listed.status, listed.detail]).toEqual(["VALIDATION", "invalid_request", 422, undefined]);
		const odd = await failure(json({ detail: { code: "search_unavailable", message: 502 } }, 502));
		expect([odd.serviceCode, odd.status, odd.detail]).toEqual(["search_unavailable", 502, undefined]);

		// No answer at all has no status.
		const unreachable = createResearchService({ VOXREN_RESEARCH_URL: "http://127.0.0.1:9", VOXREN_RESEARCH_TOKEN: "t" }, { fetchImpl: async () => Promise.reject(new Error("ECONNREFUSED")) })!;
		const down = await unreachable.call("/health", {}).catch((caught) => caught);
		expect([down.serviceCode, down.status, down.detail]).toEqual(["service_unreachable", undefined, undefined]);
	});
});

describe("a local copy the coach starts", () => {
	function local(options: { healthyAfter?: number; startTimeoutMs?: number; health?: () => Response; pollMs?: number; platform?: NodeJS.Platform; environment?: Record<string, string>; pid?: number } = {}) {
		const { bin, service, uv } = fixture();
		const started: Array<{ command: string; args: string[]; env: Record<string, string>; options: Record<string, unknown>; child: any; handoff?: Record<string, string> }> = [];
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const treesEnded: number[] = [];
		const agentDir = mkdtempSync(join(tmpdir(), "research-handoff-"));
		let healthChecks = 0;
		const research = createResearchService(
			{ PATH: bin, HOME: "/coach/pi-agent/home", PI_CODING_AGENT_DIR: agentDir, PERPLEXITY_API_KEY: "pplx", VOXREN_GEMINI_API_KEY: "gem", GEMINI_API_KEY: "bare-never-sent", TYPESAFE_API_KEY: "never-sent", VOXREN_COACH_ACCOUNTS: "Player#NA1", ...options.environment },
			{
				serviceDir: service,
				platform: options.platform ?? "darwin",
				killPid: (pid) => treesEnded.push(pid),
				sharing: false,
				freePort: async () => 41234,
				token: () => "run-token",
				// No wait between health probes by default; a test that needs the event loop to turn while the service starts asks for a real one.
				sleep: options.pollMs ? () => new Promise<void>((resolve) => setTimeout(resolve, options.pollMs)) : async () => {},
				startTimeoutMs: options.startTimeoutMs,
				spawn: ((command: string, args: string[], spawnOptions: { env: Record<string, string> }) => {
					const child = fakeChild();
					child.pid = options.pid;
					const file = spawnOptions.env.VOXREN_LAUNCH_SECRETS;
					started.push({ command, args, env: spawnOptions.env, options: spawnOptions, child, handoff: file ? JSON.parse(readFileSync(file, "utf8")) : undefined });
					return child;
				}) as any,
				fetchImpl: async (url, init) => {
					requests.push({ url, init });
					if (url.endsWith("/health")) {
						healthChecks += 1;
						if (healthChecks <= (options.healthyAfter ?? 0)) throw new Error("ECONNREFUSED");
						return options.health ? options.health() : json({ status: "ready", service: "research-tools" });
					}
					return json({ ok: true });
				},
			},
		)!;
		return { research, started, requests, uv, service, agentDir, treesEnded };
	}

	test("nothing starts until the first call; then uv runs the service on loopback with a token made for this run", async () => {
		const { research, started, requests, uv, service } = local({ healthyAfter: 2 });
		expect(started).toEqual([]);
		const [first, second] = await Promise.all([research.call("/youtube/search", { query: "fizz" }), research.call("/web/read", { url: "https://example.org" })]);
		expect([first, second]).toEqual([{ ok: true }, { ok: true }]);
		// Two calls at once share one start.
		expect(started).toHaveLength(1);
		expect(started[0].command).toBe(uv);
		expect(started[0].args).toEqual(["run", "--frozen", "--no-dev", "--directory", service, "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "41234", "--log-level", "warning"]);
		// The child gets what it needs to run and the search and Gemini keys, never the rest of the coach's environment. The Gemini key arrives as VOXREN_GEMINI_API_KEY, because Pi's own Google provider reads GEMINI_API_KEY, and leaves as the service's own RESEARCH_TOOLS_GEMINI_API_KEY.
		// The keys are in a 0600 file named in the environment (read once and deleted by the service), never in the environment itself (#371).
		expect(started[0].env).toEqual({ PATH: started[0].env.PATH, HOME: "/coach/pi-agent/home", VOXREN_LAUNCH_SECRETS: started[0].env.VOXREN_LAUNCH_SECRETS, RESEARCH_TOOLS_TOKEN: "run-token", RESEARCH_TOOLS_EXIT_ON_STDIN_EOF: "1", RESEARCH_TOOLS_CACHE_DIR: expect.any(String) });
		expect(started[0].handoff).toEqual({ PERPLEXITY_API_KEY: "pplx", VOXREN_GEMINI_API_KEY: "gem" });
		expect(existsSync(started[0].env.VOXREN_LAUNCH_SECRETS)).toBe(false);
		// It can never keep a finished run alive.
		expect(started[0].child.unrefs).toBe(2);
		expect(requests.filter((request) => request.url === "http://127.0.0.1:41234/health")).toHaveLength(3);
		const call = requests.find((request) => request.url === "http://127.0.0.1:41234/youtube/search")!;
		expect((call.init?.headers as Record<string, string>).Authorization).toBe("Bearer run-token");
	});

	test("warm starts it ahead of the first call; close ends stdin and kills it; a closed service refuses calls", async () => {
		const { research, started } = local();
		research.warm();
		research.warm();
		await research.call("/youtube/search", { query: "fizz" });
		expect(started).toHaveLength(1);
		await research.close();
		expect(started[0].child.stdinEnded).toBe(true);
		expect(started[0].child.killed).toBe(true);
		await expect(research.call("/youtube/search", { query: "fizz" })).rejects.toMatchObject({ serviceCode: "service_closed" });
		expect(started).toHaveLength(1);
	});

	test("a service that never answers is killed and reported; the next call tries a fresh start", async () => {
		const { research, started } = local({ healthyAfter: Number.POSITIVE_INFINITY, startTimeoutMs: 20 });
		await expect(research.call("/youtube/search", { query: "fizz" })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", serviceCode: "service_unreachable" });
		expect(started[0].child.killed).toBe(true);
		await expect(research.call("/youtube/search", { query: "fizz" })).rejects.toMatchObject({ serviceCode: "service_unreachable" });
		expect(started).toHaveLength(2);
	});

	test("something else answering on the port is never treated as the service, so the token is never sent to it", async () => {
		const { research, requests } = local({ health: () => json({ status: "ok", service: "something-else" }), startTimeoutMs: 20 });
		await expect(research.call("/youtube/search", { query: "fizz" })).rejects.toMatchObject({ serviceCode: "service_unreachable" });
		expect(requests.every((request) => request.url.endsWith("/health"))).toBe(true);
		expect(requests.some((request) => JSON.stringify(request.init?.headers ?? {}).includes("run-token"))).toBe(false);
	});

	test("a service that dies after it started is started again by the next call", async () => {
		const { research, started } = local();
		await research.call("/youtube/search", { query: "fizz" });
		started[0].child.emit("exit", 1);
		await research.call("/youtube/search", { query: "fizz" });
		expect(started).toHaveLength(2);
	});

	test("a cancelled turn stops waiting even while the service is still starting", async () => {
		const { research } = local({ healthyAfter: Number.POSITIVE_INFINITY, startTimeoutMs: 5000, pollMs: 5 });
		const controller = new AbortController();
		const pending = research.call("/youtube/search", { query: "fizz" }, controller.signal);
		const before = Date.now();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", serviceCode: "cancelled" });
		expect(Date.now() - before).toBeLessThan(1000);
		const already = new AbortController();
		already.abort();
		await expect(research.call("/youtube/search", { query: "fizz" }, already.signal)).rejects.toMatchObject({ serviceCode: "cancelled" });
		await research.close();
	});

	test("a cold start counts against the call's own wait: a service slow to start cuts the call off at its timeout, not at the start deadline", async () => {
		const { research } = local({ healthyAfter: Number.POSITIVE_INFINITY, startTimeoutMs: 5000, pollMs: 5 });
		const before = Date.now();
		await expect(research.call("/youtube/research", {}, undefined, 50)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", serviceCode: "timeout" });
		expect(Date.now() - before).toBeLessThan(1000);
		await research.close();
	});

	test("on Windows the coach starts it too: windowless Python, the three variables Python and uv need, the keys in the file, nothing else", async () => {
		const windowsOnly = { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", USERPROFILE: "C:\\Users\\player", APPDATA: "C:\\Users\\player\\AppData\\Roaming", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
		const { research, started, uv, service } = local({ platform: "win32", environment: windowsOnly });
		expect(await research.call("/web/search", { query: "fizz" })).toEqual({ ok: true });
		expect(started[0].command).toBe(uv);
		// pythonw, not the console program uvicorn: a console program under a detached uv opens a terminal window of its own.
		expect(started[0].args).toEqual(["run", "--frozen", "--no-dev", "--directory", service, "pythonw", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "41234", "--log-level", "warning"]);
		expect(started[0].options.windowsHide).toBe(true);
		expect(started[0].env).toEqual({ PATH: started[0].env.PATH, HOME: "/coach/pi-agent/home", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", USERPROFILE: "C:\\Users\\player", VOXREN_LAUNCH_SECRETS: started[0].env.VOXREN_LAUNCH_SECRETS, RESEARCH_TOOLS_TOKEN: "run-token", RESEARCH_TOOLS_EXIT_ON_STDIN_EOF: "1", RESEARCH_TOOLS_CACHE_DIR: expect.any(String) });
		expect(started[0].handoff).toEqual({ PERPLEXITY_API_KEY: "pplx", VOXREN_GEMINI_API_KEY: "gem" });
		// Off Windows none of the three is passed, and the server is uvicorn itself.
		const mac = local({ environment: windowsOnly });
		await mac.research.call("/web/search", { query: "fizz" });
		expect(Object.keys(mac.started[0].env).filter((name) => name in windowsOnly)).toEqual([]);
		expect(mac.started[0].args).toContain("uvicorn");
		expect(mac.started[0].args).not.toContain("pythonw");
	});

	test("on Windows a service is ended by its process tree, at close and when it never answers: ending uv alone leaves its Python serving", async () => {
		const closed = local({ platform: "win32", pid: 7001 });
		await closed.research.call("/web/search", { query: "fizz" });
		await closed.research.close();
		expect(closed.started[0].child.stdinEnded).toBe(true);
		expect(closed.treesEnded).toEqual([7001]);
		expect(closed.started[0].child.killed).toBe(false);
		const silent = local({ platform: "win32", pid: 7002, healthyAfter: Number.POSITIVE_INFINITY, startTimeoutMs: 20 });
		await expect(silent.research.call("/web/search", { query: "fizz" })).rejects.toMatchObject({ serviceCode: "service_unreachable" });
		expect(silent.treesEnded).toEqual([7002]);
		// Off Windows uv is the service (it execs), so the child itself is signalled.
		const mac = local({ pid: 7003 });
		await mac.research.call("/web/search", { query: "fizz" });
		await mac.research.close();
		expect([mac.started[0].child.killed, mac.treesEnded]).toEqual([true, []]);
	});

	test("the tree is ended by taskkill at its absolute path under SystemRoot, never a bare name PATH could supply", () => {
		expect(treeKillCommand(4242, { SystemRoot: "D:\\WinNT" })).toEqual({ command: "D:\\WinNT\\System32\\taskkill.exe", args: ["/PID", "4242", "/T", "/F"] });
		expect(treeKillCommand(4242, { windir: "E:\\Windows" }).command).toBe("E:\\Windows\\System32\\taskkill.exe");
		expect(treeKillCommand(4242, {}).command).toBe("C:\\Windows\\System32\\taskkill.exe");
	});

	// Real processes, so only where taskkill exists: a parent standing in for uv and the child it waits on, as on Windows.
	test.skipIf(process.platform !== "win32")("on a real Windows machine a service that never answers is ended with the process uv started", async () => {
		const { bin, service } = fixture();
		const idle = "setTimeout(() => {}, 60000)";
		const parent = spawn(process.execPath, ["-e", `const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(idle)}], { stdio: "ignore" }); console.log(child.pid); ${idle}`], { stdio: ["ignore", "pipe", "ignore"] });
		const grandchild = await new Promise<number>((resolve) => parent.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				// The probe's ordinary answer for a pid that is gone.
				return false;
			}
		};
		try {
			expect([alive(parent.pid!), alive(grandchild)]).toEqual([true, true]);
			const research = createResearchService({ PATH: bin, SystemRoot: process.env.SystemRoot }, { serviceDir: service, platform: "win32", sharing: false, freePort: async () => 41236, sleep: async () => {}, startTimeoutMs: 20, spawn: (() => parent) as any, fetchImpl: async () => Promise.reject(new Error("ECONNREFUSED")) })!;
			await expect(research.call("/web/search", { query: "fizz" })).rejects.toMatchObject({ serviceCode: "service_unreachable" });
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && (alive(parent.pid!) || alive(grandchild))) await new Promise((resolve) => setTimeout(resolve, 50));
			expect([alive(parent.pid!), alive(grandchild)]).toEqual([false, false]);
		} finally {
			for (const pid of [parent.pid!, grandchild]) if (alive(pid)) process.kill(pid);
		}
	});

	test("a child that dies while starting stops the wait at once", async () => {
		const { bin, service } = fixture();
		const research = createResearchService(
			{ PATH: bin },
			{
				serviceDir: service,
				platform: "darwin",
				freePort: async () => 41235,
				sleep: async () => {},
				spawn: (() => {
					const child = fakeChild();
					queueMicrotask(() => child.emit("exit", 1));
					return child;
				}) as any,
				fetchImpl: async () => Promise.reject(new Error("ECONNREFUSED")),
			},
		)!;
		const before = Date.now();
		await expect(research.call("/youtube/search", { query: "fizz" })).rejects.toMatchObject({ serviceCode: "service_unreachable" });
		expect(Date.now() - before).toBeLessThan(2000);
	});
});

describe("windows that share one service", () => {
	/** A coach home, a fake machine (which pids are alive, which service answers, with which token) and any number of windows on it. */
	function machine(platform: NodeJS.Platform = "darwin") {
		const { bin, service } = fixture();
		const home = mkdtempSync(join(tmpdir(), "research-home-"));
		const world = { children: [] as any[], options: [] as Array<Record<string, unknown>>, spawned: [] as Array<{ pid: number; token: string }>, alive: new Set<number>(), killed: [] as number[], up: undefined as { pid: number; token: string } | undefined, nextPid: 5000 };
		const environment = { PATH: bin, PI_CODING_AGENT_DIR: join(home, "agent") };
		const statePath = researchStatePath(environment, service)!;
		const window = (pid: number) => {
			world.alive.add(pid);
			let tokens = 0;
			return createResearchService(environment, {
				serviceDir: service,
				platform,
				pid,
				freePort: async () => 41000 + world.nextPid,
				token: () => `token-${pid}-${(tokens += 1)}`,
				sleep: async () => {},
				alive: (other) => world.alive.has(other),
				killPid: (other) => {
					world.killed.push(other);
					world.alive.delete(other);
					if (world.up?.pid === other) world.up = undefined;
				},
				spawn: ((_command: string, _args: string[], options: { env: Record<string, string> }) => {
					const child = fakeChild();
					child.pid = world.nextPid++;
					world.children.push(child);
					world.alive.add(child.pid);
					world.up = { pid: child.pid, token: options.env.RESEARCH_TOOLS_TOKEN };
					world.spawned.push(world.up);
					world.options.push(options);
					return child;
				}) as any,
				fetchImpl: async (url, init) => {
					if (!world.up) throw new Error("ECONNREFUSED");
					if (url.endsWith("/health")) return json({ status: "ready", service: "research-tools" });
					return (init?.headers as Record<string, string>).Authorization === `Bearer ${world.up.token}` ? json({ ok: true }) : json({ detail: { code: "auth_invalid" } }, 401);
				},
			})!;
		};
		return { world, window, statePath, service };
	}

	test("two windows on one home start the service once, and the state file is 0600 with the port, pid and token", async () => {
		const { world, window, statePath } = machine();
		const [a, b] = [window(101), window(102)];
		expect(await Promise.all([a.call("/youtube/search", {}), b.call("/youtube/search", {})])).toEqual([{ ok: true }, { ok: true }]);
		expect(world.spawned).toHaveLength(1);
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		expect(state).toMatchObject({ port: expect.any(Number), pid: world.spawned[0].pid, token: world.spawned[0].token });
		// Windows has no POSIX mode bits to read back: the file sits in the user's own profile there.
		if (process.platform !== "win32") expect(statSync(statePath).mode & 0o777).toBe(0o600);
	});

	test("the service ends with the last window out, not the first", async () => {
		const { world, window, statePath } = machine();
		const [a, b] = [window(101), window(102)];
		await a.call("/youtube/search", {});
		await b.call("/youtube/search", {});
		await a.close();
		// Window a started it, but it is no longer a's to kill.
		expect(world.children[0].killed).toBe(false);
		expect(world.killed).toEqual([]);
		expect(existsSync(statePath)).toBe(true);
		expect(await b.call("/youtube/search", {})).toEqual({ ok: true });
		await b.close();
		expect(world.killed).toEqual([world.spawned[0].pid]);
		expect(existsSync(statePath)).toBe(false);
	});

	test("a window that never used the service leaves it alone when it closes", async () => {
		const { world, window, statePath } = machine();
		const [a, idle] = [window(101), window(102)];
		await a.call("/youtube/search", {});
		await idle.close();
		expect(world.killed).toEqual([]);
		expect(existsSync(statePath)).toBe(true);
	});

	test("a state file left by dead windows is replaced, and the service it named is stopped", async () => {
		const { world, window, statePath } = machine();
		const first = window(101);
		await first.call("/youtube/search", {});
		// The window is killed with -9: no close, no cleanup.
		world.alive.delete(101);
		const second = window(102);
		expect(await second.call("/youtube/search", {})).toEqual({ ok: true });
		expect(world.spawned).toHaveLength(2);
		expect(world.killed).toEqual([world.spawned[0].pid]);
		expect(JSON.parse(readFileSync(statePath, "utf8")).pid).toBe(world.spawned[1].pid);
	});

	test("on Windows too: one service for two windows, started detached with no window, outliving its starter and ended by the last window out", async () => {
		const { world, window, statePath } = machine("win32");
		const [a, b] = [window(101), window(102)];
		expect(await Promise.all([a.call("/youtube/search", {}), b.call("/youtube/search", {})])).toEqual([{ ok: true }, { ok: true }]);
		expect(world.spawned).toHaveLength(1);
		expect(world.options[0]).toMatchObject({ detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
		await a.close();
		expect(world.killed).toEqual([]);
		expect(await b.call("/youtube/search", {})).toEqual({ ok: true });
		await b.close();
		expect(world.killed).toEqual([world.spawned[0].pid]);
		expect(existsSync(statePath)).toBe(false);
	});

	test("a record whose token the service refuses is replaced, not reused", async () => {
		const { world, window, statePath } = machine();
		const first = window(101);
		await first.call("/youtube/search", {});
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		writeFileSync(statePath, JSON.stringify({ ...state, token: "not-the-token" }), { mode: 0o600 });
		const second = window(102);
		expect(await second.call("/youtube/search", {})).toEqual({ ok: true });
		expect(world.spawned).toHaveLength(2);
	});
});
