/**
 * A worker is a second, plain Pi run once for one prompt: no coach tools, no coach prompt, no session file. The coach
 * uses it for side jobs that need a model but must not touch the player's conversation: a hosted web search
 * (src/hosted-search.ts) and the matchup-note builder's distil and merge steps.
 *
 * It runs the same Pi binary this process is, with the same environment, so it signs in the same way.
 */
import { handoffDir, LAUNCH_SECRETS_VAR, PROVIDER_KEY_NAMES, SECRET_ENV_NAMES, writeHandoff } from "./launch-secrets.mjs";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logEvent } from "./coach-log";
import { COACH_TIERS, DEFAULT_PROVIDER, type TierName } from "./contracts";
import { SafeToolError } from "./policy";
import { USAGE_MARKER, type WorkerUsage } from "./worker-extension";

export type { WorkerUsage };

const WORKER_EXTENSION = fileURLToPath(new URL("./worker-extension.ts", import.meta.url));
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** Of a stderr line still waiting for its newline, this much is kept: a usage line is under 300 characters. */
const STDERR_TAIL_CHARS = 4096;
/** The worker's own wall-clock cap, past every caller's timeout: it ends itself even when this process is gone. */
export const WORKER_HARD_DEADLINE_MS = 300_000;
/** Workers running at once in one process; each is a whole Pi, so the rest wait their turn. */
export const MAX_CONCURRENT_WORKERS = 2;
/** How long a killed worker has to exit before it is sent SIGKILL. */
const KILL_GRACE_MS = 3000;

export interface WorkerRequest {
	/** The instruction. Kept short: a Windows command line holds about 32,000 characters. */
	prompt: string;
	/** Long material the prompt is about (a transcript, a page). Pi prepends piped stdin to the prompt. */
	material?: string;
	/** Replaces Pi's own system prompt. */
	system?: string;
	/** Let the provider run its hosted web search during the turn. */
	hostedSearch?: boolean;
	/** Which coach tier's model and thinking level to run; quick unless set. */
	tier?: TierName;
	timeoutMs?: number;
	signal?: AbortSignal;
	/**
	 * Called once when the run ends, ended well or not, with what it used. Not called when the worker reported nothing (a run killed
	 * before its first answer, a worker that never started). The answer is still the returned string, so a caller that does not care ignores this.
	 */
	onUsage?: (usage: WorkerUsage) => void;
}

/** `close` kills every worker this one started; the gateway calls it at shutdown. */
export type PiWorker = ((request: WorkerRequest) => Promise<string>) & { close?: () => void };

