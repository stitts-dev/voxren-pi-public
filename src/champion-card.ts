/**
 * Stored champion cards: `data/champions/<Data Dragon id>.json`, one per champion, stamped with the Data Dragon version
 * they were read from. `voxren_game_facts` answers from a card whose version matches the live one and reads Data Dragon
 * otherwise. The card and live paths share `championFacts` and `championFactText`, so both render the same text.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvent } from "./coach-log";

export interface ChampionSpell {
	slot: string;
	name: string;
	cooldown: number[];
	cost: number[];
	range: number[];
	text: string;
}

export interface ChampionFacts {
	title: string;
	tags: string[];
	resource: string;
	stats: Record<string, number>;
	passive: { name: string; text: string };
	spells: ChampionSpell[];
}

/** One place a coaching row comes from. `game-1` is the card's own Data Dragon text; every other id is a page the builder read. */
export interface CardSource {
	id: string;
	title: string;
	url: string;
}

export interface CoachingRow {
	value: string;
	sources: string[];
}

/** The grounded layer: every row cites ids from `meta.sources`. A single-valued row Jev refused is absent, never empty. */
export interface ChampionCoaching {
	damage?: CoachingRow;
	archetype?: CoachingRow;
	axis?: CoachingRow;
	winCondition?: CoachingRow;
	spikes: Array<{ at: string; why: string; sources: string[] }>;
	bait: Array<{ slot: string; why: string; sources: string[] }>;
	mistakes: CoachingRow[];
	comp: { tags: string[]; sources: string[] };
}

export interface ChampionCard {
	meta: { version: string; generated: string; model?: string; sources?: CardSource[] };
	id: string;
	name: string;
	facts: ChampionFacts;
	coaching?: ChampionCoaching;
}

export const CHAMPION_CARDS_DIR = fileURLToPath(new URL("../data/champions/", import.meta.url));
/** The comp tags a card may carry, one list in a data file so the validator, the builder's prompt, and the docs agree. */
export const COMP_TAGS: string[] = JSON.parse(readFileSync(fileURLToPath(new URL("../data/comp-tags.json", import.meta.url)), "utf8"));
const CHAMPION_ID = /^[A-Za-z0-9]+$/;
export const MAX_ROW_CHARS = 240;
/** Rows per list (spikes, bait, mistakes): the most the builder writes. */
export const MAX_LIST_ROWS = 3;
const DATA_DRAGON_VERSION = /^\d+\.\d+\.\d+$/;
const SLOTS = ["Q", "W", "E", "R"];
/** Where a bait row points: the passive or one of the four ability keys. */
export const BAIT_SLOTS = ["Passive", ...SLOTS];

