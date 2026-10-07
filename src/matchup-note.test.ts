import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { setLogSink } from "./coach-log";
import { claimMatchupBuild, loadMatchupNote, matchupNoteFile, matchupNoteRows, matchupNoteText, matchupSlug, noteAgeDays, parseMatchupNote, saveMatchupNote, type MatchupNote } from "./matchup-note";

const note = (): MatchupNote => ({
	meta: { version: "16.19.1", generated: "2026-10-01" },
	champion: "Fizz",
	opponent: "LeBlanc",
	sources: [
		{ kind: "video", title: "Fizz vs LeBlanc", author: "One", url: "https://youtu.be/aaa", published: "2 months ago" },
		{ kind: "video", title: "Fizz Mid vs Leblanc", author: "One", url: "https://youtu.be/bbb", published: "1 year ago" },
		{ kind: "guide", title: "Challenger Fizz Guide", author: "Two", url: "https://example.com/guide", published: "Season 16" },
	],
	rows: [
		{ kind: "dodge", text: "Hold E for her ultimate.", authors: 2, links: ["https://youtu.be/aaa?t=95", "https://example.com/guide"] },
		{ kind: "trade", text: "Go in after she uses W.", authors: 1, links: ["https://youtu.be/bbb?t=400"] },
	],
});

describe("parseMatchupNote", () => {
	test("a well-formed note comes back unchanged", () => {
		expect(parseMatchupNote(note(), "test")).toEqual(note());
	});

	test("a malformed field fails with its path", () => {
		const cases: Array<[string, (value: any) => void]> = [
			["meta.version", (value) => (value.meta.version = "26.19")],
			["opponent", (value) => (value.opponent = "'")],
			["sources", (value) => (value.sources = [])],
			["sources[2].kind", (value) => (value.sources[2].kind = "wiki")],
			["sources[0].url", (value) => (value.sources[0].url = "youtu.be/aaa")],
			["rows", (value) => (value.rows = [])],
			["rows", (value) => (value.rows = Array.from({ length: 9 }, () => value.rows[0]))],
			["rows[1].kind", (value) => (value.rows[1].kind = "roam")],
			["rows[0].text", (value) => (value.rows[0].text = "two\nlines")],
			["rows[0].authors", (value) => (value.rows[0].authors = 0)],
			["rows[0].links", (value) => (value.rows[0].links = ["ftp://example.com/x"])],
			["rows[0].authors", (value) => (value.rows[0].authors = 40)],
			["rows[0].authors", (value) => (value.rows[0].authors = 3)],
			["rows[0].links", (value) => (value.rows[0].links = ["https://example.com/x"])],
			["rows[0].links", (value) => (value.rows[0].links = ["https://youtu.be/aaab"])],
		];
		for (const [path, breakIt] of cases) {
			const broken = note();
			breakIt(broken);
			expect(() => parseMatchupNote(broken, "test")).toThrow(`test: ${path} is missing or malformed`);
		}
	});
});

describe("loadMatchupNote", () => {
	test("finds the note by champion names however they are spelled; a missing or broken file is undefined", () => {
		const dir = mkdtempSync(join(tmpdir(), "matchup-note-"));
		expect(matchupNoteFile("Fizz", "LeBlanc")).toBe("fizz-leblanc.json");
		expect(matchupSlug("Kai'Sa")).toBe("kaisa");
		writeFileSync(join(dir, "fizz-leblanc.json"), JSON.stringify(note()));
		expect(loadMatchupNote("Fizz", "LeBlanc", dir)).toEqual(note());
		expect(loadMatchupNote("FIZZ", "Leblanc", dir)).toEqual(note());
		expect(loadMatchupNote("LeBlanc", "Fizz", dir)).toBeUndefined();
		// A name is model-supplied text: nothing in it can leave the folder or pick another file type.
		expect(matchupNoteFile("../../etc", "a/b\\c.json")).toBe("etc-abcjson.json");
		expect(loadMatchupNote("Fizz", "../../etc", dir)).toBeUndefined();
		expect(loadMatchupNote("Fizz", "", dir)).toBeUndefined();
		writeFileSync(join(dir, "fizz-ahri.json"), "{ not json");
		expect(loadMatchupNote("Fizz", "Ahri", dir)).toBeUndefined();
		writeFileSync(join(dir, "fizz-zed.json"), JSON.stringify({ ...note(), rows: [] }));
		expect(loadMatchupNote("Fizz", "Zed", dir)).toBeUndefined();
	});
});

describe("what the model and Jev read", () => {
	test("rows carry the agreement count, the source line counts authors not sources, and links stay out", () => {
		expect(matchupNoteRows(note())).toEqual({
			source: "2 matchup videos and 1 written guide by 2 authors; third-party, not reviewed",
			built: "2026-10-01",
			dataDragonVersion: "16.19.1",
			rows: [
				{ kind: "dodge", text: "Hold E for her ultimate.", authors: 2 },
				{ kind: "trade", text: "Go in after she uses W.", authors: 1 },
			],
		});
		expect(matchupNoteText(note())).toBe("Matchup notes for Fizz against LeBlanc, from 2 matchup videos and 1 written guide by 2 authors, built 2026-10-01. Dodge: Hold E for her ultimate. (2 authors) Trade: Go in after she uses W. (1 author)");
		const oneVideo = { ...note(), sources: note().sources.slice(0, 1) };
		expect(matchupNoteRows(oneVideo).source).toBe("1 matchup video by 1 author; third-party, not reviewed");
	});
});

