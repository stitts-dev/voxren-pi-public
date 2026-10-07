import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { setLogSink } from "./coach-log";
import {
	type AuditGameResult,
	MAX_TAKEAWAY_CHARS,
	MAX_TAKEAWAYS,
	addTakeaway,
	deleteTakeaway,
	emptyLearnings,
	foldAuditGames,
	learningsFilePath,
	learningsKey,
	learningsPath,
	loadLearnings,
	resetLearnings,
	saveLearnings,
	summarizeLearnings,
} from "./learnings-store";

function auditGame(overrides: Partial<AuditGameResult> = {}): AuditGameResult {
	return {
		matchId: "M1",
		playedAt: "2026-01-01T00:00:00Z",
		champion: "Ahri",
		win: true,
		remake: false,
		diedBefore6: false,
		aheadAt15ThenDied: false,
		...overrides,
	};
}

describe("learningsKey", () => {
	test("an ASCII Riot ID is a readable slug plus a short hash", () => {
		expect(learningsKey("Name#NA1")).toMatch(/^name-na1-[0-9a-f]{8}$/);
	});

	test("a Hangul-tag Riot ID keeps its non-Latin characters in the slug (Unicode-aware)", () => {
		expect(learningsKey("심해토끼#KR1")).toMatch(/^심해토끼-kr1-[0-9a-f]{8}$/);
	});

	test("IDs that differ only in punctuation get different keys, and case does not matter", () => {
		const keys = ["Jax Main#NA1", "Jax_Main#NA1", "Jax-Main#NA1"].map(learningsKey);
		expect(new Set(keys).size).toBe(3);
		expect(learningsKey("NAME#na1")).toBe(learningsKey("name#NA1"));
	});

	test("a symbol-only ID is never empty and its file is not just .json", () => {
		expect(learningsKey("!!!#!!!")).toMatch(/^player-[0-9a-f]{8}$/);
		expect(learningsKey("!!!#!!!")).not.toBe(learningsKey("???#???"));
	});

	test("a key is safe as a Windows file name", () => {
		for (const id of ["con#NA1", "a:b*c?#NA1", "x".repeat(300) + "#NA1"]) {
			const key = learningsKey(id);
			expect(key).toMatch(/^[\p{L}\p{N}-]+$/u);
			expect(key.length).toBeLessThanOrEqual(60);
		}
	});
});

describe("legacy file migration", () => {
	test("the old-key file moves to the new key when the new one is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-learnings-"));
		const legacy = join(dir, "name-na1.json");
		saveLearnings(legacy, addTakeaway(emptyLearnings(), "keep me", "t"));

		const path = learningsFilePath(dir, "Name#NA1") as string;

		expect(path).toBe(join(dir, `${learningsKey("Name#NA1")}.json`));
		expect(loadLearnings(path).takeaways.map((t) => t.text)).toEqual(["keep me"]);
		expect(existsSync(legacy)).toBe(false);
	});

	test("an existing new-key file is never replaced by the old one", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-learnings-"));
		const legacy = join(dir, "name-na1.json");
		saveLearnings(legacy, addTakeaway(emptyLearnings(), "old", "t"));
		saveLearnings(join(dir, `${learningsKey("Name#NA1")}.json`), addTakeaway(emptyLearnings(), "new", "t"));

		const path = learningsFilePath(dir, "Name#NA1") as string;

		expect(loadLearnings(path).takeaways.map((t) => t.text)).toEqual(["new"]);
		expect(existsSync(legacy)).toBe(true);
	});

	test("a file at the empty old key is nobody's and stays put", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-learnings-"));
		saveLearnings(join(dir, ".json"), addTakeaway(emptyLearnings(), "unknown owner", "t"));

		const path = learningsFilePath(dir, "!!!#!!!") as string;

		expect(existsSync(path)).toBe(false);
		expect(existsSync(join(dir, ".json"))).toBe(true);
	});
});

describe("learningsFilePath / learningsPath", () => {
	test("an undefined dir yields an undefined path", () => {
		expect(learningsFilePath(undefined, "Name#NA1")).toBeUndefined();
	});

	test("a dir joins with the riotId's key file", () => {
		expect(learningsFilePath("/coach-home/learnings", "Name#NA1")).toBe(join("/coach-home/learnings", `${learningsKey("Name#NA1")}.json`));
	});

	test("learningsPath is undefined outside a launch (no PI_CODING_AGENT_DIR)", () => {
		expect(learningsPath({}, "Name#NA1")).toBeUndefined();
	});

	test("learningsPath resolves under the coach home when launched", () => {
		const environment = { PI_CODING_AGENT_DIR: "/coach-home/.pi/agent" };
		expect(learningsPath(environment, "Name#NA1")).toBe(join("/coach-home/.pi/learnings", `${learningsKey("Name#NA1")}.json`));
	});
});

