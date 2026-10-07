import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { allocateImageId, getPngDimensions } from "@earendil-works/pi-tui";
import { logEvent, raiseNotice } from "./coach-log";
import { coachHomePath } from "./exchange-log";
import { writeFileAtomic } from "./safe-write";
import { STAT_SHARD_ICONS } from "./stat-shards";
import { greyIcon, imageProtocol, inlineIcon } from "./terminal-images";
import type { FetchLike } from "./policy";

/** One id so every Data Dragon icon failure this session folds into the same header line instead of stacking one per miss. */
const ICONS_NOTICE_ID = "icons";
const ICONS_NOTICE_TEXT = "icons failed this session: Data Dragon did not answer";

/** The same notice for a caller outside this file that could not reach Data Dragon for the icons' version (`index.ts`, before a build strip). */
export function iconsNotice(event: string, error: unknown): void {
	raiseNotice(ICONS_NOTICE_ID, "warn", ICONS_NOTICE_TEXT, "icons", event, undefined, error);
}

/**
 * Data Dragon item, rune, summoner spell, and champion icons for the player-audit card and the build strip. Rendering is
 * synchronous and reads only the module cache below — `prefetchItemIcons` or `prefetchRuneIcons` must have run
 * (and settled) before a render call wants `itemIconLine` or `iconLine` to return one.
 * Everything here is best-effort: a missing icon just means the row falls
 * back to plain text, so nothing here ever throws.
 */

export type { FetchLike };

const FETCH_BUDGET_MS = 1500;
/** One icon request's own clock, so a request that hangs is cut and retried instead of taking the whole prefetch budget with it (#413). */
const ATTEMPT_MS = 1500;
const ATTEMPTS = 3;
const BACKOFF_MS = 200;
/** The prefetch as a whole: three attempts and their backoff, for a name that needs them. */
const ICON_BUDGET_MS = ATTEMPTS * ATTEMPT_MS + (ATTEMPTS - 1) * BACKOFF_MS + 500;

interface CachedIcon {
	base64: string;
	dims: { widthPx: number; heightPx: number };
	imageId: number;
}

// A long /review session can prefetch icons for many champions' item lists; cap so the cache can't grow for the life of the process.
// One build strip alone holds about 30 (runes, shards, spells, items), so the cap keeps a few strips' worth.
const MAX_CACHED_ICONS = 128;

/** Item name (normalized), or `rune:`/`summoner:` and the name, -> its cached PNG. Bounded to MAX_CACHED_ICONS: oldest entry evicted past the cap. */
const iconCache = new Map<string, CachedIcon>();
/** Data Dragon version -> item name (normalized) -> item id, so a repeat prefetch skips the item.json fetch. */
const idsByVersion = new Map<string, Map<string, number>>();
/** Data Dragon version -> rune or summoner spell cache key -> icon URL, so a repeat prefetch skips both data files. */
const urlsByVersion = new Map<string, Map<string, string>>();
/** Data Dragon version -> champion id or display name (normalized) -> portrait file, so a repeat prefetch skips champion.json. */
const championFilesByVersion = new Map<string, Map<string, string>>();
/** Data Dragon version -> each spelling of a champion (its id and its name, as written) -> its display name, for `championsIn`. */
const championNamesByVersion = new Map<string, Map<string, string>>();

export type IconKind = "item" | "rune" | "summoner" | "champion";

/** Items keep the bare key the audit card and its charts already read. */
function cacheKey(kind: IconKind, name: string): string {
	return kind === "item" ? normalize(name) : `${kind}:${normalize(name)}`;
}

/** Forgets every cached icon and every Data Dragon id table, for a lab or test that loaded its own and must leave the process as it found it. */
export function resetIcons(): void {
	iconCache.clear();
	idsByVersion.clear();
	urlsByVersion.clear();
	championFilesByVersion.clear();
	championNamesByVersion.clear();
}

