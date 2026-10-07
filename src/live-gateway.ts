import { auditGame, auditHabits, auditKillPatterns, auditPassageText, killPatternText, frequency, gameMoments, habitText, keyDeaths, objectivesText, participationText, publicPatch, summarizeAudit, untradedDeaths, type AuditNames, type GameAudit } from "./audit-metrics";
import { chartedGames, worstGame } from "./charts";
import { clearNotice, logEvent, raiseNotice } from "./coach-log";
import { DEFAULT_PROVIDER, RESEARCH_CONTRACT_VERSION, RIOT_ID_PATTERN, type EvidenceReference, type GatewayOperation, type GatewayResponse, type ResearchGateway } from "./contracts";
import { EvidenceStore } from "./evidence-store";
import { HOSTED_SEARCH_PROVIDERS, createHostedSearch, type HostedSearch, type SearchAnswer, type SearchHit, type SearchQuery } from "./hosted-search";
import { MAX_NOTE_AGE_DAYS, loadMatchupNote, matchupNoteFile, matchupNoteRows, matchupNoteText, claimMatchupBuild, noteAgeDays, saveMatchupNote, type MatchupNote } from "./matchup-note";
import { buildMatchupNote, currentNames } from "./matchup-note-build";
import { createPiWorker, type PiWorker } from "./pi-worker";
import { ResearchServiceError, createResearchService, researchServiceMode, type ResearchService } from "./research-service";
import { statShardName } from "./stat-shards";
import { createGroundingJudge, type GroundingJudge, type GroundingPassage } from "./grounding-judge";
import { MIN_REFERENCE_GAMES, buildOtpReference, loadOtpReference, otpMatchup, referencePassageText, saveOtpReference, type OtpReference } from "./otp-reference";
import { coachHomePath } from "./exchange-log";
import { addTakeaway, learningsFilePath, loadLearnings, saveLearnings } from "./learnings-store";
import { createPassageJudge, type PassageInput, type PassageJudge, type PassageScores, type PassageVerdict } from "./passage-judge";
import { CHAMPION_CARDS_DIR, findChampion, knowChampions, currentCard, championCoachingRows, championCoachingText, championFactText, championFacts, championPassageText, loadChampionCard, type ChampionCard, type ChampionFacts } from "./champion-card";
import { MAX_DISPLAY_TEXT_BYTES, SafeToolError, displayBudget, assertAbortNotRequested, assertRecord, assertString, modelText, normalizeTakeaway, stripTerminalControl, type FetchLike } from "./policy";
import { LANE_WORDS, primaryLane, readSignedInRiotId } from "./lcu";
import type { RiotKeyCustodian } from "./riot-key";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Live research gateway. Four upstreams, each pinned to one host:
 *  - web search   -> Perplexity chat completions (PERPLEXITY_API_KEY)
 *  - game facts   -> Riot Data Dragon (no credential)
 *  - meta         -> OP.GG public MCP (no credential): champion overview, matchup,
 *                    tier list, synergy, champion leaderboard
 *  - player audit -> Riot API through the key custodian child; the key never
 *                    enters this process. Any Riot ID may be audited (match history is
 *                    public); with none given, the signed-in or first known account.
 * Every response is compacted to the policy payload cap before it reaches the
 * model, and every upstream payload is treated as untrusted data. An optional
 * passage judge (Jev) screens web_search passages for relevance and prompt
 * injection before they reach the model; when it is off or fails, web_search
 * behaves exactly as without it.
 */

export interface LiveGatewayOptions {
	/** The research-tools service (YouTube, keyed web search, page text); undefined when this launch cannot reach one. */
	research?: ResearchService;
	/** Web search through the model provider's own hosted search; undefined when the provider has none. */
	hostedSearch?: HostedSearch;
	/** True when the launch holds a key for a search provider the research service knows (Brave, Perplexity). */
	keyedSearch?: boolean;
	/** True when the research service is one the player runs (VOXREN_RESEARCH_URL): it holds its own keys, so a key the coach holds never reaches it. */
	remoteResearch?: boolean;
	/** Runs the matchup-note builder's distil and merge steps; without it notes are read, never built. */
	worker?: PiWorker;
	/** Where matchup notes are kept (`<coach home>/matchups`); unset means no notes at all. */
	matchupNotesDir?: string;
	/** A thunk, not a frozen list: the live, profile-and-env-aware account list, read fresh on every call. */
	auditAccounts: () => string[];
	/** The account signed into the open League client, read at audit time; undefined when the client is closed. */
	readSignedInRiotId?: () => Promise<string | undefined>;
	custodian?: Pick<RiotKeyCustodian, "fetch">;
	passageJudge?: Pick<PassageJudge, "judge">;
	groundingJudge?: Pick<GroundingJudge, "judge">;
	fetchImpl?: FetchLike;
	opggMcpUrl?: string;
	dataDragonBase?: string;
	/** Where stored champion cards live; tests point this at a temp dir. */
	championCardsDir?: string;
	riotAccountBase?: string;
	riotMatchBase?: string;
	sleep?: (ms: number) => Promise<void>;
	now?: () => Date;
	/** Where /otp saves one-trick references, one file per champion; unset means nothing is saved and only shipped references load. */
	referenceDir?: string;
	/** Where voxren_remember saves takeaways, one file per Riot ID; unset means nothing is saved. */
	learningsDir?: string;
	/** Where finished match-v5 matches and timelines are kept, gzipped, one file each; unset means every read goes to Riot. */
	matchCacheDir?: string;
}

/** Cached match files kept; the oldest go past this (a timeline is about 100 KB gzipped). */
const MATCH_CACHE_FILES = 600;

const OPGG_MCP_URL = "https://mcp-api.op.gg/mcp";
const DATA_DRAGON_BASE = "https://ddragon.leagueoflegends.com";
const RIOT_ACCOUNT_BASE = "https://americas.api.riotgames.com";
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_UPSTREAM_BYTES = 6 * 1024 * 1024;
// Room for the habits, the costly deaths, and ten per-game rows with every death, kill, and assist: inside the judge's
// request cap (systemone.ts MAX_JUDGE_REQUEST_BYTES) with the reference beside it.
const AUDIT_PASSAGE_CHARS = 44_000;
const MAX_AUDIT_GAMES = 20;
const MAX_SEARCH_CANDIDATES = 8;
/** A search result's quoted sentences, or a keyed provider's snippet: enough to ground a claim, small enough that five fit the tool budget. */
const MAX_SNIPPET_CHARS = 600;
/** A matchup whose note build failed (no sources, a rate limit) is not tried again until this much later. */
const NOTE_RETRY_MS = 30 * 60_000;
/** Video research: three videos, two transcript parts each, keeps the answer inside the display budget with room for the screen's verdicts. */
const MAX_RESEARCH_VIDEOS = 3;
const VIDEO_PASSAGES = 2;
const VIDEO_PART_CHARS = 600;
/**
 * The turn's deadline (180 s unless set otherwise) started before the model asked for this call and must still cover the Jev
 * screen and the answer, so the call gets half of it. The wait counts from the call, a cold start of the research service
 * included. A Gemini read of a 36 minute video took 10 to 30 s when measured on 2026-10-01.
 */
const VIDEO_RESEARCH_TIMEOUT_MS = 90_000;
/**
 * What the service is told to answer within: the call's own wait, less room for a cold start and the trip back. By then it
 * answers with the videos it has, so one slow Gemini read costs that video, not the whole call.
 */
const VIDEO_RESEARCH_DEADLINE_SECONDS = 75;
const OUTDATED_RESEARCH_NOTICE = "research-outdated";
const SEARCH_KEY_REFUSED_NOTICE = "search-key-refused";

/**
 * The header line for a search provider that refused its key, from the service's message ("No search provider answered:
 * brave HTTP 429, perplexity HTTP 401."; the service always writes the provider in lower case). Only a 401 or 403 is a
 * refused key: no results, a rate limit, or a timeout is not. With both refused, the first named is the one shown.
 * `remote` is a service the player runs: it holds its own keys, so no row in /config reaches them.
 */
function refusedKeyNotice(detail: string | undefined, remote: boolean): string | undefined {
	const refused = /\b(brave|perplexity) HTTP (401|403)\b/.exec(detail ?? "");
	if (!refused) return undefined;
	const provider = refused[1];
	// A stored key reaches the service only when it starts, and a window that finds one already running keeps it: every window has to close.
	// Perplexity has a row under Keys in /config; Brave is set only through BRAVE_API_KEY (docs/configuration.md).
	const replace = provider === "brave" ? "replace BRAVE_API_KEY" : "replace it under Keys in /config";
	const fix = remote ? "replace the key on the research service you run" : `${replace}, then close every coach window and restart`;
	return `${provider[0].toUpperCase()}${provider.slice(1)} refused the search key (HTTP ${refused[2]}): ${fix}`;
}
const PASSAGE_JUDGE_NOTE = "Jev screen: relevance and prompt-injection routing, not a truth check; kept passages stay untrusted.";
const PASSAGE_JUDGE_UNAVAILABLE_NOTE = "Jev screen unavailable: no passage was judged; all results are unscreened, untrusted text.";
const GROUNDING_NOTE = "Jev grounding: each claim checked against cited passage text; grounded, unsupported, contradicted, or disputed (one source states it, another opposes it). A flag, not a truth check.";
const GROUNDING_UNAVAILABLE_NOTE = "Jev grounding unavailable: no claim was checked; state them as unverified.";
const RANKED_SOLO_QUEUE = 420;

