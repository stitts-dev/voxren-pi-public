import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { setLogSink } from "./coach-log";
import { cardForChampion, championCoachingText, championFactText, championFacts, championPassageText, knowChampions, loadChampionCard, parseChampionCard } from "./champion-card";

/** Trimmed Data Dragon champion/<id>.json entry: the fields a card reads, plus noise it must ignore. */
const DETAIL = {
	id: "Fizz",
	name: "Fizz",
	title: "the Tidal Trickster",
	tags: ["Assassin", "Fighter"],
	partype: "Mana",
	stats: { hp: 640, attackrange: 175, lore: "not a number" },
	passive: { name: "Nimble Fighter", description: "Fizz can move <b>through</b> units." },
	spells: [
		{ name: "Urchin Strike", cooldown: [8, 7.5], cost: [50], range: [550], description: "Dashes <i>through</i> a target." },
		{ name: "Seastone Trident", cooldown: [7], cost: [30], range: [25000], description: "" },
	],
};

function card(overrides: Record<string, unknown> = {}) {
	return { meta: { version: "16.19.1", generated: "2026-09-27" }, id: "Fizz", name: "Fizz", facts: championFacts(DETAIL), ...overrides };
}

describe("championFacts", () => {
	test("reads title, tags, resource, numeric stats, passive, and spells with Q-W-E-R slots and tag-free text", () => {
		const facts = championFacts(DETAIL);
		expect(facts.title).toBe("the Tidal Trickster");
		expect(facts.tags).toEqual(["Assassin", "Fighter"]);
		expect(facts.resource).toBe("Mana");
		expect(facts.stats).toEqual({ hp: 640, attackrange: 175 });
		expect(facts.passive).toEqual({ name: "Nimble Fighter", text: "Fizz can move through units." });
		expect(facts.spells[0]).toEqual({ slot: "Q", name: "Urchin Strike", cooldown: [8, 7.5], cost: [50], range: [550], text: "Dashes through a target." });
		expect(facts.spells[1].slot).toBe("W");
	});

	test("tolerates missing arrays, a missing passive, and a fifth spell", () => {
		const facts = championFacts({ spells: [{ name: "A" }, {}, {}, {}, { name: "Extra" }] });
		expect(facts.title).toBe("");
		expect(facts.passive).toEqual({ name: "", text: "" });
		expect(facts.spells[0]).toEqual({ slot: "Q", name: "A", cooldown: [], cost: [], range: [], text: "" });
		expect(facts.spells[4].slot).toBe("?");
		expect(championFacts(undefined).spells).toEqual([]);
	});
});

describe("championPassageText", () => {
	test("carries every ability's plain text with its numbers, so a mechanic claim has something to be judged against", () => {
		expect(championPassageText("Fizz", championFacts(DETAIL))).toBe(
			"Fizz, the Tidal Trickster. Passive Nimble Fighter: Fizz can move through units. Q Urchin Strike (cd 8/7.5, cost 50, range 550): Dashes through a target. W Seastone Trident (cd 7, cost 30, range 25000): ",
		);
	});
});

describe("championFactText", () => {
	test("renders the line voxren_game_facts has always emitted", () => {
		expect(championFactText(championFacts(DETAIL))).toBe("the Tidal Trickster. Passive Nimble Fighter. Q Urchin Strike: cd 8/7.5, cost 50, range 550; W Seastone Trident: cd 7, cost 30, range 25000");
	});
});

describe("parseChampionCard", () => {
	test("a complete card parses", () => {
		expect(parseChampionCard(card(), "Fizz.json").id).toBe("Fizz");
	});

	test("a patch-prefix version, a bad id, or a missing facts block fails naming the source", () => {
		expect(() => parseChampionCard(card({ meta: { version: "16.19", generated: "2026-09-27" } }), "Fizz.json")).toThrow("Fizz.json: meta.version");
		expect(() => parseChampionCard(card({ id: "../Fizz" }), "Fizz.json")).toThrow("Fizz.json: id");
		expect(() => parseChampionCard(card({ facts: undefined }), "Fizz.json")).toThrow("Fizz.json: facts");
		expect(() => parseChampionCard(card({ facts: { ...championFacts(DETAIL), spells: "none" } }), "Fizz.json")).toThrow("Fizz.json: facts.spells");
	});
});

