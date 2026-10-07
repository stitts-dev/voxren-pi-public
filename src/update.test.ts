import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coachLabels, headerLines } from "./ui";
import { commitsBetween, nextTip, pendingNotes, pullLatest, readLastSeen, readNoticeState, versionLabel, whatsNewText, writeLastSeen, writeNoticeState, type Git } from "./update";

/** A git that answers by the first argument after `-C dir`, recording every call. */
function fakeGit(answers: Record<string, string | Error>) {
	const calls: string[][] = [];
	const git: Git = async (_dir, args) => {
		calls.push(args);
		const key = Object.keys(answers).find((prefix) => args.join(" ").startsWith(prefix));
		const answer = key === undefined ? "" : answers[key];
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { git, calls };
}

const onMain = { "rev-parse --abbrev-ref HEAD": "main", "rev-parse --short HEAD": "abc1234" };

describe("dev", () => {
	const onDev = { "rev-parse --abbrev-ref HEAD": "dev", "rev-parse --short HEAD": "def5678" };

	test("a rebuilt dev is pending against the head this instance loaded, with no fetch", async () => {
		const { git, calls } = fakeGit({ "rev-list --count": "1", log: "def5678 merged #456" });
		expect(await pendingNotes("/repo", { branch: "dev", head: "def5678" }, "abc1234", git)).toEqual({ count: 1, lines: ["def5678 merged #456"] });
		expect(calls.map((call) => call[0])).not.toContain("fetch");
	});

	test("an unmoved dev has nothing pending, and a rebuild with no new commits still counts", async () => {
		expect(await pendingNotes("/repo", { branch: "dev", head: "abc1234" }, "abc1234", fakeGit({}).git)).toEqual({ count: 0, lines: [] });
		expect(await pendingNotes("/repo", { branch: "dev", head: "def5678" }, "abc1234", fakeGit({ "rev-list --count": "0" }).git)).toEqual({ count: 1, lines: ["def5678 dev rebuilt"] });
	});

	test("pulling on dev neither fetches nor merges: the build is already on disk", async () => {
		const { git, calls } = fakeGit(onDev);
		expect(await pullLatest("/repo", git)).toEqual({ ok: true, notes: { count: 0, lines: [] } });
		expect(calls.map((call) => call[0])).toEqual(["rev-parse", "rev-parse"]);
	});
});

describe("pullLatest", () => {
	test("two new commits fast-forward and come back as notes", async () => {
		const { git, calls } = fakeGit({ ...onMain, "rev-list --count": "2", log: "bbb2222 second\naaa1111 first" });
		const result = await pullLatest("/repo", git);
		expect(result).toEqual({ ok: true, notes: { count: 2, lines: ["bbb2222 second", "aaa1111 first"] } });
		expect(calls.map((call) => call[0])).toContain("merge");
	});

	test("nothing new never merges", async () => {
		const { git, calls } = fakeGit({ ...onMain, "rev-list --count": "0" });
		expect(await pullLatest("/repo", git)).toEqual({ ok: true, notes: { count: 0, lines: [] } });
		expect(calls.map((call) => call[0])).not.toContain("merge");
	});

	test("local changes stop the pull and say so", async () => {
		const { git, calls } = fakeGit({ ...onMain, "rev-list --count": "1", log: "bbb2222 x", status: " M src/ui.ts" });
		const result = await pullLatest("/repo", git);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("local changes");
		expect(calls.map((call) => call[0])).not.toContain("merge");
	});

	test("a lock file change sends the player to just latest instead of pulling under a running coach", async () => {
		const { git, calls } = fakeGit({ ...onMain, "rev-list --count": "1", log: "bbb2222 x", diff: "package-lock.json" });
		const result = await pullLatest("/repo", git);
		expect(!result.ok && result.reason).toContain("just latest");
		expect(calls.map((call) => call[0])).not.toContain("merge");
	});

	test("a detached checkout has no branch to pull", async () => {
		const { git } = fakeGit({ "rev-parse --abbrev-ref HEAD": "HEAD", "rev-parse --short HEAD": "abc1234" });
		expect((await pullLatest("/repo", git)).ok).toBe(false);
	});

	test("a fetch that fails reports nothing new rather than throwing", async () => {
		const { git } = fakeGit({ ...onMain, fetch: new Error("offline") });
		expect(await pullLatest("/repo", git)).toEqual({ ok: true, notes: { count: 0, lines: [] } });
	});
});

describe("what's new", () => {
	test("a commit unknown to this clone gives no notes", async () => {
		const { git } = fakeGit({ "rev-list --count": new Error("bad revision") });
		expect(await commitsBetween("/repo", "dead000", "HEAD", git)).toEqual({ count: 0, lines: [] });
	});

	test("the note names the build and lists commits, counting the ones it leaves out", () => {
		const text = whatsNewText("main@abc1234", { count: 14, lines: ["bbb2222 second", "aaa1111 first"] });
		expect(text.split("\n")).toEqual(["Coach main@abc1234 · new since your last run (14):", "  bbb2222 second", "  aaa1111 first", "…and 12 more"]);
	});

	test("the tip and the hint go under the rows, indented like one, with or without rows", () => {
		expect(whatsNewText("main@abc1234", { count: 1, lines: ["bbb2222 second"] }, ["tip: /update pulls the newest build"]).split("\n")).toEqual(["Coach main@abc1234 · new since your last run (1):", "  bbb2222 second", "  tip: /update pulls the newest build"]);
		expect(whatsNewText("main@abc1234", { count: 0, lines: [] }, ["tip: /flow", "something went wrong: /report hands it to a local agent"]).split("\n")).toEqual(["Coach main@abc1234", "  tip: /flow", "  something went wrong: /report hands it to a local agent"]);
		expect(whatsNewText("main@abc1234", { count: 0, lines: [] })).toBe("Coach main@abc1234");
	});

	test("the last-seen commit round-trips through the coach home, and a first run has none", () => {
		const path = join(mkdtempSync(join(tmpdir(), "last-seen-")), "last-seen-commit");
		expect(readLastSeen(path)).toBeUndefined();
		writeLastSeen(path, "abc1234");
		expect(readLastSeen(path)).toBe("abc1234");
	});
});

describe("tip rotation", () => {
	const tips = ["one", "two", "three"];

	test("the first start takes the top tip, each start the next, wrapping, so consecutive starts differ", () => {
		expect(nextTip(tips, undefined)).toEqual({ index: 0, text: "one" });
		expect(nextTip(tips, 0)).toEqual({ index: 1, text: "two" });
		expect(nextTip(tips, 2)).toEqual({ index: 0, text: "one" });
		const seen: number[] = [];
		let last: number | undefined;
		for (let start = 0; start < 7; start++) {
			last = nextTip(tips, last)!.index;
			seen.push(last);
		}
		expect(seen).toEqual([0, 1, 2, 0, 1, 2, 0]);
	});

	test("a remembered index the list no longer has starts over, and no tips give no line", () => {
		expect(nextTip(tips, 7)).toEqual({ index: 0, text: "one" });
		expect(nextTip(tips, -1)).toEqual({ index: 0, text: "one" });
		expect(nextTip([], 0)).toBeUndefined();
	});

	test("the index is remembered beside profile.json and read back; a first run or a broken file starts fresh", () => {
		const path = join(mkdtempSync(join(tmpdir(), "notice-state-")), "notice-state.json");
		expect(readNoticeState(path)).toEqual({});
		writeNoticeState(path, { tip: 2, reviews: 4 });
		expect(readNoticeState(path)).toEqual({ tip: 2, reviews: 4 });
		writeFileSync(path, "{not json");
		expect(readNoticeState(path)).toEqual({});
		writeFileSync(path, JSON.stringify({ tip: "two", reviews: -1 }));
		expect(readNoticeState(path)).toEqual({});
	});
});

describe("header build label", () => {
	const theme = { fg: (_style: string, text: string) => text, bold: (text: string) => text } as any;
	const labels = { ...coachLabels("anthropic/x", ["Player#NA1"]), version: versionLabel({ branch: "main", head: "abc1234" }) };

	test("the title row carries the build when there is room", () => {
		expect(headerLines(theme, undefined, labels, 100)[1]).toContain("main@abc1234");
	});

	test("a narrow row drops the build before the player's name", () => {
		const title = headerLines(theme, undefined, labels, 30)[1];
		expect(title).not.toContain("main@abc1234");
		expect(title).toContain("Player#NA1");
	});
});

describe("what's-new renderer", () => {
	test("draws the note under the card margin with no type tag, each line cut to the pane", async () => {
		const { createWhatsNew } = await import("./ui");
		const theme = { fg: (_style: string, text: string) => text, bold: (text: string) => text } as any;
		const lines = createWhatsNew(theme, "Coach main@abc1234 · new since your last run (1):\n  bbb2222 a subject much longer than the pane").render(30);
		expect(lines).toHaveLength(2);
		expect(lines.join("\n")).not.toContain("voxren-whats-new");
		expect(lines[1]).toContain("…");
		expect(lines[1]).not.toContain("than the pane");
	});
});
