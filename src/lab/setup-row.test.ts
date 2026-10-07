import { describe, expect, test } from "bun:test";
import { runeNames, runeNamesIn, scoredSetupRow, setupRow } from "./setup-row";

// Shaped like Data Dragon's runesReforged.json (fetched live, 16.19.1): trees with slots of runes. Shards are not in that file.
const STYLES = [
	{ name: "Precision", slots: [{ runes: [{ name: "Press the Attack" }, { name: "Conqueror" }] }, { runes: [{ name: "Triumph" }] }, { runes: [{ name: "Legend: Alacrity" }] }] },
	{ name: "Sorcery", slots: [{ runes: [{ name: "Scorch" }, { name: "Nimbus Cloak" }] }] },
];

describe("setupRow", () => {
	test("takes the row labelled Setup, not the last row: a dodge row can follow it", () => {
		const rows = ["Matchup: Fizz trades after Yasuo Q3.", "Setup: Swap Cosmic Insight for Approach Velocity against the root.", "Dodge: three assassins and no frontline."];
		expect(setupRow(rows)).toBe(rows[1]);
	});

	test("ignores bullet, number, and bold markers around the label", () => {
		for (const row of ["- Setup: a", "1. Setup: a", "2) **Setup:** a", "* **Setup**: a", "setup: a"]) expect(setupRow(["Matchup: b", row, "Dodge: c"])).toBe(row);
	});

	test("undefined when no row carries the label, so a caller can tell a dodged setup from a present one", () => {
		expect(setupRow(["Matchup: b", "Dodge: c"])).toBeUndefined();
		expect(setupRow(["Set up your wards early."])).toBeUndefined();
	});
});

describe("runeNames and runeNamesIn", () => {
	const names = runeNames(STYLES);

	test("names come from the runes, not the trees, longest first", () => {
		expect(names).toEqual(["Press the Attack", "Legend: Alacrity", "Nimbus Cloak", "Conqueror", "Triumph", "Scorch"]);
	});

	test("counts each rune once, matching whole words with curly or straight quotes and any case", () => {
		expect(runeNamesIn("Take Press the Attack with Triumph and Legend: Alacrity; press the attack again.", names)).toEqual(["Press the Attack", "Legend: Alacrity", "Triumph"]);
		expect(runeNamesIn("Keep Conqueror; Nimbus Cloak vs the dive.", names)).toEqual(["Nimbus Cloak", "Conqueror"]);
	});

	test("a rune name inside a longer word is not a rune (Scorchclaw is a camp)", () => {
		expect(runeNamesIn("Clear Scorchclaw camps first.", names)).toEqual([]);
	});

	test("a row naming no rune counts none, including one that keeps the page", () => {
		expect(runeNamesIn("Keep the matchup page.", names)).toEqual([]);
	});
});

describe("scoredSetupRow", () => {
	test("a /pick answer scores its labelled Setup row even when a Dodge row follows, and nothing when unlabelled; /comp falls back to the last row", () => {
		const pick = ["Matchup: trade after Yasuo Q3.", "Setup: Swap one shard to armor.", "Dodge: three assassins."];
		expect(scoredSetupRow(pick, "pick")).toBe(pick[1]);
		expect(scoredSetupRow(["Trade after Yasuo Q3.", "Swap one shard to armor."], "pick")).toBe("");
		expect(scoredSetupRow(["Win: dive.", "Take Zhonya's against Zed."], "comp")).toBe("Take Zhonya's against Zed.");
	});
});