describe("loadLearnings", () => {
	test("undefined path, a missing file, and invalid JSON all return the same empty default without throwing", () => {
		const fallback = emptyLearnings();
		expect(loadLearnings(undefined)).toEqual(fallback);

		const written: string[] = [];
		setLogSink((line) => written.push(line));
		try {
			const dir = mkdtempSync(join(tmpdir(), "voxren-learnings-"));
			expect(loadLearnings(join(dir, "missing.json"))).toEqual(fallback);

			const badPath = join(dir, "bad.json");
			writeFileSync(badPath, "{not json");
			expect(loadLearnings(badPath)).toEqual(fallback);
			// A new player's missing file is routine (info, hidden from `just logs`); a file that will not parse is a warning.
			expect(written.map((line) => JSON.parse(line).level)).toEqual(["info", "warn"]);
		} finally {
			setLogSink(undefined);
		}
	});
});

describe("saveLearnings", () => {
	test("undefined path is a silent no-op", () => {
		expect(() => saveLearnings(undefined, emptyLearnings())).not.toThrow();
	});

	test("round-trips exactly through loadLearnings and leaves no .tmp file", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-learnings-"));
		const path = join(dir, "name-na1.json");
		const profile = foldAuditGames(emptyLearnings(), [auditGame()]);

		saveLearnings(path, profile);

		expect(loadLearnings(path)).toEqual(profile);
		expect(existsSync(`${path}.tmp`)).toBe(false);
	});
});

describe("saveLearnings over a damaged file", () => {
	test("a truncated file is kept aside, not overwritten, and the save still lands", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-learnings-"));
		const path = join(dir, "name-na1.json");
		saveLearnings(path, addTakeaway(emptyLearnings(), "play safe at 6", "t"));
		const raw = readFileSync(path, "utf8");
		const truncated = raw.slice(0, raw.length - 5);
		writeFileSync(path, truncated);

		const written: string[] = [];
		setLogSink((line) => written.push(line));
		try {
			saveLearnings(path, foldAuditGames(loadLearnings(path), [auditGame()]));
		} finally {
			setLogSink(undefined);
		}

		const aside = readdirSync(dir).filter((name) => name.startsWith("name-na1.json.corrupt-"));
		expect(aside).toHaveLength(1);
		expect(readFileSync(join(dir, aside[0]), "utf8")).toBe(truncated);
		expect(loadLearnings(path).recentGames).toHaveLength(1);
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(written.filter((line) => JSON.parse(line).event === "corrupt-moved-aside")).toHaveLength(1);
	});

	test("a valid file is replaced with nothing set aside", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-learnings-"));
		const path = join(dir, "name-na1.json");
		saveLearnings(path, emptyLearnings());
		saveLearnings(path, addTakeaway(emptyLearnings(), "x", "t"));
		expect(readdirSync(dir)).toEqual(["name-na1.json"]);
	});
});

describe("resetLearnings", () => {
	test("deletes an existing file", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-learnings-"));
		const path = join(dir, "name-na1.json");
		saveLearnings(path, emptyLearnings());
		expect(existsSync(path)).toBe(true);

		resetLearnings(path);

		expect(existsSync(path)).toBe(false);
	});

	test("is a no-op when the file does not exist, and undefined is a no-op too", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-learnings-"));
		expect(() => resetLearnings(join(dir, "missing.json"))).not.toThrow();
		expect(() => resetLearnings(undefined)).not.toThrow();
	});
});