/** Icons cached right now; never above MAX_CACHED_ICONS. */
export function cachedIconCount(): number {
	return iconCache.size;
}

function cacheIcon(key: string, entry: CachedIcon): void {
	iconCache.set(key, entry);
	if (iconCache.size > MAX_CACHED_ICONS) iconCache.delete(iconCache.keys().next().value!);
}

/**
 * The Data Dragon key a rune or summoner spell `name` means: the exact one, else the only key of that kind that begins
 * with it ("Biscuits" is "Biscuit Delivery"), a plural dropped. Two candidates, or a name under five letters, match nothing.
 */
function resolveRuneKey(keys: Iterable<string>, kind: IconKind, name: string): string | undefined {
	const exact = cacheKey(kind, name);
	const all = [...keys];
	if (all.includes(exact)) return exact;
	const stem = cacheKey(kind, name).replace(/s$/, "");
	const found = stem.length - kind.length - 1 >= 5 ? all.filter((key) => key.startsWith(stem)) : [];
	return found.length === 1 ? found[0] : undefined;
}

function normalize(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The cached PNG for `name` as base64, for charts that embed item icons; undefined until prefetched. */
export function itemIconData(name: string): string | undefined {
	return iconCache.get(normalize(name))?.base64;
}

/** The cached square portrait for a champion as base64, by Riot's championName or its display name; undefined until prefetched. */
export function championIconData(name: string): string | undefined {
	return iconCache.get(`champion:${normalize(name)}`)?.base64;
}

/**
 * A 1-row image for `name` when its PNG is cached and this terminal can draw images; else undefined.
 * `columns` is how far the cursor ends up past where the icon started.
 */
export function itemIconLine(name: string): { sequence: string; columns: number } | undefined {
	return iconLine(name, ["item"]);
}

/** An image for `name`, `rows` tall (one unless the caller keeps the rows under it empty), as the first of `kinds` with one cached, on a terminal that draws images; else undefined. */
export function iconLine(name: string, kinds: IconKind[], rows = 1): { sequence: string; columns: number } | undefined {
	for (const kind of kinds) {
		const cached = iconCache.get(cacheKey(kind, name));
		if (cached) return inlineIcon(cached.base64, cached.dims, cached.imageId, rows);
	}
	return undefined;
}

/** `iconLine`, drawn grey and faded (an owned item); undefined when the rasterizer or the icon is missing. */
export function greyIconLine(name: string, kinds: IconKind[], rows = 1): { sequence: string; columns: number } | undefined {
	for (const kind of kinds) {
		const cached = iconCache.get(cacheKey(kind, name));
		if (cached) return greyIcon(cached.base64, cached.dims, rows);
	}
	return undefined;
}

/**
 * True when `name` resolved to a real item, rune, or summoner spell under `ddragonVersion` -- once
 * `prefetchItemIcons`/`prefetchRuneIcons` have loaded that version's data. A name neither prefetch's data has an
 * entry for is likely a model mistake, not a missing icon: a genuine name whose PNG fetch itself failed is still known.
 */
export function isKnownName(name: string, kinds: IconKind[], ddragonVersion: string): boolean {
	return kinds.some((kind) => {
		if (kind === "item") return idsByVersion.get(ddragonVersion)?.has(normalize(name)) ?? false;
		const urls = urlsByVersion.get(ddragonVersion);
		return urls ? resolveRuneKey(urls.keys(), kind, name) !== undefined : false;
	});
}

/**
 * Resolves a rune, shard, summoner spell, or item name to its Data Dragon name (src/setup-swaps.ts), from the tables the
 * last prefetch or `loadKnownNames` loaded; undefined until both the rune and item tables are in, so a gate asks nothing
 * of tables it lacks. Shards come from data/stat-shards.json, merged into the rune table beside runesReforged.json.
 */
export function knownNames(): ((name: string) => string | undefined) | undefined {
	const urls = [...urlsByVersion.values()].at(-1);
	const ids = [...idsByVersion.values()].filter((table) => table.size).at(-1);
	if (!urls || !ids) return undefined;
	return (name) => {
		for (const kind of ["rune", "summoner"] as const) {
			const found = resolveRuneKey(urls.keys(), kind, name);
			if (found) return found;
		}
		const key = [normalize(name), normalize(name).replace(/s$/, "")].find((candidate) => ids.has(candidate));
		return key === undefined ? undefined : `item:${key}`;
	};
}

/** Loads the rune, shard, summoner spell, and item tables for `knownNames`, with or without a terminal that draws images. Never throws. */
export async function loadKnownNames(ddragonVersion: string, base: string, fetchImpl: FetchLike = fetch, timeoutMs = FETCH_BUDGET_MS): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		await Promise.all([loadRuneAndSpellUrls(ddragonVersion, base, fetchImpl, controller.signal), loadItemIds(ddragonVersion, base, fetchImpl, controller.signal)]);
	} finally {
		clearTimeout(timer);
	}
}

