import { appendFileSync, closeSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { scrubIdentifiers } from "./passage-judge";

/**
 * One NDJSON line per diagnostic event, written to `<coach home>/coach.log.ndjson`, beside `exchanges.ndjson`
 * (build its path with `coachHomePath(environment, "coach.log.ndjson")` from exchange-log.ts, the same helper
 * that resolves `exchanges.ndjson`). Every catch across the coach that used to fail silently calls `logEvent`
 * instead, so a failure that never reaches the screen is still on record; a capability that degrades (pictures,
 * icons) raises a player-visible notice through the same `raiseNotice` call, so the warning and the log line
 * are one mechanism, not two. `docs/agent-terminal.md` tells agents to read this file next to `exchanges.ndjson`.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogErrorDetails {
	name?: string;
	code?: string;
	message?: string;
	/** The first few lines of `error.stack`, when there is one. */
	stack?: string;
}

export interface LogLine {
	ts: string;
	level: LogLevel;
	component: string;
	event: string;
	sessionId?: string;
	runId?: string;
	details?: Record<string, unknown>;
	error?: LogErrorDetails;
}

/** Where `logEvent` appends one already-terminated line. Tests inject their own and read what lands. */
export type LogSink = (line: string) => void;

/** Each string in `details` or `error` is cut to this many characters before it is written. */
const MAX_DETAIL_CHARS = 500;
const MAX_STACK_CHARS = 600;
const MAX_STACK_LINES = 4;
/** Past this many bytes the file rotates to `.1` (overwriting a previous one) instead of growing forever. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

let sink: LogSink | undefined;
let sessionId: string | undefined;
let runId: string | undefined;

/** A rotation lock older than this belongs to a window that died holding it, and is taken over. */
const STALE_LOCK_MS = 10_000;

function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		// Not there yet: the sink's own logger, so there is nowhere to log to (a missing file is the routine first write).
		return 0;
	}
}

/** Rotates `path` to `.1` if it is still over `maxBytes`, but only while holding `<path>.lock`; does nothing when another window holds it. */
function rotateUnderLock(path: string, maxBytes: number): void {
	const lock = `${path}.lock`;
	let fd: number;
	try {
		fd = openSync(lock, "wx");
	} catch {
		// Held by another window (it is rotating right now) or unwritable: skip, and take over a lock a dead window left behind.
		try {
			if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
		} catch {
			// The holder just finished and removed it: the next write sees no lock.
		}
		return;
	}
	try {
		// Looked again under the lock: a window that rotated a moment ago has already made the file small.
		if (fileSize(path) >= maxBytes) renameSync(path, `${path}.1`);
	} catch {
		// A rename that fails (Windows holding the file open) leaves the file where it is; the line is still appended and the next write tries again.
	} finally {
		closeSync(fd);
		rmSync(lock, { force: true });
	}
}

/**
 * `path` (build it with `coachHomePath(environment, "coach.log.ndjson")`) to a sink that appends and rotates
 * past `maxBytes`, or undefined when `path` is undefined -- the same "no coach home configured" rule
 * `exchangeLogPath` follows, so a launch outside the coach writes nothing.
 * Several coach windows share one file, so only the window holding `<path>.lock` rotates, and it re-checks the size
 * first; every window appends whether or not it rotated, so rotation itself loses no line.
 * ponytail: the file can pass `maxBytes` by what other windows append during one rotation (a few lines); a dead
 * window's lock blocks rotation for at most STALE_LOCK_MS. Lines in the oldest file go when `.1` is replaced, by design.
 */
export function createFileSink(path: string | undefined, maxBytes = MAX_FILE_BYTES): LogSink | undefined {
	if (!path) return undefined;
	return (line) => {
		if (fileSize(path) >= maxBytes) rotateUnderLock(path, maxBytes);
		appendFileSync(path, line);
	};
}

/** The sink every `logEvent` call writes through from here on; undefined turns logging off. A test passes its own. */
export function setLogSink(next: LogSink | undefined): void {
	sink = next;
}

/**
 * Tags every later line with the running session and run. The extension calls this once a session starts
 * (Pi's own session id, the same value exchange-log.ts reads off `ctx.sessionManager.getSessionId()`) and
 * again each run starts (exchange-log's own `start()` now returns that run's id -- the exact `ts` the matching
 * line in `exchanges.ndjson` carries -- reused here rather than a second id scheme). Either field left out of
 * `next` clears it.
 */
export function setLogContext(next: { sessionId?: string; runId?: string }): void {
	sessionId = next.sessionId;
	runId = next.runId;
}

