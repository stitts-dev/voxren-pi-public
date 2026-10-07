import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { logEvent } from "./coach-log";
import { stripTerminalControl } from "./policy";

/**
 * `/feedback good | meh | bad [note]`: one JSON line per mark in `<coach home>/feedback.jsonl` ({at, build, command, mark,
 * note}), about the last finished run. `/feedback list` prints the rows. The file stays on this machine: nothing reads it
 * but `/feedback list` and the player (docs/privacy.md). After a post-game review, one dim line asks for it, at most once
 * per FEEDBACK_EVERY reviews (`promptAfterReview`), and not at all with VOXREN_COACH_FEEDBACK=0.
 */
export const FEEDBACK_COMMAND = "feedback";
export const FEEDBACK_COMMAND_DESCRIPTION = "Rate the last answer (good, meh, or bad, with a note) into feedback.jsonl in the coach home, or list the rows; nothing leaves this machine";
export const FEEDBACK_FILE = "feedback.jsonl";
export const FEEDBACK_PROMPT_LINE = "was this useful? /feedback good | meh | bad <note>";
/** The display-only entry drawn under a review; never a message, so it never reaches the model. */
export const FEEDBACK_PROMPT_ENTRY_TYPE = "voxren-feedback-prompt";
/** The display-only message `/feedback list` prints; filtered out of every model request like the what's-new note. */
export const FEEDBACK_LIST_MESSAGE_TYPE = "voxren-feedback-list";
export const FEEDBACK_USAGE_MESSAGE = "Usage: /feedback good | meh | bad [note], or /feedback list";
export const FEEDBACK_NO_HOME_MESSAGE = "/feedback needs the coach home, which only the launcher sets. Start the coach with `coach`.";
export const FEEDBACK_NONE_MESSAGE = `No feedback yet: ${FEEDBACK_PROMPT_LINE}`;
/** The prompt shows after the first review, then after every third one. */
export const FEEDBACK_EVERY = 3;
/** The command the row names when the session has no finished run yet. */
export const NO_RUN_COMMAND = "none";
const MAX_NOTE_CHARS = 500;

export const FEEDBACK_MARKS = ["good", "meh", "bad"] as const;
export type FeedbackMark = (typeof FEEDBACK_MARKS)[number];

export interface FeedbackRow {
	/** ISO time the mark was typed. */
	at: string;
	/** The running build, `branch@commit` (src/update.ts `versionLabel`), or "unknown" outside a checkout. */
	build: string;
	/** The last finished run's slash command, "question" for a typed one, NO_RUN_COMMAND before any run. */
	command: string;
	mark: FeedbackMark;
	note: string;
}

export type FeedbackArgs = { kind: "list" } | { kind: "mark"; mark: FeedbackMark; note: string } | { kind: "usage" };

/** `good|meh|bad [note]` (any case) or `list`; anything else, a bare line included, is usage. */
export function parseFeedbackArgs(args: string): FeedbackArgs {
	const text = args.trim();
	const [first, ...rest] = text.split(/\s+/);
	const word = (first ?? "").toLowerCase();
	if (word === "list" && rest.length === 0) return { kind: "list" };
	if ((FEEDBACK_MARKS as readonly string[]).includes(word)) return { kind: "mark", mark: word as FeedbackMark, note: rest.join(" ") };
	return { kind: "usage" };
}

/** The row as written: the note on one line, control bytes stripped, cut to MAX_NOTE_CHARS. */
export function feedbackRow(input: { build?: string; command?: string; mark: FeedbackMark; note: string; now?: Date }): FeedbackRow {
	return {
		at: (input.now ?? new Date()).toISOString(),
		build: input.build ?? "unknown",
		command: input.command ?? NO_RUN_COMMAND,
		mark: input.mark,
		note: stripTerminalControl(input.note).replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS),
	};
}

/** One JSON line, the keys in the documented order. */
export function feedbackLine(row: FeedbackRow): string {
	return `${JSON.stringify({ at: row.at, build: row.build, command: row.command, mark: row.mark, note: row.note })}\n`;
}

/** Appends the row; returns why it could not, or undefined when it landed. Never throws. */
export function appendFeedback(path: string, row: FeedbackRow): string | undefined {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, feedbackLine(row), { mode: 0o600 });
		return undefined;
	} catch (error) {
		logEvent("warn", "feedback", "append-failed", { path }, error);
		return error instanceof Error ? error.message : String(error);
	}
}

/** The rows in the file, oldest first; a line that does not parse is skipped on record, a missing file is no rows. */
export function readFeedback(path: string): FeedbackRow[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		logEvent("info", "feedback", "no-feedback-file", { path }, error);
		return [];
	}
	const rows: FeedbackRow[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const raw = JSON.parse(line);
			if (raw && typeof raw === "object" && (FEEDBACK_MARKS as readonly string[]).includes(raw.mark)) {
				rows.push({ at: String(raw.at ?? ""), build: String(raw.build ?? "unknown"), command: String(raw.command ?? NO_RUN_COMMAND), mark: raw.mark, note: String(raw.note ?? "") });
			}
		} catch (error) {
			logEvent("warn", "feedback", "row-unparsed", { path }, error);
		}
	}
	return rows;
}

/** What `/feedback list` shows: a count line, then one line per row, newest last. */
export function feedbackListText(rows: readonly FeedbackRow[]): string {
	if (!rows.length) return FEEDBACK_NONE_MESSAGE;
	return [`feedback (${rows.length}), kept on this machine:`, ...rows.map((row) => `  ${row.at.slice(0, 16).replace("T", " ")} ${row.mark.padEnd(4)} /${row.command}${row.note ? ` ${row.note}` : ""}`)].join("\n");
}

/** VOXREN_COACH_FEEDBACK=0 turns the prompt off; the command stays. */
export function feedbackPromptOn(environment: Record<string, string | undefined>): boolean {
	return environment.VOXREN_COACH_FEEDBACK?.trim() !== "0";
}

/** Whether the review just counted (`reviews` includes it) gets the prompt: the first, then every FEEDBACK_EVERY-th after it. */
export function promptAfterReview(reviews: number): boolean {
	return reviews >= 1 && (reviews - 1) % FEEDBACK_EVERY === 0;
}
