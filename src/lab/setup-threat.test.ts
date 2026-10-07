import { describe, expect, test } from "bun:test";
import { excludedThreats, setupThreatMismatch } from "./setup-threat";

// Real Data Dragon 16.19.1 description (fetched live, not paraphrased): item 3140, Quicksilver Sash.
const QSS_DESCRIPTION = "<mainText><stats><attention>30</attention> Magic Resist</stats><br><br><active>Quicksilver</active><br>Remove all crowd control debuffs (excluding <keyword>Airborne</keyword>).</mainText>";

describe("excludedThreats", () => {
	test("reads the excluded keyword out of a real Data Dragon description", () => {
		expect(excludedThreats(QSS_DESCRIPTION)).toEqual(["airborne"]);
	});

	test("an item with no exclusion clause excludes nothing", () => {
		expect(excludedThreats("<mainText><stats><attention>45</attention> Magic Resist</stats></mainText>")).toEqual([]);
	});
});

describe("setupThreatMismatch", () => {
	test("F1: flags a row that wrongly claims the item removes an excluded threat", () => {
		expect(setupThreatMismatch("Quicksilver Sash", QSS_DESCRIPTION, "Quicksilver Sash removes Wukong's knockup entirely.")).toBe(true);
	});

	test("does not flag a row that correctly says the item will NOT remove the excluded threat", () => {
		expect(
			setupThreatMismatch(
				"Quicksilver Sash",
				QSS_DESCRIPTION,
				"Quicksilver Sash: Plan it if Malzahar repeatedly catches you before you can act; its magic resistance and crowd-control removal answer that threat, not Wukong's knockup.",
			),
		).toBe(false);
	});

	test("does not flag a row that never mentions the item", () => {
		expect(setupThreatMismatch("Quicksilver Sash", QSS_DESCRIPTION, "Mercury's Treads answer the enemy's magic damage.")).toBe(false);
	});

	test("does not flag a claim about a threat the item does not exclude", () => {
		expect(setupThreatMismatch("Quicksilver Sash", QSS_DESCRIPTION, "Quicksilver Sash removes Malzahar's suppression.")).toBe(false);
	});
});