describe("loadChampionCard", () => {
	test("returns the card for its id, undefined for no file, a path-shaped id, or a card that does not parse", () => {
		const dir = mkdtempSync(join(tmpdir(), "cards-"));
		writeFileSync(join(dir, "Fizz.json"), JSON.stringify(card()));
		writeFileSync(join(dir, "Zed.json"), "{ not json");
		expect(loadChampionCard("Fizz", dir)?.name).toBe("Fizz");
		expect(loadChampionCard("Ahri", dir)).toBeUndefined();
		expect(loadChampionCard("Zed", dir)).toBeUndefined();
		expect(loadChampionCard("../Fizz", dir)).toBeUndefined();
	});
});

describe("coaching rows", () => {
	const sources = [{ id: "s1", title: "Guide", url: "https://www.mobafire.com/fizz" }, { id: "game-1", title: "Riot Data Dragon 16.19.1", url: "https://ddragon.leagueoflegends.com/x.json" }];
	const coaching = (overrides: Record<string, unknown> = {}) => ({
		damage: { value: "Burst magic damage.", sources: ["s1"] },
		spikes: [{ at: "Level 6", why: "All-in with R.", sources: ["s1"] }],
		bait: [{ slot: "E", why: "Playful dodges one hit.", sources: ["game-1"] }],
		mistakes: [{ value: "Wasting E early.", sources: ["s1"] }],
		comp: { tags: ["dive", "pick"], sources: ["s1"] },
		...overrides,
	});
	const withCoaching = (value: unknown) => card({ meta: { version: "16.19.1", generated: "2026-09-27", sources }, coaching: value });

	test("a card with every row cited from its source list parses; one without a coaching layer still does", () => {
		expect(parseChampionCard(withCoaching(coaching()), "Fizz.json").coaching?.comp.tags).toEqual(["dive", "pick"]);
		expect(parseChampionCard(card(), "Fizz.json").coaching).toBeUndefined();
	});

	test("a row citing nothing, or an id the source list lacks, fails", () => {
		expect(() => parseChampionCard(withCoaching(coaching({ damage: { value: "Burst.", sources: [] } })), "Fizz.json")).toThrow("coaching.damage.sources");
		expect(() => parseChampionCard(withCoaching(coaching({ spikes: [{ at: "6", why: "R.", sources: ["web-9"] }] })), "Fizz.json")).toThrow("coaching.spikes[0].sources");
		expect(() => parseChampionCard(card({ coaching: coaching() }), "Fizz.json")).toThrow("coaching.damage.sources");
	});

	test("comp tags come only from the fixed set, and a bait names the passive or an ability key", () => {
		expect(() => parseChampionCard(withCoaching(coaching({ comp: { tags: ["tank"], sources: ["s1"] } })), "Fizz.json")).toThrow("coaching.comp.tags");
		expect(() => parseChampionCard(withCoaching(coaching({ bait: [{ slot: "Z", why: "x", sources: ["s1"] }] })), "Fizz.json")).toThrow("coaching.bait[0].slot");
	});

	test("the passage the frame judges carries every row", () => {
		const text = championCoachingText(parseChampionCard(withCoaching(coaching()), "Fizz.json"));
		expect(text).toBe("Coaching notes for Fizz, from 2 sources, built 2026-09-27 on 16.19.1; third-party, grounded row by row. damage: Burst magic damage. power spikes: Level 6: All-in with R. cooldown to bait: E: Playful dodges one hit. common mistakes: Wasting E early. comp tags: dive; pick.");
		expect(championCoachingText(parseChampionCard(card(), "Fizz.json"))).toBeUndefined();
	});
});

