import { describe, expect, test } from "bun:test";
import { COACH_YAML } from "./contracts";
import { bareItem, buildIconNames, buildLines, isBuildFormatLine, unsourcedBuildNames, withoutBuildLines } from "./build-lines";

describe("buildLines", () => {
	const answer = [
		"Lane: Lux Q down: E in, burst, then disengage.",
		"Runes: Electrocute, Sudden Impact, Grisly Mementos, Treasure Hunter; Transcendence, Scorch; Adaptive Force, Adaptive Force, Health; Flash, Ignite",
		"Build: Doran's Ring + 2 Health Potions → Lich Bane → Sorcerer's Shoes → Zhonya's Hourglass → Shadowflame",
		"Skills: E, W, Q, then max E > W > Q",
		"Swap: Zhonya's Hourglass before Shadowflame, into Corki and Naafiri burst",
	].join("\n");

	test("reads the page, the path, the skills, and the swaps; the answer without them keeps every other line", () => {
		const lines = buildLines(answer)!;
		expect(lines.runes).toEqual([["Electrocute", "Sudden Impact", "Grisly Mementos", "Treasure Hunter"], ["Transcendence", "Scorch"], ["Adaptive Force", "Adaptive Force", "Health"], ["Flash", "Ignite"]]);
		expect(lines.build).toEqual([["Doran's Ring", "2 Health Potions"], ["Lich Bane"], ["Sorcerer's Shoes"], ["Zhonya's Hourglass"], ["Shadowflame"]]);
		expect(lines.skills).toBe("E, W, Q, then max E > W > Q");
		expect(lines.swaps).toEqual(["Zhonya's Hourglass before Shadowflame, into Corki and Naafiri burst"]);
		expect(lines.source.split("\n")).toHaveLength(4);
		// A counted plural looks up the single item; a swap's two names are looked up as items and as runes.
		expect(buildIconNames(lines).items).toEqual(expect.arrayContaining(["Doran's Ring", "Health Potion", "Shadowflame"]));
		expect(buildIconNames(lines).runes).toEqual(expect.arrayContaining(["Electrocute", "Flash", "Zhonya's Hourglass"]));
		// A swap's plural is prefetched as its singular too, since the strip draws either (#413).
		expect(buildIconNames(buildLines("Build: Lich Bane\nSwap: 2 Control Wards instead of Oracle Lens, into stealth")!).items).toEqual(expect.arrayContaining(["Control Wards", "Control Ward"]));
		// A rune with a note after it is looked up, and so prefetched, by its bare name.
		expect(buildIconNames(buildLines("Runes: Electrocute (keystone), Cut Down (2nd tree)")!).runes).toEqual(["Electrocute", "Cut Down"]);
		expect(withoutBuildLines(answer)).toBe("Lane: Lux Q down: E in, burst, then disengage.");
		expect(buildLines("Lane: Lux Q down: E in.\nSkills: E, W, Q")).toBeUndefined();
		expect(withoutBuildLines("Lane: Lux Q down: E in.")).toBe("Lane: Lux Q down: E in.");
	});
});

describe("unsourcedBuildNames", () => {
	const lines = buildLines(
		[
			"Runes: Electrocute, Sudden Impact; Transcendence; Adaptive Force; Flash, Ignite",
			"Build: Doran's Ring + 2 Health Potions → Dark Seal + Amplifying Tome → Lich Bane",
			"Swap: Zhonya's Hourglass before Lich Bane, into Corki burst",
		].join("\n"),
	)!;

	test("a name the turn's data never mentions is the coach's own pick; case, apostrophes, counts, and plurals do not matter", () => {
		const sources = `{"core":["lich bane"],"starter":["Dorans Ring","Health Potion"],"runes":{"primary":["Electrocute","Sudden Impact"],"secondary":["Transcendence"],"shards":["Adaptive Force"]},"summoners":["Flash","Ignite"],"note":"Zhonya's Hourglass into burst"}`;
		expect(unsourcedBuildNames(lines, sources)).toEqual(["Dark Seal", "Amplifying Tome"]);
	});

	test("with no data at all, every name is the coach's own, each once", () => {
		expect(unsourcedBuildNames(lines, "")).toEqual(["Electrocute", "Sudden Impact", "Transcendence", "Adaptive Force", "Flash", "Ignite", "Doran's Ring", "Health Potions", "Dark Seal", "Amplifying Tome", "Lich Bane", "Zhonya's Hourglass"]);
	});
});