describe("saving and ageing", () => {
	test("a saved note is the file a lookup reads; a malformed note is refused before anything is written", () => {
		const dir = join(mkdtempSync(join(tmpdir(), "matchup-note-save-")), "matchups");
		const path = saveMatchupNote(dir, note());
		expect(path).toBe(join(dir, "fizz-leblanc.json"));
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(note());
		expect(loadMatchupNote("Fizz", "LeBlanc", dir)).toEqual(note());
		expect(() => saveMatchupNote(dir, { ...note(), opponent: "Ahri", rows: [] })).toThrow("rows is missing or malformed");
		expect(loadMatchupNote("Fizz", "Ahri", dir)).toBeUndefined();
	});

	test("age is whole days since the build date; an unreadable date is too old", () => {
		expect(noteAgeDays(note(), new Date("2026-10-01T23:00:00Z"))).toBe(0);
		expect(noteAgeDays(note(), new Date("2026-11-05T00:00:00Z"))).toBe(35);
		expect(noteAgeDays({ ...note(), meta: { version: "16.19.1", generated: "last week" } }, new Date("2026-10-01T00:00:00Z"))).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("saveMatchupNote across processes", () => {
	test("two processes saving one matchup at once never throw and always leave a parseable note", async () => {
		const dir = mkdtempSync(join(tmpdir(), "notes-"));
		const code = `import { saveMatchupNote } from ${JSON.stringify(join(import.meta.dir, "matchup-note"))};
const note = JSON.parse(process.argv[2]);
note.rows[0].text = "x".repeat(200);
for (let i = 0; i < 300; i++) saveMatchupNote(process.argv[3], note, new Date("2099-01-01"));`;
		const script = join(dir, "writer.ts");
		writeFileSync(script, code);
		const run = () => Bun.spawn(["bun", script, JSON.stringify(note()), dir], { stderr: "pipe", stdout: "ignore" });
		const children = [run(), run()];
		const codes = await Promise.all(children.map((child) => child.exited));
		const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
		expect(errors.join("")).toBe("");
		expect(codes).toEqual([0, 0]);
		expect(loadMatchupNote("Fizz", "LeBlanc", dir)).toBeDefined();
	}, 30_000);
});

describe("claimMatchupBuild", () => {
	test("one window holds a matchup at a time; a released or stale lock can be taken", () => {
		const dir = mkdtempSync(join(tmpdir(), "notes-"));
		const now = new Date();
		const release = claimMatchupBuild(dir, "Fizz", "LeBlanc", now);
		expect(release).toBeDefined();
		expect(claimMatchupBuild(dir, "Fizz", "LeBlanc", now)).toBeUndefined();
		expect(claimMatchupBuild(dir, "Fizz", "Zed", now)).toBeDefined();
		release?.();
		expect(claimMatchupBuild(dir, "Fizz", "LeBlanc", now)).toBeDefined();
		expect(claimMatchupBuild(dir, "Fizz", "LeBlanc", new Date(now.getTime() + 21 * 60_000))).toBeDefined();
	});

	test("a save skips when a fresh note is already there", () => {
		const dir = mkdtempSync(join(tmpdir(), "notes-"));
		const first = note();
		saveMatchupNote(dir, first, new Date("2026-10-02"));
		const second = { ...note(), rows: [{ ...note().rows[0], text: "Second window's row." }] };
		saveMatchupNote(dir, second, new Date("2026-10-02"));
		expect(loadMatchupNote("Fizz", "LeBlanc", dir)?.rows[0].text).toBe("Hold E for her ultimate.");
		saveMatchupNote(dir, second, new Date("2026-12-01"));
		expect(loadMatchupNote("Fizz", "LeBlanc", dir)?.rows[0].text).toBe("Second window's row.");
	});
});

describe("loadMatchupNote with a hand-edited file", () => {
	test("a note the builder could never write is skipped and logged, not trusted", () => {
		const dir = mkdtempSync(join(tmpdir(), "notes-"));
		const edited = note();
		edited.rows[0].authors = 40;
		edited.rows[0].links.push("https://example.com/x");
		writeFileSync(join(dir, matchupNoteFile("Fizz", "LeBlanc")), JSON.stringify(edited));
		const written: string[] = [];
		setLogSink((line) => written.push(line));
		try {
			expect(loadMatchupNote("Fizz", "LeBlanc", dir)).toBeUndefined();
		} finally {
			setLogSink(undefined);
		}
		expect(written.join("")).toContain("load-failed");
		expect(written.join("")).toContain("rows[0]");
	});
});
