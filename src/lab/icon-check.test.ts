import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLabelRow, cropRect, cropSpread, expectedIcons, paneMetrics, parsePlacements, stripPlacements, textNames, BLANK_SPREAD, iconEvidence } from "./icon-check.ts";
import { iconVerdict } from "./stories.ts";

const iterm = (cells: number) => `\x1b7\x1b]1337;File=doNotMoveCursor=1;inline=1;size=4;width=${cells};height=1:AAAA\x07\x1b8\x1b[${cells}C `;
const kitty = (extra = "") => `\x1b_Ga=T,f=100,q=2,c=2,r=1,C=1${extra};AAAA\x1b\\`;
const answer = "Runes: Electrocute, Sudden Impact; Triumph; Adaptive Force; Flash, Ignite\nBuild: Dark Seal + 2 Health Potions → Lich Bane\nSwap: Zhonya's Hourglass instead of Banshee's Veil, into armor";

describe("expectedIcons", () => {
	test("one icon per chip: runes, shards, spells, steps (counts stripped), both swap names", () => {
		expect(expectedIcons(answer).names).toEqual(["Electrocute", "Sudden Impact", "Triumph", "Adaptive Force", "Flash", "Ignite", "Dark Seal", "Health Potions", "Lich Bane", "Zhonya's Hourglass", "Banshee's Veil"]);
	});
	test("a name Data Dragon does not know is unresolved, and a plural retries without its s", () => {
		const known = (name: string) => ["Electrocute", "Health Potion"].includes(name);
		const result = expectedIcons("Runes: Electrocute, Nonsense\nBuild: 2 Health Potions", known);
		expect(result.names).toEqual(["Electrocute", "Health Potions"]);
		expect(result.unresolved).toEqual(["Nonsense"]);
	});
	test("no build lines, nothing expected", () => expect(expectedIcons("just prose").names).toEqual([]));
});

describe("parsePlacements", () => {
	test("iTerm2: size and cell, following the cursor across restore and step", () => {
		const bytes = `\x1b[?2026h\r\n  │ BUILD   ${iterm(2)}${iterm(2)}\r\n  │ items   ${iterm(2)}\x1b[?2026l`;
		const found = parsePlacements(bytes);
		expect(found.map((p) => [p.protocol, p.col, p.cols, p.rows, p.rowFromBuild])).toEqual([["iterm2", 12, 2, 1, 0], ["iterm2", 15, 2, 1, 0], ["iterm2", 12, 2, 1, 1]]);
	});
	test("Kitty: chunked image counts once, with c and r", () => {
		const bytes = `\x1b[?2026h │ BUILD ${kitty(",m=1")}\x1b_Gm=1;BBBB\x1b\\\x1b_Gm=0;CCCC\x1b\\ ${kitty()}`;
		const found = parsePlacements(bytes);
		expect(found).toHaveLength(2);
		expect(found[0]).toMatchObject({ protocol: "kitty", cols: 2, rows: 1, col: 9 });
	});
	test("an icon two rows tall keeps its height", () => {
		expect(parsePlacements("\x1b]1337;File=width=2;height=2:AAAA\x07")[0]).toMatchObject({ cols: 2, rows: 2 });
	});
	test("the strip is the frame that placed the most pictures", () => {
		const bytes = `\x1b[?2026h${iterm(2)}${iterm(2)}${iterm(2)}\x1b[?2026l\x1b[?2026h${iterm(2)}\x1b[?2026l`;
		expect(stripPlacements(parsePlacements(bytes))).toHaveLength(3);
	});
	test("text with no pictures places none", () => expect(parsePlacements("\x1b[?2026h hello \x1b[2K\r\n")).toEqual([]));
});