describe("an annotation after an item", () => {
	const lines = buildLines("Build: Dark Seal + Refillable Potion → Amplifying Tome (first back) → Sorcerer's Shoes (at 12 min) → Lich Bane (if ahead)\nSwap: Zhonya's Hourglass (if behind) before Lich Bane, into Corki burst")!;

	test("is taken off the name before any lookup, whichever caller asks", () => {
		expect(bareItem("Amplifying Tome (first back)")).toBe("Amplifying Tome");
		expect(bareItem("2 Health Potions (at 12 min)")).toBe("Health Potions");
		expect(bareItem("Lich Bane (if ahead)")).toBe("Lich Bane");
		expect(buildIconNames(lines).items).toEqual(expect.arrayContaining(["Amplifying Tome", "Sorcerer's Shoes", "Lich Bane"]));
		expect(buildIconNames(lines).items.some((name) => name.includes("("))).toBe(false);
	});

	test("makes no own-pick row of its own: the bare item found in the data is sourced", () => {
		const sources = '{"core":["Dark Seal","Refillable Potion","Amplifying Tome","Sorcerer\'s Shoes","Lich Bane","Zhonya\'s Hourglass"],"threat":"Corki burst"}';
		expect(unsourcedBuildNames(lines, sources)).toEqual([]);
	});

	test("a name still unknown once stripped keeps its place, the annotation with it", () => {
		const odd = buildLines("Build: Imaginary Blade (first back)")!;
		expect(odd.build).toEqual([["Imaginary Blade (first back)"]]);
		expect(unsourcedBuildNames(odd, "Lich Bane")).toEqual(["Imaginary Blade"]);
	});
});

describe("isBuildFormatLine", () => {
	test("matches each label, with a bullet or bold tolerated, and not a plain prose line", () => {
		expect(isBuildFormatLine("Runes: Electrocute, Sudden Impact")).toBe(true);
		expect(isBuildFormatLine("- **Swap:** Zhonya's Hourglass before Shadowflame")).toBe(true);
		expect(isBuildFormatLine("Lane: Lux Q down: E in.")).toBe(false);
	});

	test("never carries state across calls, unlike a global regex's lastIndex", () => {
		for (let i = 0; i < 3; i++) expect(isBuildFormatLine("Build: Doran's Ring")).toBe(true);
	});
});

describe("coach.yaml's <build> format", () => {
	test("each template line, placeholders filled with plausible names, parses through buildLines into the matching shape -- so a format change the parser cannot read fails here", () => {
		const section = /<build>([\s\S]*?)<\/build>/.exec(COACH_YAML.prompts.system)![1];
		const templates = section
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^(Runes|Build|Skills|Swap):/.test(line));
		expect(templates).toHaveLength(4); // one line per label, today's format

		const placeholders: Record<string, string> = {
			"<keystone>": "Electrocute",
			"<rune>": "Sudden Impact",
			"<secondary rune>": "Scorch",
			"<shard>": "Health",
			"<summoner>": "Flash",
			"<start>": "Doran's Ring",
			"<item>": "Lich Bane",
			"<boots>": "Sorcerer's Shoes",
			"<first three level-ups>": "E, W, Q",
			"<ability>": "Q",
			"<item or rune>": "Zhonya's Hourglass",
			"<what it replaces>": "Shadowflame",
			"<the enemy or threat it answers>": "Zed burst",
		};
		const fill = (line: string) => Object.entries(placeholders).reduce((text, [token, name]) => text.replaceAll(token, name), line);
		const filled = templates.map(fill);
		// Every placeholder in today's template is one this test knows how to fill; a new one left literal would still
		// parse (buildLines reads structure, not content), so this only guards against a typo in the map above.
		expect(filled.every((line) => !/<[^>]+>/.test(line))).toBe(true);

		const lines = buildLines(filled.join("\n"));
		expect(lines).toBeDefined();

		const runesTemplate = templates.find((line) => line.startsWith("Runes:"))!.slice("Runes:".length);
		const runeGroups = runesTemplate.split(";");
		expect(lines!.runes).toHaveLength(runeGroups.length);
		runeGroups.forEach((group, index) => expect(lines!.runes[index]).toHaveLength(group.split(",").length));

		const buildTemplate = templates.find((line) => line.startsWith("Build:"))!.slice("Build:".length);
		expect(lines!.build).toHaveLength(buildTemplate.split(/→|->/).length);

		const skillsTemplate = templates.find((line) => line.startsWith("Skills:"))!.slice("Skills:".length).trim();
		expect(lines!.skills).toBe(fill(skillsTemplate));

		expect(lines!.swaps).toHaveLength(1);
		expect(lines!.swaps[0]).toContain("Zhonya's Hourglass");
		expect(lines!.swaps[0]).toContain("Shadowflame");
	});
});
