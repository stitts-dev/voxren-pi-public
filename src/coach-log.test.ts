import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { coachLabels, headerLines } from "./ui";
import { clearAllNoticesForTest, clearNotice, createFileSink, logEvent, noticeLines, raiseNotice, setLogContext, setLogSink, setNoticeHandler } from "./coach-log";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as any;

function parsed(lines: string[], at = lines.length - 1): any {
	return JSON.parse(lines[at].trimEnd());
}

describe("logEvent", () => {
	afterEach(() => {
		setLogSink(undefined);
		setLogContext({});
	});

	test("writes one NDJSON line with level, component, event, ts, and the session/run ids set so far", () => {
		const written: string[] = [];
		setLogSink((line) => written.push(line));
		setLogContext({ sessionId: "s-1", runId: "2026-01-01T00:00:00.000Z" });
		logEvent("warn", "icons", "fetch-failed", { url: "https://example.com/x.png" });
		expect(written).toHaveLength(1);
		const line = parsed(written);
		expect(line).toMatchObject({ level: "warn", component: "icons", event: "fetch-failed", sessionId: "s-1", runId: "2026-01-01T00:00:00.000Z" });
		expect(typeof line.ts).toBe("string");
		expect(line.details).toEqual({ url: "https://example.com/x.png" });
	});

	test("leaves sessionId and runId off a line written before setLogContext names them", () => {
		const written: string[] = [];
		setLogSink((line) => written.push(line));
		logEvent("info", "x", "y");
		expect(parsed(written).sessionId).toBeUndefined();
		expect(parsed(written).runId).toBeUndefined();
	});

	test("does nothing with no sink set, the same as outside a launch", () => {
		setLogSink(undefined);
		expect(() => logEvent("error", "x", "y")).not.toThrow();
	});

	test("redacts a key-shaped query parameter in a detail and a Riot ID in an error message, leaving the rest readable", () => {
		const written: string[] = [];
		setLogSink((line) => written.push(line));
		const error = new Error("fetch failed for Faker#KR1");
		logEvent("error", "live-gateway", "request-failed", { url: "https://x.example.com/a?token=ABC123&other=1" }, error);
		const line = parsed(written);
		expect(line.details.url).not.toContain("ABC123");
		expect(line.details.url).toBe("https://x.example.com/a?token=[redacted]&other=1");
		expect(line.error.message).toBe("fetch [riot-id]");
	});

	test("redacts an Authorization header's credential wherever it shows up in logged text", () => {
		const written: string[] = [];
		setLogSink((line) => written.push(line));
		logEvent("warn", "research-service", "call-failed", { headers: "Authorization: Bearer sk-live-abc123" });
		expect(parsed(written).details.headers).toBe("Authorization: Bearer [redacted]");
	});

	test("reduces a thrown Error to name, code, message, and a bounded stack", () => {
		const written: string[] = [];
		setLogSink((line) => written.push(line));
		const error = Object.assign(new Error("boom"), { code: "ENOENT" });
		logEvent("warn", "config", "profile-load-failed", { path: "x" }, error);
		const line = parsed(written);
		expect(line.error.name).toBe("Error");
		expect(line.error.code).toBe("ENOENT");
		expect(line.error.message).toBe("boom");
		expect(typeof line.error.stack).toBe("string");
		expect(line.error.stack.split("\n").length).toBeLessThanOrEqual(4);
	});

	test("a non-Error thrown value still logs, as its stringified message", () => {
		const written: string[] = [];
		setLogSink((line) => written.push(line));
		logEvent("warn", "x", "y", undefined, "a plain string failure");
		expect(parsed(written).error.message).toBe("a plain string failure");
	});
});

describe("unserializable details", () => {
	afterEach(() => setLogSink(undefined));

	test("a circular object or a BigInt becomes a marker and the line, with its error, is still written", () => {
		const written: string[] = [];
		setLogSink((line) => void written.push(line));
		const circular: any = {};
		circular.self = circular;
		logEvent("error", "t", "fetch-failed", { response: circular, ok: "kept" }, new Error("boom"));
		logEvent("error", "t", "big", { n: 10n }, new Error("boom"));
		expect(written).toHaveLength(2);
		expect(parsed(written, 0).details).toEqual({ response: "[unserializable]", ok: "kept" });
		expect(parsed(written, 1).details.n).toBe("[unserializable]");
		expect(parsed(written, 1).error.message).toBe("boom");
	});
});

describe("redaction", () => {
	afterEach(() => setLogSink(undefined));

	test.each([
		"x-api-key: sk-ant-SECRET123",
		'{"X-Riot-Token":"RGAPI-aaaa-bbbb"}',
		"?api-key=SECRET123",
		'{"apiKey":"SECRET123"}',
		"bad key RGAPI-1111-2222-3333",
		"?client_secret=SECRET123",
	])("%s is written as [redacted] in details and error.message", (msg) => {
		const written: string[] = [];
		setLogSink((line) => void written.push(line));
		logEvent("error", "t", "e", { msg }, new Error(msg));
		const line = parsed(written);
		for (const text of [line.details.msg, line.error.message]) {
			expect(text).toContain("[redacted]");
			expect(text).not.toMatch(/SECRET123|RGAPI-|aaaa-bbbb/);
		}
	});
});

