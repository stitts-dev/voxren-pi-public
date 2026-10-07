/**
 * The coach's link to the research-tools service (services/research-tools, Python FastAPI): YouTube search and
 * transcripts, web search through a keyed provider, and page text, all as passages.
 *
 * Two ways to reach it. VOXREN_RESEARCH_URL (with VOXREN_RESEARCH_TOKEN) names a copy that is already running. Without
 * it the coach starts its own on 127.0.0.1 with `uv`, on the first call that needs it, on Windows as on macOS and Linux
 * (startLocal and stopChild hold what Windows does differently). Windows on one coach home share
 * one: the first publishes its port, pid and token in a 0600 file in the home (researchStatePath), later windows reuse
 * it once `/health` names the service and it accepts the token, and the last window out stops it. A file left by
 * windows that all died is replaced by the next window to start. With no coach home (or one that cannot be written)
 * the service is private to this process and exits by itself when it dies (it watches its stdin).
 */
import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvent } from "./coach-log";
import { handoffDir, LAUNCH_SECRETS_VAR, writeHandoff } from "./launch-secrets.mjs";
import { coachHomePath } from "./exchange-log";
import { SafeToolError, type FetchLike, type SafeErrorCode } from "./policy";

const SERVICE_DIR = fileURLToPath(new URL("../services/research-tools", import.meta.url));
/** First start installs Python packages; later starts take a second or two. */
const START_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;
/** One health probe may not outlast this: a port that accepts and never answers must not stall the start deadline. */
const HEALTH_TIMEOUT_MS = 2000;
/** A research call walks several videos with a gap between caption downloads. */
const CALL_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** The most of the service's message that an error keeps. */
const MAX_DETAIL_CHARS = 200;

/**
 * A failure the service named: `serviceCode` is its own stable code (rate_limited, search_unconfigured, not_archived, ...).
 * `status` is the HTTP status of its reply and `detail` its message (clipped), for a log line: neither reaches the model.
 */
export class ResearchServiceError extends SafeToolError {
	constructor(
		safe: SafeErrorCode,
		readonly serviceCode: string,
		readonly status?: number,
		readonly detail?: string,
	) {
		super(safe);
		this.name = "ResearchServiceError";
	}
}

export interface ResearchService {
	/** POST one route with a JSON body; the parsed JSON answer, or a ResearchServiceError. `timeoutMs` replaces the default wait for this one call. */
	call(path: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<any>;
	/** Start the local copy now, in the background, so the first call does not wait for it. Never throws. */
	warm(): void;
	close(): Promise<void>;
}

export interface ResearchServiceDeps {
	fetchImpl?: FetchLike;
	spawn?: (command: string, args: string[], options: { env: Record<string, string>; stdio: ["pipe" | "ignore", "ignore", "ignore"]; detached?: boolean; windowsHide?: boolean }) => ChildProcess;
	/** False keeps the service private to this process even when the coach home could hold a shared record; true unless a test says otherwise. */
	sharing?: boolean;
	/** This window's pid in the shared record; the process's own unless a test says otherwise. */
	pid?: number;
	alive?: (pid: number) => boolean;
	killPid?: (pid: number) => void;
	freePort?: () => Promise<number>;
	token?: () => string;
	serviceDir?: string;
	platform?: NodeJS.Platform;
	sleep?: (ms: number) => Promise<void>;
	startTimeoutMs?: number;
}

/** The absolute path of `name` on PATH, or undefined. */
export function findOnPath(name: string, path: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
	const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
	for (const dir of (path ?? "").split(platform === "win32" ? ";" : delimiter)) {
		if (!dir) continue;
		for (const candidate of names) if (existsSync(join(dir, candidate))) return join(dir, candidate);
	}
	return undefined;
}

/**
 * How this launch reaches the service, decided from the environment alone so the launch can say up front which tools
 * are off: a URL the player set, a local copy the coach will start, or nothing.
 */
export function researchServiceMode(environment: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform, serviceDir: string = SERVICE_DIR): { kind: "remote"; url: string } | { kind: "local"; uv: string } | { kind: "off"; reason: string } {
	const url = environment.VOXREN_RESEARCH_URL?.trim();
	if (url) {
		if (!/^https?:\/\//.test(url)) return { kind: "off", reason: "VOXREN_RESEARCH_URL must start with http:// or https://" };
		// The service refuses every call without its token, so a URL alone is not a working service.
		if (!environment.VOXREN_RESEARCH_TOKEN?.trim()) return { kind: "off", reason: "set VOXREN_RESEARCH_TOKEN to the token of the service at VOXREN_RESEARCH_URL" };
		return { kind: "remote", url: url.replace(/\/+$/, "") };
	}
	const uv = findOnPath("uv", environment.PATH, platform);
	if (!uv) return { kind: "off", reason: "install uv (https://docs.astral.sh/uv/) or set VOXREN_RESEARCH_URL" };
	if (!existsSync(join(serviceDir, "pyproject.toml"))) return { kind: "off", reason: "services/research-tools is missing from this checkout" };
	return { kind: "local", uv };
}

async function freeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
		});
	});
}

