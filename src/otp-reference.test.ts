import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OTP_REFERENCE, buildOtpReference, otpMatchup, parseOtpReference, referencePassageText, saveOtpReference, savedOneTricks } from "./otp-reference";

// otpMatchup normalizes both sides (strip non-letters, lowercase) before comparing. The reference
// table's opponent names are always exact-cased ("Ryze", "TwistedFate"), so the only exercised input
// so far is an exact match — this drives the normalization with inputs that differ from the table.
describe("otpMatchup", () => {
	test("a lowercase name matches the capitalized table entry", () => {
		expect(otpMatchup("ryze")?.opponent).toBe("Ryze");
	});

	test("an exact name still resolves", () => {
		expect(otpMatchup("Zed")?.opponent).toBe("Zed");
	});

	test("an unknown champion returns undefined", () => {
		expect(otpMatchup("NotAChampion")).toBeUndefined();
	});

	// The table has no apostrophe'd champion (e.g. Kai'Sa); "TwistedFate" is the table's only multi-word
	// name, so a spaced variant of the real champion name exercises the same non-letter-stripping path.
	test("a punctuated/spaced variant resolves", () => {
		expect(otpMatchup("Twisted Fate")?.opponent).toBe("TwistedFate");
	});
});

describe("parseOtpReference", () => {
	test("the shipped Fizz file loads whole", () => {
		expect(OTP_REFERENCE.champion).toBe("Fizz");
		expect(OTP_REFERENCE.games).toBe(394);
		expect(OTP_REFERENCE.matchups).toHaveLength(26);
		expect(OTP_REFERENCE.itemTimingMin["Zhonya's Hourglass"]).toBe(18.9);
	});

	test("a hand-edited file with a bad field fails at load and names the path", () => {
		const copy = structuredClone(OTP_REFERENCE) as any;
		copy.matchups[3].goldDiff15 = "692";
		expect(() => parseOtpReference(copy, "fizz.json")).toThrow("fizz.json: matchups[3].goldDiff15 must be a number");
		delete copy.matchups;
		expect(() => parseOtpReference(copy)).toThrow("reference: matchups must be an array");
		expect(() => parseOtpReference(null)).toThrow("(root) must be an object");
	});
});

describe("referencePassageText", () => {
	test("states the reference's champion, sample, per-game numbers, item timings, and rules in one passage", () => {
		const text = referencePassageText(OTP_REFERENCE);
		expect(text.startsWith(`${OTP_REFERENCE.champion} ${OTP_REFERENCE.position}, ${OTP_REFERENCE.games} games on patch ${OTP_REFERENCE.patch}.`)).toBe(true);
		expect(text).not.toContain(OTP_REFERENCE.title);
		for (const [item, min] of Object.entries(OTP_REFERENCE.itemTimingMin)) expect(text).toContain(`${item} at minute ${min}`);
		expect(text).toContain(`Rules: ${OTP_REFERENCE.rules.join(" ")}`);
	});
});