const plain = (value: unknown) => String(value ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const numbers = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number") : []);

/** One Data Dragon `champion/<id>.json` entry to card facts; every field is optional upstream, so every field defaults. */
export function championFacts(full: unknown): ChampionFacts {
	const entry = (full && typeof full === "object" ? full : {}) as Record<string, any>;
	const stats: Record<string, number> = {};
	for (const [key, value] of Object.entries(entry.stats ?? {})) if (typeof value === "number") stats[key] = value;
	const spells: any[] = Array.isArray(entry.spells) ? entry.spells : [];
	return {
		title: String(entry.title ?? ""),
		tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
		resource: String(entry.partype ?? ""),
		stats,
		passive: { name: String(entry.passive?.name ?? ""), text: plain(entry.passive?.description) },
		spells: spells.map((spell, index) => ({ slot: SLOTS[index] ?? "?", name: String(spell?.name ?? ""), cooldown: numbers(spell?.cooldown), cost: numbers(spell?.cost), range: numbers(spell?.range), text: plain(spell?.description) })),
	};
}

/** The fact line `voxren_game_facts` returns for a champion: title, passive, then each spell's cooldown, cost, and first range. */
/** The passage the frame judges an ability claim against: every ability's text, with the numbers the fact line has. The model reads the fact line; Jev reads this. */
export function championPassageText(name: string, facts: ChampionFacts): string {
	const spells = facts.spells.map((spell) => `${spell.slot} ${spell.name} (cd ${spell.cooldown.join("/")}, cost ${spell.cost.join("/")}, range ${spell.range.slice(0, 1).join("")}): ${spell.text}`);
	return [`${name}, ${facts.title}.`, `Passive ${facts.passive.name || "?"}: ${facts.passive.text}`, ...spells].join(" ");
}

export function championFactText(facts: ChampionFacts): string {
	const spells = facts.spells.map((spell) => `${spell.slot} ${spell.name}: cd ${spell.cooldown.join("/")}, cost ${spell.cost.join("/")}, range ${spell.range.slice(0, 1).join("")}`).join("; ");
	return `${facts.title}. Passive ${facts.passive.name || "?"}. ${spells}`;
}

function need(condition: unknown, source: string, path: string): void {
	if (!condition) throw new Error(`${source}: ${path} is missing or malformed`);
}

/** `fileId` is the file name a stored card was read from: the card must name that champion. */
export function parseChampionCard(value: unknown, source: string, fileId?: string): ChampionCard {
	const card = value as Record<string, any> | undefined;
	need(card && typeof card === "object", source, "card");
	need(typeof card?.meta?.version === "string" && DATA_DRAGON_VERSION.test(card.meta.version), source, "meta.version");
	need(typeof card?.meta?.generated === "string" && card.meta.generated.length > 0, source, "meta.generated");
	need(typeof card?.id === "string" && CHAMPION_ID.test(card.id), source, "id");
	need(fileId === undefined || card?.id === fileId, source, `id (${card?.id}) does not match the file name`);
	need(typeof card?.name === "string" && card.name.length > 0, source, "name");
	const facts = card?.facts as Record<string, any> | undefined;
	need(facts && typeof facts === "object", source, "facts");
	need(typeof facts?.title === "string", source, "facts.title");
	need(Array.isArray(facts?.tags) && facts.tags.every((tag: unknown) => typeof tag === "string"), source, "facts.tags");
	need(typeof facts?.resource === "string", source, "facts.resource");
	need(facts?.stats && typeof facts.stats === "object" && !Array.isArray(facts.stats) && Object.values(facts.stats).every((stat) => typeof stat === "number" && Number.isFinite(stat)), source, "facts.stats");
	need(typeof facts?.passive?.name === "string" && typeof facts?.passive?.text === "string", source, "facts.passive");
	need(Array.isArray(facts?.spells), source, "facts.spells");
	(facts?.spells as any[]).forEach((spell, index) => {
		need(SLOTS.includes(spell?.slot) && typeof spell?.name === "string" && typeof spell?.text === "string", source, `facts.spells[${index}]`);
		for (const key of ["cooldown", "cost", "range"]) need(Array.isArray(spell?.[key]) && spell[key].every((n: unknown) => typeof n === "number" && Number.isFinite(n)), source, `facts.spells[${index}].${key}`);
	});
	if (card?.meta?.sources !== undefined) parseSources(card.meta.sources, source);
	if (card?.coaching !== undefined) parseCoaching(card.coaching, new Set((card.meta.sources ?? []).map((entry: CardSource) => entry.id)), source);
	return card as ChampionCard;
}

function parseSources(sources: unknown, source: string): void {
	need(Array.isArray(sources), source, "meta.sources");
	(sources as any[]).forEach((entry, index) => {
		need(typeof entry?.id === "string" && entry.id.length > 0 && typeof entry?.title === "string", source, `meta.sources[${index}]`);
		need(typeof entry?.url === "string" && entry.url.startsWith("https://"), source, `meta.sources[${index}].url`);
	});
	need(new Set((sources as CardSource[]).map((entry) => entry.id)).size === (sources as CardSource[]).length, source, "meta.sources ids are not unique");
}

/** Every coaching row holds text and cites at least one id the card's source list has; comp tags come from COMP_TAGS. */
function parseCoaching(coaching: any, ids: Set<string>, source: string): void {
	need(coaching && typeof coaching === "object", source, "coaching");
	const cited = (sources: unknown, path: string) => need(Array.isArray(sources) && sources.length > 0 && sources.every((id) => typeof id === "string" && ids.has(id)), source, `${path}.sources`);
	const text = (value: unknown, path: string) => need(typeof value === "string" && value.length > 0 && value.length <= MAX_ROW_CHARS && !value.includes("\n"), source, path);
	for (const key of ["damage", "archetype", "axis", "winCondition"]) {
		if (coaching[key] === undefined) continue;
		text(coaching[key]?.value, `coaching.${key}.value`);
		cited(coaching[key]?.sources, `coaching.${key}`);
	}
	for (const key of ["spikes", "bait", "mistakes"]) need(Array.isArray(coaching[key]) && coaching[key].length <= MAX_LIST_ROWS, source, `coaching.${key}`);
	coaching.spikes.forEach((row: any, index: number) => {
		text(row?.at, `coaching.spikes[${index}].at`);
		text(row?.why, `coaching.spikes[${index}].why`);
		cited(row?.sources, `coaching.spikes[${index}]`);
	});
	coaching.bait.forEach((row: any, index: number) => {
		need(BAIT_SLOTS.includes(row?.slot), source, `coaching.bait[${index}].slot`);
		text(row?.why, `coaching.bait[${index}].why`);
		cited(row?.sources, `coaching.bait[${index}]`);
	});
	coaching.mistakes.forEach((row: any, index: number) => {
		text(row?.value, `coaching.mistakes[${index}].value`);
		cited(row?.sources, `coaching.mistakes[${index}]`);
	});
	need(Array.isArray(coaching.comp?.tags) && coaching.comp.tags.every((tag: unknown) => COMP_TAGS.includes(tag as string)), source, "coaching.comp.tags");
	if (coaching.comp.tags.length) cited(coaching.comp.sources, "coaching.comp");
	// A layer with nothing in it would reach the prompt as a header with nothing under it.
	need(Object.keys(coachingRows(coaching)).length > 0, source, "coaching (it holds no row and no tag)");
}

const label = (key: string) => key.replace(/([A-Z])/g, " $1").toLowerCase();

/** The coaching rows as the model reads them, in the words of the card. Empty for a card with no coaching layer. */
export function championCoachingRows(card: ChampionCard) {
	return card.coaching && coachingRows(card.coaching);
}

function coachingRows(coaching: ChampionCoaching) {
	return {
		...(coaching.damage ? { damage: coaching.damage.value } : {}),
		...(coaching.archetype ? { archetype: coaching.archetype.value } : {}),
		...(coaching.axis ? { laneAxis: coaching.axis.value } : {}),
		...(coaching.spikes.length ? { powerSpikes: coaching.spikes.map((row) => `${row.at}: ${row.why}`) } : {}),
		...(coaching.bait.length ? { cooldownToBait: coaching.bait.map((row) => `${row.slot}: ${row.why}`) } : {}),
		...(coaching.winCondition ? { winCondition: coaching.winCondition.value } : {}),
		...(coaching.mistakes.length ? { commonMistakes: coaching.mistakes.map((row) => row.value) } : {}),
		...(coaching.comp.tags.length ? { compTags: coaching.comp.tags } : {}),
	};
}

/** The passage the frame judges a card claim against: every kept row, so a claim lifted from the card is never unsupported for lack of text. */
export function championCoachingText(card: ChampionCard): string | undefined {
	const rows = championCoachingRows(card);
	if (!rows) return undefined;
	const lines = Object.entries(rows).map(([key, value]) => `${label(key)}: ${Array.isArray(value) ? value.join("; ") : value}.`.replace(/\.\.$/, "."));
	return [`Coaching notes for ${card.name}, from ${card.meta.sources?.length ?? 0} sources, built ${card.meta.generated} on ${card.meta.version}; third-party, grounded row by row.`, ...lines].join(" ");
}

const loadFailLogged = new Set<string>();

/** The stored card for a Data Dragon champion id, or undefined: no file, a path-shaped id, or a card that no longer parses is skipped, never fatal. */
export function loadChampionCard(id: string, dir: string = CHAMPION_CARDS_DIR): ChampionCard | undefined {
	if (!CHAMPION_ID.test(id)) return undefined;
	const path = join(dir, `${id}.json`);
	if (!existsSync(path)) return undefined;
	try {
		return parseChampionCard(JSON.parse(readFileSync(path, "utf8")), path, id);
	} catch (error) {
		const why = `${path}: ${error instanceof Error ? error.message : error}`;
		if (!loadFailLogged.has(why)) {
			loadFailLogged.add(why);
			logEvent("warn", "champion-card", "load-failed", { path }, error);
		}
		return undefined;
	}
}

const squash = (value: unknown) => String(value ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();

/** The Data Dragon champion entry for a typed name: its id ("MonkeyKing") or its display name ("Wukong"), letters and digits, any case. */
export function findChampion(champions: Record<string, any>, name: string): any {
	const key = squash(name);
	return Object.values(champions).find((entry: any) => squash(entry?.id) === key || squash(entry?.name) === key);
}

let knownChampions: Record<string, any> | undefined;
/** The gateway hands over Data Dragon's champion list once it loads it, so a card lookup maps a display name to its id the way `voxren_game_facts` does. */
export function knowChampions(champions: Record<string, any> | undefined): void {
	knownChampions = champions;
	// No list is the state before the first load: a test starting from it must see a missing card logged again, not the line a run before it wrote.
	if (champions === undefined) missingLogged.clear();
}

const missingLogged = new Set<string>();

/**
 * The stored card for a champion as the player typed it ("Wukong", "Nunu & Willump", "Kai'Sa"): Data Dragon's id for the
 * name when its list is known, else the file whose name matches letters and digits. A name with no card is logged once.
 */
export function cardForChampion(name: string, dir: string = CHAMPION_CARDS_DIR, champions: Record<string, any> | undefined = knownChampions): ChampionCard | undefined {
	const key = squash(findChampion(champions ?? {}, name)?.id) || squash(name);
	const file = key && existsSync(dir) ? readdirSync(dir).find((entry) => entry.toLowerCase() === `${key}.json`) : undefined;
	if (file) return loadChampionCard(file.slice(0, -5), dir);
	if (key && !missingLogged.has(key)) {
		missingLogged.add(key);
		logEvent("info", "champion-card", "no-card", { champion: name, id: key, mapped: champions !== undefined });
	}
	return undefined;
}

/** What the system prompt carries of a card: its coaching rows, one `- label: value` line each. Undefined for a card with no coaching layer. */
export interface PromptCard {
	name: string;
	built: string;
	version: string;
	rows: string[];
}

const staleLogged = new Set<string>();

/**
 * The one decision on whether a card's coaching may reach the coach: only a card built on the live Data Dragon version.
 * Spike, bait, and mistake rows name items and numbers a patch moves, so a patch-old row left in the prompt or the
 * evidence would be stated, and judged supported, as current. It is left out, not labelled: a label asks the model to
 * weigh a claim it cannot check, and an omitted row costs only a missing hint, never a wrong call. The facts always come
 * from the live version. A stale card is logged once; an unknown live version (Data Dragon unreachable) is not proof of a
 * stale card, but is not proof of a fresh one either, so it also stays out, unlogged.
 */
export function currentCard(card: ChampionCard | undefined, liveVersion: string | undefined): ChampionCard | undefined {
	if (!card || liveVersion === undefined) return undefined;
	if (card.meta.version === liveVersion) return card;
	const key = `${card.id}@${card.meta.version}>${liveVersion}`;
	if (!staleLogged.has(key)) {
		staleLogged.add(key);
		logEvent("warn", "champion-card", "stale-card", { id: card.id, built: card.meta.version, live: liveVersion, fix: "run src/lab/refresh-champion-kb.ts --coaching" });
	}
	return undefined;
}

export function promptCard(stored: ChampionCard | undefined, liveVersion: string | undefined): PromptCard | undefined {
	const card = currentCard(stored, liveVersion);
	const rows = card && championCoachingRows(card);
	if (!card || !rows) return undefined;
	return { name: card.name, built: card.meta.generated, version: card.meta.version, rows: Object.entries(rows).map(([key, value]) => `- ${label(key)}: ${Array.isArray(value) ? value.join("; ") : value}`) };
}
