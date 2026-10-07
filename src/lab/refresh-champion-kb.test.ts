import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CHAMPION_CARDS_DIR, parseChampionCard, type ChampionCard } from "../champion-card";
import { buildChampionCoaching, type CardBuildDeps } from "../champion-card-build";
import { createHostedSearch } from "../hosted-search";
import { measureWorker, noUsage, type PiWorker } from "../pi-worker";
import { cardFromDataDragon, parseRefreshArgs, refreshChampions, usageText, type RefreshDeps } from "./refresh-champion-kb";

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

const DD = "https://ddragon.leagueoflegends.com";

/** Data Dragon as a test sees it: the version list, the champion list, and one file per champion; `broken` ids answer 503. */
function fakeDataDragon(ids: string[], broken: string[] = []) {
	const urls: string[] = [];
	const fetch = async (input: string) => {
		urls.push(input);
		if (input === `${DD}/api/versions.json`) return Response.json(["16.20.1", "16.19.1"]);
		if (input === `${DD}/cdn/16.20.1/data/en_US/champion.json`) return Response.json({ data: Object.fromEntries(ids.map((id) => [id, { id, name: id }])) });
		const id = /\/cdn\/16\.20\.1\/data\/en_US\/champion\/(\w+)\.json$/.exec(input)?.[1];
		if (id && broken.includes(id)) return new Response("down", { status: 503 });
		if (id) return Response.json({ data: { [id]: { name: id, title: `the ${id}`, partype: "Mana", tags: ["Mage"], stats: { hp: 600 }, passive: { name: "Passive", description: "p" }, spells: [{ name: `${id} Q`, cooldown: [8], cost: [50], range: [550], description: "Hits." }] } } });
		return new Response("not found", { status: 404 });
	};
	return { fetch, urls };
}

/**
 * The whole coaching build with the worker, Jev, and the research service faked: the real builder, the real hosted search, and the
 * real measuring worker. Every worker run reports usage (a search one cheaper). The worker answers no rows for a champion in `empty`.
 */
function world(empty: string[] = []) {
	const stored = new Map<string, ChampionCard>();
	let jev = 0;
	const asked: string[] = [];
	const fake: PiWorker = async (request) => {
		asked.push(request.prompt.slice(0, 40));
		request.onUsage?.(request.hostedSearch ? { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.001 } : { input: 1000, output: 200, cacheRead: 50, cacheWrite: 0, cost: 0.01 });
		if (request.hostedSearch) return JSON.stringify({ answer: "", results: [{ title: "Guide", url: "https://www.mobafire.com/guide", quotes: ["a guide"] }] });
		const champion = /coaching rows for (\w+)/.exec(request.prompt)?.[1] ?? "";
		return request.material?.includes("PART s1-1") && !empty.includes(champion) ? `Damage: ${champion} deals burst magic damage. [s1-1]` : "";
	};
	const measured = measureWorker(fake);
	const deps: CardBuildDeps = {
		model: "test-model",
		research: { async call() { return { source: "site", passages: [{ id: "p1", text: "A burst mage guide." }] }; } },
		hostedSearch: createHostedSearch(measured.worker),
		worker: measured.worker,
		judge: { async judge(claims, passages) { jev += 100; return { status: "judged", judge: "f", model: "f", latencyMs: 1, inputTokens: 100, verdicts: [{ claim: claims[0], route: "grounded", p: { supported: 1, contradicted: 0 }, source: passages[0].id }] } as any; } },
		screen: { async judge(_query, _context, passages) { jev += 10; return { status: "judged", judge: "f", model: "f", latencyMs: 1, inputTokens: 10, verdicts: passages.map((passage) => ({ id: passage.id, route: "evidence", p: { relevant: 1, support: 1, injection: 0 } })) } as any; } },
		now: () => new Date("2026-10-04T12:00:00Z"),
	};
	const log: string[] = [];
	const refreshDeps = (dragon: { fetch: RefreshDeps["fetch"] }): RefreshDeps => ({
		fetch: dragon.fetch,
		load: (id) => stored.get(id),
		save: (card) => void stored.set(card.id, card),
		build: (card) => buildChampionCoaching(deps, card),
		spent: () => {
			const taken = { worker: measured.take(), jevTokens: jev };
			jev = 0;
			return taken;
		},
		log: (line) => void log.push(line),
		now: () => new Date("2026-10-04T12:00:00Z"),
	});
	return { stored, log, refreshDeps, asked };
}

