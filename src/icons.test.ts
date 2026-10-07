import { getCapabilities, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAllNoticesForTest, noticeLines, setLogSink, setNoticeHandler } from "./coach-log";
import { cachedIconCount, championIconData, championsIn, iconLine, isKnownName, itemIconLine, prefetchChampionIcons, prefetchItemIcons, prefetchRuneIcons, resetIcons } from "./icons";

// A minimal valid 1x1 transparent PNG, reused as the fixture "item icon".
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const BASE = "https://ddragon.example";

/** icons.ts caches item ids per Data Dragon version; each test uses its own fake version so that cache never leaks across tests. */
function fakeFetch(idByName: Record<string, number>, calls: string[] = []): { fetchImpl: typeof fetch; calls: string[] } {
	const fetchImpl = (async (url: string) => {
		calls.push(url);
		if (url.endsWith("/item.json")) {
			const data: Record<string, { name: string }> = {};
			for (const [name, id] of Object.entries(idByName)) data[String(id)] = { name };
			return { json: async () => ({ data }) } as Response;
		}
		return { arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) } as Response;
	}) as typeof fetch;
	return { fetchImpl, calls };
}

describe("icons", () => {
	afterEach(() => {
		resetCapabilitiesCache();
		clearAllNoticesForTest();
		setNoticeHandler(undefined);
		setLogSink(undefined);
	});

	test("resolves name -> id via item.json, fetches each PNG once, and caches it for itemIconLine", async () => {
		const version = "14.19.1-alpha";
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const { fetchImpl, calls } = fakeFetch({ "Icon Boots Alpha": 1001 });
		await prefetchItemIcons(["Icon Boots Alpha"], version, BASE, fetchImpl);
		expect(calls).toEqual([`${BASE}/cdn/${version}/data/en_US/item.json`, `${BASE}/cdn/${version}/img/item/1001.png`]);
		const line = itemIconLine("Icon Boots Alpha");
		expect(line).toBeDefined();
		expect(line).not.toBe("");

		// A second prefetch for the same name must not re-fetch the PNG (module cache).
		await prefetchItemIcons(["Icon Boots Alpha"], version, BASE, fetchImpl);
		expect(calls).toHaveLength(2);
	});

	test("an icon fetch that fails or returns no PNG is retried twice, and one that never decodes leaves the name as text", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const version = "14.19.1-retry";
		const pngCalls: Record<string, number> = {};
		const fetchImpl = (async (url: string) => {
			if (url.endsWith("/item.json")) return { json: async () => ({ data: { "1": { name: "Retry Flaky" }, "2": { name: "Retry Empty" } } }) } as Response;
			pngCalls[url] = (pngCalls[url] ?? 0) + 1;
			if (url.endsWith("/1.png")) {
				if (pngCalls[url] === 1) throw new Error("socket hang up");
				return { ok: true, arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) } as Response;
			}
			return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
		}) as typeof fetch;
		await prefetchItemIcons(["Retry Flaky", "Retry Empty"], version, BASE, fetchImpl);
		expect(itemIconLine("Retry Flaky")).toBeDefined();
		expect(itemIconLine("Retry Empty")).toBeUndefined();
		expect(pngCalls[`${BASE}/cdn/${version}/img/item/1.png`]).toBe(2);
		expect(pngCalls[`${BASE}/cdn/${version}/img/item/2.png`]).toBe(3);
	});

	test("champion portraits resolve by match-history spelling or display name through champion.json, each PNG fetched once", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const version = "14.19.1-champions";
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			if (url.endsWith("/champion.json")) return { json: async () => ({ data: { MonkeyKing: { id: "MonkeyKing", name: "Wukong", image: { full: "MonkeyKing.png" } }, Fiddlesticks: { id: "Fiddlesticks", name: "Fiddlesticks", image: { full: "Fiddlesticks.png" } } } }) } as Response;
			return { arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) } as Response;
		}) as typeof fetch;
		expect(championIconData("FiddleSticks")).toBeUndefined();
		// Match history spells it "FiddleSticks"; a champion Data Dragon does not list is skipped, not fetched.
		await prefetchChampionIcons(["FiddleSticks", "Wukong", "Not A Champion"], version, BASE, fetchImpl);
		expect(calls).toEqual([`${BASE}/cdn/${version}/data/en_US/champion.json`, `${BASE}/cdn/${version}/img/champion/Fiddlesticks.png`, `${BASE}/cdn/${version}/img/champion/MonkeyKing.png`]);
		expect(championIconData("FiddleSticks")).toBe(PNG_BASE64);
		expect(championIconData("Wukong")).toBe(PNG_BASE64);
		await prefetchChampionIcons(["FiddleSticks"], version, BASE, fetchImpl);
		expect(calls).toHaveLength(3);
	});

	test("the champions an answer names come back as Data Dragon names, in the order the answer names them, either spelling once", async () => {
		const version = "14.19.1-named";
		const champions = { Caitlyn: { id: "Caitlyn", name: "Caitlyn", image: { full: "Caitlyn.png" } }, Sona: { id: "Sona", name: "Sona", image: { full: "Sona.png" } }, Viego: { id: "Viego", name: "Viego", image: { full: "Viego.png" } }, MonkeyKing: { id: "MonkeyKing", name: "Wukong", image: { full: "MonkeyKing.png" } } };
		const fetchImpl = (async (url: string) => ({ json: async () => ({ data: champions }) }) as Response) as typeof fetch;
		expect(await championsIn("Sona uses Crescendo: burst Caitlyn, then Viego", version, BASE, fetchImpl)).toEqual(["Sona", "Caitlyn", "Viego"]);
		expect(await championsIn("MonkeyKing and Wukong", version, BASE, fetchImpl)).toEqual(["Wukong"]);
		expect(await championsIn("Cait walks up", version, BASE, fetchImpl)).toEqual([]);
	});

	test("a champion portrait draws inline as its own kind of icon", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const version = "14.19.1-portrait";
		const fetchImpl = (async (url: string) =>
			url.endsWith("/champion.json")
				? ({ json: async () => ({ data: { Sona: { id: "Sona", name: "Sona", image: { full: "Sona.png" } } } }) } as Response)
				: ({ arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) } as Response)) as typeof fetch;
		await prefetchChampionIcons(["Sona"], version, BASE, fetchImpl);
		expect(iconLine("Sona", ["champion"], 2)?.sequence).toContain("1337;File=");
		expect(iconLine("Sona", ["item"])).toBeUndefined();
	});

	test("a name Data Dragon lists once per game mode draws the Summoner's Rift item and the CLASSIC spell, never another mode's older art", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const version = "14.19.1-modes";
		const calls: string[] = [];
		// Data Dragon's own shapes: Arena (map 30) and another mode's copy (77xxxx) share the name with the Summoner's Rift item.
		const items = { "223115": { name: "Mode Tooth", maps: { "30": true } }, "3115": { name: "Mode Tooth", maps: { "11": true, "12": true } }, "773115": { name: "Mode Tooth", maps: { "12": true } } };
		const spells = { SummonerModeCherry: { name: "Mode Flash", image: { full: "SummonerModeCherry.png" }, modes: ["CHERRY"] }, SummonerMode: { name: "Mode Flash", image: { full: "SummonerMode.png" }, modes: ["ARAM", "CLASSIC"] }, SummonerMode_Jade: { name: "Mode Flash", image: { full: "SummonerMode_Jade.png" }, modes: ["JADE"] } };
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			if (url.endsWith("/item.json")) return { json: async () => ({ data: items }) } as Response;
			if (url.endsWith("/runesReforged.json")) return { json: async () => [] } as Response;
			if (url.endsWith("/summoner.json")) return { json: async () => ({ data: spells }) } as Response;
			return { arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) } as Response;
		}) as typeof fetch;
		await prefetchItemIcons(["Mode Tooth"], version, BASE, fetchImpl);
		await prefetchRuneIcons(["Mode Flash"], version, BASE, fetchImpl);
		const images = calls.filter((url) => url.endsWith(".png"));
		expect(images).toEqual([`${BASE}/cdn/${version}/img/item/3115.png`, `${BASE}/cdn/${version}/img/spell/SummonerMode.png`]);
	});

	test("rune and summoner spell icons resolve by name through runesReforged.json and summoner.json, each under its own kind", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const version = "14.19.1-runes";
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			if (url.endsWith("/runesReforged.json")) return { json: async () => [{ name: "Domination", slots: [{ runes: [{ name: "Icon Rune Alpha", icon: "perk-images/Styles/Domination/Alpha/Alpha.png" }] }] }] } as Response;
			if (url.endsWith("/summoner.json")) return { json: async () => ({ data: { SummonerAlpha: { name: "Icon Spell Alpha", image: { full: "SummonerAlpha.png" } } } }) } as Response;
			return { arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) } as Response;
		}) as typeof fetch;
		await prefetchRuneIcons(["Icon Rune Alpha", "Icon Spell Alpha", "Icon Not A Rune"], version, BASE, fetchImpl);
		expect(calls).toContain(`${BASE}/cdn/img/perk-images/Styles/Domination/Alpha/Alpha.png`);
		expect(calls).toContain(`${BASE}/cdn/${version}/img/spell/SummonerAlpha.png`);
		expect(iconLine("Icon Rune Alpha", ["rune"])).toBeDefined();
		expect(iconLine("Icon Spell Alpha", ["rune", "summoner"])).toBeDefined();
		expect(iconLine("Icon Spell Alpha", ["item"])).toBeUndefined();
		expect(iconLine("Icon Not A Rune", ["rune", "summoner"])).toBeUndefined();
		expect(isKnownName("Icon Rune Alpha", ["rune", "summoner"], version)).toBe(true);
		expect(isKnownName("Icon Not A Rune", ["rune", "summoner"], version)).toBe(false);
	});

	test("a shortened rune name draws the one rune it begins, and an ambiguous or short one draws nothing", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const version = "14.19.1-prefix";
		const runes = ["Biscuit Delivery", "Manaflow Band", "Manaflow Wave", "Cut Down"].map((name) => ({ name, icon: `perk-images/${name.replace(/ /g, "")}.png` }));
		const fetchImpl = (async (url: string) => {
			if (url.endsWith("/runesReforged.json")) return { json: async () => [{ name: "Inspiration", slots: [{ runes }] }] } as Response;
			if (url.endsWith("/summoner.json")) return { json: async () => ({ data: {} }) } as Response;
			return { arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) } as Response;
		}) as typeof fetch;
		await prefetchRuneIcons(["Biscuits", "Manaflow", "Cut"], version, BASE, fetchImpl);
		expect(iconLine("Biscuits", ["rune"])).toBeDefined();
		expect(isKnownName("Biscuits", ["rune"], version)).toBe(true);
		expect(iconLine("Manaflow", ["rune"])).toBeUndefined(); // two runes begin with it
		expect(iconLine("Cut", ["rune"])).toBeUndefined(); // too short to guess from
	});

	test("an unknown item name resolves to no id and stays uncached", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const { fetchImpl } = fakeFetch({ "Icon Boots Beta": 1002 });
		await prefetchItemIcons(["Icon Item Not In Ddragon"], "14.19.1-beta", BASE, fetchImpl);
		expect(itemIconLine("Icon Item Not In Ddragon")).toBeUndefined();
	});

	test("isKnownName answers from item.json's own id lookup, even for a name whose PNG itself never cached", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const version = "14.19.1-known";
		const fetchImpl = (async (url: string) => {
			if (url.endsWith("/item.json")) return { json: async () => ({ data: { "7001": { name: "Icon Known Item" }, "7002": { name: "Icon Broken Png" } } }) } as Response;
			if (url.endsWith("/7002.png")) throw new Error("network down");
			return { arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) } as Response;
		}) as typeof fetch;
		await prefetchItemIcons(["Icon Known Item", "Icon Broken Png", "Icon Not In Ddragon"], version, BASE, fetchImpl);
		expect(itemIconLine("Icon Broken Png")).toBeUndefined(); // the PNG itself never cached
		expect(isKnownName("Icon Broken Png", ["item"], version)).toBe(true); // but item.json still named it: not a model mistake
		expect(isKnownName("Icon Known Item", ["item"], version)).toBe(true);
		expect(isKnownName("Icon Not In Ddragon", ["item"], version)).toBe(false); // no id at all: likely a model mistake
		expect(isKnownName("Icon Known Item", ["item"], "some-other-version")).toBe(false); // a different version's data
	});

	test("no network at all when this terminal cannot draw images", async () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const { fetchImpl, calls } = fakeFetch({ "Icon Boots Gamma": 1003 });
		await prefetchItemIcons(["Icon Boots Gamma"], "14.19.1-gamma", BASE, fetchImpl);
		expect(calls).toEqual([]);
		expect(itemIconLine("Icon Boots Gamma")).toBeUndefined();
	});

	test("a fetch that never resolves times out and returns without throwing", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		// A real fetch rejects once its AbortSignal fires; this fixture does the same so the budget's abort actually lands.
		const hangingFetch = ((_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
		await expect(prefetchItemIcons(["Icon Boots Delta"], "14.19.1-delta", BASE, hangingFetch, 20)).resolves.toBeUndefined();
		expect(itemIconLine("Icon Boots Delta")).toBeUndefined();
	});

	test("itemIconLine respects capability changes even with a warm cache", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const { fetchImpl } = fakeFetch({ "Icon Boots Epsilon": 1004 });
		await prefetchItemIcons(["Icon Boots Epsilon"], "14.19.1-epsilon", BASE, fetchImpl);
		expect(itemIconLine("Icon Boots Epsilon")).toBeDefined();
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		expect(itemIconLine("Icon Boots Epsilon")).toBeUndefined();
		expect(getCapabilities().images).toBeNull();
	});

	test("iconCache is capped: past the cap, the oldest entry is evicted", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const version = "14.19.1-cap";
		const total = 135; // more than MAX_CACHED_ICONS (128)
		const names = Array.from({ length: total }, (_, i) => `Icon Cap Item ${i}`);
		const idByName: Record<string, number> = {};
		names.forEach((name, i) => {
			idByName[name] = 5000 + i;
		});
		const { fetchImpl } = fakeFetch(idByName);
		// One at a time so cache insertion order matches array order deterministically.
		for (const name of names) await prefetchItemIcons([name], version, BASE, fetchImpl);

		expect(cachedIconCount()).toBe(128);
		expect(itemIconLine(names[0])).toBeUndefined(); // oldest, evicted
		expect(itemIconLine(names[total - 1])).toBeDefined(); // newest, still cached
	});

	test("a failing icon fetch logs a warn and raises the icons notice once, even when more than one icon fails", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const logged: any[] = [];
		setLogSink((line) => logged.push(JSON.parse(line)));
		let changes = 0;
		setNoticeHandler(() => changes++);
		// item.json resolves fine (so each name gets an id); only the PNG fetch itself fails, for both icons.
		const failingFetch = (async (url: string) => {
			if (String(url).endsWith("/item.json")) return { json: async () => ({ data: { "9001": { name: "Icon Zeta One" }, "9002": { name: "Icon Zeta Two" } } }) } as Response;
			throw new Error("network down");
		}) as typeof fetch;
		await prefetchItemIcons(["Icon Zeta One", "Icon Zeta Two"], "14.19.1-zeta", BASE, failingFetch);
		const warnings = logged.filter((line) => line.component === "icons" && line.level === "warn" && line.event === "icon-fetch-failed");
		expect(warnings).toHaveLength(2); // every failure is logged
		expect(noticeLines()).toEqual(["icons failed this session: Data Dragon did not answer"]); // but the notice shows once
		expect(changes).toBe(1);
		expect(itemIconLine("Icon Zeta One")).toBeUndefined();
	});

	describe("disk cache (#413)", () => {
		function coachHome(): { home: string; cache: string } {
			const home = mkdtempSync(join(tmpdir(), "voxren-icons-"));
			mkdirSync(join(home, "agent"));
			process.env.PI_CODING_AGENT_DIR = join(home, "agent");
			return { home, cache: join(home, "cache", "icons") };
		}
		afterEach(() => {
			delete process.env.PI_CODING_AGENT_DIR;
			resetIcons();
		});

		test("a name fetched once is read from disk after the memory cache is gone, with no PNG request", async () => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
			const { cache } = coachHome();
			const version = "14.19.1-disk";
			const first = fakeFetch({ "Disk Boots": 7 });
			await prefetchItemIcons(["Disk Boots"], version, BASE, first.fetchImpl);
			expect(existsSync(join(cache, version, "item", "diskboots.png"))).toBe(true);
			resetIcons();
			const second = fakeFetch({ "Disk Boots": 7 });
			await prefetchItemIcons(["Disk Boots"], version, BASE, second.fetchImpl);
			expect(itemIconLine("Disk Boots")).toBeDefined();
			expect(second.calls.some((url) => url.endsWith("7.png"))).toBe(false);
		});

		test("a damaged cache file is ignored and the icon fetched again", async () => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
			const { cache } = coachHome();
			const version = "14.19.1-damaged";
			mkdirSync(join(cache, version, "item"), { recursive: true });
			writeFileSync(join(cache, version, "item", "damagedboots.png"), "not a png");
			const { fetchImpl, calls } = fakeFetch({ "Damaged Boots": 8 });
			await prefetchItemIcons(["Damaged Boots"], version, BASE, fetchImpl);
			expect(calls.some((url) => url.endsWith("8.png"))).toBe(true);
			expect(itemIconLine("Damaged Boots")).toBeDefined();
			expect(readFileSync(join(cache, version, "item", "damagedboots.png"))).toEqual(PNG_BYTES);
		});

		test("a fetch that is not a PNG is never written to disk", async () => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
			const { cache } = coachHome();
			const version = "14.19.1-nopng";
			const fetchImpl = (async (url: string) => (url.endsWith("/item.json") ? ({ json: async () => ({ data: { "9": { name: "Empty Boots" } } }) } as Response) : ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response))) as typeof fetch;
			await prefetchItemIcons(["Empty Boots"], version, BASE, fetchImpl);
			expect(existsSync(join(cache, version, "item", "emptyboots.png"))).toBe(false);
		});

		test("writing the current version deletes every other version's folder", async () => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
			const { cache } = coachHome();
			mkdirSync(join(cache, "13.1.1", "item"), { recursive: true });
			writeFileSync(join(cache, "13.1.1", "item", "old.png"), PNG_BYTES);
			const version = "14.19.1-prune";
			await prefetchItemIcons(["Prune Boots"], version, BASE, fakeFetch({ "Prune Boots": 10 }).fetchImpl);
			expect(readdirSync(cache)).toEqual([version]);
		});

		test("a hung request is cut by its own clock and retried, not left to the whole budget", async () => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
			const version = "14.19.1-hung";
			let pngCalls = 0;
			const fetchImpl = (async (url: string, init?: { signal?: AbortSignal }) => {
				if (url.endsWith("/item.json")) return { json: async () => ({ data: { "11": { name: "Hung Boots" } } }) } as Response;
				if (++pngCalls === 1) return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
				return { ok: true, arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) } as Response;
			}) as typeof fetch;
			await prefetchItemIcons(["Hung Boots"], version, BASE, fetchImpl);
			expect(itemIconLine("Hung Boots")).toBeDefined();
			expect(pngCalls).toBe(2);
		}, 10_000);
	});
});
