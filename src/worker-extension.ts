/**
 * The only extension a worker Pi loads (src/pi-worker.ts starts it with --no-extensions --extension <this file>).
 * A worker is a plain one-shot Pi with no coach tools. With VOXREN_WORKER_HOSTED_SEARCH=1 it asks the model provider
 * to run its own hosted web search for the turn, so a search costs no extra key: the provider runs it on the same sign-in.
 * Whatever the job, it also writes the run's token usage to stderr as it goes (`usageReporter`), for the caller's `onUsage`.
 */

/** The OpenAI Responses request shape, as far as this file reads it. */
interface ResponsesPayload {
	input?: unknown;
	tools?: unknown;
	[key: string]: unknown;
}

/** The payload with OpenAI's hosted web search tool added; any other request shape comes back unchanged. */
export function withHostedSearch(payload: unknown): unknown {
	const request = payload as ResponsesPayload | undefined;
	// Only the Responses API has this tool and names it this way; a chat-completions or Anthropic payload has no `input`.
	if (!request || typeof request !== "object" || !("input" in request)) return payload;
	return { ...request, tools: [...(Array.isArray(request.tools) ? request.tools : []), { type: "web_search" }] };
}

import { logEvent } from "./coach-log";
import { adoptLaunchSecrets } from "./launch-secrets.mjs";

/** What one worker run used. Tokens are what the provider reported; `cost` is the dollars Pi priced them at, absent when Pi has no price for the model. */
export interface WorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: number;
}

/** Starts the stderr line a worker writes with its usage so far; `src/pi-worker.ts` reads the last one when the run ends. */
export const USAGE_MARKER = "VOXREN_WORKER_USAGE ";

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * The handler for `message_end`: each assistant message adds its usage to a running total and writes the total as one line,
 * so a run that is killed after its answer still left its numbers. Pi's own usage record is the source: nothing is estimated here.
 */
export function usageReporter(write: (line: string) => void): (event: { message?: unknown }) => void {
	const total: WorkerUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let cost = 0;
	return (event) => {
		const message = event.message as { role?: string; usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } } } | undefined;
		if (message?.role !== "assistant" || !message.usage) return;
		total.input += count(message.usage.input);
		total.output += count(message.usage.output);
		total.cacheRead += count(message.usage.cacheRead);
		total.cacheWrite += count(message.usage.cacheWrite);
		cost += count(message.usage.cost?.total);
		write(`${USAGE_MARKER}${JSON.stringify(cost > 0 ? { ...total, cost } : total)}\n`);
	};
}

const PARENT_POLL_MS = 2000;

/** Process exists (signal 0 sends nothing); EPERM still means it exists. Works the same on macOS and Windows. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * A worker ends itself when its parent is gone and at its own wall-clock deadline, so a coach killed with SIGKILL
 * leaves no running Pi behind. Returns a function that stops both timers.
 */
export function watchParent(options: { parentPid: number; deadlineMs: number; pollMs?: number; isAlive?: (pid: number) => boolean; exit?: () => void }): () => void {
	const exit = options.exit ?? (() => process.exit(1));
	const isAlive = options.isAlive ?? pidAlive;
	// Plain housekeeping timers nothing awaits, unref'd so they never keep a finished worker alive (AGENTS.md rule 8).
	const poll = setInterval(() => {
		if (!isAlive(options.parentPid)) exit();
	}, options.pollMs ?? PARENT_POLL_MS);
	const deadline = setTimeout(exit, options.deadlineMs);
	poll.unref();
	deadline.unref();
	return () => {
		clearInterval(poll);
		clearTimeout(deadline);
	};
}

export default function voxrenWorker(pi: { on(event: "before_provider_request", handler: (event: { payload: unknown }) => unknown): unknown; on(event: "message_end", handler: (event: { message?: unknown }) => unknown): unknown }) {
	// The provider key arrives in a 0600 file, not the environment (#371); read once and deleted. A failure leaves the worker without a key, which the coach sees as an unavailable worker.
	const unreadable = adoptLaunchSecrets();
	if (unreadable) logEvent("error", "worker-extension", "launch_secrets_unreadable", undefined, unreadable);
	const parentPid = Number(process.env.VOXREN_WORKER_PARENT_PID);
	const deadlineMs = Number(process.env.VOXREN_WORKER_DEADLINE_MS);
	if (parentPid > 0 && deadlineMs > 0) watchParent({ parentPid, deadlineMs });
	// stderr, never stdout: stdout is the answer the launcher returns.
	const report = usageReporter((line) => process.stderr.write(line));
	pi.on("message_end", (event) => void report(event));
	if (process.env.VOXREN_WORKER_HOSTED_SEARCH !== "1") return;
	pi.on("before_provider_request", (event) => withHostedSearch(event.payload));
}