describe("buildOtpReference", () => {
	const game = (id: string, items: Array<[string, number]>, overrides: Record<string, unknown> = {}) =>
		({ matchId: id, champion: "Jinx", position: "BOTTOM", patch: "16.19", opponent: "Ezreal", win: true, kills: 5, deaths: 2, assists: 7, deathsBefore6: 0, deathsAt15: 1, deathsAfter15: 1, killsAt15: 2, durationMin: 30, csAt10: 80, csAt15: 130, goldDiffAt10: 200, goldDiffAt15: 500, level6Min: 6.5, firstBackMin: 4, keystone: "Lethal Tempo", skillOrder: "QWE", skillMax: "Q", itemTimingMin: Object.fromEntries(items), finalItems: items.map(([name]) => name), build: { itemOrder: items.map(([name, min]) => ({ name, min })) }, play: { killParticipationPct: 50, damageSharePct: 25, visionPerMin: 1, visionScore: 20, wardsPlaced: 8, wardsKilled: 2, controlWards: 1, damagePerMin: 600, damageTakenSharePct: 20, plates: 1, participation: { dragon: [1, 2], herald: [0, 0], baron: [0, 0], tower: [1, 2] }, objectives: { dragons: [2, 1], barons: [0, 0], heralds: [0, 0], grubs: [3, 3], towers: [7, 4] } }, ...overrides }) as any;

	test("tracks finished items bought in two or more games at their median minute; a component held at the end is dropped", () => {
		const games = [
			game("A", [["Kraken Slayer", 12], ["Amplifying Tome", 5]]),
			game("B", [["Kraken Slayer", 14], ["Amplifying Tome", 6], ["Infinity Edge", 20]], { win: false, goldDiffAt15: null }),
			game("C", [["Kraken Slayer", 13]], { opponent: "Caitlyn" }),
		];
		const reference = buildOtpReference(games, { player: "Jinxer#KR1", url: "https://op.gg/x" }, new Set(["Kraken Slayer", "Infinity Edge"]));
		expect(reference.itemTimingMin).toEqual({ "Kraken Slayer": 13 });
		expect(reference).toMatchObject({ champion: "Jinx", position: "BOTTOM", patch: "16.19", games: 3, rules: [] });
		expect(reference.perGame).toMatchObject({ kills: 5, deaths: 2, kda: 6, csAt15: 130 });
		// Ezreal: two games, gold at 15 only from one; Caitlyn: one game.
		expect(reference.matchups).toEqual([
			{ opponent: "Ezreal", games: 2, winRatePct: 50, goldDiff15: 500, diesBefore6Pct: 0, deathsPerGame: 2, boots: "", finish: ["Kraken Slayer", "Infinity Edge"], tip: "" },
			{ opponent: "Caitlyn", games: 1, winRatePct: 100, goldDiff15: 500, diesBefore6Pct: 0, deathsPerGame: 2, boots: "", finish: ["Kraken Slayer"], tip: "" },
		]);
		// Without the finished set every build-order item counts.
		expect(Object.keys(buildOtpReference(games, { player: "Jinxer#KR1", url: "https://op.gg/x" }).itemTimingMin).sort()).toEqual(["Amplifying Tome", "Kraken Slayer"]);
	});
});

describe("savedOneTricks", () => {
	test("lists the player and champion of each reference /otp saved, skipping the shipped kind and a file that does not parse", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-one-tricks-"));
		saveOtpReference(dir, { ...OTP_REFERENCE, champion: "Ahri", title: "Faker on stream#KR1 on Ahri (saved from /otp: 20 ranked games, patch 16.19)" });
		saveOtpReference(dir, { ...OTP_REFERENCE, champion: "Zed" }); // a hand-copied shipped reference: no player in its title
		writeFileSync(join(dir, "broken.json"), "{");
		expect(savedOneTricks(dir)).toEqual([{ player: "Faker on stream#KR1", champion: "Ahri" }]);
		expect(savedOneTricks(join(dir, "missing"))).toEqual([]);
		expect(savedOneTricks(undefined)).toEqual([]);
	});
});

describe("saveOtpReference across windows and damage", () => {
	test("three processes saving the same champion at once never throw", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-otp-"));
		const module = JSON.stringify(join(import.meta.dir, "otp-reference.ts"));
		const script = `import { OTP_REFERENCE, saveOtpReference } from ${module}; for (let i = 0; i < 300; i++) saveOtpReference(${JSON.stringify(dir)}, OTP_REFERENCE);`;
		const children = [1, 2, 3].map(() => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }));
		const results = await Promise.all(children.map(async (child) => ({ code: await child.exited, err: await new Response(child.stderr).text() })));
		expect(results.map((r) => r.err.slice(0, 300))).toEqual(["", "", ""]);
		expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	}, 60_000);

	test("a damaged saved file is set aside as .corrupt-<time> before the write replaces it", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-otp-"));
		const damaged = '{"title":"hand edited rules...","rules":["keep W lvl", ';
		writeFileSync(join(dir, "fizz.json"), damaged);
		const path = saveOtpReference(dir, OTP_REFERENCE);
		const aside = readdirSync(dir).filter((name) => name.startsWith("fizz.json.corrupt-"));
		expect(aside).toHaveLength(1);
		expect(readFileSync(join(dir, aside[0]), "utf8")).toBe(damaged);
		expect(JSON.parse(readFileSync(path, "utf8")).champion).toBe(OTP_REFERENCE.champion);
		expect(existsSync(`${path}.tmp`)).toBe(false);
	});
});
