import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEEDBACK_NONE_MESSAGE, appendFeedback, feedbackLine, feedbackListText, feedbackPromptOn, feedbackRow, parseFeedbackArgs, promptAfterReview, readFeedback } from "./feedback";

describe("/feedback arguments", () => {
	test("a mark with a note, any case; list; anything else is usage", () => {
		expect(parseFeedbackArgs("good")).toEqual({ kind: "mark", mark: "good", note: "" });
		expect(parseFeedbackArgs("  BAD  the Threat row named my own champion ")).toEqual({ kind: "mark", mark: "bad", note: "the Threat row named my own champion" });
		expect(parseFeedbackArgs("meh")).toEqual({ kind: "mark", mark: "meh", note: "" });
		expect(parseFeedbackArgs("list")).toEqual({ kind: "list" });
		expect(parseFeedbackArgs("")).toEqual({ kind: "usage" });
		expect(parseFeedbackArgs("great")).toEqual({ kind: "usage" });
		expect(parseFeedbackArgs("list all")).toEqual({ kind: "usage" });
	});
});

describe("the feedback row", () => {
	const now = new Date("2026-10-06T01:02:03.000Z");

	test("is one JSON line with at, build, command, mark, note in that order", () => {
		const row = feedbackRow({ build: "dev@abc1234", command: "review", mark: "good", note: "the Kill row was right", now });
		expect(feedbackLine(row)).toBe(`{"at":"2026-10-06T01:02:03.000Z","build":"dev@abc1234","command":"review","mark":"good","note":"the Kill row was right"}\n`);
	});

	test("defaults for no build and no run, and a note flattened to one clean line", () => {
		const row = feedbackRow({ mark: "bad", note: "  two\nlines\u001b[31m and a colour ", now });
		expect(row).toEqual({ at: "2026-10-06T01:02:03.000Z", build: "unknown", command: "none", mark: "bad", note: "two lines and a colour" });
		expect(feedbackRow({ mark: "meh", note: "x".repeat(600), now }).note).toHaveLength(500);
	});

	test("appends to the file and reads back in order, skipping a line that does not parse", () => {
		const path = join(mkdtempSync(join(tmpdir(), "feedback-")), "feedback.jsonl");
		expect(readFeedback(path)).toEqual([]);
		expect(appendFeedback(path, feedbackRow({ build: "dev@abc1234", command: "review", mark: "good", note: "", now }))).toBeUndefined();
		expect(appendFeedback(path, feedbackRow({ build: "dev@abc1234", command: "question", mark: "meh", note: "vague", now }))).toBeUndefined();
		writeFileSync(path, `${readFileSync(path, "utf8")}{"at":"half`);
		const rows = readFeedback(path);
		expect(rows.map((row) => [row.command, row.mark, row.note])).toEqual([
			["review", "good", ""],
			["question", "meh", "vague"],
		]);
		expect(feedbackListText(rows).split("\n")).toEqual(["feedback (2), kept on this machine:", "  2026-10-06 01:02 good /review", "  2026-10-06 01:02 meh  /question vague"]);
		expect(feedbackListText([])).toBe(FEEDBACK_NONE_MESSAGE);
	});
});

describe("the feedback prompt", () => {
	test("shows after the first review, then every third", () => {
		expect([1, 2, 3, 4, 5, 6, 7].map(promptAfterReview)).toEqual([true, false, false, true, false, false, true]);
		expect(promptAfterReview(0)).toBe(false);
	});

	test("is off with VOXREN_COACH_FEEDBACK=0 and on otherwise", () => {
		expect(feedbackPromptOn({})).toBe(true);
		expect(feedbackPromptOn({ VOXREN_COACH_FEEDBACK: "1" })).toBe(true);
		expect(feedbackPromptOn({ VOXREN_COACH_FEEDBACK: " 0 " })).toBe(false);
	});
});