describe("createFileSink", () => {
	function tempFile(): string {
		return join(mkdtempSync(join(tmpdir(), "voxren-coach-log-")), "coach.log.ndjson");
	}

	afterEach(() => setLogSink(undefined));

	test("undefined path means no sink, same rule exchangeLogPath follows outside a launch", () => {
		expect(createFileSink(undefined)).toBeUndefined();
	});

	test("appends every line to the file in order", () => {
		const path = tempFile();
		const sink = createFileSink(path)!;
		sink("one\n");
		sink("two\n");
		expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
	});

	test("rotates the file to .1 once it is already past maxBytes, instead of growing forever", () => {
		const path = tempFile();
		const sink = createFileSink(path, 5)!;
		sink("first\n"); // 6 bytes: creates the file (the very first write can never itself trigger rotation)
		sink("second\n"); // the file is already 6 bytes, past the 5-byte cap: this write rotates it first
		expect(existsSync(`${path}.1`)).toBe(true);
		expect(readFileSync(`${path}.1`, "utf8")).toBe("first\n");
		expect(readFileSync(path, "utf8")).toBe("second\n");
	});

	test("three processes writing at once through a small cap lose no line to rotation", async () => {
		const path = tempFile();
		const module = JSON.stringify(join(import.meta.dir, "coach-log.ts"));
		// 3 x 2000 lines of ~50 bytes is ~300 KB: one rotation at 200 KB, so main + .1 must hold every line.
		const script = `import { createFileSink } from ${module}; const sink = createFileSink(${JSON.stringify(path)}, 200_000)!; for (let i = 0; i < 2000; i++) sink(\`\${process.pid}-\${i} \${"x".repeat(36)}\\n\`);`;
		const children = [1, 2, 3].map(() => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }));
		const codes = await Promise.all(children.map((child) => child.exited));
		expect(codes).toEqual([0, 0, 0]);
		const lines = [path, `${path}.1`].filter(existsSync).flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean));
		expect(new Set(lines).size).toBe(6000);
	}, 30_000);

	test("a lock left by a dead window blocks rotation only until it is stale", () => {
		const path = tempFile();
		const sink = createFileSink(path, 5)!;
		sink("first\n");
		writeFileSync(`${path}.lock`, "");
		sink("second\n"); // fresh lock: no rotation, the line is still written
		expect(existsSync(`${path}.1`)).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("first\nsecond\n");
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${path}.lock`, old, old);
		sink("third\n"); // stale lock: removed, rotation on the next write
		sink("fourth\n");
		expect(readFileSync(`${path}.1`, "utf8")).toBe("first\nsecond\nthird\n");
		expect(readFileSync(path, "utf8")).toBe("fourth\n");
	});

	test("never throws through logEvent when the path is unwritable (no such directory)", () => {
		setLogSink(createFileSink(join(tmpdir(), "voxren-coach-log-missing", "nested", "coach.log.ndjson")));
		expect(() => logEvent("error", "x", "y", { detail: "z" })).not.toThrow();
	});
});

describe("notices", () => {
	afterEach(() => {
		clearAllNoticesForTest();
		setNoticeHandler(undefined);
		setLogSink(undefined);
	});

	test("raising the same id and text again updates nothing and calls onChange only the first time", () => {
		let changes = 0;
		setNoticeHandler(() => changes++);
		raiseNotice("pictures", "warn", "pictures off: no protocol", "terminal-images", "startup");
		raiseNotice("pictures", "warn", "pictures off: no protocol", "terminal-images", "startup");
		expect(noticeLines()).toEqual(["pictures off: no protocol"]);
		expect(changes).toBe(1);
	});

	test("raising the same id with new text repaints again and replaces the line, never stacking a duplicate", () => {
		let changes = 0;
		setNoticeHandler(() => changes++);
		raiseNotice("pictures", "warn", "pictures off: no protocol", "terminal-images", "startup");
		raiseNotice("pictures", "warn", "pictures off: the terminal never answered the cell-size query", "terminal-images", "cell-size-timeout");
		expect(noticeLines()).toEqual(["pictures off: the terminal never answered the cell-size query"]);
		expect(changes).toBe(2);
	});

	test("a notice raised after the header already exists still reaches headerLines, with no restart", () => {
		const labels = coachLabels("anthropic/claude", [], ["static note"]);
		const before = headerLines(theme, undefined, labels, 80).join("\n");
		expect(before).toContain("static note");
		expect(before).not.toContain("icons failed");
		// The same wiring index.ts uses: fold the notice board into labels.notes and ask for a repaint.
		let repaints = 0;
		setNoticeHandler(() => {
			labels.notes = ["static note", ...noticeLines()];
			repaints++;
		});
		raiseNotice("icons", "warn", "icons failed this session: Data Dragon did not answer", "icons", "icon-fetch-failed");
		expect(repaints).toBe(1);
		const after = headerLines(theme, undefined, labels, 80).join("\n");
		expect(after).toContain("static note");
		expect(after).toContain("icons failed this session: Data Dragon did not answer");
	});

	test("clearNotice removes a shown line and calls onChange only when something actually changed", () => {
		let changes = 0;
		setNoticeHandler(() => changes++);
		raiseNotice("icons", "warn", "icons failed", "icons", "x");
		clearNotice("no-such-id");
		expect(changes).toBe(1); // only the raise above; clearing an id that isn't showing repaints nothing
		clearNotice("icons");
		expect(changes).toBe(2);
		expect(noticeLines()).toEqual([]);
	});
});
