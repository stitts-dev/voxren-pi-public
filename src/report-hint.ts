import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { logEvent } from "./coach-log";

/**
 * The /report hint: one dim line, under the start notice or under an answer, when something went wrong and the player
 * may not know `/report` hands it to a local Claude Code session (src/debug-handoff.ts). Three causes: the previous
 * run's log (`coach.log.ndjson`, the file /report bundles) ends with an error; a model call failed in the last turn;
 * the live game read failed before the last turn. Each cause hints once per session, so a repeated failure stays one line.
 */
export const REPORT_HINT_LINE = "something went wrong: /report hands it to a local agent";
/** The display-only entry drawn under an answer; never a message, so it never reaches the model. */
export const REPORT_HINT_ENTRY_TYPE = "voxren-report-hint";
/** How much of the log's end is read for its last line; a line is a few hundred bytes. */
const LOG_TAIL_BYTES = 64 * 1024;

export type ReportHintCause = "last-run-error" | "model-call" | "live-read";

/** Which causes have shown their line; `note` says whether this one still has to. */
export function createReportHints(): { note: (cause: ReportHintCause) => boolean; shown: () => ReportHintCause[] } {
	const shown = new Set<ReportHintCause>();
	return {
		note(cause) {
			if (shown.has(cause)) return false;
			shown.add(cause);
			return true;
		},
		shown: () => [...shown],
	};
}

/**
 * Whether the previous run left the log on an error: the last line that parses and belongs to another session (this
 * one may already have logged its own start) has level "error". A half-written last line is skipped, not an error.
 */
export function logEndsWithError(text: string, currentSessionId?: string): boolean {
	const lines = text.split("\n");
	for (let at = lines.length - 1; at >= 0; at--) {
		const line = lines[at].trim();
		if (!line) continue;
		let row: { level?: unknown; sessionId?: unknown };
		try {
			row = JSON.parse(line);
		} catch {
			// The file's last line is still being written by another window, or was cut off: routine, read the one before it.
			continue;
		}
		if (!row || typeof row !== "object") continue;
		if (currentSessionId && row.sessionId === currentSessionId) continue;
		return row.level === "error";
	}
	return false;
}

/** The last LOG_TAIL_BYTES of a file, or nothing when it does not exist or cannot be read (a first run has no log yet). */
export function readLogTail(path: string, bytes = LOG_TAIL_BYTES): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const length = Math.min(size, bytes);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} catch (error) {
		logEvent("info", "report-hint", "log-tail-unread", { path }, error);
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** The start-time check: whether the log /report would bundle ends on an error from before this session. */
export function lastRunFailed(logPath: string | undefined, currentSessionId?: string): boolean {
	return logPath ? logEndsWithError(readLogTail(logPath), currentSessionId) : false;
}
