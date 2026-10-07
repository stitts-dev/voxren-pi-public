import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReportHints, lastRunFailed, logEndsWithError, readLogTail } from "./report-hint";

const line = (level: string, sessionId?: string) => JSON.stringify({ ts: "2026-10-06T00:00:00.000Z", level, component: "index", event: "x", ...(sessionId ? { sessionId } : {}) });

describe("the hint trigger", () => {
	test("a log ending on an error line triggers, one ending on a warning does not", () => {
		expect(logEndsWithError(`${line("info")}\n${line("error")}\n`)).toBe(true);
		expect(logEndsWithError(`${line("error")}\n${line("warn")}\n`)).toBe(false);
		expect(logEndsWithError("")).toBe(false);
	});

	test("a half-written last line is skipped, and the line before it decides", () => {
		expect(logEndsWithError(`${line("error")}\n{"ts":"2026-10-06T00:00:01.000Z","level":"inf`)).toBe(true);
		expect(logEndsWithError(`${line("info")}\n{"ts":"2026-10-06T00:00:01.000Z","level":"err`)).toBe(false);
	});

	test("this session's own lines are read past: the previous session's last line decides", () => {
		const text = `${line("error", "old")}\n${line("info", "new")}\n`;
		expect(logEndsWithError(text, "new")).toBe(true);
		expect(logEndsWithError(text)).toBe(false);
		expect(logEndsWithError(`${line("info", "old")}\n${line("error", "new")}\n`, "new")).toBe(false);
	});

	test("the file's tail is read, and a missing file is no error", () => {
		const dir = mkdtempSync(join(tmpdir(), "report-hint-"));
		const path = join(dir, "coach.log.ndjson");
		expect(lastRunFailed(path)).toBe(false);
		expect(lastRunFailed(undefined)).toBe(false);
		const filler = `${line("info")}\n`.repeat(2000);
		writeFileSync(path, `${filler}${line("error")}\n`);
		expect(readLogTail(path, 256).endsWith(`${line("error")}\n`)).toBe(true);
		expect(lastRunFailed(path)).toBe(true);
	});

	test("each cause hints once a session", () => {
		const hints = createReportHints();
		expect(hints.note("model-call")).toBe(true);
		expect(hints.note("model-call")).toBe(false);
		expect(hints.note("live-read")).toBe(true);
		expect(hints.note("last-run-error")).toBe(true);
		expect(hints.note("live-read")).toBe(false);
		expect(hints.shown().sort()).toEqual(["last-run-error", "live-read", "model-call"]);
	});
});