const aCard = (id: string, version: string, coaching = true): ChampionCard =>
	({ meta: { version, generated: "2026-10-01" }, id, name: id, facts: { title: "", tags: [], resource: "", stats: {}, passive: { name: "", text: "" }, spells: [] }, ...(coaching ? { coaching: { spikes: [], bait: [], mistakes: [], comp: { tags: [], sources: [] } } } : {}) }) as ChampionCard;

describe("refreshChampions (--all)", () => {
	test("takes the champion list from Data Dragon, builds each card, and prints the measured usage of each", async () => {
		const dragon = fakeDataDragon(["Jinx", "Ahri", "Fizz"]);
		const { stored, log, refreshDeps } = world();
		const report = await refreshChampions({ ids: [], all: true, coaching: true }, refreshDeps(dragon));
		// Data Dragon's list, in order, never a list in code.
		expect(report.built).toEqual(["Ahri", "Fizz", "Jinx"]);
		expect(dragon.urls).toContain(`${DD}/cdn/16.20.1/data/en_US/champion.json`);
		expect([...stored.keys()].sort()).toEqual(["Ahri", "Fizz", "Jinx"]);
		expect(stored.get("Fizz")?.coaching?.damage?.value).toBe("Fizz deals burst magic damage.");
		// One search run and two distil runs per card, all counted: 100 + 2 x 1000 in.
		const line = log.find((entry) => entry.startsWith("Fizz: coaching"));
		expect(line).toContain("worker 3 runs 2100 in 410 out, cache 100 read 0 written, $0.0210 at Pi list price, tokens only");
		// One judged row at 100 and the two screens (the page, then the finished rows) at 10 each.
		expect(line).toContain("120 input tokens incl. screen");
		expect(report.spent.worker).toMatchObject({ runs: 9, reported: 9, input: 6300, output: 1230, cacheRead: 300, unpriced: 0 });
		expect(report.spent.worker.cost).toBeCloseTo(0.063, 10);
		expect(report.spent.jevTokens).toBe(360);
	});

	test("skips a champion whose card is current, and counts one built on an older patch or with no coaching layer as not current", async () => {
		const dragon = fakeDataDragon(["Ahri", "Fizz", "Jinx", "Ornn"]);
		const { stored, log, refreshDeps } = world();
		stored.set("Ahri", aCard("Ahri", "16.20.1"));
		stored.set("Fizz", aCard("Fizz", "16.19.1"));
		stored.set("Jinx", aCard("Jinx", "16.20.1", false));
		const report = await refreshChampions({ ids: [], all: true, coaching: true }, refreshDeps(dragon));
		expect(report.skipped).toEqual(["Ahri"]);
		expect(report.built).toEqual(["Fizz", "Jinx", "Ornn"]);
		expect(dragon.urls.some((url) => url.endsWith("/champion/Ahri.json"))).toBe(false);
		expect(stored.get("Ahri")?.meta.generated).toBe("2026-10-01");
		expect(log).toContain("Ahri: skipped, its card is current for 16.20.1");
	});

	test("a card that is current without a coaching layer is current when only facts are refreshed", async () => {
		const dragon = fakeDataDragon(["Ahri", "Fizz"]);
		const { stored, refreshDeps } = world();
		stored.set("Ahri", aCard("Ahri", "16.20.1", false));
		const report = await refreshChampions({ ids: [], all: true, coaching: false }, { ...refreshDeps(dragon), build: undefined });
		expect(report.skipped).toEqual(["Ahri"]);
		expect(report.built).toEqual(["Fizz"]);
		expect(stored.get("Fizz")?.coaching).toBeUndefined();
	});

	test("keeps going after a failure, and ends with each failure's reason and the usage of every card, failed ones too", async () => {
		const dragon = fakeDataDragon(["Ahri", "Fizz", "Jinx", "Ornn"], ["Fizz"]);
		const { stored, log, refreshDeps } = world(["Ahri"]);
		const report = await refreshChampions({ ids: [], all: true, coaching: true }, refreshDeps(dragon));
		expect(report.built).toEqual(["Jinx", "Ornn"]);
		expect(report.failed).toEqual([
			{ id: "Ahri", reason: "no row survived the source check" },
			{ id: "Fizz", reason: `${DD}/cdn/16.20.1/data/en_US/champion/Fizz.json: HTTP 503` },
		]);
		expect([...stored.keys()].sort()).toEqual(["Jinx", "Ornn"]);
		// Ahri spent a search and two distils before Jev kept nothing; Fizz never reached a worker.
		expect(report.spent.worker.runs).toBe(9);
		expect(report.spent.worker.cost).toBeCloseTo(0.063, 10);
		expect(log.slice(log.findIndex((line) => line.startsWith("refreshed")))).toEqual([
			"refreshed on Data Dragon 16.20.1: 2 built, 0 skipped, 2 failed",
			"failed Ahri: no row survived the source check",
			`failed Fizz: ${DD}/cdn/16.20.1/data/en_US/champion/Fizz.json: HTTP 503`,
			"spent by every card, failed ones too: worker 9 runs 6300 in 1230 out, cache 300 read 0 written, $0.0630 at Pi list price, tokens only, Jev 250 input tokens incl. screen",
		]);
		// 120 each for Jinx and Ornn, and the 10 Ahri spent screening its page before its build failed.
	});

	test("--limit builds at most that many cards, in Data Dragon's order, and names the champions it did not reach", async () => {
		const dragon = fakeDataDragon(["Ahri", "Fizz", "Jinx", "Ornn"]);
		const { stored, log, refreshDeps } = world(["Fizz"]);
		stored.set("Ahri", aCard("Ahri", "16.20.1"));
		// A skipped card is not a build, a failed one is: Ahri is skipped, Fizz fails, Jinx is built, and Ornn is left.
		const report = await refreshChampions({ ids: [], all: true, coaching: true, limit: 2 }, refreshDeps(dragon));
		expect(report.skipped).toEqual(["Ahri"]);
		expect(report.failed.map((entry) => entry.id)).toEqual(["Fizz"]);
		expect(report.built).toEqual(["Jinx"]);
		expect(report.notReached).toEqual(["Ornn"]);
		expect(dragon.urls.some((url) => url.endsWith("/champion/Ornn.json"))).toBe(false);
		expect(log.find((line) => line.startsWith("refreshed"))).toBe("refreshed on Data Dragon 16.20.1: 1 built, 1 skipped, 1 failed, 1 not reached (--limit 2): Ornn");
	});

	test("champions named on the command line are rebuilt even when current, and Data Dragon's list is not read", async () => {
		const dragon = fakeDataDragon(["Ahri", "Fizz"]);
		const { stored, refreshDeps } = world();
		stored.set("Fizz", aCard("Fizz", "16.20.1"));
		const report = await refreshChampions({ ids: ["Fizz"], all: false, coaching: true }, refreshDeps(dragon));
		expect(report.built).toEqual(["Fizz"]);
		expect(stored.get("Fizz")?.meta.generated).toBe("2026-10-04");
		expect(dragon.urls.some((url) => url.endsWith("/champion.json"))).toBe(false);
	});
});