/** Where windows on one coach home publish the service they share: one file per checkout, so a window never reuses a service built from other code. */
export function researchStatePath(environment: Record<string, string | undefined>, serviceDir: string = SERVICE_DIR): string | undefined {
	return coachHomePath(environment, `research-service-${createHash("sha1").update(serviceDir).digest("hex").slice(0, 8)}.json`);
}

/** What windows publish: where the shared service is, how to talk to it, and which windows are using it. */
interface SharedState {
	port: number;
	pid: number;
	token: string;
	clients: number[];
}

/** The lock around the record is held for one check-and-start, so a wait longer than the start deadline means a holder that died. */
const LOCK_POLL_MS = 25;

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * What stops the whole service on Windows: `uv` there is a parent that waits on the Python it started, and ending `uv`
 * alone leaves that Python serving. taskkill by its absolute path, so neither the cwd nor PATH can supply the binary.
 */
export function treeKillCommand(pid: number, environment: Record<string, string | undefined>): { command: string; args: string[] } {
	return { command: win32.join(environment.SystemRoot || environment.windir || "C:\\Windows", "System32", "taskkill.exe"), args: ["/PID", String(pid), "/T", "/F"] };
}

function killTree(pid: number, environment: Record<string, string | undefined>): void {
	const { command, args } = treeKillCommand(pid, environment);
	// An empty environment: this process holds the keys in its own, and taskkill needs none of it.
	const result = spawnSync(command, args, { env: {}, stdio: "ignore", windowsHide: true });
	if (result.error || result.status !== 0) logEvent("warn", "research-service", "tree-kill-failed", { status: result.status ?? -1 }, result.error);
}

const SAFE_BY_SERVICE_CODE: Record<string, SafeErrorCode> = {
	rate_limited: "RATE_LIMITED",
	auth_invalid: "CONFIGURATION",
	auth_unconfigured: "CONFIGURATION",
	search_unconfigured: "CONFIGURATION",
	url_blocked: "VALIDATION",
	invalid_video_id: "VALIDATION",
};