/** `<coach home>/cache/icons`: PNGs by Data Dragon version, kind, and name, so a name fetched once never needs the network again. Undefined without a coach home. */
function iconCacheRoot(): string | undefined {
	return coachHomePath(process.env, join("cache", "icons"));
}

/** The cache key "rune:suddenimpact" as kind "rune" and name "suddenimpact"; an item key has no prefix. */
function keyParts(key: string): { kind: string; name: string } {
	const [kind, name] = key.includes(":") ? key.split(":") : ["item", key];
	return { kind, name };
}

function diskPath(version: string, key: string): string | undefined {
	const root = iconCacheRoot();
	const { kind, name } = keyParts(key);
	return root && /^[\w.-]+$/.test(version) ? join(root, version, kind, `${name}.png`) : undefined;
}

/** The icon for `key` from disk into memory; false when there is none or the file is not a PNG (a damaged file is deleted, so the name is fetched again). */
function loadFromDisk(version: string, key: string): boolean {
	if (iconCache.has(key)) return true;
	const path = diskPath(version, key);
	if (!path) return false;
	try {
		const base64 = readFileSync(path).toString("base64");
		const dims = getPngDimensions(base64);
		if (!dims) throw new Error("not a PNG");
		cacheIcon(key, { base64, dims, imageId: allocateImageId() });
		logEvent("info", "icons", "icon-fetch", { key, outcome: "disk" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		logEvent("warn", "icons", "icon-cache-damaged", { path }, error);
		rmSync(path, { force: true });
		return false;
	}
}

const pruned = new Set<string>();

/** Writes a fetched PNG to disk, and once per process deletes every other version's folder, so the cache holds one version. Never throws: a cache that cannot be written only costs a fetch next time. */
function saveToDisk(version: string, key: string, base64: string): void {
	const path = diskPath(version, key);
	const root = iconCacheRoot();
	if (!path || !root) return;
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileAtomic(path, Buffer.from(base64, "base64"), "icons");
		if (!pruned.has(root + version)) {
			pruned.add(root + version);
			for (const entry of readdirSync(root)) if (entry !== version) rmSync(join(root, entry), { recursive: true, force: true });
		}
	} catch (error) {
		logEvent("warn", "icons", "icon-cache-write-failed", { path }, error);
	}
}

/**
 * One PNG into the cache under `key`. Only a response that decodes as a PNG is cached, so a picture is never placed from an
 * empty or error body (the row draws the name instead). A failed fetch is tried once more, since a busy machine drops one.
 */
async function fetchIcon(key: string, url: string, version: string, fetchImpl: FetchLike, signal: AbortSignal): Promise<void> {
	if (loadFromDisk(version, key)) return;
	const started = Date.now();
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		const own = new AbortController();
		const stop = () => own.abort();
		signal.addEventListener("abort", stop);
		const timer = setTimeout(stop, ATTEMPT_MS);
		try {
			const response = await fetchImpl(url, { signal: own.signal });
			if (response.ok === false) throw new Error(`HTTP ${response.status}`);
			const bytes = Buffer.from(await response.arrayBuffer());
			const base64 = bytes.toString("base64");
			const dims = getPngDimensions(base64);
			if (!dims) throw new Error("not a PNG");
			cacheIcon(key, { base64, dims, imageId: allocateImageId() });
			saveToDisk(version, key, base64);
			logEvent("info", "icons", "icon-fetch", { key, outcome: attempt > 1 ? "ok-retried" : "ok", attempt, ms: Date.now() - started });
			return;
		} catch (error) {
			const message = String((error as Error)?.message);
			const outcome = own.signal.aborted ? "timeout" : (/^HTTP \d+/.exec(message)?.[0] ?? (message === "not a PNG" ? "not-a-png" : "error"));
			logEvent("info", "icons", "icon-fetch", { key, outcome, attempt, ms: Date.now() - started });
			if (attempt === ATTEMPTS || signal.aborted) {
				// this one icon's fetch failed or was aborted; leave it uncached
				raiseNotice(ICONS_NOTICE_ID, "warn", ICONS_NOTICE_TEXT, "icons", "icon-fetch-failed", { key }, error);
				return;
			}
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", stop);
		}
		await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS));
	}
}