describe("usageText", () => {
	test("tokens as measured, dollars only when Pi priced them, and any run that reported nothing named", () => {
		const total = { ...noUsage(), runs: 4, reported: 3, input: 3000, output: 600, cacheRead: 40, cacheWrite: 7, cost: 0.03, unpriced: 1 };
		expect(usageText(total)).toBe("worker 4 runs 3000 in 600 out, cache 40 read 7 written, $0.0300 at Pi list price, tokens only (1 runs unpriced), 1 runs reported nothing");
		expect(usageText({ ...noUsage(), runs: 1, reported: 1, input: 5, output: 2, unpriced: 1 })).toBe("worker 1 runs 5 in 2 out, cost not given");
	});
});

describe("parseRefreshArgs", () => {
	test("champion ids, or --all, with --coaching and --limit N (or --limit=N) beside them", () => {
		expect(parseRefreshArgs(["--coaching", "Fizz", "Ahri"])).toEqual({ ids: ["Fizz", "Ahri"], all: false, coaching: true });
		expect(parseRefreshArgs(["--all", "--limit", "3", "--coaching"])).toEqual({ ids: [], all: true, coaching: true, limit: 3 });
		expect(parseRefreshArgs(["--all", "--limit=5"])).toEqual({ ids: [], all: true, coaching: false, limit: 5 });
	});

	test("a line typed wrong says what is wrong", () => {
		expect(() => parseRefreshArgs([])).toThrow("usage:");
		expect(() => parseRefreshArgs(["--all", "Fizz"])).toThrow("--all takes the list from Data Dragon");
		expect(() => parseRefreshArgs(["--all", "--limit"])).toThrow("--limit takes a whole number");
		expect(() => parseRefreshArgs(["--all", "--limit", "0"])).toThrow("--limit takes a whole number");
		expect(() => parseRefreshArgs(["--all", "--limit", "two"])).toThrow("--limit takes a whole number");
		expect(() => parseRefreshArgs(["--alll"])).toThrow("unknown option --alll");
	});
});