export interface PiWorkerDeps {
	spawn?: (command: string, args: string[], options: { env: Record<string, string | undefined>; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcess;
	/** Pi's entry script; inside a running Pi that is process.argv[1]. */
	entry?: string;
	execPath?: string;
	killGraceMs?: number;
}

/** The provider and model a worker runs: the launch's own provider, and its pinned model when the launch pinned one. */
export function workerModel(environment: Record<string, string | undefined>, tier: TierName): { provider: string; model: string; thinking: string } {
	const row = COACH_TIERS[tier];
	return { provider: environment.VOXREN_COACH_PROVIDER?.trim() || DEFAULT_PROVIDER, model: environment.VOXREN_COACH_MODEL?.trim() || row.model, thinking: environment.VOXREN_COACH_THINKING?.trim() || row.thinking };
}

export function workerArgs(entry: string, environment: Record<string, string | undefined>, request: WorkerRequest): string[] {
	const { provider, model, thinking } = workerModel(environment, request.tier ?? "quick");
	return [
		entry,
		"--no-extensions",
		"--extension", WORKER_EXTENSION,
		"--no-builtin-tools",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-session",
		"--provider", provider,
		"--model", model,
		"--thinking", thinking,
		...(request.system ? ["--system-prompt", request.system] : []),
		"--print", request.prompt,
	];
}

/** The usage a worker wrote on one stderr line, or undefined for any other line (Pi writes its own warnings there too). */
export function readUsageLine(line: string): WorkerUsage | undefined {
	const at = line.indexOf(USAGE_MARKER);
	if (at === -1) return undefined;
	try {
		const value = JSON.parse(line.slice(at + USAGE_MARKER.length)) as Record<string, unknown>;
		const whole = (field: unknown): field is number => typeof field === "number" && Number.isFinite(field) && field >= 0;
		if (!whole(value.input) || !whole(value.output) || !whole(value.cacheRead) || !whole(value.cacheWrite) || (value.cost !== undefined && !whole(value.cost))) throw new Error("usage line has a missing or negative count");
		return { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, ...(value.cost ? { cost: value.cost } : {}) };
	} catch (error) {
		logEvent("warn", "pi-worker", "usage-line-unreadable", undefined, error);
		return undefined;
	}
}

/** argv[1] when it is Pi's entry script (`pi`, or its `cli.js` when started through node), else undefined: a test runner or a lab script must never be started again as if it were Pi. */
export function piEntry(script: string | undefined): string | undefined {
	return script && /(^|[\\/])(pi|cli\.js)$/.test(script) && existsSync(script) ? script : undefined;
}

/** Undefined when this process is not a Pi run (no entry script to start again), so callers can say the job is unavailable. */
/**
 * A worker is a Pi process of its own with a process title: it gets its provider's key and none of the coach's other keys,
 * and not in its environment (#371): the key goes in a fresh 0600 file the worker extension reads once and deletes.
 */
function workerEnvironment(environment: Record<string, string | undefined>): { env: Record<string, string | undefined>; cleanup: () => void } {
	const rest = { ...environment };
	for (const name of SECRET_ENV_NAMES) delete rest[name];
	delete rest[LAUNCH_SECRETS_VAR];
	const keys = Object.fromEntries(PROVIDER_KEY_NAMES.filter((name) => environment[name]).map((name) => [name, environment[name] as string]));
	if (Object.keys(keys).length === 0) return { env: rest, cleanup: () => {} };
	const { path, cleanup } = writeHandoff(keys, handoffDir(environment));
	return { env: { ...rest, [LAUNCH_SECRETS_VAR]: path }, cleanup };
}

export function createPiWorker(environment: Record<string, string | undefined> = process.env, deps: PiWorkerDeps = {}): PiWorker | undefined {
	const entry = deps.entry ?? piEntry(process.argv[1]);
	if (!entry) return undefined;
	const spawn = deps.spawn ?? (nodeSpawn as NonNullable<PiWorkerDeps["spawn"]>);
	const execPath = deps.execPath ?? process.execPath;
	const live = new Map<ChildProcess, () => void>();
	/** Requests waiting for a slot; `cancel` rejects one that was aborted or is dropped at close. */
	const queue: { start: () => void; cancel: () => void }[] = [];
	let closed = false;
	const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
	/** SIGTERM now, SIGKILL if it is still there after the grace. */
	const kill = (child: ChildProcess) => {
		child.kill();
		const escalate = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
		child.once("close", () => clearTimeout(escalate));
		// Fire-and-forget housekeeping nothing awaits (rule 8).
		escalate.unref();
	};
	const next = () => {
		while (!closed && live.size < MAX_CONCURRENT_WORKERS && queue.length) queue.shift()!.start();
	};
	const run: PiWorker = (request) =>
		new Promise<string>((resolve, reject) => {
			const unavailable = () => new SafeToolError("UPSTREAM_UNAVAILABLE");
			if (closed || request.signal?.aborted) return reject(unavailable());
			const start = () => {
				request.signal?.removeEventListener("abort", dequeue);
				const handoff = workerEnvironment(environment);
				const child = spawn(execPath, workerArgs(entry, environment, request), { env: { ...handoff.env, VOXREN_WORKER_HOSTED_SEARCH: request.hostedSearch ? "1" : "", VOXREN_WORKER_PARENT_PID: String(process.pid), VOXREN_WORKER_DEADLINE_MS: String(WORKER_HARD_DEADLINE_MS) }, stdio: ["pipe", "pipe", "pipe"] });
				const chunks: Buffer[] = [];
				let bytes = 0;
				let settled = false;
				/** The last usage line the worker wrote: each carries the totals so far. */
				let usage: WorkerUsage | undefined;
				const finish = (error?: Error) => {
					if (settled) return;
					settled = true;
					live.delete(child);
					handoff.cleanup();
					clearTimeout(timer);
					request.signal?.removeEventListener("abort", onAbort);
					try {
						if (usage) request.onUsage?.(usage);
					} catch (callerError) {
						// The caller's callback is its own: a throw there must not leave this run unsettled.
						logEvent("error", "pi-worker", "on-usage-threw", undefined, callerError);
					}
					if (error) {
						kill(child);
						reject(error);
					} else resolve(Buffer.concat(chunks).toString("utf8"));
					next();
				};
				const onAbort = () => finish(unavailable());
				live.set(child, onAbort);
				// A plain timer, cleared in finish: nothing awaits an unref'd one (AGENTS.md rule 8). It starts here, at the spawn, not at the enqueue.
				const timer = setTimeout(() => finish(unavailable()), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
				request.signal?.addEventListener("abort", onAbort, { once: true });
				child.stdout?.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > MAX_OUTPUT_BYTES) finish(new SafeToolError("MALFORMED_RESPONSE"));
					else chunks.push(chunk);
				});
				// A line is read whole even when it arrives in two chunks; only the tail of an unfinished line is kept.
				let unfinished = "";
				child.stderr?.on("data", (chunk: Buffer) => {
					const lines = (unfinished + chunk.toString("utf8")).split("\n");
					unfinished = lines.pop()!.slice(-STDERR_TAIL_CHARS);
					for (const line of lines) usage = readUsageLine(line) ?? usage;
				});
				child.on("error", () => finish(unavailable()));
				child.on("close", (code) => finish(code === 0 ? undefined : unavailable()));
				// Print mode waits on an open stdin, so it is always closed, with or without material.
				child.stdin?.on("error", () => {});
				child.stdin?.end(request.material ?? "");
			};
			const entryInQueue = { start, cancel: () => reject(unavailable()) };
			function dequeue() {
				const at = queue.indexOf(entryInQueue);
				if (at !== -1) queue.splice(at, 1);
				reject(unavailable());
			}
			if (live.size < MAX_CONCURRENT_WORKERS) return start();
			queue.push(entryInQueue);
			request.signal?.addEventListener("abort", dequeue, { once: true });
		});
	run.close = () => {
		closed = true;
		for (const stop of [...live.values()]) stop();
		for (const waiting of queue.splice(0)) waiting.cancel();
	};
	return run;
}