describe("coaching rules the builder keeps", () => {
	const sources = [{ id: "s1", title: "Guide", url: "https://www.mobafire.com/fizz" }, { id: "game-1", title: "Riot Data Dragon 16.19.1", url: "https://ddragon.leagueoflegends.com/x.json" }];
	const withCoaching = (coaching: Record<string, unknown>, metaSources: unknown[] = sources) => card({ meta: { version: "16.19.1", generated: "2026-09-27", sources: metaSources }, coaching: { spikes: [], bait: [], mistakes: [], comp: { tags: [], sources: [] }, ...coaching } });
	const row = (n: number) => ({ value: `Mistake ${n}.`, sources: ["s1"] });

	test("duplicate source ids and more rows than the builder's list cap fail", () => {
		expect(() => parseChampionCard(withCoaching({}, [sources[0], sources[0]]), "Fizz.json")).toThrow("meta.sources");
		expect(() => parseChampionCard(withCoaching({ mistakes: [row(1), row(2), row(3), row(4)] }), "Fizz.json")).toThrow("coaching.mistakes");
		expect(() => parseChampionCard(withCoaching({ spikes: [1, 2, 3, 4].map((n) => ({ at: `Level ${n}`, why: "x", sources: ["s1"] })) }), "Fizz.json")).toThrow("coaching.spikes");
		expect(() => parseChampionCard(withCoaching({ bait: ["Q", "W", "E", "R"].map((slot) => ({ slot, why: "x", sources: ["s1"] })) }), "Fizz.json")).toThrow("coaching.bait");
		expect(parseChampionCard(withCoaching({ mistakes: [row(1), row(2), row(3)] }), "Fizz.json").id).toBe("Fizz");
	});

	test("a coaching layer with no row and no tag fails; any one row or tag is enough", () => {
		expect(() => parseChampionCard(withCoaching({}), "Fizz.json")).toThrow("no row and no tag");
		const cited = { value: "Burst magic damage.", sources: ["s1"] };
		const alone: Record<string, Record<string, unknown>> = {
			damage: { damage: cited },
			archetype: { archetype: cited },
			axis: { axis: cited },
			winCondition: { winCondition: cited },
			spikes: { spikes: [{ at: "Level 6", why: "All-in with R.", sources: ["s1"] }] },
			bait: { bait: [{ slot: "E", why: "Playful dodges one hit.", sources: ["game-1"] }] },
			mistakes: { mistakes: [cited] },
			"comp tags": { comp: { tags: ["dive"], sources: ["s1"] } },
		};
		for (const [name, layer] of Object.entries(alone)) expect(parseChampionCard(withCoaching(layer), "Fizz.json").id, name).toBe("Fizz");
	});

	test("a stored card that breaks them is skipped and logged on load", () => {
		const dir = mkdtempSync(join(tmpdir(), "cards-"));
		writeFileSync(join(dir, "Fizz.json"), JSON.stringify(withCoaching({}, [sources[0], sources[0]])));
		const written: string[] = [];
		setLogSink((line) => written.push(line));
		try {
			expect(loadChampionCard("Fizz", dir)).toBeUndefined();
		} finally {
			setLogSink(undefined);
		}
		expect(written.join("")).toContain("load-failed");
	});
});

