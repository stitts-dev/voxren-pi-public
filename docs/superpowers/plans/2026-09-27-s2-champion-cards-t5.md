# S2 / T5 Stored Champion Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `voxren_game_facts` answers a champion lookup from a checked-in card at `data/champions/<id>.json` when the card's Data Dragon version matches the live one, falls back to live facts with a stale marker when it does not, and behaves exactly as today when no card exists (issue #87).

**Architecture:** One new module, `src/champion-card.ts`, owns the card format: the Data Dragon parser (`championFacts`), the fact text the tool already emits (`championFactText`), the validator (`parseChampionCard`), and the loader (`loadChampionCard`, skip-never-fatal like `loadOtpReference`). The gateway's champion branch switches to that module, so card and live paths render the same text. A hand-run lab writes one card from Data Dragon.

**Tech Stack:** TypeScript on Bun, Riot Data Dragon `champion/<id>.json`.

**Spec:** `docs/superpowers/specs/2026-09-27-coach-knowledge-design.md` (section "S2 Champion cards"; this plan is T5 only: facts, no coaching layer).

## Global Constraints

- Game data comes from Data Dragon or a named data file; no champion constant in code (AGENTS rule 5). The one checked-in card is data, not code.
- Lane play rates are not copied into cards; they stay in `data/championRoles.json`.
- A card that fails to parse at runtime is skipped (live facts), never fatal; the test suite is what stops a bad card from shipping.
- The tool's model-facing fact text is unchanged for the live path; a fresh card produces the same text from stored facts.
- Tests prove behavior through public functions (AGENTS rule 6).
- Commits: `git add <paths>` explicitly, no co-author trailer.
- Worktree `<worktree>`, branch `87/champion-cards` (from `coach-knowledge-spec`).

## Review Focus

1. Existing gateway tests that pass no `championCardsDir` read the real `data/champions/`. The checked-in card's version (`16.19.x`) differs from the fake's `16.18.1`, so they take the stale path and still fetch, which the abort test relies on. Task 2 runs the whole file to confirm.
2. A champion id with path characters (`../x`) reaching the loader could read outside `data/champions/`. Task 1 tests that a non-alphanumeric id returns undefined.
3. A card whose `meta.version` is a patch prefix (`16.19`) rather than the full Data Dragon version (`16.19.1`) would always read as stale. Task 1's validator requires the full `N.N.N` shape.
4. Data Dragon adding a fifth spell or omitting `cost` would throw in a strict parser. Task 1 tests that `championFacts` tolerates missing arrays and extra spells.
5. A fresh card must spare the per-champion Data Dragon request; a stale card must not. Task 2 asserts on the fetched URLs.
6. The card file name and its `id` disagreeing (`fizz.json` holding `"id": "Fizz"`) would make the loader miss it on a case-sensitive filesystem. Task 3's data test requires the file name to equal `<id>.json`.

---

### Task 1: Card format module

**Files:**
- Create: `src/champion-card.ts`
- Test: `src/champion-card.test.ts`

**Interfaces:**
- Produces:
  - `interface ChampionSpell { slot: string; name: string; cooldown: number[]; cost: number[]; range: number[]; text: string }`
  - `interface ChampionFacts { title: string; tags: string[]; resource: string; stats: Record<string, number>; passive: { name: string; text: string }; spells: ChampionSpell[] }`
  - `interface ChampionCard { meta: { version: string; generated: string }; id: string; name: string; facts: ChampionFacts }`
  - `championFacts(full: unknown): ChampionFacts`
  - `championFactText(facts: ChampionFacts): string`
  - `parseChampionCard(value: unknown, source: string): ChampionCard`
  - `loadChampionCard(id: string, dir?: string): ChampionCard | undefined`
  - `CHAMPION_CARDS_DIR: string`

