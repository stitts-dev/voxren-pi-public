import { describe, expect, test } from "bun:test";
import { damageLine, damageText, deathDamage } from "./death-damage";

const CHAMPIONS = new Map<number, unknown>([[6, "Hwei"], [7, "Jayce"]]);
const SPELLS = { summonerdot: "Ignite", summonersmite: "Smite" };
/** One entry of `victimDamageReceived`, in Riot's shape. */
const hit = (participantId: number, spellSlot: number, damage: { magic?: number; physical?: number; true?: number }, extra: Record<string, unknown> = {}) => ({
	participantId,
	spellSlot,
	basic: false,
	type: "OTHER",
	magicDamage: damage.magic ?? 0,
	physicalDamage: damage.physical ?? 0,
	trueDamage: damage.true ?? 0,
	...extra,
});

describe("death damage", () => {
	test("sums each enemy's ability slot and attacks, keeps the three biggest as shares, and splits the damage by type", () => {
		const event = {
			victimDamageReceived: [
				hit(6, 3, { magic: 380 }), // Hwei R
				hit(6, 0, { magic: 120 }), // Hwei Q, twice
				hit(6, 0, { magic: 100 }),
				hit(7, -1, { physical: 150 }, { basic: true }), // Jayce attacks
				hit(6, 4, { true: 50 }, { spellName: "summonerdot" }), // Hwei's Ignite: too small for the top three here
				hit(0, -1, { physical: 200 }, { type: "TOWER" }),
			],
		};
		const damage = deathDamage(event, CHAMPIONS, SPELLS)!;
		expect(damage).toEqual({
			sources: [{ from: "Hwei", how: "R", pct: 38 }, { from: "Hwei", how: "Q", pct: 22 }, { from: "tower", how: "", pct: 20 }],
			magicPct: 60,
			physicalPct: 35,
			truePct: 5,
		});
		expect(damage.sources.map(damageText)).toEqual(["Hwei R 38%", "Hwei Q 22%", "tower 20%"]);
		expect(damageLine(damage)).toBe("Hwei R 38%, Hwei Q 22%, tower 20% (60% magic, 35% physical, 5% true)");
	});

	test("a summoner spell is named from Data Dragon, a passive by its slot; item damage, which the event does not name, stays 'other'", () => {
		// Spellings as real timelines carry them: Ignite is the Data Dragon id, Smite a variant containing it, a passive sits in slot 63, an item in its inventory slot with no name.
		const event = { victimDamageReceived: [hit(6, 5, { true: 300 }, { spellName: "summonerdot" }), hit(6, 0, { magic: 500 }, { spellName: "hweiq" }), hit(6, 7, { magic: 100 }, { spellName: "" })] };
		expect(deathDamage(event, CHAMPIONS, SPELLS)!.sources.map(damageText)).toEqual(["Hwei Q 56%", "Hwei Ignite 33%", "Hwei other 11%"]);
		// Without the names (Data Dragon did not answer), the same damage is still counted, unnamed.
		expect(deathDamage(event, CHAMPIONS)!.sources.map(damageText)).toEqual(["Hwei Q 56%", "Hwei other 44%"]);
		const jungler = { victimDamageReceived: [hit(7, 4, { true: 600 }, { spellName: "summonersmiteavataroffensive" }), hit(7, 63, { magic: 400 }, { spellName: "jaycepassive" })] };
		expect(deathDamage(jungler, CHAMPIONS, SPELLS)!.sources.map(damageText)).toEqual(["Jayce Smite 60%", "Jayce passive 40%"]);
	});

	test("a damage type nobody dealt is left out of the line, and an event with no damage has none to report", () => {
		expect(damageLine(deathDamage({ victimDamageReceived: [hit(7, 0, { physical: 300 })] }, CHAMPIONS)!)).toBe("Jayce Q 100% (100% physical)");
		expect(deathDamage({}, CHAMPIONS)).toBeUndefined();
		expect(deathDamage({ victimDamageReceived: [hit(6, 0, {})] }, CHAMPIONS)).toBeUndefined();
	});

	test("the type shares sum to 100, and so do the source shares when all are shown", () => {
		const equal = deathDamage({ victimDamageReceived: [hit(6, 0, { magic: 100 }), hit(6, 1, { physical: 100 }), hit(6, 2, { true: 100 })] }, CHAMPIONS)!;
		expect([equal.magicPct, equal.physicalPct, equal.truePct]).toEqual([34, 33, 33]);
		expect(equal.sources.map((source) => source.pct)).toEqual([34, 33, 33]);
		// 1/6, 1/6, 2/3: each rounds on its own to 17, 17, 67 = 101.
		const sixths = deathDamage({ victimDamageReceived: [hit(6, 0, { magic: 100 }), hit(6, 1, { physical: 100 }), hit(7, 2, { true: 400 })] }, CHAMPIONS)!;
		expect([sixths.magicPct, sixths.physicalPct, sixths.truePct]).toEqual([17, 17, 66]);
		expect(sixths.sources.reduce((sum, source) => sum + source.pct, 0)).toBe(100);
		for (const [a, b, c] of [[1, 1, 1], [1, 1, 2], [5, 5, 1], [7, 11, 13], [1, 1, 199]]) {
			const d = deathDamage({ victimDamageReceived: [hit(6, 0, { magic: a }), hit(6, 1, { physical: b }), hit(6, 2, { true: c })] }, CHAMPIONS)!;
			expect(d.magicPct + d.physicalPct + d.truePct).toBe(100);
		}
	});
});