describe("cardForChampion", () => {
	const DDRAGON = {
		MonkeyKing: { id: "MonkeyKing", name: "Wukong" },
		Nunu: { id: "Nunu", name: "Nunu & Willump" },
		Renata: { id: "Renata", name: "Renata Glasc" },
		Kaisa: { id: "Kaisa", name: "Kai'Sa" },
		Belveth: { id: "Belveth", name: "Bel'Veth" },
	};
	function dirWith(ids: string[]) {
		const dir = mkdtempSync(join(tmpdir(), "cards-"));
		for (const id of ids) writeFileSync(join(dir, `${id}.json`), JSON.stringify(card({ id, name: id })));
		return dir;
	}

	test("a display name finds the card named by its Data Dragon id", () => {
		const dir = dirWith(["MonkeyKing", "Nunu", "Renata", "Kaisa", "Belveth"]);
		for (const [name, id] of [["Wukong", "MonkeyKing"], ["Nunu & Willump", "Nunu"], ["Renata Glasc", "Renata"], ["Kai'Sa", "Kaisa"], ["Bel'Veth", "Belveth"], ["MonkeyKing", "MonkeyKing"], ["nunu", "Nunu"]]) {
			expect(cardForChampion(name, dir, DDRAGON)?.id).toBe(id);
		}
	});

	test("a main with no card logs once and returns nothing", () => {
		knowChampions(undefined);
		const lines: any[] = [];
		setLogSink((line: any) => lines.push(line));
		try {
			const dir = dirWith(["Fizz"]);
			expect(cardForChampion("Wukong", dir, DDRAGON)).toBeUndefined();
			expect(cardForChampion("Wukong", dir, DDRAGON)).toBeUndefined();
			expect(JSON.stringify(lines).match(/no-card/g)?.length).toBe(1);
		} finally {
			setLogSink(undefined as any);
		}
	});

	test("knowChampions(undefined) forgets which missing cards were logged, so a second run in one process logs them again; a champion list does not", () => {
		const lines: any[] = [];
		setLogSink((line: any) => lines.push(line));
		try {
			const dir = dirWith(["Fizz"]);
			const asked = () => (cardForChampion("Wukong", dir, DDRAGON), JSON.stringify(lines).match(/no-card/g)?.length ?? 0);
			knowChampions(undefined);
			expect(asked()).toBe(1);
			knowChampions(DDRAGON);
			expect(asked()).toBe(1);
			knowChampions(undefined);
			expect(asked()).toBe(2);
		} finally {
			setLogSink(undefined as any);
			knowChampions(undefined);
		}
	});
});

describe("a card that does not match what it claims", () => {
	function load(id: string, value: unknown) {
		const dir = mkdtempSync(join(tmpdir(), "cards-"));
		writeFileSync(join(dir, `${id}.json`), JSON.stringify(value));
		const written: string[] = [];
		setLogSink((line) => written.push(line));
		try {
			return { loaded: loadChampionCard(id, dir), log: written.join("") };
		} finally {
			setLogSink(undefined);
		}
	}
	const facts = (patch: Record<string, unknown>) => ({ ...championFacts(DETAIL), ...patch });
	const spell = (patch: Record<string, unknown>) => facts({ spells: [{ ...championFacts(DETAIL).spells[0], ...patch }] });

	test("Fizz's card saved as Ahri.json is refused and logged", () => {
		const { loaded, log } = load("Ahri", card());
		expect(loaded).toBeUndefined();
		expect(log).toContain("load-failed");
	});

	test("a refused card is logged once however often it is asked for", () => {
		const dir = mkdtempSync(join(tmpdir(), "cards-"));
		writeFileSync(join(dir, "Ahri.json"), JSON.stringify(card()));
		const written: string[] = [];
		setLogSink((line) => written.push(line));
		try {
			loadChampionCard("Ahri", dir);
			loadChampionCard("Ahri", dir);
		} finally {
			setLogSink(undefined);
		}
		expect(written.join("").match(/load-failed/g)?.length).toBe(1);
	});

	test("the right file name still loads", () => {
		expect(load("Fizz", card()).loaded?.id).toBe("Fizz");
	});

	test.each([
		["a non-numeric stat", facts({ stats: { hp: "lots" } })],
		["non-string tags", facts({ tags: [1, {}] })],
		["a spell slot outside Q/W/E/R", spell({ slot: "Z" })],
		["cooldowns that are not numbers", spell({ cooldown: ["x", null] })],
		["a cost that is not numbers", spell({ cost: ["5"] })],
		["a range that is not numbers", spell({ range: [{}] })],
	])("%s is refused and logged", (_label, bad) => {
		const { loaded, log } = load("Fizz", card({ facts: bad }));
		expect(loaded).toBeUndefined();
		expect(log).toContain("load-failed");
	});
});