describe("screen text", () => {
	const viewport = "header\n\n │ BUILD   \n │ items   \n\n";
	test("the BUILD row, and names drawn as text", () => {
		expect(buildLabelRow(viewport)).toBe(2);
		expect(buildLabelRow("nothing")).toBeUndefined();
		expect(textNames(" │ BUILD   Electrocute · Flash\n │ items   Dark Seal\n\nelse Triumph", ["Electrocute", "Dark Seal", "Triumph"])).toEqual(["Electrocute", "Dark Seal"]);
		expect(textNames(viewport, ["Electrocute"])).toEqual([]);
		expect(textNames(" │ BUILD   \n │ items   \n │ unsourced Amplifying Tome", ["Amplifying Tome"])).toEqual([]);
	});
});

describe("pixels", () => {
	const dir = mkdtempSync(join(tmpdir(), "icon-check-"));
	const make = (name: string, source: string) => {
		const file = join(dir, name);
		spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", source, "-frames:v", "1", file]);
		return file;
	};
	// CI runners have no ffmpeg; the lab machines do.
	const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
	test.skipIf(!hasFfmpeg)("a blank crop fails and a drawn one does not", () => {
		const blank = make("blank.png", "color=c=0x0b2026:s=200x100");
		const art = make("art.png", "testsrc=s=200x100");
		const rect = { x: 20, y: 20, w: 24, h: 24 };
		expect(cropSpread(blank, rect)!).toBeLessThanOrEqual(BLANK_SPREAD);
		expect(cropSpread(art, rect)!).toBeGreaterThan(BLANK_SPREAD);
		const common = { answer: "Build: Lich Bane", bytes: `\x1b[?2026h │ BUILD ${iterm(2)}`, screen: " │ BUILD   ", viewport: " │ BUILD   ", supported: true };
		const metrics = { cellW: 10, cellH: 20, originX: 0, originY: 0 };
		expect(iconEvidence({ ...common, shot: { png: blank, metrics } })).toMatchObject({ expected: 1, placed: 1, blank: 1 });
		expect(iconEvidence({ ...common, shot: { png: art, metrics } })).toMatchObject({ expected: 1, placed: 1, blank: 0 });
	});
	test("pane metrics and crop rectangle", () => {
		const list = [{ pane_id: 1, left_col: 0, top_row: 0, size: { cols: 10, rows: 5, pixel_width: 200, pixel_height: 200 } }, { pane_id: 2, left_col: 0, top_row: 5, size: { cols: 10, rows: 1, pixel_width: 200, pixel_height: 40 } }];
		const metrics = paneMetrics(list, 1, { width: 232, height: 300 })!;
		expect(metrics).toMatchObject({ cellW: 20, cellH: 40, originX: 16 });
		expect(cropRect({ protocol: "iterm2", cols: 2, rows: 1, col: 3, row: 0, rowFromBuild: 1, frame: 0 }, 2, metrics)).toMatchObject({ x: 76, w: 40, h: 40 });
	});
});

describe("iconVerdict", () => {
	const ev = { supported: true, expected: 5, placed: 5, blank: 0, unchecked: 0, text: [], unresolved: [] };
	test("passes when all are placed and drawn", () => expect(iconVerdict({ expect: "all" }, ev).status).toBe("pass"));
	test("fewer placed than expected: 0 of N", () => expect(iconVerdict({ expect: "all" }, { ...ev, placed: 0 }).failures[0].detail).toBe("0 of 5 icons placed"));
	test("min alone", () => {
		expect(iconVerdict({ min: 3 }, { ...ev, placed: 3 }).status).toBe("pass");
		expect(iconVerdict({ min: 4 }, { ...ev, placed: 3 }).status).toBe("fail");
	});
	test("a blank icon fails", () => expect(iconVerdict({}, { ...ev, blank: 2 }).failures[0].detail).toContain("2 of 5 placed icons are unpainted"));
	test("text fallback where images draw fails", () => expect(iconVerdict({}, { ...ev, placed: 0, text: ["Lich Bane"] }).failures.map((f) => f.detail).join()).toContain("text fallback"));
	test("no image support is skipped, never a pass", () => expect(iconVerdict({}, { ...ev, supported: false, placed: 0 })).toEqual({ status: "skipped", failures: [] }));
});