async function loadRuneAndSpellUrls(version: string, base: string, fetchImpl: FetchLike, signal: AbortSignal): Promise<Map<string, string>> {
	const cached = urlsByVersion.get(version);
	if (cached) return cached;
	const urls = new Map<string, string>();
	try {
		const styles: any = await (await fetchImpl(`${base}/cdn/${version}/data/en_US/runesReforged.json`, { signal })).json();
		for (const style of Array.isArray(styles) ? styles : []) {
			for (const slot of Array.isArray(style?.slots) ? style.slots : []) {
				for (const rune of Array.isArray(slot?.runes) ? slot.runes : []) if (typeof rune?.name === "string" && typeof rune?.icon === "string") urls.set(cacheKey("rune", rune.name), `${base}/cdn/img/${rune.icon}`);
			}
		}
	} catch (error) {
		// no rune icons this call
		raiseNotice(ICONS_NOTICE_ID, "warn", ICONS_NOTICE_TEXT, "icons", "rune-data-failed", { version }, error);
	}
	// Shards are drawn as runes; their icons need no data file from Data Dragon, so they count only beside a real load.
	if (urls.size) for (const [name, file] of Object.entries(STAT_SHARD_ICONS)) urls.set(cacheKey("rune", name), `${base}/cdn/img/perk-images/StatMods/${file}`);
	try {
		const spells: any = await (await fetchImpl(`${base}/cdn/${version}/data/en_US/summoner.json`, { signal })).json();
		// One name, one spell per mode (Arena's SummonerCherryFlash, the JADE mode's older art): the CLASSIC one wins.
		for (const spell of Object.values<any>(spells?.data ?? {})) {
			if (typeof spell?.name !== "string" || typeof spell?.image?.full !== "string") continue;
			const key = cacheKey("summoner", spell.name);
			if (!urls.has(key) || (Array.isArray(spell.modes) && spell.modes.includes("CLASSIC"))) urls.set(key, `${base}/cdn/${version}/img/spell/${spell.image.full}`);
		}
	} catch (error) {
		// no summoner spell icons this call
		raiseNotice(ICONS_NOTICE_ID, "warn", ICONS_NOTICE_TEXT, "icons", "summoner-data-failed", { version }, error);
	}
	// An empty map is a failed load, not an answer: the next prefetch tries again.
	if (urls.size) urlsByVersion.set(version, urls);
	return urls;
}

/**
 * Rune and summoner spell icons for `names`, from Data Dragon's runesReforged.json and summoner.json, cached for
 * `iconLine`. Same contract as `prefetchItemIcons`: bounded to `timeoutMs`, never throws, no network without images.
 */