export function createResearchService(environment: Record<string, string | undefined> = process.env, deps: ResearchServiceDeps = {}): ResearchService | undefined {
	const serviceDir = deps.serviceDir ?? SERVICE_DIR;
	const windows = (deps.platform ?? process.platform) === "win32";
	const mode = researchServiceMode(environment, deps.platform, serviceDir);
	if (mode.kind === "off") return undefined;
	const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let child: ChildProcess | undefined;
	let closed = false;
	let ready: Promise<{ url: string; token: string }> | undefined;
	const statePath = mode.kind === "local" && deps.sharing !== false ? researchStatePath(environment, serviceDir) : undefined;
	const myPid = deps.pid ?? process.pid;
	const alive = deps.alive ?? pidAlive;
	const killPid = deps.killPid ?? (windows ? (pid: number) => killTree(pid, environment) : (pid: number) => process.kill(pid));
	/** Ends a child this window started: on Windows by its tree, since `kill` ends `uv` alone there. */
	const stopChild = (target: ChildProcess) => (windows && target.pid ? killPid(target.pid) : target.kill());
	/** Set once this window is in the shared record: only then does closing it touch the record. */
	let shared = false;

	/** True when `url` answers /health as the research service. The port may have been picked before the service bound it, so the token is never sent anywhere that has not said so. */
	async function isService(url: string): Promise<boolean> {
		const probe = new AbortController();
		const timer = setTimeout(() => probe.abort(), HEALTH_TIMEOUT_MS);
		try {
			const response = await fetchImpl(`${url}/health`, { method: "GET", signal: probe.signal });
			return response.ok && ((await response.json()) as { service?: unknown })?.service === "research-tools";
		} catch {
			// Deliberate, documented retry probe, not a reportable error: the port refuses or times out on every
			// poll until the service finishes starting, up to every HEALTH_POLL_MS for the whole startTimeoutMs,
			// so logging it would be one warn line per poll on every ordinary cold start. The callers' own outcome
			// (a typed error when the service never comes up, a fresh start when a record is stale) is never silent.
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	/** True when the service at `url` accepts `token`: a tool route answers 401 to a wrong token before it reads the body, and 422 to an empty one with the right token, with no network behind it. */
	async function acceptsToken(url: string, token: string): Promise<boolean> {
		const probe = new AbortController();
		const timer = setTimeout(() => probe.abort(), HEALTH_TIMEOUT_MS);
		try {
			const response = await fetchImpl(`${url}/youtube/search`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: "{}", signal: probe.signal });
			return response.status !== 401 && response.status !== 503;
		} catch (error) {
			logEvent("warn", "research-service", "token-probe-failed", undefined, error);
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Tells the service which windows use it now, so it leaves when they are all gone. A failure only costs the service its early exit, so it is logged and not thrown. */
	async function registerClients(url: string, token: string, pids: number[]): Promise<void> {
		const probe = new AbortController();
		const timer = setTimeout(() => probe.abort(), HEALTH_TIMEOUT_MS);
		try {
			await fetchImpl(`${url}/clients`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ pids }), signal: probe.signal });
		} catch (error) {
			logEvent("warn", "research-service", "register-clients-failed", undefined, error);
		} finally {
			clearTimeout(timer);
		}
	}

	async function startLocal(uv: string, shareable: boolean): Promise<{ url: string; token: string; pid?: number; port: number }> {
		const port = await (deps.freePort ?? freeLoopbackPort)();
		const token = (deps.token ?? (() => randomBytes(24).toString("hex")))();
		const url = `http://127.0.0.1:${port}`;
		// An allowlist, like the key helper's: the service gets what it needs to run and nothing else from this process. A remote service holds its own keys, so none is sent to it.
		const env: Record<string, string> = { PATH: environment.PATH ?? "", RESEARCH_TOOLS_TOKEN: token };
		// A private service exits when its starter does; a shared one outlives its starter and is stopped by the last window out.
		// It also watches the pids of the windows it serves (this one first, later ones by POST /clients) and leaves when none is alive, which covers a starter that is hard-killed.
		if (shareable) env.RESEARCH_TOOLS_WATCH_PIDS = String(myPid);
		else env.RESEARCH_TOOLS_EXIT_ON_STDIN_EOF = "1";
		// On Windows Python cannot open a socket without SystemRoot, and uv finds its cache and its Pythons from the profile. Node and Bun hand a child these three themselves when they are left out; named here so the service does not rest on that.
		for (const name of ["HOME", "LANG", ...(windows ? ["SystemRoot", "TEMP", "USERPROFILE"] : [])]) if (environment[name]) env[name] = environment[name] as string;
		// The keys go in a fresh 0600 file the service reads once and deletes (app/config.py), never in its environment (#371). The Gemini key keeps the name Pi's launcher gave it: Pi's own Google provider reads GEMINI_API_KEY and would switch on with it.
		const keys = Object.fromEntries(["BRAVE_API_KEY", "PERPLEXITY_API_KEY", "VOXREN_GEMINI_API_KEY"].filter((name) => environment[name]).map((name) => [name, environment[name] as string]));
		const handoff = Object.keys(keys).length ? writeHandoff(keys, handoffDir(environment)) : undefined;
		if (handoff) env[LAUNCH_SECRETS_VAR] = handoff.path;
		const cache = coachHomePath(environment, "research-cache");
		if (cache) env.RESEARCH_TOOLS_CACHE_DIR = cache;
		const spawn = deps.spawn ?? (nodeSpawn as NonNullable<ResearchServiceDeps["spawn"]>);
		// stdin stays open and unwritten: when this process ends, however it ends, the pipe closes and the service exits.
		// On Windows a detached `uv` has no console, and the console program `uvicorn` would open a terminal window of its own; pythonw is Python with no console at all, so nothing shows.
		const server = windows ? ["pythonw", "-m", "uvicorn"] : ["uvicorn"];
		child = spawn(uv, ["run", "--frozen", "--no-dev", "--directory", serviceDir, ...server, "app.main:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], { env, stdio: [shareable ? "ignore" : "pipe", "ignore", "ignore"], windowsHide: true, ...(shareable ? { detached: true } : {}) });
		const started = child;
		let exited = false;
		// The service deletes the file as it starts; this covers one that died before reading it.
		started.once("exit", () => handoff?.cleanup());
		started.once("error", () => handoff?.cleanup());
		// A service that dies, at start or an hour in, is forgotten: the next call starts a new one instead of calling a dead port.
		const gone = () => {
			exited = true;
			if (child === started) {
				child = undefined;
				ready = undefined;
			}
		};
		child.once("exit", gone);
		child.once("error", gone);
		child.stdin?.on("error", () => {});
		// The child must never keep a finished print-mode run alive.
		child.unref();
		(child.stdin as { unref?: () => void } | null)?.unref?.();
		const deadline = Date.now() + (deps.startTimeoutMs ?? START_TIMEOUT_MS);
		while (Date.now() < deadline && !exited && !closed) {
			if (await isService(url)) {
				handoff?.cleanup();
				return { url, token, pid: started.pid, port };
			}
			await sleep(HEALTH_POLL_MS);
		}
		stopChild(started);
		handoff?.cleanup();
		if (child === started) child = undefined;
		throw new ResearchServiceError("UPSTREAM_UNAVAILABLE", "service_unreachable");
	}

	function readState(path: string): SharedState | undefined {
		try {
			const state = JSON.parse(readFileSync(path, "utf8")) as SharedState;
			return Number.isInteger(state.port) && Number.isInteger(state.pid) && typeof state.token === "string" && Array.isArray(state.clients) ? state : undefined;
		} catch (error) {
			// A missing record is the ordinary first start, not worth a line; one that exists and cannot be read is.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") logEvent("warn", "research-service", "state-unreadable", undefined, error);
			return undefined;
		}
	}

	/** Written beside the target and renamed over it, 0600 from the first byte: the token is never on disk readable by anyone else. */
	function writeState(path: string, state: SharedState): void {
		const temp = `${path}.${myPid}.tmp`;
		writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
		chmodSync(temp, 0o600);
		renameSync(temp, path);
	}

	/** One window at a time reads and changes the record. An exclusive create is the lock; a holder that died is replaced. */
	async function withLock<T>(path: string, run: () => Promise<T>): Promise<T> {
		const lock = `${path}.lock`;
		// A holder that is alive but stuck cannot be told from a slow start; waiting past the start deadline gives up instead of hanging the window.
		const giveUp = Date.now() + (deps.startTimeoutMs ?? START_TIMEOUT_MS) + HEALTH_TIMEOUT_MS;
		for (;;) {
			try {
				const fd = openSync(lock, "wx", 0o600);
				writeSync(fd, String(myPid));
				closeSync(fd);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				// ponytail: two waiters may both clear a dead holder's lock and both take it; the record's checks (health, token) still hold, so the cost is one extra service, not a wrong one.
				const holder = Number(readFileSync(lock, "utf8").trim());
				if (!holder || !alive(holder)) rmSync(lock, { force: true });
				else if (Date.now() > giveUp) throw new ResearchServiceError("UPSTREAM_UNAVAILABLE", "service_unreachable");
				else await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
			}
		}
		try {
			return await run();
		} finally {
			rmSync(lock, { force: true });
		}
	}

	/** The service the record names when it is the research service, answers to its token, and some window using it is alive. */
	async function reusable(state: SharedState): Promise<boolean> {
		if (!alive(state.pid) || !state.clients.some((client) => alive(client))) return false;
		const url = `http://127.0.0.1:${state.port}`;
		return (await isService(url)) && (await acceptsToken(url, state.token));
	}

	async function connectShared(uv: string, path: string): Promise<{ url: string; token: string }> {
		return withLock(path, async () => {
			const state = readState(path);
			if (state && (await reusable(state))) {
				const url = `http://127.0.0.1:${state.port}`;
				const clients = [...new Set([...state.clients.filter((client) => alive(client)), myPid])];
				writeState(path, { ...state, clients });
				await registerClients(url, state.token, clients);
				shared = true;
				return { url, token: state.token };
			}
			// A stale record's service is stopped, but only when it still answers as ours: a recycled pid is never signalled.
			if (state && alive(state.pid) && (await isService(`http://127.0.0.1:${state.port}`))) killPid(state.pid);
			const started = await startLocal(uv, true);
			if (started.pid) writeState(path, { port: started.port, pid: started.pid, token: started.token, clients: [myPid] });
			shared = true;
			return { url: started.url, token: started.token };
		});
	}

	/** Takes this window out of the shared record; the last one out stops the service and removes the record. */
	async function leaveShared(path: string): Promise<void> {
		await withLock(path, async () => {
			const state = readState(path);
			if (!state) return;
			const clients = state.clients.filter((client) => client !== myPid && alive(client));
			if (clients.length) {
				writeState(path, { ...state, clients });
				return registerClients(`http://127.0.0.1:${state.port}`, state.token, clients);
			}
			if (alive(state.pid) && (await isService(`http://127.0.0.1:${state.port}`))) killPid(state.pid);
			rmSync(path, { force: true });
		});
	}

	/** The shared record when the coach home can hold one; else a service private to this process. */
	async function startPrivateOrShared(uv: string): Promise<{ url: string; token: string }> {
		if (statePath) {
			try {
				mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
				return await connectShared(uv, statePath);
			} catch (error) {
				if (error instanceof ResearchServiceError) throw error;
				logEvent("warn", "research-service", "shared-state-unavailable", undefined, error);
			}
		}
		return startLocal(uv, false);
	}

	function connect(): Promise<{ url: string; token: string }> {
		if (closed) return Promise.reject(new ResearchServiceError("UPSTREAM_UNAVAILABLE", "service_closed"));
		if (!ready) {
			ready = mode.kind === "remote" ? Promise.resolve({ url: mode.url, token: environment.VOXREN_RESEARCH_TOKEN?.trim() ?? "" }) : startPrivateOrShared((mode as { uv: string }).uv);
			// A failed start is retried on the next call instead of being remembered for the whole session.
			ready.catch((error) => {
				logEvent("warn", "research-service", "start-failed", undefined, error);
				ready = undefined;
			});
		}
		return ready;
	}

	return {
		warm() {
			void connect().catch((error) => logEvent("warn", "research-service", "warm-failed", undefined, error));
		},
		async call(path, body, signal, timeoutMs = CALL_TIMEOUT_MS) {
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			if (signal?.aborted) controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				// The wait counts from here, so a cold start of the service uses up part of it.
				timer = setTimeout(() => controller.abort(), timeoutMs);
				// A cancelled turn, or a call out of time, stops waiting at once, even while the service is still starting.
				const stopped = () => (signal?.aborted ? "cancelled" : "timeout");
				const cancelled = new Promise<never>((_resolve, reject) => {
					const fail = () => reject(new ResearchServiceError("UPSTREAM_UNAVAILABLE", stopped()));
					if (controller.signal.aborted) fail();
					else controller.signal.addEventListener("abort", fail, { once: true });
				});
				// Not a swallowed error: `cancelled` only matters when it wins the race below, where its rejection
				// reason is what gets thrown. This catch exists purely so Node never reports it "unhandled" on the
				// far more common path where `connect()` wins instead and `cancelled` rejects later (or never).
				cancelled.catch(() => {});
				const { url, token } = await Promise.race([connect(), cancelled]);
				let response: Response;
				try {
					response = await fetchImpl(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: controller.signal });
				} catch {
					// A shared service that stopped answering is looked up again by the next call, as a private one that died is.
					if (shared && !controller.signal.aborted) ready = undefined;
					throw new ResearchServiceError("UPSTREAM_UNAVAILABLE", controller.signal.aborted ? stopped() : "service_unreachable");
				}
				const raw = await response.text();
				if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) throw new ResearchServiceError("MALFORMED_RESPONSE", "response_too_large");
				let parsed: any;
				try {
					parsed = JSON.parse(raw);
				} catch {
					throw new ResearchServiceError("MALFORMED_RESPONSE", "not_json");
				}
				if (response.ok) return parsed;
				const code = typeof parsed?.detail?.code === "string" ? parsed.detail.code : response.status === 422 ? "invalid_request" : "service_error";
				// FastAPI's own 422 sends detail as a list, so only a message that is text is kept.
				const message = parsed?.detail?.message;
				throw new ResearchServiceError(SAFE_BY_SERVICE_CODE[code] ?? (response.status === 422 ? "VALIDATION" : "UPSTREAM_UNAVAILABLE"), code, response.status, typeof message === "string" ? message.slice(0, MAX_DETAIL_CHARS) : undefined);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
		async close() {
			closed = true;
			ready = undefined;
			// A shared service is stopped by the last window out (leaveShared), not by the window that happened to start it.
			if (!shared) {
				child?.stdin?.end();
				if (child) stopChild(child);
			}
			child = undefined;
			if (shared && statePath) {
				shared = false;
				await leaveShared(statePath).catch((error) => logEvent("warn", "research-service", "leave-failed", undefined, error));
			}
		},
	};
}