- [ ] **Step 1: Write the failing tests**

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { championFactText, championFacts, loadChampionCard, parseChampionCard } from "./champion-card";

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/champion-card.test.ts`
Expected: FAIL, cannot resolve `./champion-card`.

- [ ] **Step 3: Implement**

```ts
/**
 * Stored champion cards: `data/champions/<Data Dragon id>.json`, one per champion, stamped with the Data Dragon version
 * they were read from. `voxren_game_facts` answers from a card whose version matches the live one and reads Data Dragon
 * otherwise. The card and live paths share `championFacts` and `championFactText`, so both render the same text.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

export interface ChampionCard {
	meta: { version: string; generated: string };
	id: string;
	name: string;
	facts: ChampionFacts;
}

export const CHAMPION_CARDS_DIR = fileURLToPath(new URL("../data/champions/", import.meta.url));
const CHAMPION_ID = /^[A-Za-z0-9]+$/;
const DATA_DRAGON_VERSION = /^\d+\.\d+\.\d+$/;
const SLOTS = ["Q", "W", "E", "R"];

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
export function championFactText(facts: ChampionFacts): string {
	const spells = facts.spells.map((spell) => `${spell.slot} ${spell.name}: cd ${spell.cooldown.join("/")}, cost ${spell.cost.join("/")}, range ${spell.range.slice(0, 1).join("")}`).join("; ");
	return `${facts.title}. Passive ${facts.passive.name || "?"}. ${spells}`;
}

function need(condition: unknown, source: string, path: string): void {
	if (!condition) throw new Error(`${source}: ${path} is missing or malformed`);
}

export function parseChampionCard(value: unknown, source: string): ChampionCard {
	const card = value as Record<string, any> | undefined;
	need(card && typeof card === "object", source, "card");
	need(typeof card?.meta?.version === "string" && DATA_DRAGON_VERSION.test(card.meta.version), source, "meta.version");
	need(typeof card?.meta?.generated === "string" && card.meta.generated.length > 0, source, "meta.generated");
	need(typeof card?.id === "string" && CHAMPION_ID.test(card.id), source, "id");
	need(typeof card?.name === "string" && card.name.length > 0, source, "name");
	const facts = card?.facts as Record<string, any> | undefined;
	need(facts && typeof facts === "object", source, "facts");
	need(typeof facts?.title === "string", source, "facts.title");
	need(Array.isArray(facts?.tags), source, "facts.tags");
	need(typeof facts?.resource === "string", source, "facts.resource");
	need(facts?.stats && typeof facts.stats === "object", source, "facts.stats");
	need(typeof facts?.passive?.name === "string" && typeof facts?.passive?.text === "string", source, "facts.passive");
	need(Array.isArray(facts?.spells), source, "facts.spells");
	(facts?.spells as any[]).forEach((spell, index) => {
		need(typeof spell?.slot === "string" && typeof spell?.name === "string" && typeof spell?.text === "string", source, `facts.spells[${index}]`);
		for (const key of ["cooldown", "cost", "range"]) need(Array.isArray(spell?.[key]), source, `facts.spells[${index}].${key}`);
	});
	return card as ChampionCard;
}

/** The stored card for a Data Dragon champion id, or undefined: no file, a path-shaped id, or a card that no longer parses is skipped, never fatal. */
export function loadChampionCard(id: string, dir: string = CHAMPION_CARDS_DIR): ChampionCard | undefined {
	if (!CHAMPION_ID.test(id)) return undefined;
	const path = join(dir, `${id}.json`);
	if (!existsSync(path)) return undefined;
	try {
		return parseChampionCard(JSON.parse(readFileSync(path, "utf8")), path);
	} catch {
		return undefined;
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/champion-card.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/champion-card.ts src/champion-card.test.ts
git commit -m "feat(coach): champion card format, Data Dragon parser, and skip-never-fatal loader"
```

### Task 2: `voxren_game_facts` reads the card

**Files:**
- Modify: `src/live-gateway.ts` (`LiveGatewayOptions`, champion branch of `gameFacts`)
- Test: `src/live-gateway.test.ts`

**Interfaces:**
- Consumes: `championFacts`, `championFactText`, `loadChampionCard`, `CHAMPION_CARDS_DIR` from Task 1.
- Produces: `LiveGatewayOptions.championCardsDir?: string`; each champion entity in the `gamedata.lookup` response gains `card?: { version: string; stale: boolean }` (absent with no card).

- [ ] **Step 1: Write the failing tests**

Add `import { championFacts } from "./champion-card";` to the imports of `src/live-gateway.test.ts` (`mkdtempSync`, `writeFileSync`, `tmpdir`, `join` are already imported). Append this block; it builds `LiveResearchGateway` the way the file's abort test does, over the file's `dataDragon(url)` fake (which reports version `16.18.1`):

```ts
describe("voxren_game_facts reads stored champion cards (#87)", () => {
	function gatewayWith(route: (url: string) => Response | undefined, championCardsDir: string) {
		const fetchImpl = async (url: string) => {
			const response = route(url);
			if (!response) throw new Error(`unexpected upstream ${url}`);
			return response;
		};
		return new LiveResearchGateway({ auditAccounts: () => [], fetchImpl: fetchImpl as any, championCardsDir, sleep: async () => {}, now: () => new Date("2026-09-25T20:00:00.000Z") });
	}

	function cardsDir(version: string) {
		const dir = mkdtempSync(join(tmpdir(), "cards-"));
		const facts = championFacts({ title: "the Tidal Trickster", passive: { name: "Nimble Fighter" }, spells: [{ name: "Urchin Strike", cooldown: [8, 7.5], cost: [50], range: [550] }] });
		writeFileSync(join(dir, "Fizz.json"), JSON.stringify({ meta: { version, generated: "2026-09-27" }, id: "Fizz", name: "Fizz", facts }));
		return dir;
	}

	test("a card at the live version answers from disk and skips the per-champion request", async () => {
		const calls: string[] = [];
		const live = gatewayWith((url) => { calls.push(url); return dataDragon(url); }, cardsDir("16.18.1"));
		const result = await live.call("gamedata.lookup", { entities: [{ kind: "champion", name: "Fizz" }] });
		const entity = (result.data as any).entities[0];
		expect(entity.fact).toBe("the Tidal Trickster. Passive Nimble Fighter. Q Urchin Strike: cd 8/7.5, cost 50, range 550");
		expect(entity.card).toEqual({ version: "16.18.1", stale: false });
		expect(calls.some((url) => url.endsWith("/champion/Fizz.json"))).toBe(false);
	});

	test("a card from another version is marked stale and the live facts answer", async () => {
		const calls: string[] = [];
		const live = gatewayWith((url) => { calls.push(url); return dataDragon(url); }, cardsDir("16.17.1"));
		const result = await live.call("gamedata.lookup", { entities: [{ kind: "champion", name: "Fizz" }] });
		const entity = (result.data as any).entities[0];
		expect(entity.card).toEqual({ version: "16.17.1", stale: true });
		expect(calls.some((url) => url.endsWith("/champion/Fizz.json"))).toBe(true);
		expect(entity.fact).toContain("Urchin Strike: cd 8/7.5");
	});

	test("no card: the entity carries no card field and facts come from Data Dragon, as before", async () => {
		const live = gatewayWith(dataDragon, mkdtempSync(join(tmpdir(), "cards-")));
		const result = await live.call("gamedata.lookup", { entities: [{ kind: "champion", name: "Fizz" }] });
		const entity = (result.data as any).entities[0];
		expect(entity.card).toBeUndefined();
		expect(entity.fact).toBe("the Tidal Trickster. Passive Nimble Fighter. Q Urchin Strike: cd 8/7.5, cost 50, range 550");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/live-gateway.test.ts`
Expected: the three new tests FAIL (`championCardsDir` ignored: fresh test sees the `/champion/Fizz.json` call and no `card` field).

- [ ] **Step 3: Implement**

In `src/live-gateway.ts`:

1. Import: `import { CHAMPION_CARDS_DIR, championFactText, championFacts, loadChampionCard, type ChampionFacts } from "./champion-card";`
2. In `LiveGatewayOptions`, after `dataDragonBase?: string;` add:
```ts
	/** Where stored champion cards live; tests point this at a temp dir. */
	championCardsDir?: string;
```
3. Change the `facts` array type in `gameFacts` to `Array<{ name: string; kind: string; fact: string; card?: { version: string; stale: boolean } }>`.
4. Replace the champion branch body after the `if (!champion) { ... continue; }` block with:
```ts
				const card = loadChampionCard(String(champion.id), this.options.championCardsDir ?? CHAMPION_CARDS_DIR);
				const fresh = card?.meta.version === dd.version;
				let championFactsNow: ChampionFacts;
				let name = String(champion.name);
				if (card && fresh) {
					championFactsNow = card.facts;
					name = card.name;
				} else {
					const detail = await this.json(`${base}/cdn/${dd.version}/data/en_US/champion/${champion.id}.json`, { method: "GET" }, signal);
					const full: any = detail?.data?.[champion.id] ?? {};
					championFactsNow = championFacts(full);
					name = String(full.name ?? champion.name);
				}
				facts.push({ name, kind, fact: clip(championFactText(championFactsNow), 700), ...(card ? { card: { version: card.meta.version, stale: !fresh } } : {}) });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/live-gateway.test.ts && npm run typecheck`
Expected: all PASS, including the existing `game-1` evidence test (`Fizz: the Tidal Trickster`, `Urchin Strike`) and the abort test that expects no `TwistedFate.json` request.

- [ ] **Step 5: Commit**

```bash
git add src/live-gateway.ts src/live-gateway.test.ts
git commit -m "feat(coach): voxren_game_facts answers from a current champion card and marks a stale one"
```

### Task 3: Card lab, the first card, and the data gate

**Files:**
- Create: `src/lab/refresh-champion-kb.ts`
- Create: `src/lab/refresh-champion-kb.test.ts`
- Create: `data/champions/Fizz.json` (generated by the lab, not hand-written)
- Modify: `AGENTS.md` (layout rows for `src/champion-card.ts` and `data/`)

**Interfaces:**
- Consumes: `championFacts`, `parseChampionCard`, `CHAMPION_CARDS_DIR`, `type ChampionCard` from Task 1.
- Produces: `cardFromDataDragon(detail: unknown, id: string, version: string, generated: string): ChampionCard`.

- [ ] **Step 1: Write the failing tests**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CHAMPION_CARDS_DIR, parseChampionCard } from "../champion-card";
import { cardFromDataDragon } from "./refresh-champion-kb";

describe("cardFromDataDragon", () => {
	test("builds a valid card from a champion/<id>.json response, stamped with the full version", () => {
		const detail = { data: { Fizz: { name: "Fizz", title: "the Tidal Trickster", partype: "Mana", tags: ["Assassin"], stats: { hp: 640 }, passive: { name: "Nimble Fighter", description: "x" }, spells: [{ name: "Urchin Strike", cooldown: [8], cost: [50], range: [550], description: "y" }] } } };
		const card = cardFromDataDragon(detail, "Fizz", "16.19.1", "2026-09-27");
		expect(parseChampionCard(card, "test")).toEqual(card);
		expect(card.meta).toEqual({ version: "16.19.1", generated: "2026-09-27" });
		expect(card.name).toBe("Fizz");
		expect(card.facts.spells[0].name).toBe("Urchin Strike");
	});

	test("a response without the champion fails instead of writing an empty card", () => {
		expect(() => cardFromDataDragon({ data: {} }, "Fizz", "16.19.1", "2026-09-27")).toThrow("Data Dragon has no Fizz");
	});
});

describe("data/champions (checked-in cards)", () => {
	test("every card parses, and its file name is <id>.json", () => {
		const files = readdirSync(CHAMPION_CARDS_DIR).filter((file) => file.endsWith(".json"));
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const card = parseChampionCard(JSON.parse(readFileSync(join(CHAMPION_CARDS_DIR, file), "utf8")), file);
			expect(file).toBe(`${card.id}.json`);
		}
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/lab/refresh-champion-kb.test.ts`
Expected: FAIL, cannot resolve `./refresh-champion-kb`.

- [ ] **Step 3: Implement the lab**

```ts
/**
 * Champion card lab: writes data/champions/<id>.json from Riot Data Dragon (the current version's champion/<id>.json),
 * the same endpoint voxren_game_facts reads live. Run by hand when a patch ships, then commit the card:
 *
 *   bun run src/lab/refresh-champion-kb.ts Fizz [Ahri ...]
 *
 * Never loaded by the coach. A champion the fetch or the validator rejects keeps its previous card and is reported.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAMPION_CARDS_DIR, championFacts, parseChampionCard, type ChampionCard } from "../champion-card";

const DATA_DRAGON_BASE = "https://ddragon.leagueoflegends.com";

export function cardFromDataDragon(detail: unknown, id: string, version: string, generated: string): ChampionCard {
	const full = (detail as any)?.data?.[id];
	if (!full || typeof full !== "object") throw new Error(`Data Dragon has no ${id} in this response`);
	return parseChampionCard({ meta: { version, generated }, id, name: String(full.name ?? id), facts: championFacts(full) }, `${id} from Data Dragon ${version}`);
}

async function json(url: string): Promise<unknown> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	return response.json();
}

async function main() {
	const ids = process.argv.slice(2);
	if (!ids.length) throw new Error("usage: bun run src/lab/refresh-champion-kb.ts <DataDragonId> [...]");
	const versions = (await json(`${DATA_DRAGON_BASE}/api/versions.json`)) as string[];
	const version = versions[0];
	const generated = new Date().toISOString().slice(0, 10);
	for (const id of ids) {
		try {
			const card = cardFromDataDragon(await json(`${DATA_DRAGON_BASE}/cdn/${version}/data/en_US/champion/${id}.json`), id, version, generated);
			writeFileSync(join(CHAMPION_CARDS_DIR, `${id}.json`), `${JSON.stringify(card, null, "\t")}\n`);
			console.log(`${id}: wrote card for ${version} (${card.facts.spells.length} spells)`);
		} catch (error) {
			console.log(`${id}: kept previous card, ${(error as Error).message}`);
		}
	}
}

if (import.meta.main) await main();
```

- [ ] **Step 4: Generate the first card**

Run: `mkdir -p data/champions && bun run src/lab/refresh-champion-kb.ts Fizz`
Expected: `Fizz: wrote card for 16.19.1 (4 spells)` (the version is whatever Data Dragon lists first today).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test && npm run typecheck`
Expected: all PASS, including the data gate over `data/champions/`.

- [ ] **Step 6: Update AGENTS.md layout**

Add a row after `src/otp-reference.ts`'s row:
```
| `src/champion-card.ts` | Stored champion cards: format, Data Dragon parser, validator, skip-never-fatal loader. `voxren_game_facts` answers from a card at the live Data Dragon version and marks an older one stale. |
```
In the `data/` row, add "champion cards (`champions/<Data Dragon id>.json`, written by `src/lab/refresh-champion-kb.ts`)".

- [ ] **Step 7: Verify in the real coach**

Run: `node bin/coach.mjs -p "what are Fizz's cooldowns"`, then:
```bash
tail -n 1 ~/Library/Application\ Support/voxren-coach/exchanges.ndjson | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s);for(const t of e.tools)if(t.name==="voxren_game_facts")console.log(JSON.stringify(t.result?.data?.entities))})'
```
Expected: the Fizz entity carries `"card":{"version":"<today's version>","stale":false}` and the answer's cooldowns match the card.

- [ ] **Step 8: Commit**

```bash
git add src/lab/refresh-champion-kb.ts src/lab/refresh-champion-kb.test.ts data/champions/Fizz.json AGENTS.md
git commit -m "feat(lab): champion card lab and the first stored card"
```