function clip(text: unknown, max: number): string {
	const value = stripTerminalControl(typeof text === "string" ? text : "");
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The body as text, read as a stream: an over-cap Content-Length is refused unread, and a body that passes the cap is cancelled there. */
async function readCapped(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	const tooBig = () => new SafeToolError("MALFORMED_RESPONSE");
	if (declared > MAX_UPSTREAM_BYTES) {
		await response.body?.cancel();
		throw tooBig();
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_UPSTREAM_BYTES) {
			await reader.cancel();
			throw tooBig();
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function hostOf(url: string): string {
	try {
		// Deliberate, documented parse probe: tests whether `url` is well-formed enough to have a hostname at
		// all, for display -- arbitrary citation text, so a malformed one is routine, not a bug.
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

export { RIOT_ID_PATTERN };

export function parseAuditAccounts(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => RIOT_ID_PATTERN.test(entry));
}

/** Omitting OP.GG's tier filter returns its Emerald+ sample (same game count as tier=emerald_plus, probed 2026-09-26), not all ranks. */
const OPGG_DEFAULT_SAMPLE = "Emerald+ ranked (OP.GG default)";
const OPGG_POSITION: Record<string, string> = { top: "top", jungle: "jungle", middle: "mid", bottom: "adc", support: "support" };
/** The champion-analysis fields a coach answer uses; unprojected, the payload overflows the 4000-char summary and the tail is lost. */
const OVERVIEW_FIELDS = [
	"data.summary.average_stats.{ban_rate,kda,pick_rate,play,rank,tier,win_rate}",
	"data.damage_type",
	"data.starter_items.{ids_names[],pick_rate,play,win}",
	"data.core_items.{ids_names[],pick_rate,play,win}",
	"data.boots.{ids_names[],pick_rate,play,win}",
	"data.fourth_items[].{ids_names[],pick_rate,play,win}",
	"data.runes.{primary_page_name,primary_rune_names[],secondary_page_name,secondary_rune_names[],stat_mod_names[],pick_rate,play,win}",
	"data.summoner_spells.{ids_names[],pick_rate,play,win}",
	"data.skill_masteries.{ids[],pick_rate,play,win}",
	"data.skills.{order[],pick_rate,play,win}",
	"data.strong_counters[].{champion_name,my_win_rate,play}",
	"data.weak_counters[].{champion_name,my_win_rate,play}",
	"data.trends.win.{version,rate,rank}",
];

/** The fields a Riot ID lookup answer needs: the resolved account, nothing else (probed live 2026-09-27). */
const PRO_PLAYER_RIOT_ID_FIELDS = ["data.player.riot_id.{game_name,tagline,full}"];

function opggPosition(value: unknown): string {
	return OPGG_POSITION[String(value ?? "middle")] ?? "mid";
}

/** OP.GG champion keys are UPPER_SNAKE_CASE: "Lee Sin" -> LEE_SIN, "Kai'Sa" -> KAISA. */
function opggChampion(name: unknown): string {
	return String(name).replace(/[^a-z0-9 ]/gi, "").trim().replace(/\s+/g, "_").toUpperCase();
}

function opggSlug(name: unknown): string {
	return String(name).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/** OP.GG's two known "bad input field" shapes for a -32600 error: a validation bag keyed by field name with a list of messages (e.g. `{"champion":["..."]}`), or a "the selected <field> is invalid" sentence. Anything else is a real upstream fault, not a validation error. */
function opggErrorNamesField(message: unknown): boolean {
	if (typeof message !== "string") return false;
	try {
		const parsed = JSON.parse(message);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		const bags = Object.values(parsed);
		return bags.length > 0 && bags.every((messages) => Array.isArray(messages) && messages.length > 0 && messages.every((text) => typeof text === "string"));
	} catch {
		// Deliberate, documented parse probe: this is the test for OP.GG's other known shape (the bare "the
		// selected X is invalid" sentence below), not a step this -32600 message is expected to always meet.
		return /^the selected \w+ is invalid\.?$/i.test(message.trim());
	}
}

type SampledRow = { games: number; winRate: number };
type PickRow = SampledRow & { items: unknown };

function pickStats(entry: any): SampledRow {
	const games = Number(entry?.play) || 0;
	return { games, winRate: games ? Math.round((Number(entry?.win) / games) * 1000) / 1000 : 0 };
}

/** The most names one OP.GG row may carry before the Data Dragon check: more than any build, rune page, or skill order has. */
const MAX_ROW_NAMES = 8;

/**
 * The names of one OP.GG row that Data Dragon knows, clipped and control-free; everything else (a non-string, an unknown
 * or oversized string) is dropped and logged. Third-party text reaches the model only as a name Riot itself publishes.
 */
function knownNames(value: unknown, known: ReadonlySet<string>, what: string): string[] {
	const kept: string[] = [];
	const dropped: unknown[] = [];
	for (const entry of Array.isArray(value) ? value.slice(0, MAX_ROW_NAMES * 2) : []) {
		const name = clip(entry, 60);
		if (typeof entry === "string" && name === entry && known.has(name) && kept.length < MAX_ROW_NAMES) kept.push(name);
		else dropped.push(entry);
	}
	if (dropped.length) logEvent("warn", "live-gateway", "matchup-unknown-names", { what, dropped: dropped.length, first: clip(typeof dropped[0] === "string" ? dropped[0] : typeof dropped[0], 60) });
	return kept;
}

/** The top n build rows of one OP.GG list: item names with games and win rate. A row left with no known name is dropped. */
function topPicks(list: unknown, n: number, known: ReadonlySet<string>, what: string): PickRow[] {
	return (Array.isArray(list) ? list : [])
		.slice(0, n)
		.map((entry: any) => ({ items: knownNames(entry?.ids_names, known, what), ...pickStats(entry) }))
		.filter((row) => row.items.length > 0);
}

const SKILL_KEYS: ReadonlySet<string> = new Set(["Q", "W", "E", "R"]);

/** The structured matchup rows as one passage, so the grounding gate can check rune, skill, item, and tip claims against OP.GG. */
function matchupText(rows: { champion: string; opponent: string; patch: string; laneAdvantage: string; soloKillAdvantage: string; playStyle: string; tip: string; starters: PickRow[]; core: PickRow[]; boots: PickRow[]; summoners: PickRow[]; runes: Array<SampledRow & { primary?: unknown; secondary?: unknown; shards?: unknown }>; skillMax: Array<SampledRow & { order?: unknown }> }): string {
	const names = (value: unknown) => (Array.isArray(value) ? value.join(", ") : "");
	// The model reads games and win rate on every row, so the passage carries them too; without them a sample-size claim is always unsupported.
	const sample = (row: SampledRow) => (row.games ? ` (${row.games} games, ${Math.round(row.winRate * 1000) / 10}% win rate)` : "");
	const picks = (list: PickRow[]) => list.filter((entry) => names(entry.items)).map((entry) => `${names(entry.items)}${sample(entry)}`).join(" | ");
	const runes = rows.runes.map((page) => `${names(page.primary)}; ${names(page.secondary)}; shards ${names(page.shards)}${sample(page)}`).join(" | ");
	return clip(
		[
			`${rows.champion} vs ${rows.opponent}, patch ${rows.patch}: lane advantage ${rows.laneAdvantage}, solo kill advantage ${rows.soloKillAdvantage}, play ${rows.playStyle}.`,
			rows.tip ? `Tip: ${rows.tip}` : "",
			`Starters: ${picks(rows.starters)}. Core: ${picks(rows.core)}. Boots: ${picks(rows.boots)}. Summoners: ${picks(rows.summoners)}.`,
			`Runes: ${runes}. Skill max: ${rows.skillMax.map((entry) => `${names(entry.order)}${sample(entry)}`).join(" | ")}.`,
		]
			.filter(Boolean)
			.join(" "),
		4000,
	);
}

const MAX_OTP_GAMES = 10;
/** match-v5 regional clusters, in the order a bare Riot ID is tried. */
const RIOT_CLUSTERS = ["americas", "asia", "europe", "sea"] as const;
export type RiotCluster = (typeof RIOT_CLUSTERS)[number];
/** op.gg / Riot platform → match-v5 cluster. */
const PLATFORM_CLUSTER: Record<string, RiotCluster> = {
	na: "americas", br: "americas", lan: "americas", las: "americas",
	kr: "asia", jp: "asia",
	euw: "europe", eune: "europe", tr: "europe", ru: "europe", me: "europe",
	oce: "sea", sg: "sea", ph: "sea", th: "sea", tw: "sea", vn: "sea",
};

export interface PlayerRef {
	gameName: string;
	tagLine: string;
	/** op.gg platform slug when the ref was a link. */
	platform?: string;
	region?: RiotCluster;
}

/** Riot tags are 3-5 letters or digits in any script: KR accounts carry Hangul tags such as 심해토끼. */
const RIOT_TAG = /^[\p{L}\p{N} ]{3,5}$/u;

/** `Name#TAG`, or an op.gg summoner link like `https://op.gg/lol/summoners/kr/Name-TAG?queue_type=SOLORANKED` (URL-encoded, `%20` for spaces; the `lol/` segment is optional). */
export function parsePlayerRef(text: string): PlayerRef | undefined {
	const trimmed = text.trim();
	const link = /^https?:\/\/(?:www\.)?op\.gg\/(?:[a-z]{2}\/)?(?:lol\/)?summoners\/([a-z]+)\/([^/?#]+)/i.exec(trimmed);
	if (link) {
		const platform = link[1].toLowerCase();
		let slug: string;
		try {
			// Deliberate, documented parse probe: decoding is the test for "this part of the pasted link is
			// well-formed", not a step expected to always succeed on arbitrary pasted text.
			slug = decodeURIComponent(link[2]);
		} catch {
			return undefined;
		}
		const dash = slug.lastIndexOf("-");
		if (dash <= 0) return undefined;
		const ref: PlayerRef = { gameName: slug.slice(0, dash), tagLine: slug.slice(dash + 1), platform };
		if (PLATFORM_CLUSTER[platform]) ref.region = PLATFORM_CLUSTER[platform];
		// op.gg shows tags as Riot renders them, spaces included ("Lux R"); the Riot API call encodes them.
		return /^[^#]{3,16}$/.test(ref.gameName) && RIOT_TAG.test(ref.tagLine) ? ref : undefined;
	}
	const id = /^([^#]{3,16})#([^#]{3,5})$/.exec(trimmed);
	return id && RIOT_TAG.test(id[2]) ? { gameName: id[1], tagLine: id[2] } : undefined;
}

/**
 * OP.GG's champion analysis prints a page's shards as perk ids (`Runes("Precision",[...],"Inspiration",[...],[5005,5008,5001],...)`).
 * Named here, as the matchup rows are, so the model copies a name instead of recalling one: it once read 5005 (Attack Speed) as Adaptive Force.
 */
export function nameOverviewShards(text: string): string {
	return text.replace(/(Runes\("[^"]*",\[[^\]]*\],"[^"]*",\[[^\]]*\],)\[([\d,\s]+)\]/g, (_, head: string, ids: string) => `${head}[${ids.split(",").map((id) => JSON.stringify(statShardName(id.trim()))).join(",")}]`);
}

type DataDragonData = { version: string; champions: Record<string, any>; items: Record<number, any>; runes: Record<number, string>; summoners: Record<number, string>; spells: Record<string, string> };

export class LiveResearchGateway implements ResearchGateway {
	private readonly evidenceStore = new EvidenceStore();
	/** One counter per id prefix (web, game, matchup, champion_overview, ...), so no two calls in a session ever hand out the same evidence id. */
	private readonly idCounters = new Map<string, number>();
	private readonly noteBuilds = new Map<string, AbortController>();
	private readonly noteFailures = new Map<string, number>();
	private readonly noteSkipLogged = new Set<string>();
	private noteBuildsOn = false;
	private closed = false;
	private readonly fetchImpl: FetchLike;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => Date;
	/** The patch a game_facts call pinned: its own slot, so an older patch never replaces the latest that every unpinned caller reads. */
	private pinnedDataDragon: DataDragonData | undefined;
	private dataDragon: DataDragonData | undefined;

	constructor(private readonly options: LiveGatewayOptions) {
		this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.now = options.now ?? (() => new Date());
	}

	async call(operation: GatewayOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		assertAbortNotRequested(signal);
		if (this.closed) throw new SafeToolError("CONFIGURATION");
		switch (operation) {
			case "research_web_search":
				return this.webSearch(input, signal);
			case "research_video":
				return this.videoResearch(input, signal);
			case "gamedata.lookup":
				return this.gameFacts(input, signal);
			case "meta.champion_overview":
				return this.metaResearch(input, signal);
			case "meta.matchup":
				return this.matchup(input, signal);
			case "meta.tier_list":
				return this.tierList(input, signal);
			case "meta.synergy":
				return this.synergy(input, signal);
			case "meta.top_players":
				return this.topPlayers(input, signal);
			case "meta.pro_player_riot_id":
				return this.proPlayerLookup(input, signal);
			case "strategy_frame":
				return this.strategyFrame(input, signal);
			case "player_audit":
				return this.playerAudit(input, signal);
			case "otp_build":
				return this.otpBuild(input, signal);
			case "remember":
				return this.remember(input);
			default:
				throw new SafeToolError("CONFIGURATION");
		}
	}

	/** The Data Dragon version/CDN base once `loadDataDragon` has run; undefined before any call needed it. */
	dataDragonInfo(): { version: string; base: string } | undefined {
		return this.dataDragon ? { version: this.dataDragon.version, base: this.options.dataDragonBase ?? DATA_DRAGON_BASE } : undefined;
	}

	/** The same, loading Data Dragon first when no call has needed it yet (a session whose first answer is a build). Rejects when Data Dragon cannot be reached. */
	async loadDataDragonInfo(signal?: AbortSignal): Promise<{ version: string; base: string }> {
		const dd = await this.loadDataDragon(signal);
		return { version: dd.version, base: this.options.dataDragonBase ?? DATA_DRAGON_BASE };
	}

	/**
	 * The champion's primary lane (data/championRoles.json's highest play rate), as the coaching word
	 * ("mid", not "middle"). Loads Data Dragon if needed to map the name to a champion id; undefined
	 * when Data Dragon is unreachable, the name doesn't match a champion, or the id has no lane data.
	 * Never throws — an unreachable Data Dragon degrades to "no lane word", not a guessed default.
	 */
	async championLane(name: string): Promise<string | undefined> {
		try {
			const dd = await this.loadDataDragon();
			const champion: any = findChampion(dd.champions, name);
			const championId = champion ? Number(champion.key) : undefined;
			const lane = championId ? primaryLane(championId) : undefined;
			return lane ? LANE_WORDS[lane] : undefined;
		} catch (error) {
			logEvent("warn", "live-gateway", "champion-lane-failed", { champion: name }, error);
			return undefined;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.evidenceStore.clear();
		this.idCounters.clear();
		for (const build of this.noteBuilds.values()) build.abort();
		this.options.worker?.close?.();
		await this.options.research?.close();
	}

	/** Start the research service now, in the background, so the first tool call that needs it does not wait for it. */
	warmResearch(): void {
		this.options.research?.warm();
	}

	private stamp(): string {
		return this.now().toISOString();
	}

	/** The next evidence id for a prefix: `prefix-1` the first time, `prefix-2` the next, and so on for the life of the gateway (reset by `close()`). */
	private nextId(prefix: string): string {
		const next = (this.idCounters.get(prefix) ?? 0) + 1;
		this.idCounters.set(prefix, next);
		return `${prefix}-${next}`;
	}

	/** True for an id `nextId` handed out this session, whether or not the bounded store still holds it. */
	private wasIssued(id: string): boolean {
		const cut = id.lastIndexOf("-");
		const n = Number(id.slice(cut + 1));
		return cut > 0 && Number.isInteger(n) && n >= 1 && n <= (this.idCounters.get(id.slice(0, cut)) ?? 0);
	}

	/** `texts` maps evidence id to the passage text Jev may later judge; a source without one (otp build) cannot ground a claim. */
	private response(operation: GatewayOperation, data: Record<string, unknown>, evidence: EvidenceReference[], texts: Record<string, string> = {}): GatewayResponse {
		for (const entry of evidence) this.evidenceStore.remember(entry.id, { source: entry.source, title: entry.title, ...(texts[entry.id] ? { text: texts[entry.id] } : {}) });
		return { version: RESEARCH_CONTRACT_VERSION, operation, data, evidence };
	}

	/** What the frame may cite for an id, or undefined for one never returned this session. */
	recallEvidence(id: string) {
		return this.evidenceStore.recall(id);
	}

	// --- shared transport ----------------------------------------------------

	private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; text: string }> {
		assertAbortNotRequested(signal);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = await this.fetchImpl(url, { ...init, signal: controller.signal, redirect: "error" });
			return { status: response.status, text: await readCapped(response) };
		} catch (error) {
			if (error instanceof SafeToolError) throw error;
			throw new SafeToolError("UPSTREAM_UNAVAILABLE");
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private async json(url: string, init: RequestInit, signal?: AbortSignal): Promise<any> {
		const { status, text } = await this.request(url, init, signal);
		if (status === 401 || status === 403) throw new SafeToolError("AUTHENTICATION");
		if (status === 429) throw new SafeToolError("RATE_LIMITED");
		if (status < 200 || status >= 300) throw new SafeToolError("UPSTREAM_UNAVAILABLE");
		try {
			return JSON.parse(text);
		} catch {
			throw new SafeToolError("MALFORMED_RESPONSE");
		}
	}

	// --- web search: Perplexity ----------------------------------------------

	/**
	 * Where a search runs. A keyed provider behind the research service comes first when the launch has a key for one:
	 * it answers in a second or two. When it fails (no credit left, provider down) or no key is set, the model
	 * provider's hosted search runs through a worker: slower, and it needs no key.
	 */
	private async searchWeb(query: SearchQuery, signal?: AbortSignal): Promise<SearchAnswer> {
		const { research, hostedSearch, keyedSearch, remoteResearch } = this.options;
		if (research && keyedSearch) {
			try {
				const found = await research.call("/web/search", { query: query.query, max_results: query.maxResults, ...(query.domains?.length ? { domains: query.domains } : {}), ...(query.freshnessDays ? { freshness_days: query.freshnessDays } : {}) }, signal);
				// A reply, even with nothing found, means some provider answered this search (another may still have refused its key). The service answers a repeated query from
				// its 24 h cache before it calls a provider, so a stale key can clear the notice here and the next new query raises it again.
				clearNotice(SEARCH_KEY_REFUSED_NOTICE);
				const hits: SearchHit[] = (Array.isArray(found?.results) ? found.results : []).map((entry: any) => ({ title: String(entry?.title ?? ""), url: String(entry?.url ?? ""), date: String(entry?.date ?? ""), snippet: String(entry?.snippet ?? "") }));
				const provider = `${clip(found?.provider, 40) || "search"} (research service)`;
				if (hits.length) return { provider, answer: "", hits };
				// The service answered and found nothing: with no hosted search to try, that is the answer, not a missing setting.
				if (!hostedSearch) return { provider, answer: "", hits: [] };
			} catch (error) {
				if (!hostedSearch) throw error;
				const failure = error instanceof ResearchServiceError ? error : undefined;
				const details = failure && { status: failure.status, serviceCode: failure.serviceCode, detail: failure.detail };
				const refused = refusedKeyNotice(failure?.detail, Boolean(remoteResearch));
				if (refused) raiseNotice(SEARCH_KEY_REFUSED_NOTICE, "warn", refused, "live-gateway", "research-search-fallback", details, error);
				else logEvent("warn", "live-gateway", "research-search-fallback", details, error);
			}
		}
		if (!hostedSearch) throw new SafeToolError("CONFIGURATION");
		return hostedSearch(query, signal);
	}

	private async webSearch(input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		assertString(input.query, 3, 300);
		const maxResults = typeof input.max_results === "number" ? input.max_results : 5;
		const domains = Array.isArray(input.domains) ? (input.domains as string[]).slice(0, 10) : undefined;
		const found = await this.searchWeb({ query: input.query, domains, freshnessDays: typeof input.freshness_days === "number" ? input.freshness_days : undefined, maxResults }, signal);
		const retrievedAt = this.stamp();
		const candidates = found.hits
			.map((entry) => ({ title: clip(entry.title, 160) || hostOf(entry.url), url: stripTerminalControl(entry.url), date: clip(entry.date, 40), snippet: clip(entry.snippet, MAX_SNIPPET_CHARS) }))
			.filter((entry) => /^https?:\/\//.test(entry.url) && entry.url.length <= 512)
			.slice(0, MAX_SEARCH_CANDIDATES);
		let answer = clip(found.answer, 2400);
		const screened = await this.screenPassages(input.query, answer, candidates, signal);
		if (screened.answerDropped) answer = "";
		// Snippet text reaches the model only after a successful screen; with the
		// screen off or unavailable the result rows keep the pre-screen shape
		// (date-only snippet), so a missing screen changes nothing the model reads.
		const judged = screened.judgment?.status === "judged";
		const assemble = (rows: typeof screened.kept, ids: string[]) => {
			const evidence: EvidenceReference[] = rows.map((entry, index) => ({ id: ids[index], source: "web_search", title: entry.title || "untitled", url: entry.url, retrievedAt }));
			const data = {
				provider: found.provider,
				retrievedAt,
				results: rows.map((entry, index) =>
					judged && entry.verdict
						? { title: evidence[index].title, url: entry.url, domain: hostOf(entry.url), snippet: entry.snippet, date: entry.date, retrievedAt, route: entry.verdict.route, p: entry.verdict.p }
						: { title: evidence[index].title, url: entry.url, domain: hostOf(entry.url), snippet: entry.date ? `dated ${entry.date}` : "", retrievedAt },
				),
				answer,
				...(screened.answerRoute === "weak" ? { answerRoute: "weak" } : {}),
				...(rows.length === 0 ? { note: "no results for this query" } : {}),
				...(screened.judgment ? { judgment: screened.judgment } : {}),
			};
			return { data, evidence };
		};
		const kept = this.rowsThatFit("research_web_search", "web", screened.kept.slice(0, maxResults), assemble);
		const { data, evidence } = assemble(kept, kept.map(() => this.nextId("web")));
		const texts: Record<string, string> = judged ? Object.fromEntries(kept.map((entry, index) => [evidence[index].id, entry.snippet]).filter(([, snippet]) => snippet)) : {};
		return this.response("research_web_search", data, evidence, texts);
	}

	/**
	 * The leading rows whose response fits the display budget. Full-size quotes, long titles, and long links can add up
	 * past it; the last rows are the least useful, so they go rather than the whole call failing as oversized.
	 * `assemble` builds the response for a set of rows and ids and must register nothing.
	 */
	private rowsThatFit<Row>(operation: GatewayOperation, prefix: string, rows: Row[], assemble: (rows: Row[], ids: string[]) => { data: Record<string, unknown>; evidence: EvidenceReference[] }): Row[] {
		const next = (this.idCounters.get(prefix) ?? 0) + 1;
		let kept = rows;
		const size = () => Buffer.byteLength(modelText({ version: RESEARCH_CONTRACT_VERSION, operation, ...assemble(kept, kept.map((_row, index) => `${prefix}-${next + index}`)) }), "utf8");
		while (kept.length > 1 && size() > MAX_DISPLAY_TEXT_BYTES) kept = kept.slice(0, -1);
		return kept;
	}

	/**
	 * What guide and matchup videos say, as transcript parts: the research service searches YouTube, gets each transcript
	 * (from Gemini with a key, else from the video's captions), and ranks it against the focus. A speaker's words are
	 * third-party text, so the same Jev screen that reads web passages reads them; unlike a web snippet, the text reaches
	 * the model with the screen off too, because without it the tool would return nothing to read.
	 */
	private async videoResearch(input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		assertString(input.query, 3, 200);
		const research = this.options.research;
		if (!research) throw new SafeToolError("CONFIGURATION");
		const body = {
			query: input.query,
			...(typeof input.focus === "string" && input.focus ? { focus: input.focus } : {}),
			title_terms: Array.isArray(input.title_terms) ? (input.title_terms as string[]).slice(0, 4) : [],
			max_videos: MAX_RESEARCH_VIDEOS,
			max_passages_per_video: VIDEO_PASSAGES,
			part_chars: VIDEO_PART_CHARS,
		};
		const found = await research.call("/youtube/research", { ...body, deadline_seconds: VIDEO_RESEARCH_DEADLINE_SECONDS }, signal, VIDEO_RESEARCH_TIMEOUT_MS).then(
			(answer) => {
				clearNotice(OUTDATED_RESEARCH_NOTICE);
				return answer;
			},
			async (error) => {
				// A service started before deadline_seconds existed refuses it (its requests forbid unknown fields). Asked again
				// without it the videos still come, only without the time limit; the notice is raised once that has worked.
				if (!(error instanceof ResearchServiceError && error.serviceCode === "invalid_request")) throw error;
				const answer = await research.call("/youtube/research", body, signal, VIDEO_RESEARCH_TIMEOUT_MS);
				raiseNotice(OUTDATED_RESEARCH_NOTICE, "warn", "Research service out of date: restart it (services/research-tools)", "live-gateway", "research-service-outdated", { field: "deadline_seconds" }, error);
				return answer;
			},
		);
		const retrievedAt = this.stamp();
		const skipped = Array.isArray(found?.skipped) ? (found.skipped as any[]) : [];
		const timedOut = skipped.filter((video) => video?.reason === "timeout").length;
		const videos = (Array.isArray(found?.videos) ? (found.videos as any[]) : [])
			.map((video) => {
				// The service names who made the transcript. Only YouTube's own machine captions are "auto captions"; a Gemini transcript is not.
				const transcript: "gemini" | "captions" = video?.source === "gemini" ? "gemini" : "captions";
				const passages = (Array.isArray(video?.passages) ? (video.passages as any[]) : []).slice(0, VIDEO_PASSAGES).map((passage) => ({ at: Number(passage?.at) || 0, text: clip(passage?.text, VIDEO_PART_CHARS + 200) }));
				return { title: clip(`${clip(video?.channel, 60)}: ${clip(video?.title, 110)}`, 160), url: stripTerminalControl(String(video?.url ?? "")), date: clip(video?.published, 40), transcript, autoCaptions: transcript === "captions" && Boolean(video?.generated), passages, snippet: passages.map((passage) => passage.text).join(" … ") };
			})
			.filter((video) => /^https:\/\//.test(video.url) && video.url.length <= 512 && video.snippet)
			.slice(0, MAX_RESEARCH_VIDEOS);
		const screened = await this.screenPassages(input.query, "", videos, signal);
		const assemble = (rows: typeof screened.kept, ids: string[]) => ({
			evidence: rows.map((video, index): EvidenceReference => ({ id: ids[index], source: "voxren_video_research", title: video.title, url: video.url, retrievedAt })),
			data: {
				provider: "YouTube transcripts (research service)",
				retrievedAt,
				videos: rows.map((video) => ({ title: video.title, url: video.url, published: video.date, transcript: video.transcript, autoCaptions: video.autoCaptions, passages: video.passages, ...(video.verdict ? { route: video.verdict.route, p: video.verdict.p } : {}) })),
				skipped: skipped.length,
				// Videos still being read at the service's deadline: a thin answer explained, like a rate limit.
				...(timedOut ? { timedOut } : {}),
				rateLimited: Boolean(found?.rate_limited),
				...(screened.judgment ? { judgment: screened.judgment } : {}),
			},
		});
		const kept = this.rowsThatFit("research_video", "video", screened.kept, assemble);
		const { data, evidence } = assemble(kept, kept.map(() => this.nextId("video")));
		return this.response("research_video", data, evidence, Object.fromEntries(kept.map((video, index) => [evidence[index].id, video.snippet])));
	}

	/**
	 * Route web_search passages through the opt-in Jev screen. Without a judge
	 * the passages come back untouched and no `judgment` field exists; with a
	 * judge that fails, the passages still come back untouched (date-only
	 * snippets, as before the screen existed) and `judgment` says so, so a
	 * missing screen can never read as a passed one.
	 */
	private async screenPassages<Entry extends { title: string; url: string; date: string; snippet: string }>(query: string, answer: string, candidates: Entry[], signal?: AbortSignal) {
		type Candidate = Entry & { verdict?: PassageVerdict };
		const judge = this.options.passageJudge;
		const passages: PassageInput[] = [
			// An empty answer (a keyed provider returns none) is not a passage: Jev would only be asked to judge nothing.
			...(answer ? [{ id: "answer", title: "search answer", domain: "search", text: answer }] : []),
			...candidates.map((entry, index) => ({ id: `r${index + 1}`, title: entry.title, domain: hostOf(entry.url), url: entry.url, date: entry.date, text: entry.snippet })),
		];
		// With no passage there is no request, so the result must not come back as judged: no judgment, and the card says there was nothing to screen.
		if (!judge || !passages.length) return { kept: candidates as Candidate[], answerDropped: false, answerRoute: undefined, judgment: undefined };
		const context = { patch: this.dataDragon ? publicPatch(this.dataDragon.version) : undefined, accounts: this.options.auditAccounts() };
		const result = await judge.judge(query, context, passages, signal);
		if (result.status !== "judged") {
			// Nothing judged the title or the link, so the model gets the host alone for each (#281).
			const unjudged = candidates.map((entry) => ({ ...entry, title: hostOf(entry.url), url: `${new URL(entry.url).origin}/` })) as Candidate[];
			return { kept: unjudged, answerDropped: false, answerRoute: undefined, judgment: { judge: result.judge, status: "unavailable", model: result.model, reason: result.reason, latencyMs: result.latencyMs, note: PASSAGE_JUDGE_UNAVAILABLE_NOTE } };
		}
		const byId = new Map(result.verdicts.map((verdict) => [verdict.id, verdict]));
		// A search with no answer sends no answer passage: no answer route is claimed for it.
		const answerVerdict = byId.get("answer");
		const kept: Candidate[] = [];
		const removed: Array<{ domain: string; route: string; title: string; p: PassageScores }> = [];
		candidates.forEach((entry, index) => {
			const verdict = byId.get(`r${index + 1}`);
			if (verdict && (verdict.route === "withheld" || verdict.route === "off_topic")) removed.push({ domain: hostOf(entry.url), route: verdict.route, title: entry.title, p: verdict.p });
			else kept.push({ ...entry, verdict });
		});
		return {
			kept,
			// The answer takes the snippets' route: withheld and off_topic are blanked, weak is marked (`answerRoute`).
			answerDropped: answerVerdict?.route === "withheld" || answerVerdict?.route === "off_topic",
			answerRoute: answerVerdict?.route,
			judgment: { judge: result.judge, status: "judged", model: result.model, latencyMs: result.latencyMs, inputTokens: result.inputTokens, ...(answerVerdict && { answer: answerVerdict.route, answerP: answerVerdict.p }), kept: kept.length, removed, note: PASSAGE_JUDGE_NOTE },
		};
	}

	// --- game facts: Data Dragon ---------------------------------------------

	private async loadDataDragon(signal?: AbortSignal, patch?: string): Promise<DataDragonData> {
		if (!patch) return (this.dataDragon ??= await this.fetchDataDragon(signal));
		const wanted = `${patch}.`;
		if (this.dataDragon?.version.startsWith(wanted)) return this.dataDragon;
		if (this.pinnedDataDragon?.version.startsWith(wanted)) return this.pinnedDataDragon;
		return (this.pinnedDataDragon = await this.fetchDataDragon(signal, patch));
	}

	private async fetchDataDragon(signal?: AbortSignal, patch?: string): Promise<DataDragonData> {
		const base = this.options.dataDragonBase ?? DATA_DRAGON_BASE;
		const versions = await this.json(`${base}/api/versions.json`, { method: "GET" }, signal);
		if (!Array.isArray(versions) || typeof versions[0] !== "string") throw new SafeToolError("MALFORMED_RESPONSE");
		const version = patch ? (versions.find((entry: unknown) => typeof entry === "string" && entry.startsWith(`${patch}.`)) ?? versions[0]) : versions[0];
		const locale = `${base}/cdn/${version}/data/en_US`;
		const [champions, items, runes, summoners] = await Promise.all([
			this.json(`${locale}/champion.json`, { method: "GET" }, signal),
			this.json(`${locale}/item.json`, { method: "GET" }, signal),
			this.json(`${locale}/runesReforged.json`, { method: "GET" }, signal),
			this.json(`${locale}/summoner.json`, { method: "GET" }, signal),
		]);
		const itemMap: Record<number, any> = {};
		for (const [id, item] of Object.entries(items?.data ?? {})) itemMap[Number(id)] = item;
		const runeMap: Record<number, string> = {};
		for (const style of Array.isArray(runes) ? runes : []) {
			// Tree ids (Precision, Domination, ...) share the map with the runes: a rune page names both.
			if (typeof style?.id === "number") runeMap[style.id] = String(style.name ?? style.id);
			for (const slot of Array.isArray(style?.slots) ? style.slots : []) {
				for (const rune of Array.isArray(slot?.runes) ? slot.runes : []) if (typeof rune?.id === "number") runeMap[rune.id] = String(rune.name ?? rune.id);
			}
		}
		const summonerMap: Record<number, string> = {};
		for (const spell of Object.values(summoners?.data ?? {}) as any[]) if (spell?.key) summonerMap[Number(spell.key)] = String(spell.name ?? spell.key);
		// By id as well: a kill event's damage list names a summoner spell by its id, lowercased, not by its key.
		const spellMap: Record<string, string> = {};
		for (const [id, spell] of Object.entries(summoners?.data ?? {}) as Array<[string, any]>) if (typeof spell?.name === "string") spellMap[id.toLowerCase()] = spell.name;
		knowChampions(champions?.data ?? {});
		return { version, champions: champions?.data ?? {}, items: itemMap, runes: runeMap, summoners: summonerMap, spells: spellMap };
	}

	private auditNames(): AuditNames {
		const dd = this.dataDragon;
		const items: Record<number, string> = {};
		const listed = new Set<number>();
		const all = dd?.items ?? {};
		for (const [id, item] of Object.entries(all) as Array<[string, any]>) {
			items[Number(id)] = String(item?.name ?? id);
			// A build lists finished items: nothing it still builds into (an Ornn masterwork doesn't count), plus upgraded
			// boots (which do build on), never consumables or trinkets. All from Data Dragon fields, nothing named here.
			const tags: string[] = Array.isArray(item?.tags) ? item.tags : [];
			if (tags.includes("Consumable") || tags.includes("Trinket") || (item?.gold?.total ?? 0) <= 0) continue;
			const into: string[] = Array.isArray(item?.into) ? item.into : [];
			const finished = into.every((next) => all[Number(next)]?.requiredAlly);
			const upgradedBoots = tags.includes("Boots") && Array.isArray(item?.from) && item.from.length > 0;
			if (finished || upgradedBoots) listed.add(Number(id));
		}
		return { items, runes: dd?.runes ?? {}, summoners: dd?.summoners ?? {}, spells: dd?.spells ?? {}, listed };
	}

	private async gameFacts(input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		const entities = input.entities;
		if (!Array.isArray(entities)) throw new SafeToolError("VALIDATION");
		const patch = typeof input.patch === "string" ? input.patch : undefined;
		const dd = await this.loadDataDragon(signal, patch);
		const base = this.options.dataDragonBase ?? DATA_DRAGON_BASE;
		const retrievedAt = this.stamp();
		const facts: Array<{ name: string; kind: string; fact: string; card?: { version: string; stale: boolean }; coaching?: Record<string, unknown>; coachingEvidence?: string }> = [];
		// Ability text per champion, for the passage only: the model reads the clipped fact line, Jev judges against the full text.
		const passages: string[] = [];
		// A card's coaching rows, one passage per champion under its own kb id, so the frame can ground a claim lifted from the card.
		const cardEvidence: Array<{ id: string; card: ChampionCard; text: string }> = [];
		for (const entity of entities.slice(0, 20)) {
			assertRecord(entity);
			assertString(entity.name, 1, 80);
			const kind = String(entity.kind);
			const key = entity.name.replace(/[^a-z0-9]/gi, "").toLowerCase();
			if (kind === "champion") {
				const champion: any = findChampion(dd.champions, entity.name);
				if (!champion) {
					facts.push({ name: entity.name, kind, fact: "not found in Data Dragon" });
					continue;
				}
				const card = loadChampionCard(String(champion.id), this.options.championCardsDir ?? CHAMPION_CARDS_DIR);
				const fresh = card?.meta.version === dd.version;
				let championFactsNow: ChampionFacts;
				let name: string;
				if (card && fresh) {
					championFactsNow = card.facts;
					name = card.name;
				} else {
					const detail = await this.json(`${base}/cdn/${dd.version}/data/en_US/champion/${champion.id}.json`, { method: "GET" }, signal);
					const full: any = detail?.data?.[champion.id] ?? {};
					championFactsNow = championFacts(full);
					name = String(full.name ?? champion.name);
				}
				// A card from another patch answers nothing here but its own version: its coaching is neither shown nor judged against.
				const coachable = currentCard(card, dd.version);
				const coachingText = coachable ? championCoachingText(coachable) : undefined;
				const kbId = coachingText ? this.nextId("kb") : undefined;
				if (coachable && coachingText && kbId) cardEvidence.push({ id: kbId, card: coachable, text: coachingText });
				facts.push({ name, kind, fact: clip(championFactText(championFactsNow), 700), ...(card ? { card: { version: card.meta.version, stale: !fresh } } : {}), ...(coachable && kbId ? { coaching: championCoachingRows(coachable), coachingEvidence: kbId } : {}) });
				passages.push(clip(championPassageText(name, championFactsNow), 1800));
			} else if (kind === "item") {
				const item: any = Object.values(dd.items).find((entry: any) => String(entry?.name ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase() === key);
				facts.push({ name: entity.name, kind, fact: item ? clip(`${item.gold?.total ?? "?"} gold. ${String(item.plaintext ?? "")} ${String(item.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`, 500) : "not found in Data Dragon" });
			} else if (kind === "rune") {
				const name = Object.values(dd.runes).find((entry) => entry.replace(/[^a-z0-9]/gi, "").toLowerCase() === key);
				facts.push({ name: entity.name, kind, fact: name ? `rune present in patch ${dd.version}` : "not found in Data Dragon" });
			} else {
				const name = Object.values(dd.summoners).find((entry) => entry.replace(/[^a-z0-9]/gi, "").toLowerCase() === key);
				facts.push({ name: entity.name, kind, fact: name ? `summoner spell present in patch ${dd.version}` : "not found in Data Dragon" });
			}
		}
		const id = this.nextId("game");
		const evidence: EvidenceReference[] = [
			{ id, source: "voxren_game_facts", title: `Riot Data Dragon ${dd.version}`, url: `${base}/cdn/${dd.version}/data/en_US/champion.json`, retrievedAt },
			...cardEvidence.map(({ id: kbId, card }) => ({ id: kbId, source: "voxren_game_facts" as const, title: `Champion card: ${card.name} coaching rows (${card.meta.sources?.length ?? 0} sources, built ${card.meta.generated}, patch ${card.meta.version})`, url: card.meta.sources?.find((entry) => entry.id !== "game-1")?.url ?? card.meta.sources?.[0]?.url ?? `${base}/cdn/${dd.version}/data/en_US/champion.json`, retrievedAt })),
		];
		// Public static data, rendered as one passage so the frame can ground a cooldown, range, or cost claim against it. It opens with the patch in
		// both numberings: the judge rejects a claim that names a patch its passage does not, and the coach names the public one (26.N) while Data
		// Dragon names 16.N, so true cooldowns were checked as unsupported or contradicted.
		const factsText = clip([`Patch ${publicPatch(dd.version)} (game version ${dd.version}), Riot Data Dragon.`, ...facts.filter((entry) => entry.kind !== "champion").map((entry) => `${entry.name}: ${entry.fact}`), ...passages].join(" "), 6000);
		return this.response("gamedata.lookup", { patch: dd.version, patchNotesLabel: publicPatch(dd.version), provenance: "Riot Data Dragon static data", retrievedAt, entities: facts }, evidence, { [id]: factsText, ...Object.fromEntries(cardEvidence.map((entry) => [entry.id, entry.text])) });
	}

	// --- meta: OP.GG public MCP ----------------------------------------------

	/** One MCP tools/call. `request` is the exact upstream call minus the field projection, shown on the tool card so a dropped argument is visible. */
	private async opgg(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; request: string }> {
		const payload = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { lang: "en_US", ...args } } };
		const raw = await this.json(
			this.options.opggMcpUrl ?? OPGG_MCP_URL,
			{ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "voxren-coach/1" }, body: JSON.stringify(payload) },
			signal,
		);
		if (raw?.error?.code === -32600 && opggErrorNamesField(raw.error.message)) throw new SafeToolError("VALIDATION");
		if (raw?.error || raw?.result?.isError) throw new SafeToolError("UPSTREAM_UNAVAILABLE");
		const content: any[] = Array.isArray(raw?.result?.content) ? raw.result.content : [];
		const text = content.find((block) => block?.type === "text")?.text;
		if (typeof text !== "string" || !text) throw new SafeToolError("MALFORMED_RESPONSE");
		const shown = Object.entries(args).filter(([key]) => key !== "desired_output_fields").map(([key, value]) => `${key}=${value}`);
		return { text, request: `${name}(${shown.join(", ")})` };
	}

	/** An OP.GG answer as the model reads it: provider, the upstream request, the sample it covers, and the compact text, screened for planted instructions when the judge is on. */
	private async opggOverview(operation: GatewayOperation, source: EvidenceReference["source"], title: string, url: string, name: string, args: Record<string, unknown>, sample: string, signal?: AbortSignal): Promise<GatewayResponse> {
		const { text, request } = await this.opgg(name, args, signal);
		const retrievedAt = this.stamp();
		let summary = clip(nameOverviewShards(text.replace(/\s+/g, " ").trim()), 4000);
		const screened = await this.screenSummary(title, summary, signal);
		if (screened.withheld) summary = "";
		// One counter per query type (champion_overview, tier_list, synergy, top_players, pro_player_riot_id): sharing
		// one id across query types let a later call's summary overwrite an earlier one's stored passage text.
		const id = this.nextId(operation.replace(/^meta\./, ""));
		return this.response(
			operation,
			{ provider: "op.gg public MCP", request, sample, staleness: `retrieved ${retrievedAt.slice(0, 10)}; third-party aggregate, not reviewed`, retrievedAt, summary, ...(screened.judgment ? { judgment: screened.judgment } : {}) },
			[{ id, source, title, url, retrievedAt }],
			{ [id]: summary },
		);
	}

	/**
	 * One passage through the Jev screen. Only `withheld` changes anything:
	 * relevance is ill-posed for structured aggregate rows, so `off_topic` is
	 * recorded and never removes text. Failures keep the text and say so.
	 */
	private async screenSummary(query: string, summary: string, signal?: AbortSignal) {
		const judge = this.options.passageJudge;
		if (!judge) return { withheld: false, judgment: undefined };
		const context = { patch: this.dataDragon ? publicPatch(this.dataDragon.version) : undefined, accounts: this.options.auditAccounts() };
		const result = await judge.judge(query, context, [{ id: "meta", title: query, domain: "op.gg", text: summary }], signal);
		if (result.status !== "judged") {
			return { withheld: false, judgment: { judge: result.judge, status: "unavailable", model: result.model, reason: result.reason, latencyMs: result.latencyMs, note: PASSAGE_JUDGE_UNAVAILABLE_NOTE } };
		}
		const route = result.verdicts[0]?.route ?? "weak";
		return {
			withheld: route === "withheld",
			judgment: { judge: result.judge, status: "judged", model: result.model, latencyMs: result.latencyMs, inputTokens: result.inputTokens, answer: route, kept: route === "withheld" ? 0 : 1, removed: [], p: result.verdicts[0]?.p, note: PASSAGE_JUDGE_NOTE },
		};
	}

	private async metaResearch(input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		assertString(input.query_type, 1, 80);
		const champion = typeof input.champion === "string" ? input.champion : "";
		if (!champion) throw new SafeToolError("VALIDATION");
		const position = opggPosition(input.position ?? input.lane);
		const tier = typeof input.tier === "string" ? input.tier : undefined;
		return this.opggOverview(
			"meta.champion_overview",
			"voxren_meta_research",
			`OP.GG champion analysis: ${champion} ${position}${tier ? ` ${tier}` : ""}`,
			`https://www.op.gg/champions/${opggSlug(champion)}/build/${position}`,
			"lol_get_champion_analysis",
			{ champion: opggChampion(champion), position, game_mode: "ranked", ...(tier ? { tier } : {}), desired_output_fields: OVERVIEW_FIELDS },
			tier ? `${tier} ranked` : OPGG_DEFAULT_SAMPLE,
			signal,
		);
	}

	/** The matchup guide has no field projection upstream (≈47KB), so the head-to-head rows are picked here. */
	private async matchup(input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		assertString(input.champion, 1, 80);
		assertString(input.opponent, 1, 80);
		const position = opggPosition(input.position);
		const { text, request } = await this.opgg("lol_get_lane_matchup_guide", { position, my_champion: opggChampion(input.champion), opponent_champion: opggChampion(input.opponent) }, signal);
		let parsed: any;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new SafeToolError("MALFORMED_RESPONSE");
		}
		const data = parsed?.data;
		if (!data || typeof data !== "object") throw new SafeToolError("MALFORMED_RESPONSE");
		const retrievedAt = this.stamp();
		const patch = clip(data.trends?.win?.[0]?.version, 16);
		// Names OP.GG sends are checked against Data Dragon's lists. With Data Dragon down no name can be checked, so none is passed on.
		const dd = await this.loadDataDragon(signal).catch((error) => {
			logEvent("warn", "live-gateway", "matchup-names-unchecked", undefined, error);
			return undefined;
		});
		const itemNames = new Set(Object.values(dd?.items ?? {}).map((item: any) => String(item?.name ?? "")));
		const runeNames = new Set(Object.values(dd?.runes ?? {}));
		const summonerNames = new Set(Object.values(dd?.summoners ?? {}));
		const rows = {
			champion: clip(parsed.my_champion, 40),
			opponent: clip(parsed.opponent_champion, 40),
			patch,
			patchNotesLabel: publicPatch(patch),
			laneAdvantage: clip(data.lane_advantage_champion, 40),
			soloKillAdvantage: clip(data.lane_solo_kill_advantage_champion, 40),
			playStyle: clip(data.recommended_play_style, 40),
			tip: clip(data.opponent_champion_tip, 400),
			starters: topPicks(data.starter_items, 2, itemNames, "item"),
			core: topPicks(data.core_items, 3, itemNames, "item"),
			boots: topPicks(data.boots, 2, itemNames, "item"),
			summoners: topPicks(data.summoner_spells, 1, summonerNames, "summoner"),
			runes: (Array.isArray(data.runes) ? data.runes : []).slice(0, 2).map((page: any) => ({
				primary: knownNames(page?.primary_rune_names, runeNames, "rune"),
				secondary: knownNames(page?.secondary_rune_names, runeNames, "rune"),
				// OP.GG reports shards by perk id: named here so the model copies a name instead of recalling one. Only an id is taken.
				shards: (Array.isArray(page?.stat_mod_names) ? page.stat_mod_names : []).slice(0, 3).filter((id: unknown) => typeof id === "number" || (typeof id === "string" && /^\d{1,6}$/.test(id))).map(statShardName),
				...pickStats(page),
			})),
			skillMax: (Array.isArray(data.skill_masteries) ? data.skill_masteries : []).slice(0, 1).map((entry: any) => ({ order: knownNames(entry?.ids, SKILL_KEYS, "skill"), ...pickStats(entry) })),
		};
		const title = `OP.GG matchup: ${input.champion} vs ${input.opponent} ${position}`;
		// Every other OP.GG and web text gets the Jev screen; the free-text tip is the one that did not. Reuse the same
		// screenSummary path (skip it for an empty tip, nothing to judge) rather than a second screen path.
		const screened = rows.tip ? await this.screenSummary(title, rows.tip, signal) : { withheld: false, judgment: undefined };
		if (screened.withheld) rows.tip = "";
		const id = this.nextId("matchup");
		// The note rides along as its own passage: OP.GG says what players pick, the note says how the lane is played.
		const { note, building } = this.matchupNote(input.champion, input.opponent);
		const noteId = note ? this.nextId("guide") : "";
		return this.response(
			"meta.matchup",
			{
				provider: "op.gg public MCP",
				request,
				sample: OPGG_DEFAULT_SAMPLE,
				staleness: `retrieved ${retrievedAt.slice(0, 10)}; third-party aggregate, not reviewed`,
				retrievedAt,
				...rows,
				...(note ? { notes: matchupNoteRows(note) } : {}),
				...(building ? { notesBuilding: true } : {}),
				...(screened.judgment ? { judgment: screened.judgment } : {}),
			},
			[
				{ id, source: "voxren_meta_research", title, url: `https://www.op.gg/champions/${opggSlug(input.champion)}/counters/${position}?target_champion=${opggSlug(input.opponent)}`, retrievedAt },
				...(note ? [{ id: noteId, source: "voxren_meta_research" as const, title: `Matchup notes: ${note.champion} vs ${note.opponent} (${note.sources.length} sources, built ${note.meta.generated})`, url: note.rows[0].links[0], retrievedAt }] : []),
			],
			{ [id]: matchupText(rows), ...(note ? { [noteId]: matchupNoteText(note) } : {}) },
		);
	}

	/**
	 * The stored note for a matchup, and whether one is being built. A missing note, or one older than
	 * MAX_NOTE_AGE_DAYS, starts a build in the background: a minute or more of video and guide reading that must not
	 * hold up the answer in champ select. The next lookup of the pair finds the finished note.
	 */
	private matchupNote(champion: string, opponent: string): { note: MatchupNote | undefined; building: boolean } {
		const dir = this.options.matchupNotesDir;
		if (!dir) return { note: undefined, building: false };
		const note = loadMatchupNote(champion, opponent, dir);
		const key = matchupNoteFile(champion, opponent);
		const { research, worker, groundingJudge, passageJudge } = this.options;
		const failedAt = this.noteFailures.get(key);
		const fresh = note && noteAgeDays(note, this.now()) <= MAX_NOTE_AGE_DAYS;
		const retryable = failedAt === undefined || this.now().getTime() - failedAt > NOTE_RETRY_MS;
		// No Jev key, no passage screen: research text never reaches a worker unscreened, so no note is built.
		if (!fresh && this.noteBuildsOn && !this.closed && research && worker && groundingJudge && !passageJudge && !this.noteBuilds.has(key) && !this.noteSkipLogged.has(key)) {
			this.noteSkipLogged.add(key);
			logEvent("info", "live-gateway", "matchup-note-build-skipped", { champion, opponent, reason: "no Jev key, so no passage screen for research text" });
		}
		if (!fresh && this.noteBuildsOn && !this.closed && research && worker && groundingJudge && passageJudge && !this.noteBuilds.has(key) && retryable) {
			// Another coach window may be building this pair: it holds the lock, and this window builds nothing and asks again later.
			const release = claimMatchupBuild(dir, champion, opponent, this.now());
			if (!release) return { note, building: true };
			const controller = new AbortController();
			this.noteBuilds.set(key, controller);
			void buildMatchupNote(
				{ research, worker, judge: groundingJudge, passageJudge, accounts: this.options.auditAccounts, hostedSearch: this.options.hostedSearch, now: this.now, signal: controller.signal, log: (line) => logEvent("info", "matchup-note-build", "build-line", { champion, opponent, line }), gameNames: async () => {
					const dd = await this.loadDataDragon(controller.signal);
					return { version: dd.version, names: currentNames(dd.items, dd.runes, dd.summoners) };
				} },
				champion,
				opponent,
			)
				.then((built) => {
					this.noteFailures.delete(key);
					// A failed write is a disk problem, not a thin matchup: logged, and the next lookup builds again instead of waiting out NOTE_RETRY_MS.
					try {
						if (!controller.signal.aborted) saveMatchupNote(dir, built, this.now());
					} catch (error) {
						logEvent("warn", "live-gateway", "matchup-note-save-failed", { champion, opponent }, error);
					}
				})
				// A thin matchup (no videos, nothing kept) or a rate limit: served without notes, and not retried for a while.
				.catch((error) => {
					logEvent("warn", "live-gateway", "matchup-note-build-failed", { champion, opponent }, error);
					this.noteFailures.set(key, this.now().getTime());
				})
				.finally(() => {
					this.noteBuilds.delete(key);
					release();
				});
		}
		return { note, building: this.noteBuilds.has(key) };
	}

	/** Matchup notes are built only with a player at the terminal: a one-shot print run must end when its answer is printed, not a minute later. */
	enableNoteBuilds(): void {
		this.noteBuildsOn = true;
	}

	private async tierList(input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		const position = opggPosition(input.position);
		return this.opggOverview(
			"meta.tier_list",
			"voxren_meta_research",
			`OP.GG ${position} tier list`,
			`https://www.op.gg/champions?position=${position}`,
			"lol_list_lane_meta_champions",
			{ position, desired_output_fields: [`data.positions.${position}[].{champion,tier,rank,win_rate,pick_rate,ban_rate,play}`] },
			OPGG_DEFAULT_SAMPLE,
			signal,
		);
	}

	private async synergy(input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		assertString(input.champion, 1, 80);
		const position = opggPosition(input.position);
		const ally = opggPosition(input.ally_position);
		return this.opggOverview(
			"meta.synergy",
			"voxren_meta_research",
			`OP.GG synergy: ${input.champion} ${position} with ${ally}`,
			`https://www.op.gg/champions/${opggSlug(input.champion)}/build/${position}`,
			"lol_get_champion_synergies",
			{ champion: opggChampion(input.champion), my_position: position, synergy_position: ally, desired_output_fields: ["data.synergies[].{synergy_champion_name,score_rank,win_rate,play}", "data.synergies[].synergy_tier_data.{tier}"] },
			OPGG_DEFAULT_SAMPLE,
			signal,
		);
	}

	private async topPlayers(input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		assertString(input.champion, 1, 80);
		assertString(input.region, 2, 4);
		return this.opggOverview(
			"meta.top_players",
			"voxren_meta_research",
			`OP.GG ${input.champion} leaderboard ${input.region}`,
			`https://www.op.gg/leaderboards/champions/${opggSlug(input.champion)}?region=${input.region}`,
			"lol_list_champion_leaderboard",
			{
				region: input.region,
				champion: opggChampion(input.champion),
				desired_output_fields: ["leaderboard[].rank", "leaderboard[].summoner.{game_name,tagline}", "leaderboard[].summoner.league_stats[].tier_info.{tier,division,lp}", "leaderboard[].most_champion_stat.{play,win,lose,kill,death,assist}"],
			},
			"master+ players on this server, ranked by games on the champion",
			signal,
		);
	}

	/** Resolving a pro/known player's nickname to a Riot ID has no rank-tier sample; the field just names the source. */
	private async proPlayerLookup(input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		assertString(input.player_name, 1, 80);
		assertString(input.region, 2, 4);
		return this.opggOverview(
			"meta.pro_player_riot_id",
			"voxren_meta_research",
			`OP.GG pro player Riot ID: ${input.player_name} (${input.region})`,
			`https://www.op.gg/esports/players/${opggSlug(input.player_name)}`,
			"lol_get_pro_player_riot_id",
			{ player_name: input.player_name, region: input.region, desired_output_fields: PRO_PLAYER_RIOT_ID_FIELDS },
			"OP.GG pro player directory",
			signal,
		);
	}

	// --- strategy frame: grounding gate ----------------------------------------

	private async strategyFrame(input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		assertString(input.question, 3, 1200);
		const claims = input.claims;
		if (!Array.isArray(claims) || claims.length < 1 || claims.length > 8) throw new SafeToolError("VALIDATION");
		for (const claim of claims) assertString(claim, 1, 240);
		const evidence = input.evidence;
		if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 12) throw new SafeToolError("VALIDATION");
		const citationIds: string[] = [];
		const sources: Array<{ id: string; title: string; unread?: true }> = [];
		const passages: GroundingPassage[] = [];
		for (const ref of evidence) {
			assertRecord(ref);
			assertString(ref.id, 1, 64);
			const stored = this.evidenceStore.recall(ref.id);
			if (!citationIds.includes(ref.id)) {
				citationIds.push(ref.id);
				// An id the bounded store has dropped: listed as expired and never judged, so the rest of the frame still is. An id this session never issued stays a VALIDATION error.
				if (!stored) {
					if (!this.wasIssued(ref.id)) throw new SafeToolError("VALIDATION");
					sources.push({ id: ref.id, title: "source expired", unread: true });
					continue;
				}
				// An id with no stored text (an otp build, an unscreened search) is listed but never reaches the judge: the card marks it unread.
				sources.push({ id: ref.id, title: clip(stored.title ?? ref.id, 80), ...(!stored.text && { unread: true }) });
				if (stored.text) passages.push({ id: ref.id, text: stored.text });
			}
		}
		const judged = await this.groundClaims(claims as string[], passages, signal);
		return this.response("strategy_frame", { goal: clip(input.question, 200), claims: judged.claims, citation_ids: citationIds, sources, ...(judged.judgment ? { judgment: judged.judgment } : {}) }, []);
	}

	/** Flags, never removes: without a judge every claim is not_judged and no judgment field exists; a failed judge says so. */
	private async groundClaims(claims: string[], passages: GroundingPassage[], signal?: AbortSignal) {
		const notJudged = claims.map((claim) => ({ claim, route: "not_judged" as const }));
		const judge = this.options.groundingJudge;
		if (!judge) return { claims: notJudged, judgment: undefined };
		const result = await judge.judge(claims, passages, this.options.auditAccounts(), signal);
		if (result.status !== "judged") {
			return { claims: notJudged, judgment: { judge: result.judge, status: "unavailable", model: result.model, reason: result.reason, latencyMs: result.latencyMs, note: GROUNDING_UNAVAILABLE_NOTE } };
		}
		return {
			claims: result.verdicts,
			judgment: { judge: result.judge, status: "judged", model: result.model, latencyMs: result.latencyMs, inputTokens: result.inputTokens, checked: result.verdicts.length, note: GROUNDING_NOTE },
		};
	}

	// --- player audit: Riot API via custodian ----------------------------------

	private async riot(url: string, signal?: AbortSignal): Promise<any> {
		if (!this.options.custodian) throw new SafeToolError("CONFIGURATION");
		for (let attempt = 0; attempt < 2; attempt += 1) {
			assertAbortNotRequested(signal);
			const outcome = await this.options.custodian.fetch(url, signal);
			if (!outcome.ok) {
				if (outcome.reason === "not_stored" || outcome.reason === "keychain_read_failed") throw new SafeToolError("AUTHENTICATION");
				throw new SafeToolError("UPSTREAM_UNAVAILABLE");
			}
			if (outcome.httpStatus === 429 && attempt === 0) {
				await this.sleep(Math.min(Math.max(outcome.retryAfterSeconds ?? 1, 1), 10) * 1000);
				continue;
			}
			if (outcome.httpStatus === 401 || outcome.httpStatus === 403) throw new SafeToolError("AUTHENTICATION");
			if (outcome.httpStatus === 429) throw new SafeToolError("RATE_LIMITED");
			if (outcome.httpStatus === 404) throw new SafeToolError("VALIDATION");
			if (outcome.httpStatus !== 200) throw new SafeToolError("UPSTREAM_UNAVAILABLE");
			try {
				return JSON.parse(outcome.body ?? "");
			} catch {
				throw new SafeToolError("MALFORMED_RESPONSE");
			}
		}
		throw new SafeToolError("RATE_LIMITED");
	}

	/**
	 * A listed ranked match is finished, so it and its timeline never change: read each once, from disk after that.
	 * /otp and the audit reread the same players' games across turns and sessions; a hit costs no Riot call.
	 */
	private async riotMatch(url: string, file: string, signal?: AbortSignal): Promise<any> {
		const dir = this.options.matchCacheDir;
		const path = dir && join(dir, `${file}.json.gz`);
		if (path) {
			try {
				return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
			} catch {
				// Missing or unreadable: read it from Riot and write it again.
			}
		}
		const body = await this.riot(url, signal);
		if (dir && path) {
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(path, gzipSync(JSON.stringify(body)));
			} catch (error) {
				logEvent("warn", "live-gateway", "match-cache-write-failed", { file }, error);
			}
		}
		return body;
	}

	/** Drops the oldest cached match files past MATCH_CACHE_FILES; once per history read. */
	private pruneMatchCache(): void {
		const dir = this.options.matchCacheDir;
		if (!dir) return;
		try {
			const files = readdirSync(dir).filter((name) => name.endsWith(".json.gz"));
			if (files.length <= MATCH_CACHE_FILES) return;
			// ponytail: stats every file each prune; fine at hundreds, an index file if it grows to thousands.
			const aged = files.map((name) => ({ name, time: statSync(join(dir, name)).mtimeMs })).sort((a, b) => a.time - b.time);
			for (const { name } of aged.slice(0, files.length - MATCH_CACHE_FILES)) rmSync(join(dir, name), { force: true });
		} catch (error) {
			logEvent("warn", "live-gateway", "match-cache-prune-failed", {}, error);
		}
	}

	/** account-v1 is global: any regional cluster resolves a Riot ID. */
	private async riotPuuid(gameName: string, tagLine: string, signal?: AbortSignal): Promise<string> {
		const accountBase = this.options.riotAccountBase ?? RIOT_ACCOUNT_BASE;
		// A 404 here means no such Riot ID (often a tag cut at its space), not a malformed request.
		const account = await this.riot(`${accountBase}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`, signal).catch((error) => {
			throw error instanceof SafeToolError && error.code === "VALIDATION" ? new SafeToolError("NOT_FOUND") : error;
		});
		const puuid = typeof account?.puuid === "string" ? account.puuid : "";
		if (!puuid) throw new SafeToolError("MALFORMED_RESPONSE");
		return puuid;
	}

	/** Ranked solo ids from one match-v5 cluster, then match + timeline per game until `count` audited games; each match costs two calls. */
	private async rankedGames(matchBase: string, puuid: string, count: number, championFilter: string, signal?: AbortSignal): Promise<{ games: GameAudit[]; skipped: string[]; ids: string[] }> {
		const names = this.auditNames();
		// Over-fetch ids when filtering by champion.
		const idCount = championFilter ? Math.min(count * 3, 60) : count;
		const ids = await this.riot(`${matchBase}/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=${RANKED_SOLO_QUEUE}&start=0&count=${idCount}`, signal);
		if (!Array.isArray(ids)) throw new SafeToolError("MALFORMED_RESPONSE");
		const games: GameAudit[] = [];
		const skipped: string[] = [];
		// Riot keeps no timeline for some matches, and a match can age out: a 404 on either skips that game, it is not bad input.
		const readOrMissing = async (url: string, matchId: string, file: string): Promise<any | undefined> => {
			try {
				return await this.riotMatch(url, file, signal);
			} catch (error) {
				if (!(error instanceof SafeToolError) || error.code !== "VALIDATION") throw error;
				logEvent("warn", "live-gateway", "audit-game-missing", { matchId }, error);
				skipped.push(matchId);
				missing += 1;
				return undefined;
			}
		};
		let filtered = 0;
		let missing = 0;
		for (const matchId of ids) {
			if (games.length >= count) break;
			if (typeof matchId !== "string" || !/^[A-Z0-9]+_[0-9]+$/.test(matchId)) continue;
			const match = await readOrMissing(`${matchBase}/lol/match/v5/matches/${matchId}`, matchId, matchId);
			if (match === undefined) continue;
			const mine = (match?.info?.participants ?? []).find((participant: any) => participant?.puuid === puuid);
			if (championFilter && String(mine?.championName ?? "").toLowerCase() !== championFilter) {
				filtered += 1;
				continue;
			}
			const timeline = await readOrMissing(`${matchBase}/lol/match/v5/matches/${matchId}/timeline`, matchId, `${matchId}.timeline`);
			if (timeline === undefined) continue;
			try {
				games.push(auditGame(match, timeline, puuid, names));
			} catch (error) {
				logEvent("warn", "live-gateway", "audit-game-failed", { matchId }, error);
				skipped.push(matchId);
			}
		}
		this.pruneMatchCache();
		// Every game gone: Riot is not serving this history right now, which is not the player's typo either.
		if (games.length === 0 && missing > 0 && filtered === 0) throw new SafeToolError("UPSTREAM_UNAVAILABLE");
		return { games, skipped, ids };
	}

	/**
	 * match-v5 is cluster-scoped even though puuid lookup (account-v1) is global: a player's ranked
	 * history only shows up on their home cluster. Try the hinted cluster, then the rest, until one
	 * has ranked games.
	 */
	private async rankedGamesAnyCluster(hinted: string | undefined, puuid: string, count: number, championFilter: string, signal?: AbortSignal): Promise<{ games: GameAudit[]; skipped: string[]; ids: string[]; cluster: string }> {
		const clusters = this.options.riotMatchBase ? [this.options.riotMatchBase] : [...new Set([hinted ?? "americas", ...RIOT_CLUSTERS])].map((cluster) => `https://${cluster}.api.riotgames.com`);
		let result: { games: GameAudit[]; skipped: string[]; ids: string[] } = { games: [], skipped: [], ids: [] };
		let cluster = clusters[0];
		let failure: unknown;
		for (cluster of clusters) {
			try {
				result = await this.rankedGames(cluster, puuid, count, championFilter, signal);
				if (result.ids.length) break;
			} catch (error) {
				// A bad key fails the same everywhere; a 5xx, a rate limit, or a bad body is one cluster's problem, so keep looking.
				if (!(error instanceof SafeToolError) || error.code === "AUTHENTICATION" || error.code === "CONFIGURATION") throw error;
				assertAbortNotRequested(signal);
				failure = error;
			}
		}
		// No cluster had games and one of them failed: that failure is the honest answer, not "0 games".
		if (!result.ids.length && failure) throw failure;
		return { ...result, cluster };
	}

	// --- OTP build: any player's setup on one champion --------------------------

	/** Saves what /otp read as the champion's reference; undefined when there is nowhere to save or too few games on it. */
	private saveReference(games: GameAudit[], championFilter: string, player: string, url: string): { champion: string; games: number } | { saved: false; reason: string } | undefined {
		if (!this.options.referenceDir || !championFilter) return undefined;
		const onChampion = games.filter((game) => game.champion.toLowerCase() === championFilter);
		if (onChampion.length < MIN_REFERENCE_GAMES) return { saved: false, reason: `needs ${MIN_REFERENCE_GAMES} games on the champion, read ${onChampion.length}` };
		try {
			const names = this.auditNames();
			const reference = buildOtpReference(onChampion, { player, url }, names.listed && new Set([...names.listed].map((id) => names.items[id])));
			saveOtpReference(this.options.referenceDir, reference);
			return { champion: reference.champion, games: reference.games };
		} catch (error) {
			logEvent("warn", "live-gateway", "save-reference-failed", { champion: championFilter }, error);
			return { saved: false, reason: "could not write the reference file" };
		}
	}

	private async otpBuild(input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		const ref = parsePlayerRef(String(input.player ?? ""));
		if (!ref) throw new SafeToolError("VALIDATION");
		const count = Math.min(typeof input.count === "number" ? input.count : 5, MAX_OTP_GAMES);
		const championFilter = typeof input.champion === "string" ? input.champion.replace(/[^a-z0-9]/gi, "").toLowerCase() : "";
		await this.loadDataDragon(signal);
		const puuid = await this.riotPuuid(ref.gameName, ref.tagLine, signal);
		// The op.gg platform names the cluster; a bare Riot ID tries the hinted cluster, then the rest, until one has ranked games.
		const hinted = (typeof input.region === "string" ? input.region : undefined) ?? ref.region;
		const { games, skipped, cluster } = await this.rankedGamesAnyCluster(hinted, puuid, count, championFilter, signal);
		const retrievedAt = this.stamp();
		const riotId = `${ref.gameName}#${ref.tagLine}`;
		const platform = ref.platform ?? "na";
		const build = games.map((game) => game.build);
		const savedReference = this.saveReference(games, championFilter, riotId, `https://op.gg/lol/summoners/${platform}/${encodeURIComponent(ref.gameName)}-${encodeURIComponent(ref.tagLine)}?queue_type=SOLORANKED`);
		const shape = (game: GameAudit) => `${game.build.runes.keystone} · ${game.build.runes.primary}/${game.build.runes.secondary}`;
		const evidence: EvidenceReference[] = [
			{ id: this.nextId("otp"), source: "voxren_otp_build", title: `Riot match-v5 ranked solo history for ${riotId}${championFilter ? ` on ${games[0]?.champion ?? input.champion}` : ""} (${games.length} games)`, url: `https://op.gg/lol/summoners/${platform}/${encodeURIComponent(ref.gameName)}-${encodeURIComponent(ref.tagLine)}?queue_type=SOLORANKED`, retrievedAt },
		];
		const response = this.response(
			"otp_build",
			{
				player: riotId,
				cluster: cluster.replace(/^https:\/\/([a-z]+)\..*$/, "$1"),
				champion: championFilter ? (games[0]?.champion ?? input.champion) : "any",
				queue: "ranked solo/duo (420)",
				retrievedAt,
				requested: count,
				analyzed: games.length,
				skipped,
				patches: [...new Set(games.map((game) => game.patch))],
				patchNotesLabels: [...new Set(games.map((game) => publicPatch(game.patch)))],
				record: `${games.filter((game) => game.win).length}-${games.filter((game) => !game.win).length}`,
				// The player asked about this one-trick: their games become the champion's reference for voxren_player_audit.
				...(savedReference ? { savedReference } : {}),
				// How often each choice recurs across the games read: the model quotes counts, never a guess about "the" build.
				recurring: {
					runePages: frequency(games.map(shape)),
					primaryRunes: frequency(build.map((entry) => [entry.runes.keystone, ...entry.runes.primaryRunes].join(", "))),
					secondaryRunes: frequency(build.map((entry) => `${entry.runes.secondary}: ${entry.runes.secondaryRunes.join(", ")}`)),
					shards: frequency(build.map((entry) => entry.runes.shards.join(" / "))),
					firstThreeItems: frequency(build.map((entry) => entry.itemOrder.slice(0, 3).map((item) => item.name).join(" → "))),
					finalItems: frequency(games.flatMap((game) => game.finalItems)),
					skillMax: frequency(games.map((game) => game.skillMax)),
					summoners: frequency(games.map((game) => game.summoners.join(" + "))),
				},
				games: games.map((game) => ({
					id: game.matchId,
					date: game.playedAt,
					patch: game.patch,
					win: game.win,
					champ: game.champion,
					role: game.position,
					vs: game.opponent,
					kda: `${game.kills}/${game.deaths}/${game.assists}`,
					dur: game.durationMin,
					summoners: game.summoners,
					runes: game.build.runes,
					skills: `${game.build.skills} max ${game.skillMax || "?"}`,
					items: game.build.itemOrder.map((item) => `${item.name}@${item.min}`),
					final: game.finalItems,
				})),
			},
			evidence,
		);
		// Ten games' rows run past the tool budget: the oldest rows go first, and `recurring` still counts every game read.
		const rows = response.data.games as unknown[];
		while (rows.length > 1 && Buffer.byteLength(modelText(response), "utf8") > displayBudget("otp_build")) {
			rows.pop();
			response.data.gameRowsShown = rows.length;
		}
		return response;
	}

	private async playerAudit(input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
		// The account signed into the open League client comes first; VOXREN_COACH_ACCOUNTS fills in while it is closed.
		const signedIn = await this.options.readSignedInRiotId?.();
		const accounts = this.options.auditAccounts();
		const known = signedIn ? [signedIn, ...accounts] : accounts;
		// Omitted riot_id means the player's own (first known) account; any other Riot ID is a friend's or teammate's public history, like voxren_otp_build.
		const riotId = input.riot_id === undefined ? known[0] : input.riot_id;
		if (riotId === undefined) throw new SafeToolError("CONFIGURATION");
		assertString(riotId, 3, 22);
		if (!RIOT_ID_PATTERN.test(riotId)) throw new SafeToolError("VALIDATION");
		const count = Math.min(typeof input.count === "number" ? input.count : 10, MAX_AUDIT_GAMES);
		const championFilter = typeof input.champion === "string" ? input.champion.replace(/[^a-z0-9]/gi, "").toLowerCase() : "";
		const [gameName, tagLine] = riotId.split("#");

		await this.loadDataDragon(signal);
		const puuid = await this.riotPuuid(gameName, tagLine, signal);
		// match-v5 is cluster-scoped: the account may live on any server.
		const { games, skipped } = await this.rankedGamesAnyCluster(undefined, puuid, count, championFilter, signal);
		const retrievedAt = this.stamp();
		const evidence: EvidenceReference[] = [
			{ id: this.nextId("audit"), source: "voxren_player_audit", title: `Riot match-v5 ranked solo history for ${riotId} (${games.length} games)`, url: `https://www.op.gg/summoners/na/${encodeURIComponent(gameName)}-${encodeURIComponent(tagLine)}`, retrievedAt },
		];
		// The reference: the most-played champion in these games that has one (saved with /otp, else shipped), or none.
		const played = [...new Set(games.map((game) => game.champion))].sort((a, b) => games.filter((game) => game.champion === b).length - games.filter((game) => game.champion === a).length);
		let reference: OtpReference | undefined;
		for (const champion of played) if ((reference = loadOtpReference(champion, this.options.referenceDir))) break;
		// A per-call id: a fixed one lets a later audit overwrite what an earlier frame cited (#80, #269).
		const referenceId = reference ? this.nextId("audit-ref") : "";
		const referenceEntry: EvidenceReference[] = reference ? [{ id: referenceId, source: "voxren_player_audit", title: reference.title, url: reference.url, retrievedAt }] : [];
		const referenceText = reference ? clip(referencePassageText(reference), 4000) : "";
		const trackedItems = Object.keys(reference?.itemTimingMin ?? {});
		// `detail`: how many of the newest games carry every death and every kill and assist in context.
		const build = (kept: GameAudit[], deathCount: number, detail: number): { response: GatewayResponse; passageChars: number } => {
			// A remake carries no LP and its stats are a partial game; it stays in the fetched list below but never in an average.
			const nonRemake = kept.filter((game) => !game.remake);
			const deaths = keyDeaths(nonRemake, deathCount);
			// A reference is one player's habits on one champion: only games on that champion are comparable to it, so its tracked
			// item medians come from those games alone; the rest of the summary covers every non-remake game.
			const referenceGames = reference ? nonRemake.filter((game) => game.champion === reference.champion) : [];
			const summary = summarizeAudit(nonRemake, trackedItems, referenceGames);
			const opponentsSeen = [...new Set(referenceGames.map((game) => game.opponent))];
			const referenceMatchups = reference ? opponentsSeen.map((opponent) => otpMatchup(opponent, reference)).filter((entry) => entry !== undefined) : [];
			const detailed = kept.slice(0, detail).filter((game) => !game.remake);
			const passage = auditPassageText(nonRemake, summary, deaths, detailed);
			// The one game whose deaths the card draws one by one, picked by the card's own rule. Only its deaths keep who stood
			// around them and what did the damage: on every death of twenty games that alone passes the chart payload cap.
			const drawn = worstGame(chartedGames(kept.map((game) => ({ id: game.matchId, remake: game.remake, gd15: game.goldDiffAt15, chart: { gd: game.timeline.goldDiff, deaths: [], kills: [], items: [] } }))))?.id;
			const response = this.response(
			"player_audit",
			{
				account: riotId,
				queue: "ranked solo/duo (420)",
				retrievedAt,
				requested: count,
				analyzed: kept.length,
				// Oldest games dropped so the result fits the model-text budget; the model sees the count, not a failure.
				...(kept.length < games.length ? { dropped: games.length - kept.length } : {}),
				skipped,
				patches: [...new Set(kept.map((game) => game.patch))],
				patchNotesLabels: [...new Set(kept.map((game) => publicPatch(game.patch)))],
				summary,
				// Counted patterns, best evidenced first, each with its share in the losses: what the coach names habits from.
				habits: auditHabits(nonRemake).map(habitText),
				// The same for the kills and assists, split between wins and losses: where the lead comes from and what a kill becomes.
				killPatterns: auditKillPatterns(nonRemake).map(killPatternText),
				// The costliest deaths in context (where, gold held, what the enemy took after): what the coach builds "what else you could have done" from.
				keyDeaths: deaths,
				games: kept.map((game) => {
					// Reference champion: the tracked items the reference is compared on. Anyone else: the finished-item build order, which
					// is already curated by audit-metrics and stays bounded (every raw purchase over 20 games breaks the payload budget).
					const items = game.champion === reference?.champion
						? Object.entries(game.itemTimingMin).filter(([name]) => trackedItems.includes(name)).map(([name, min]) => ({ name, min }))
						: game.build.itemOrder;
					return {
					id: game.matchId,
					date: game.playedAt,
					// Display only (policy.ts strips it): the learnings fold orders same-day games by it.
					playedAtMs: game.playedAtMs,
					patch: game.patch,
					win: game.win,
					remake: game.remake,
					champ: game.champion,
					vs: game.opponent,
					kda: `${game.kills}/${game.deaths}/${game.assists}`,
					dur: game.durationMin,
					d6: game.deathsBefore6,
					d15: game.deathsAt15,
					dLate: game.deathsAfter15,
					k15: game.killsAt15,
					cs10: game.csAt10,
					cs15: game.csAt15,
					gd10: game.goldDiffAt10,
					gd15: game.goldDiffAt15,
					lvl6: game.level6Min,
					back1: game.firstBackMin,
					keystone: game.keystone,
					skills: `${game.skillOrder} max ${game.skillMax || "?"}`,
					items: items.map(({ name, min }) => `${name}@${min}`).join(", "),
					// Deaths that followed a teammate's death nearby, and deaths with no kill, objective, or tower for the team right after.
					dAfterAlly: game.timeline.deaths.filter((death) => death.afterAllyDeath).length,
					dUntraded: untradedDeaths(game),
					dWorth: game.play.deaths.filter((death) => death.worth).length,
					cspm15: game.play.csPerMinTo15,
					cspmLate: game.play.csPerMinAfter15,
					gd20: game.play.goldDiffAt20,
					gdPeak: game.play.leadPeak,
					gdPeakMin: game.play.leadPeakMin,
					gdEnd: game.play.leadEnd,
					obj: objectivesText(game.play.objectives),
					epic: `${game.play.epicTakesOn} of ${game.play.epicTakes}`,
					deadPct: game.play.deadPct,
					towers: game.play.turretTakedowns,
					kp: game.play.killParticipationPct,
					dmg: game.play.damageSharePct,
					vis: game.play.visionPerMin,
					cw: game.play.controlWards,
					// Vision score, wards placed and cleared; damage per minute and share of the team's taken; turret plates; objective takes the player was on, of the team's.
					ward: `${game.play.visionScore}/${game.play.wardsPlaced}/${game.play.wardsKilled}`,
					dpm: game.play.damagePerMin,
					taken: game.play.damageTakenSharePct,
					plates: game.play.plates,
					part: participationText(game.play.participation),
					...(detailed.includes(game) ? gameMoments(game) : {}),
					// Display only: policy.ts strips `chart` before the model reads or budgets the result.
					chart: {
						gd: game.timeline.goldDiff,
						deaths: game.matchId === drawn ? game.timeline.deaths : game.timeline.deaths.map(({ scene: _scene, damage: _damage, ...mark }) => mark),
						kills: game.timeline.kills,
						items,
					},
					};
				}),
				...(reference && referenceGames.length > 0 ? { reference: {
					title: reference.title,
					url: reference.url,
					trust: "one-trick reference; untrusted, one player's habits",
					champion: reference.champion,
					patch: reference.patch,
					games: reference.games,
					perGame: reference.perGame,
					itemTimingMin: reference.itemTimingMin,
					deathBandWinPct: reference.deathBandWinPct,
					deathsAt15WinPct: reference.deathsAt15WinPct,
					rules: reference.rules,
					matchups: referenceMatchups.map((entry) => ({ vs: entry.opponent, n: entry.games, wr: entry.winRatePct, gd15: entry.goldDiff15, deaths: entry.deathsPerGame, d6pct: entry.diesBefore6Pct, boots: entry.boots, finish: entry.finish, tip: entry.tip })),
				} } : {}),
			},
			// The reference is cited only when the model was shown it (data.reference above).
			[...evidence, ...(referenceGames.length > 0 ? referenceEntry : [])],
			{ ...(referenceGames.length > 0 ? { [referenceId]: referenceText } : {}), [evidence[0].id]: clip(passage, AUDIT_PASSAGE_CHARS) },
			);
			return { response, passageChars: passage.length };
		};
		// Twenty real games do not always fit the audit's display budget: give up the oldest game's deaths and kills in context
		// first (a few games keep them, a long history is read from its counts), then costly deaths down to three, then drop the
		// oldest games until they fit, rather than fail the audit. A game's moments also go when the judge's passage has no room
		// for them: the model never reads a moment the frame cannot check.
		let kept = games;
		let deathCount = 6;
		let detail = kept.length;
		let built = build(kept, deathCount, detail);
		const over = () => Buffer.byteLength(modelText(built.response), "utf8") > displayBudget("player_audit");
		while ((detail > 0 && (over() || built.passageChars > AUDIT_PASSAGE_CHARS)) || (kept.length > 1 && over())) {
			if (detail > 0) detail -= 1;
			else if (deathCount > 3) deathCount -= 1;
			else kept = kept.slice(0, -1);
			built = build(kept, deathCount, detail);
		}
		logEvent("info", "live-gateway", "audit-fit", { requested: count, kept: kept.length, detail, deathCount, modelBytes: Buffer.byteLength(modelText(built.response), "utf8"), passageChars: built.passageChars });
		return built.response;
	}

	/**
	 * Saves one explicit takeaway to the active Riot ID's learnings file. Reads the signed-in Riot ID the same
	 * way playerAudit does (that call already reads the League client inside a tool call; this is not a new
	 * client read, AGENTS.md rule 3) and falls back to the first approved account while the client is closed.
	 * The text is normalized (terminal-control stripped, whitespace collapsed to one line) before it is saved,
	 * so a web or OP.GG passage that talks the model into calling this tool cannot plant a persistent
	 * multi-line or control-character instruction into a later system prompt.
	 */
	private async remember(input: Record<string, unknown>): Promise<GatewayResponse> {
		const signedIn = await this.options.readSignedInRiotId?.();
		const riotId = signedIn ?? this.options.auditAccounts()[0];
		if (!riotId) throw new SafeToolError("CONFIGURATION");
		const text = normalizeTakeaway(String(input.text ?? ""));
		assertString(text, 1, 200);
		const path = learningsFilePath(this.options.learningsDir, riotId);
		if (!path) throw new SafeToolError("CONFIGURATION");
		saveLearnings(path,addTakeaway(loadLearnings(path), text, this.stamp()));
		return this.response("remember", { saved: true, riotId }, []);
	}
}

/** A launch has a keyed search provider when either key the research service reads is set. */
export function hasSearchKey(environment: Record<string, string | undefined>): boolean {
	return Boolean(environment.BRAVE_API_KEY?.trim() || environment.PERPLEXITY_API_KEY?.trim());
}

/** Hosted search for this launch: the provider must have one, and this process must be a Pi run a worker can copy. */
export function hostedSearchFor(environment: Record<string, string | undefined>, worker: PiWorker | undefined = createPiWorker(environment)): HostedSearch | undefined {
	if (!HOSTED_SEARCH_PROVIDERS.has(environment.VOXREN_COACH_PROVIDER?.trim() || DEFAULT_PROVIDER)) return undefined;
	return worker && createHostedSearch(worker);
}

export function createLiveResearchGateway(
	environment: Record<string, string | undefined>,
	custodian: Pick<RiotKeyCustodian, "fetch"> | undefined,
	overrides: Partial<LiveGatewayOptions> = {},
): LiveResearchGateway {
	const worker = createPiWorker(environment);
	return new LiveResearchGateway({
		research: createResearchService(environment),
		hostedSearch: hostedSearchFor(environment, worker),
		keyedSearch: hasSearchKey(environment),
		remoteResearch: researchServiceMode(environment).kind === "remote",
		worker,
		matchupNotesDir: coachHomePath(environment, "matchups"),
		auditAccounts: () => parseAuditAccounts(environment.VOXREN_COACH_ACCOUNTS),
		readSignedInRiotId,
		custodian,
		passageJudge: createPassageJudge(environment),
		groundingJudge: createGroundingJudge(environment),
		referenceDir: coachHomePath(environment, "references"),
		learningsDir: coachHomePath(environment, "learnings"),
		matchCacheDir: coachHomePath(environment, "cache/riot-matches"),
		...overrides,
	});
}
