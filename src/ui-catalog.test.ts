import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOXREN_TOOLS } from "./contracts";
import { tierResult } from "./lab/ui-critics.ts";
import { loadTheme, themeNames } from "./lab/ui-data.ts";
import { GATE_WIDTHS, fixtures, gateProblems, iconCount, prepareFixtures, releaseFixtures, stablePictures } from "./lab/ui-fixtures.ts";

beforeAll(() => prepareFixtures());
afterAll(releaseFixtures);
const fixturesCount = fixtures().length;

describe("UI catalogue", () => {
	test("every tool has entries at every card level", () => {
		const names = new Set(fixtures().map((fixture) => fixture.name));
		const missing = VOXREN_TOOLS.flatMap((tool) => ["call", "running", "collapsed", "expanded claims", "expanded full"].map((level) => `${tool} ${level}`)).filter((name) => !names.has(name));
		expect(missing).toEqual([]);
	});

	test("every icon-bearing entry is named *-icons and draws icons (the offline squares), so a shot of it is never the text fallback", () => {
		const theme = loadTheme("tidal");
		const icons = fixtures().filter((fixture) => fixture.icons);
		expect(icons.length).toBeGreaterThanOrEqual(5);
		for (const fixture of icons) {
			expect(fixture.name.endsWith("-icons")).toBe(true);
			for (const width of [80, 100]) expect(iconCount(fixture, theme, width)).toBeGreaterThan(0);
		}
	});

	test("the audit card at 80 columns: a death takes at most two rows, and the item counts say what they count", () => {
		const theme = loadTheme("tidal");
		const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
		const card = fixtures().find((fixture) => fixture.name === "voxren_player_audit expanded full")!.render(theme, 80).map(strip);
		const first = card.findIndex((line) => /deaths\s+\d+:\d\d/.test(line));
		const end = card.findIndex((line, index) => index > first && line.includes("contract"));
		const starts = card.slice(first, end).flatMap((line, index) => (/(^|\s)\d+:\d\d {2}(alone|after ally death)/.test(line) ? [index] : []));
		expect(starts.length).toBeGreaterThan(1);
		starts.forEach((start, n) => expect((starts[n + 1] ?? end - first) - start).toBeLessThanOrEqual(2));
		expect(card.join("\n")).toMatch(/Dark Seal \d+:\d\d \d+\/\d+ games/);
	});

	test("entry names are unique", () => {
		const names = fixtures().map((fixture) => fixture.name);
		expect(names.length).toBe(new Set(names).size);
	});

	// Windows CI timeout: ~0.1 s on a Mac, 1.1 to 2.7 s on windows-latest, 6.5 s once (hextech, the first); bunfig's timeout is not applied (5 s), 15 s is ~2x the worst.
	for (const themeName of themeNames()) {
		test(`every entry passes the text gates at ${GATE_WIDTHS.join("/")} in ${themeName}`, () => {
			const problems = [...gateProblems(loadTheme(themeName))].flatMap(([name, list]) => list.map((problem) => `${name} ${problem}`));
			expect(problems).toEqual([]);
		}, 15_000);
	}
});

describe("tier.json, what the scoring step reads", () => {
	const KEYS = ["tier", "pass", "fail", "skipped", "seconds", "costUsd", "findings"];

	test("tierResult counts what ran, failed, and was left out", () => {
		expect(tierResult({ total: 10, checked: 7, failed: 2, seconds: 1.234, costUsd: 0.12345, findings: 5 })).toEqual({ tier: "ui", pass: 5, fail: 2, skipped: 3, seconds: 1.2, costUsd: 0.1235, findings: 5 });
		expect(tierResult({ total: 4, checked: 4, failed: 0, seconds: 0 })).toEqual({ tier: "ui", pass: 4, fail: 0, skipped: 0, seconds: 0, costUsd: 0, findings: 0 });
	});

	test("`ui-shoot` writes <out>/tier.json and the --json copy with exactly those keys", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-tier-"));
		try {
			const ran = spawnSync(process.execPath, ["src/lab/ui-shoot.ts", "--only", "footer", "--out", dir, "--json", join(dir, "copy", "t.json")], { cwd: join(import.meta.dir, ".."), encoding: "utf8" });
			expect(ran.status).toBe(0);
			for (const file of [join(dir, "tier.json"), join(dir, "copy", "t.json")]) {
				const tier = JSON.parse(readFileSync(file, "utf8"));
				expect(Object.keys(tier)).toEqual(KEYS);
				expect(tier.tier).toBe("ui");
				for (const key of KEYS.slice(1)) expect(typeof tier[key]).toBe("number");
				expect(tier.pass).toBe(4);
				expect(tier.fail).toBe(0);
				expect(tier.pass + tier.fail + tier.skipped).toBe(fixturesCount);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a picture's hash follows its size and place, not its id or bytes", () => {
		const iterm = (width: string, payload: string, size: number) => `a\x1b7\x1b]1337;File=inline=1;size=${size};width=${width};height=1:${payload}\x07\x1b8\x1b[4Cb`;
		const kitty = (cols: number, id: number, payload: string) => `a\x1b_Ga=T,f=100,q=2,C=1,c=${cols},r=1,i=${id};${payload}\x1b\\b`;
		expect(stablePictures(iterm("40px", "AAAA", 3))).not.toBe(stablePictures(iterm("48px", "AAAA", 3)));
		expect(stablePictures(iterm("40px", "AAAA", 3))).toBe(stablePictures(iterm("40px", "BBBBBB", 5)));
		expect(stablePictures(kitty(2, 7, "AAAA"))).not.toBe(stablePictures(kitty(3, 7, "AAAA")));
		expect(stablePictures(kitty(2, 7, "AAAA"))).toBe(stablePictures(kitty(2, 9, "BBBB")));
		expect(stablePictures(`${iterm("40px", "A", 1)}\x1b[2A`)).not.toBe(stablePictures(iterm("40px", "A", 1)));
	});
});
