import { posix, win32 } from "node:path";
import { createFileSink, logEvent, redactSecrets } from "./coach-log";

/**
 * One NDJSON line per model run, written to `<coach home>/exchanges.ndjson`: the prompt as the model saw it (a
 * slash command's composed text or the typed question), every tool call with its arguments, timing and result,
 * the final answer, and the run's tokens and cost. Labs parse this file instead of mining Pi's session logs.
 */
export interface ExchangeTool {
	name: string;
	args: unknown;
	ms: number;
	ok: boolean;
	/** The tool's `details` (a coach tool's gateway response) when it fits `RESULT_CAP`, else its text. */
	result: unknown;
}

export interface Exchange {
	ts: string;
	sessionId?: string;
	model?: { provider: string; id: string };
	/** The slash command that composed the prompt; absent for a typed question. */
	command?: string;
	/** The line the player typed: a command's `/name args`, or a typed question as is (equal to `prompt`). Absent for an auto run, whose `command` ends in ":auto". */
	input?: string;
	/** Set when the coach's own turn deadline aborted the run (e.g. "timeout"); absent for a run that ended on its own. */
	aborted?: string;
	prompt: string;
	/** The system prompt as forced for this run, and the tools the model could call. */
	systemPrompt?: string;
	toolsAvailable?: string[];
	thinkingLevel?: string;
	/** Every reasoning block the provider returned, in order, across the run's assistant messages. */
	reasoning: string[];
	/** Each assistant message's text (intermediate narration included) and the tool calls it made. */
	turns: Array<{ text: string; toolCalls: string[]; stopReason?: string; error?: string }>;
	answer: string;
	ms: number;
	tools: ExchangeTool[];
	usage: { input: number; output: number; costUsd: number; turns: number; /** Prompt-cache tokens read and written; absent when the provider reported none. */ cacheRead?: number; cacheWrite?: number };
}

export interface ExchangeStart {
	systemPrompt?: string;
	toolsAvailable?: string[];
}

export interface ExchangeLog {
	path: string | undefined;
	/** Tags the next run as a command's, but only if it starts on `text` (the composed prompt): a command whose turn never started tags nothing. `input` is the typed line, left out for a run the coach started itself. */
	command(name: string, text: string, input?: string): void;
	/** Returns this run's id: the ISO timestamp it started at, the same value `end()` later writes as the matching line's `ts` -- coach-log.ts's `setLogContext` reuses it as `runId` rather than inventing a second scheme. */
	start(prompt: string, meta?: ExchangeStart): string;
	toolStart(event: { toolCallId: string; toolName: string; args: unknown }): void;
	toolEnd(event: { toolCallId: string; result: unknown; isError: boolean }): void;
	end(messages: unknown[], ctx: unknown, thinkingLevel?: string, aborted?: string): Exchange | undefined;
}

/** Past this many bytes `exchanges.ndjson` rotates to `.1`, as coach.log.ndjson does (a line holds a whole system prompt and up to RESULT_CAP of a tool result). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** `value` with credentials in any string replaced (a provider error echoes the request URL, a tool's args carry one); a value that will not serialize becomes a marker. */
function redactedValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	try {
		const text = JSON.stringify(value);
		if (text === undefined) return value;
		const clean = redactSecrets(text);
		try {
			return JSON.parse(clean);
		} catch {
			// Redaction cut across a JSON escape: keep the redacted text rather than the secret.
			return clean;
		}
	} catch (error) {
		logEvent("warn", "exchange-log", "args-stringify-failed", undefined, error);
		return "[unserializable]";
	}
}

// ponytail: a flat cap on the serialized tool result; an audit with charts fits, a runaway payload is kept as text only.
const RESULT_CAP = 200_000;

/** `<coach home>/exchanges.ndjson`, the coach home being the parent of Pi's agent dir that the launcher sets; undefined outside a launch. */
/** A path in the coach home: the parent of Pi's agent dir, which the launcher sets. Undefined without a launch. */
export function coachHomePath(environment: Record<string, string | undefined>, name: string): string | undefined {
	const agentDir = environment.PI_CODING_AGENT_DIR?.trim();
	if (!agentDir) return undefined;
	// The agent dir is a Windows path on Windows: parse it with the rules that wrote it, whatever OS reads it.
	const path = agentDir.includes("\\") ? win32 : posix;
	return path.join(path.dirname(agentDir), name);
}