export async function prefetchRuneIcons(names: string[], ddragonVersion: string, base: string, fetchImpl: FetchLike = fetch, timeoutMs = ICON_BUDGET_MS): Promise<void> {
	if (!imageProtocol() || names.length === 0) return;
	// Disk first: a name cached on an earlier run draws without the network, even if the data files below never load.
	for (const name of names) for (const kind of ["rune", "summoner"] as const) loadFromDisk(ddragonVersion, cacheKey(kind, name));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const urls = await loadRuneAndSpellUrls(ddragonVersion, base, fetchImpl, controller.signal);
		await Promise.all(
			names.flatMap((name) =>
				(["rune", "summoner"] as const).map((kind) => {
					const found = resolveRuneKey(urls.keys(), kind, name);
					// cached under the name asked, so iconLine finds it by the same name
					return found ? fetchIcon(cacheKey(kind, name), urls.get(found)!, ddragonVersion, fetchImpl, controller.signal) : undefined;
				}),
			),
		);
	} catch (error) {
		// the whole budget expired; icons stay off for names not already cached
		raiseNotice(ICONS_NOTICE_ID, "warn", ICONS_NOTICE_TEXT, "icons", "rune-prefetch-aborted", undefined, error);
	} finally {
		clearTimeout(timer);
	}
}

async function loadChampionFiles(version: string, base: string, fetchImpl: FetchLike, signal: AbortSignal): Promise<Map<string, string>> {
	const cached = championFilesByVersion.get(version);
	if (cached) return cached;
	const files = new Map<string, string>();
	const spellings = new Map<string, string>();
	try {
		const json: any = await (await fetchImpl(`${base}/cdn/${version}/data/en_US/champion.json`, { signal })).json();
		// Under both spellings: match history says "MonkeyKing" and "FiddleSticks", a player says "Wukong".
		for (const champion of Object.values<any>(json?.data ?? {})) {
			if (typeof champion?.image?.full !== "string") continue;
			for (const name of [champion.id, champion.name]) {
				if (typeof name !== "string") continue;
				files.set(normalize(name), champion.image.full);
				if (typeof champion.name === "string") spellings.set(name, champion.name);
			}
		}
	} catch (error) {
		// no champion portraits this call
		raiseNotice(ICONS_NOTICE_ID, "warn", ICONS_NOTICE_TEXT, "icons", "champion-data-failed", { version }, error);
	}
	// An empty map is a failed load, not an answer: the next prefetch tries again.
	if (files.size) {
		championFilesByVersion.set(version, files);
		championNamesByVersion.set(version, spellings);
	}
	return files;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The champions `text` names, as Data Dragon display names, in the order the text first names them, each once
 * ("MonkeyKing" and "Wukong" are one). A whole-word match on a champion's id or name, so "Cait" names nobody.
 * Bounded to `timeoutMs`; never throws, `[]` when champion.json does not load.
 */
export async function championsIn(text: string, ddragonVersion: string, base: string, fetchImpl: FetchLike = fetch, timeoutMs = FETCH_BUDGET_MS): Promise<string[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		await loadChampionFiles(ddragonVersion, base, fetchImpl, controller.signal);
	} finally {
		clearTimeout(timer);
	}
	const spellings = championNamesByVersion.get(ddragonVersion);
	if (!spellings) return [];
	const found = new Map<string, number>();
	for (const [spelling, name] of spellings) {
		const at = new RegExp(`(?<![A-Za-z'])${escaped(spelling)}(?![A-Za-z'])`).exec(text)?.index;
		if (at !== undefined && at < (found.get(name) ?? Number.POSITIVE_INFINITY)) found.set(name, at);
	}
	return [...found].sort((a, b) => a[1] - b[1]).map(([name]) => name);
}

/**
 * Champion square portraits for `names`, from Data Dragon's champion.json, cached for `championIconData`. Same
 * contract as `prefetchItemIcons`: bounded to `timeoutMs`, never throws, no network without images.
 */
