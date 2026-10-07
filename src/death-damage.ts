/**
 * What killed the player, read from one CHAMPION_KILL event's `victimDamageReceived` (Riot's death recap for that
 * kill): the biggest sources as an enemy champion and the ability slot it came from, and the split by damage type,
 * which is what armor or magic resist answers. Shares, never raw numbers: a share compares across deaths.
 */

/** One source of the damage in a kill event: an enemy's ability or attacks, or a tower, minions, a monster. */
export interface DamageSource {
	/** The enemy champion, or "tower", "minions", "a monster"; "unknown" when Riot names neither. */
	from: string;
	/** "Q", "W", "E", "R", "autos", "passive", a summoner spell's name ("Ignite"), or "other" (items); empty when not from a champion. */
	how: string;
	/** Share of all the damage in the kill event, whole percent. */
	pct: number;
}

export interface DeathDamage {
	/** At most DAMAGE_SOURCES, largest first; a source rounding to 0% is left out. */
	sources: DamageSource[];
	magicPct: number;
	physicalPct: number;
	truePct: number;
}

const DAMAGE_SOURCES = 3;
const SLOTS = ["Q", "W", "E", "R"];
/** The slot a kill event gives a champion's passive (seen on real timelines: "hweipassive", "katarinapassive"). */
const PASSIVE_SLOT = 63;
// Riot event constants outside Data Dragon (no data file carries them), named the way players say them.
const DAMAGE_FROM: Record<string, string> = { TOWER: "tower", MINION: "minions", MONSTER: "a monster" };

/**
 * The damage of one kill event, or undefined when the event carries none. `championOf`: participant id to champion
 * name. `spells`: Data Dragon summoner spell id, lowercased, to its name ("summonerdot" to "Ignite"), which is how the
 * event spells one.
 */
export function deathDamage(event: any, championOf: Map<number, unknown>, spells: Record<string, string> = {}): DeathDamage | undefined {
	const hits: any[] = Array.isArray(event?.victimDamageReceived) ? event.victimDamageReceived : [];
	const dealt = (hit: any, key: string): number => (typeof hit?.[key] === "number" && hit[key] > 0 ? hit[key] : 0);
	let magic = 0;
	let physical = 0;
	let truly = 0;
	const bySource = new Map<string, { from: string; how: string; amount: number }>();
	for (const hit of hits) {
		magic += dealt(hit, "magicDamage");
		physical += dealt(hit, "physicalDamage");
		truly += dealt(hit, "trueDamage");
		const champion = championOf.get(hit?.participantId);
		const from = typeof champion === "string" ? champion : (DAMAGE_FROM[hit?.type] ?? "unknown");
		// The event spells Ignite "summonerdot", the Data Dragon id, and Smite by variant ("summonersmiteavataroffensive"), which contains it.
		const spellName = String(hit.spellName ?? "").toLowerCase();
		const spell = spells[spellName] ?? Object.entries(spells).find(([id]) => spellName.includes(id))?.[1];
		// ponytail: item damage (slots 6 and up, no name in the event) folds into "other"; naming it needs the killer's inventory at that minute.
		const how = typeof champion !== "string" ? "" : hit.basic === true ? "autos" : (spell ?? SLOTS[hit.spellSlot] ?? (hit.spellSlot === PASSIVE_SLOT ? "passive" : "other"));
		const source = bySource.get(`${from}|${how}`) ?? { from, how, amount: 0 };
		source.amount += dealt(hit, "magicDamage") + dealt(hit, "physicalDamage") + dealt(hit, "trueDamage");
		bySource.set(`${from}|${how}`, source);
	}
	const total = magic + physical + truly;
	if (total <= 0) return undefined;
	const ranked = [...bySource.values()].sort((a, b) => b.amount - a.amount);
	const sourcePcts = wholePercents(ranked.map((source) => source.amount));
	const [magicPct, physicalPct, truePct] = wholePercents([magic, physical, truly]);
	return {
		sources: ranked
			.map(({ from, how }, i) => ({ from, how, pct: sourcePcts[i] }))
			.slice(0, DAMAGE_SOURCES)
			.filter((source) => source.pct > 0),
		magicPct,
		physicalPct,
		truePct,
	};
}

/**
 * Whole percents of `amounts` that sum to exactly 100 (largest remainder). A tie in the remainder goes to the earlier
 * entry, so the result depends only on the input order. All zeros give all zeros.
 */
export function wholePercents(amounts: number[]): number[] {
	const total = amounts.reduce((sum, amount) => sum + amount, 0);
	if (total <= 0) return amounts.map(() => 0);
	const exact = amounts.map((amount) => (amount / total) * 100);
	const floors = exact.map(Math.floor);
	const byRemainder = exact.map((value, i) => i).sort((a, b) => exact[b] - floors[b] - (exact[a] - floors[a]) || a - b);
	for (let left = 100 - floors.reduce((sum, n) => sum + n, 0), i = 0; left > 0; left--, i++) floors[byRemainder[i]]++;
	return floors;
}

/** "Hwei R 38%", "tower 12%". */
export function damageText(source: DamageSource): string {
	return `${source.from}${source.how ? ` ${source.how}` : ""} ${source.pct}%`;
}

/** One death's damage as the model and the grounding passage read it: "Hwei R 38%, Hwei Q 22% (71% magic, 29% physical)". */
export function damageLine(damage: DeathDamage): string {
	const kinds = [`${damage.magicPct}% magic`, `${damage.physicalPct}% physical`, `${damage.truePct}% true`].filter((kind) => !kind.startsWith("0%"));
	return `${damage.sources.map(damageText).join(", ")} (${kinds.join(", ")})`;
}