describe("foldAuditGames", () => {
	test("re-adding an already-present matchId replaces it rather than duplicating it", () => {
		const once = foldAuditGames(emptyLearnings(), [auditGame({ matchId: "A", win: true })]);
		const replayed = foldAuditGames(once, [auditGame({ matchId: "A", win: false })]);

		expect(replayed.recentGames).toHaveLength(1);
		expect(replayed.recentGames[0].win).toBe(false);
	});

	test("a remake is never stored", () => {
		const profile = foldAuditGames(emptyLearnings(), [auditGame({ matchId: "A", remake: true }), auditGame({ matchId: "B", remake: false })]);
		expect(profile.recentGames.map((g) => g.matchId)).toEqual(["B"]);
	});

	test("25 distinct games keep only the newest 20 by playedAt", () => {
		const games = Array.from({ length: 25 }, (_, i) => auditGame({ matchId: `M${i}`, playedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
		const profile = foldAuditGames(emptyLearnings(), games);

		expect(profile.recentGames).toHaveLength(20);
		expect(profile.recentGames[0].matchId).toBe("M24");
		expect(profile.recentGames.at(-1)!.matchId).toBe("M5");
	});

	test("perChampion, currentWinStreak, and bestWinStreak are exact on a hand-built fixture", () => {
		// Newest first: Ahri win, Ahri win, Zed loss, Ahri win, Zed win, Ahri loss.
		// -> current streak 2 (index 0-1), best streak 2 (tied at index 0-1 and 3-4).
		const games = [
			auditGame({ matchId: "1", playedAt: "2026-01-06T00:00:00Z", champion: "Ahri", win: true }),
			auditGame({ matchId: "2", playedAt: "2026-01-05T00:00:00Z", champion: "Ahri", win: true }),
			auditGame({ matchId: "3", playedAt: "2026-01-04T00:00:00Z", champion: "Zed", win: false }),
			auditGame({ matchId: "4", playedAt: "2026-01-03T00:00:00Z", champion: "Ahri", win: true }),
			auditGame({ matchId: "5", playedAt: "2026-01-02T00:00:00Z", champion: "Zed", win: true }),
			auditGame({ matchId: "6", playedAt: "2026-01-01T00:00:00Z", champion: "Ahri", win: false }),
		];
		const profile = foldAuditGames(emptyLearnings(), games);

		expect(profile.perChampion).toEqual({
			Ahri: { games: 4, wins: 3, losses: 1 },
			Zed: { games: 2, wins: 1, losses: 1 },
		});
		expect(profile.streaks.currentWinStreak).toBe(2);
		expect(profile.streaks.bestWinStreak).toBe(2);
	});

	test("focusAreas needs at least 4 games and at least half flagged", () => {
		const below4 = foldAuditGames(
			emptyLearnings(),
			Array.from({ length: 3 }, (_, i) => auditGame({ matchId: `s${i}`, playedAt: `2026-02-0${i + 1}T00:00:00Z`, diedBefore6: true })),
		);
		expect(below4.focusAreas).not.toContain("dying before minute 6");

		const underHalf = foldAuditGames(
			emptyLearnings(),
			[
				auditGame({ matchId: "a", playedAt: "2026-02-04T00:00:00Z", diedBefore6: true }),
				auditGame({ matchId: "b", playedAt: "2026-02-03T00:00:00Z", diedBefore6: false }),
				auditGame({ matchId: "c", playedAt: "2026-02-02T00:00:00Z", diedBefore6: false }),
				auditGame({ matchId: "d", playedAt: "2026-02-01T00:00:00Z", diedBefore6: false }),
			],
		);
		expect(underHalf.focusAreas).not.toContain("dying before minute 6");

		const atHalf = foldAuditGames(
			emptyLearnings(),
			[
				auditGame({ matchId: "a", playedAt: "2026-02-04T00:00:00Z", diedBefore6: true }),
				auditGame({ matchId: "b", playedAt: "2026-02-03T00:00:00Z", diedBefore6: true }),
				auditGame({ matchId: "c", playedAt: "2026-02-02T00:00:00Z", diedBefore6: false }),
				auditGame({ matchId: "d", playedAt: "2026-02-01T00:00:00Z", diedBefore6: false }),
			],
		);
		expect(atHalf.focusAreas).toContain("dying before minute 6");

		const aheadThenDied = foldAuditGames(
			emptyLearnings(),
			[
				auditGame({ matchId: "a", playedAt: "2026-02-04T00:00:00Z", aheadAt15ThenDied: true }),
				auditGame({ matchId: "b", playedAt: "2026-02-03T00:00:00Z", aheadAt15ThenDied: true }),
				auditGame({ matchId: "c", playedAt: "2026-02-02T00:00:00Z", aheadAt15ThenDied: true }),
				auditGame({ matchId: "d", playedAt: "2026-02-01T00:00:00Z", aheadAt15ThenDied: false }),
			],
		);
		expect(aheadThenDied.focusAreas).toContain("dying after being ahead at 15");
	});
});

describe("addTakeaway / deleteTakeaway", () => {
	test("text is trimmed and capped to MAX_TAKEAWAY_CHARS", () => {
		const profile = addTakeaway(emptyLearnings(), `  ${"x".repeat(MAX_TAKEAWAY_CHARS + 50)}  `, "2026-01-01T00:00:00Z");
		expect(profile.takeaways[0].text).toHaveLength(MAX_TAKEAWAY_CHARS);
	});

	test("the list caps at MAX_TAKEAWAYS, dropping the oldest first", () => {
		let profile = emptyLearnings();
		for (let i = 0; i < MAX_TAKEAWAYS + 5; i++) profile = addTakeaway(profile, `takeaway ${i}`, `2026-01-01T00:00:0${i % 10}Z`);

		expect(profile.takeaways).toHaveLength(MAX_TAKEAWAYS);
		expect(profile.takeaways[0].text).toBe(`takeaway ${MAX_TAKEAWAYS + 4}`);
		expect(profile.takeaways.some((t) => t.text === "takeaway 0")).toBe(false);
	});

	test("deleteTakeaway removes the given index; an out-of-range index is a no-op", () => {
		let profile = addTakeaway(emptyLearnings(), "keep me", "2026-01-01T00:00:00Z");
		profile = addTakeaway(profile, "drop me", "2026-01-02T00:00:00Z");

		const deleted = deleteTakeaway(profile, 0);
		expect(deleted.takeaways.map((t) => t.text)).toEqual(["keep me"]);

		expect(deleteTakeaway(profile, 99)).toEqual(profile);
		expect(deleteTakeaway(profile, -1)).toEqual(profile);
	});
});

describe("summarizeLearnings", () => {
	test("an empty profile summarizes to an empty string", () => {
		expect(summarizeLearnings(emptyLearnings())).toBe("");
	});

	test("an exact sentence on a fixed fixture", () => {
		const games = [
			auditGame({ matchId: "1", playedAt: "2026-01-04T00:00:00Z", champion: "Ahri", win: true }),
			auditGame({ matchId: "2", playedAt: "2026-01-03T00:00:00Z", champion: "Ahri", win: true }),
			auditGame({ matchId: "3", playedAt: "2026-01-02T00:00:00Z", champion: "Zed", win: false }),
			auditGame({ matchId: "4", playedAt: "2026-01-01T00:00:00Z", champion: "Ahri", win: false }),
		];
		let profile = foldAuditGames(emptyLearnings(), games);
		profile = addTakeaway(profile, "working on wave management", "2026-01-05T00:00:00Z");

		expect(summarizeLearnings(profile)).toBe(
			"Recent form 2-2 over the last 4 games. most played Ahri (3g, 2-1). 2-game win streak, best 2. remembers: working on wave management.",
		);
	});

	test("a long takeaway list truncates to fit maxChars", () => {
		let profile = foldAuditGames(emptyLearnings(), [auditGame()]);
		for (let i = 0; i < 10; i++) profile = addTakeaway(profile, `a fairly long takeaway about lane management number ${i}`, "2026-01-01T00:00:00Z");

		const result = summarizeLearnings(profile, 60);

		expect(result.length).toBeLessThanOrEqual(60);
		expect(result.endsWith("…")).toBe(true);
	});
});

describe("game order within one day", () => {
	const morning = auditGame({ matchId: "NA1_100", playedAt: "2026-10-03", playedAtMs: Date.UTC(2026, 9, 3, 9), win: true });
	const evening = auditGame({ matchId: "NA1_101", playedAt: "2026-10-03", playedAtMs: Date.UTC(2026, 9, 3, 21), win: false });

	test("a later game on the same date folds in ahead of a stored earlier one, so the streak reads the right game", () => {
		const stored = foldAuditGames(emptyLearnings(), [morning]);
		const profile = foldAuditGames(stored, [evening, morning]);

		expect(profile.recentGames.map((g) => g.matchId)).toEqual(["NA1_101", "NA1_100"]);
		expect(profile.streaks.currentWinStreak).toBe(0);
	});

	test("with no start time stored, a same-date tie goes to the higher match number", () => {
		const older = auditGame({ matchId: "NA1_100", playedAt: "2026-10-03" });
		const newer = auditGame({ matchId: "NA1_101", playedAt: "2026-10-03" });
		const stored = foldAuditGames(emptyLearnings(), [older]);

		expect(foldAuditGames(stored, [newer, older]).recentGames.map((g) => g.matchId)).toEqual(["NA1_101", "NA1_100"]);
	});

	test("a game stored before start times existed still orders by its date against one that has a start time", () => {
		const legacy = auditGame({ matchId: "NA1_200", playedAt: "2026-10-02" });
		const fresh = auditGame({ matchId: "NA1_150", playedAt: "2026-10-03", playedAtMs: Date.UTC(2026, 9, 3, 1) });

		expect(foldAuditGames(foldAuditGames(emptyLearnings(), [legacy]), [fresh]).recentGames.map((g) => g.matchId)).toEqual(["NA1_150", "NA1_200"]);
	});

	test("the start time survives save and load, and a malformed one is dropped alone, not its game", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-learnings-order-"));
		const path = join(dir, "player.json");
		saveLearnings(path, foldAuditGames(emptyLearnings(), [evening]));
		expect(loadLearnings(path).recentGames[0].playedAtMs).toBe(Date.UTC(2026, 9, 3, 21));

		const raw = { recentGames: [{ matchId: "NA1_7", playedAt: "2026-10-03", playedAtMs: "soon", champion: "Ahri", win: true, diedBefore6: false, aheadAt15ThenDied: false }] };
		writeFileSync(path, JSON.stringify(raw));
		const [game] = loadLearnings(path).recentGames;
		expect(game.matchId).toBe("NA1_7");
		expect(game.playedAtMs).toBeUndefined();
	});
});