function clip(text: string, max = MAX_DETAIL_CHARS): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Secret-shaped text in whatever a network error's message or a logged detail carries: a URL query parameter, a
// header or JSON key that names a credential (`x-api-key: v`, `"X-Riot-Token":"v"`, `apiKey=v`), an Authorization
// credential, and a bare Riot key (`RGAPI-...`). Riot IDs and match ids go through scrubIdentifiers in `redact`
// below -- the same scrubbing passage-judge.ts and model-router.ts already apply before a judge call leaves the
// process, reused here rather than duplicated.
const SECRET_QUERY_PARAM = /([?&](?:key|api[-_]?key|token|access[-_]token|client[-_]secret|secret|password)=)[^&\s"'\\]+/gi;
const SECRET_NAMED_VALUE = /((?:x-api-key|x-riot-token|api[-_]?key|client[-_]secret|password)["']?\s*[:=]\s*["']?)[^&\s"',}\\]+/gi;
const AUTH_HEADER_VALUE = /(authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+)\S+/gi;
const RIOT_KEY = /RGAPI-[\w-]+/g;

/** `text` with every credential in it replaced by `[redacted]`; Riot IDs and ids are left alone (a local lab log needs them). */
export function redactSecrets(text: string): string {
	return text.replace(SECRET_QUERY_PARAM, "$1[redacted]").replace(SECRET_NAMED_VALUE, "$1[redacted]").replace(AUTH_HEADER_VALUE, "$1[redacted]").replace(RIOT_KEY, "[redacted]");
}

/** The one redaction for a diagnostic line: credentials, then Riot IDs and match ids. */
export function redact(text: string): string {
	return scrubIdentifiers(redactSecrets(text));
}

function safeString(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		// A circular object or a BigInt: the line still goes out, this one field becomes a marker. (Logging the failure
		// from inside the logger would just fail the same way.)
		return "[unserializable]";
	}
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(details)) {
		const passthrough = typeof value === "number" || typeof value === "boolean" || value === null || value === undefined;
		// matchId is a Riot match-v5 id (its one caller, live-gateway.ts, already validated the shape before logging
		// it), not a secret or a Riot ID: scrubIdentifiers's match-id pattern exists for free text that could
		// incidentally contain one (an error message, a judge-bound passage), not for an id a caller deliberately
		// logs here to make its own line useful. Redacting it anyway would turn every occurrence into the literal
		// string "[match-id]", discarding the one piece of context the event exists to carry.
		out[key] = passthrough ? value : key === "matchId" && typeof value === "string" ? clip(value) : clip(redact(safeString(value)));
	}
	return out;
}

function sanitizeError(error: unknown): LogErrorDetails {
	if (!(error instanceof Error)) return { message: clip(redact(safeString(error))) };
	const code = (error as NodeJS.ErrnoException).code;
	const stack = error.stack
		?.split("\n")
		.slice(0, MAX_STACK_LINES)
		.join("\n");
	return {
		name: error.name,
		...(code ? { code: String(code) } : {}),
		message: clip(redact(error.message ?? "")),
		...(stack ? { stack: clip(redact(stack), MAX_STACK_CHARS) } : {}),
	};
}

/**
 * Appends one line, or does nothing when no sink is set (no coach home configured). `details` is a flat bag of
 * context -- a url, a key, a count -- each clipped and scrubbed; `error` is whatever a catch caught, reduced to
 * its name, code, message, and the first few lines of its stack, also scrubbed.
 */
export function logEvent(level: LogLevel, component: string, event: string, details?: Record<string, unknown>, error?: unknown): void {
	if (!sink) return;
	try {
		const line: LogLine = {
			ts: new Date().toISOString(),
			level,
			component,
			event,
			...(sessionId ? { sessionId } : {}),
			...(runId ? { runId } : {}),
			...(details ? { details: sanitizeDetails(details) } : {}),
			...(error !== undefined ? { error: sanitizeError(error) } : {}),
		};
		sink(`${JSON.stringify(line)}\n`);
	} catch {
		// The logger must never throw into the caller's own catch: a bad sink, an unwritable path, or a detail
		// that cannot be stringified just means this one diagnostic line is lost, never a second failure on top
		// of the first.
	}
}

// --- notices -----------------------------------------------------------------

/**
 * Player-visible notices, each keyed by an id so raising the same one twice updates it in place instead of
 * stacking a duplicate; `index.ts` folds `noticeLines()` into the header's notes (`SurfaceLabels.notes`) next to
 * the static ones computed at launch, and calls `setNoticeHandler` once so a notice raised mid-session (an
 * icon fetch failing, the cell-size query timing out) repaints without a restart.
 */
const activeNotices = new Map<string, string>();
let noticeHandler: (() => void) | undefined;

/** The callback `raiseNotice`/`clearNotice` call after the visible set actually changes; set once at startup. */
export function setNoticeHandler(onChange: (() => void) | undefined): void {
	noticeHandler = onChange;
}

/** Every notice currently showing, in the order first raised. */
export function noticeLines(): string[] {
	return [...activeNotices.values()];
}

/**
 * Shows `text` under `id` and writes a matching log line (`component`/`event`/`details`/`error`, the same
 * shape `logEvent` takes). Raising the same id with the same text again just repeats the log line -- so a
 * capability that fails on every call still leaves a trail -- without touching the header a second time or
 * repainting for no visible change.
 */
export function raiseNotice(id: string, level: LogLevel, text: string, component: string, event: string, details?: Record<string, unknown>, error?: unknown): void {
	logEvent(level, component, event, details, error);
	if (activeNotices.get(id) === text) return;
	activeNotices.set(id, text);
	noticeHandler?.();
}

/** Removes `id`'s notice, if it is showing one. */
export function clearNotice(id: string): void {
	if (activeNotices.delete(id)) noticeHandler?.();
}

/** Test-only: drops every active notice without touching the handler, so one test file's notices never leak into the next. */
export function clearAllNoticesForTest(): void {
	activeNotices.clear();
}