/** What a set of worker runs used: the sum of their reports, and how many runs there were against how many reported. */
export interface UsageTotal extends WorkerUsage {
	runs: number;
	reported: number;
	/** Reported runs Pi had no dollar price for: `cost` is the sum over the other ones. */
	unpriced: number;
}

export const noUsage = (): UsageTotal => ({ runs: 0, reported: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpriced: 0 });

export function addUsage(a: UsageTotal, b: UsageTotal): UsageTotal {
	return {
		runs: a.runs + b.runs,
		reported: a.reported + b.reported,
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		unpriced: a.unpriced + b.unpriced,
		...(a.cost === undefined && b.cost === undefined ? {} : { cost: (a.cost ?? 0) + (b.cost ?? 0) }),
	};
}

/**
 * A worker that counts: every run through it, whoever asked (a builder's distil and the hosted search it calls alike), is
 * added to one running total. `take()` hands over the total since the last take and starts again from nothing.
 */
export function measureWorker(worker: PiWorker): { worker: PiWorker; take: () => UsageTotal } {
	let total = noUsage();
	const measured: PiWorker = (request) => {
		total = addUsage(total, { ...noUsage(), runs: 1 });
		return worker({
			...request,
			onUsage: (usage) => {
				total = addUsage(total, { ...noUsage(), reported: 1, unpriced: usage.cost === undefined ? 1 : 0, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost });
				request.onUsage?.(usage);
			},
		});
	};
	measured.close = () => worker.close?.();
	return {
		worker: measured,
		take: () => {
			const taken = total;
			total = noUsage();
			return taken;
		},
	};
}