export async function prefetchChampionIcons(names: string[], ddragonVersion: string, base: string, fetchImpl: FetchLike = fetch, timeoutMs = ICON_BUDGET_MS): Promise<void> {
	if (!imageProtocol() || names.length === 0) return;
	for (const name of names) loadFromDisk(ddragonVersion, `champion:${normalize(name)}`);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const files = await loadChampionFiles(ddragonVersion, base, fetchImpl, controller.signal);
		await Promise.all(
			names.map((name) => {
				const file = files.get(normalize(name));
				return file === undefined ? undefined : fetchIcon(`champion:${normalize(name)}`, `${base}/cdn/${ddragonVersion}/img/champion/${file}`, ddragonVersion, fetchImpl, controller.signal);
			}),
		);
	} catch (error) {
		// the whole budget expired; portraits stay off for names not already cached
		raiseNotice(ICONS_NOTICE_ID, "warn", ICONS_NOTICE_TEXT, "icons", "champion-prefetch-aborted", undefined, error);
	} finally {
		clearTimeout(timer);
	}
}

async function loadItemIds(version: string, base: string, fetchImpl: FetchLike, signal: AbortSignal): Promise<Map<string, number>> {
	const cached = idsByVersion.get(version);
	if (cached) return cached;
	const ids = new Map<string, number>();
	try {
		const response = await fetchImpl(`${base}/cdn/${version}/data/en_US/item.json`, { signal });
		const json: any = await response.json();
		// One name, one item per game mode: Arena's 22xxxx and other modes' 77xxxx copies carry older art. The Summoner's Rift
		// copy (map 11) wins; a name with none keeps the first listed.
		const onRift = new Set<string>();
		for (const [id, item] of Object.entries<any>(json?.data ?? {})) {
			if (typeof item?.name !== "string") continue;
			const key = normalize(item.name);
			const rift = item.maps?.["11"] === true;
			if (ids.has(key) && (onRift.has(key) || !rift)) continue;
			ids.set(key, Number(id));
			if (rift) onRift.add(key);
		}
	} catch (error) {
		// leave `ids` empty on any failure; every name misses and icons stay off this call
		raiseNotice(ICONS_NOTICE_ID, "warn", ICONS_NOTICE_TEXT, "icons", "item-data-failed", { version }, error);
	}
	idsByVersion.set(version, ids);
	return ids;
}

/**
 * Resolve `names` to Data Dragon item ids and fetch each PNG once, caching it
 * for `itemIconLine`. Bounded to `timeoutMs` total via AbortSignal; a name
 * whose fetch doesn't land in time (or fails, or has no id) is simply left
 * uncached. Never throws, and skips all network when this terminal can't
 * draw images at all.
 */
export async function prefetchItemIcons(names: string[], ddragonVersion: string, base: string, fetchImpl: FetchLike = fetch, timeoutMs = ICON_BUDGET_MS): Promise<void> {
	// Sixel terminals draw no inline icon rows, but the item-timing chart embeds these PNGs.
	if (!imageProtocol() || names.length === 0) return;
	for (const name of names) loadFromDisk(ddragonVersion, cacheKey("item", name));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const ids = await loadItemIds(ddragonVersion, base, fetchImpl, controller.signal);
		await Promise.all(
			names.map((name) => {
				const id = ids.get(normalize(name));
				return id === undefined ? undefined : fetchIcon(cacheKey("item", name), `${base}/cdn/${ddragonVersion}/img/item/${id}.png`, ddragonVersion, fetchImpl, controller.signal);
			}),
		);
	} catch (error) {
		// item.json itself failed or the whole budget expired; icons stay off for names not already cached
		raiseNotice(ICONS_NOTICE_ID, "warn", ICONS_NOTICE_TEXT, "icons", "item-prefetch-aborted", undefined, error);
	} finally {
		clearTimeout(timer);
	}
}