export function exchangeLogPath(environment: Record<string, string | undefined>): string | undefined {
	return coachHomePath(environment, "exchanges.ndjson");
}

function textOf(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function blocks(message: any, type: string, field: string): string[] {
	const content = message?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((block) => block?.type === type && typeof block[field] === "string").map((block) => block[field]);
}

function resultOf(result: any): unknown {
	const details = result?.details;
	if (details !== undefined) {
		try {
			if (JSON.stringify(details).length <= RESULT_CAP) return details;
		} catch (error) {
			logEvent("warn", "exchange-log", "result-stringify-failed", undefined, error);
		}
	}
	return textOf(result);
}

export function createExchangeLog(path: string | undefined, now: () => number = Date.now, append?: (path: string, line: string) => void, maxBytes = MAX_FILE_BYTES): ExchangeLog {
	const sink = createFileSink(path, maxBytes);
	let pendingCommand: { name: string; text: string; input?: string } | undefined;
	let run: { started: number; prompt: string; meta: ExchangeStart; command?: string; input?: string; tools: ExchangeTool[]; open: Map<string, { name: string; args: unknown; started: number }> } | undefined;
	return {
		path,
		command(name, text, input) {
			pendingCommand = { name, text, input };
		},
		start(prompt, meta = {}) {
			// A tag that does not match the starting prompt is a command whose turn never started: drop it. No tag means the player typed a question, so the prompt is the line. A command with no input is an auto run.
			const tag = pendingCommand?.text === prompt ? pendingCommand : undefined;
			const started = now();
			run = { started, prompt, meta, command: tag?.name, input: tag ? tag.input : prompt, tools: [], open: new Map() };
			pendingCommand = undefined;
			return new Date(started).toISOString();
		},
		toolStart(event) {
			run?.open.set(event.toolCallId, { name: event.toolName, args: event.args, started: now() });
		},
		toolEnd(event) {
			const open = run?.open.get(event.toolCallId);
			if (!run || !open) return;
			run.open.delete(event.toolCallId);
			run.tools.push({ name: open.name, args: redactedValue(open.args), ms: now() - open.started, ok: !event.isError, result: resultOf(event.result) });
		},
		end(messages, ctx: any, thinkingLevel, aborted) {
			if (!run) return undefined;
			const assistant = (Array.isArray(messages) ? messages : []).filter((message: any) => message?.role === "assistant");
			const usage: Exchange["usage"] = { input: 0, output: 0, costUsd: 0, turns: assistant.length };
			for (const message of assistant as any[]) {
				usage.input += message.usage?.input ?? 0;
				usage.output += message.usage?.output ?? 0;
				usage.costUsd += message.usage?.cost?.total ?? 0;
				for (const key of ["cacheRead", "cacheWrite"] as const) if (typeof message.usage?.[key] === "number") usage[key] = (usage[key] ?? 0) + message.usage[key];
			}
			usage.costUsd = Math.round(usage.costUsd * 1e6) / 1e6; // summed provider floats, kept to a micro-dollar
			const exchange: Exchange = {
				ts: new Date(run.started).toISOString(),
				sessionId: ctx?.sessionManager?.getSessionId?.(),
				model: ctx?.model?.provider && ctx?.model?.id ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				command: run.command,
				input: run.input,
				aborted,
				prompt: run.prompt,
				systemPrompt: run.meta.systemPrompt,
				toolsAvailable: run.meta.toolsAvailable,
				thinkingLevel,
				reasoning: assistant.flatMap((message: any) => blocks(message, "thinking", "thinking")),
				turns: assistant.map((message: any) => ({ text: textOf(message), toolCalls: blocks(message, "toolCall", "name"), stopReason: message.stopReason, error: typeof message.errorMessage === "string" ? redactSecrets(message.errorMessage) : message.errorMessage })),
				answer: textOf(assistant.at(-1)),
				ms: now() - run.started,
				tools: run.tools,
				usage,
			};
			run = undefined;
			if (path) {
				try {
					const line = `${JSON.stringify(exchange)}\n`;
					if (append) append(path, line);
					else sink?.(line);
				} catch (error) {
					// Unlike a best-effort fallback (a missed icon, a skipped chart), this loses the whole run's audit line.
					logEvent("error", "exchange-log", "append-failed", { path }, error);
				}
			}
			return exchange;
		},
	};
}
