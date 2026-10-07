// League Client (LCU) transport: lockfile discovery + a host-guarded, TLS-pinned GET.
// Command-time only — nothing here is a model-callable tool. See docs/lcu.md.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Agent, request } from "node:https";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { logEvent } from "./coach-log";
import { statShardName } from "./stat-shards";

/** Riot's LCU root CA, checked into the repo. Never `rejectUnauthorized: false`. */
const RIOT_CA_PATH = fileURLToPath(new URL("../data/riotgames.pem", import.meta.url));
const RIOT_CA = readFileSync(RIOT_CA_PATH, "utf8");
// ponytail: pinned to the Riot root only, no `checkServerIdentity` override — a real LCU leaf cert
// may lack a 127.0.0.1 SAN and fail Node's hostname check even though the chain validates. Verify
// against a live client first (untestable in this environment); if it fails, add a
// `checkServerIdentity` override that still validates the chain and only skips the IP match. Never
// `rejectUnauthorized: false`.
const RIOT_CA_AGENT = new Agent({ ca: RIOT_CA });

/** Per-lane play rates by champion id, data/championRoles.json: OP.GG per-lane play rates, patch 26.S2, carried over from the Voxren desktop app. */
const CHAMPION_ROLES: { roles: Record<string, Record<string, number>> } = JSON.parse(readFileSync(fileURLToPath(new URL("../data/championRoles.json", import.meta.url)), "utf8"));

/** The only host any LCU (or fixed-port live-client) request may target. */
const ALLOWED_HOST = "127.0.0.1";

export function isAllowedLcuHost(host: string): boolean {
	return host === ALLOWED_HOST;
}

// --- Lockfile discovery -----------------------------------------------------

/** `process:pid:port:password:protocol` (Riot's format; only port + password are used). */
export interface Lockfile {
	port: number;
	password: string;
}

const LOCKFILE_PATHS: Readonly<Record<string, readonly string[]>> = {
	darwin: [
		"/Applications/League of Legends.app/Contents/LoL/lockfile",
		"/Applications/Riot Games/League of Legends.app/Contents/LoL/lockfile",
	],
	win32: [String.raw`C:\Riot Games\League of Legends\lockfile`, String.raw`D:\Riot Games\League of Legends\lockfile`, String.raw`E:\Riot Games\League of Legends\lockfile`],
};

/** Common per-OS install paths, same list the desktop app falls back to (`connector.rs`). No registry lookup: this is Node, and it's one more path to check, not a different mechanism. */
export function defaultLockfileCandidates(): readonly string[] {
	return LOCKFILE_PATHS[platform()] ?? [];
}

export function findLockfilePath(candidates: readonly string[] = defaultLockfileCandidates()): string | undefined {
	return candidates.find((path) => existsSync(path));
}

export function parseLockfile(content: string): Lockfile | undefined {
	const parts = content.trim().split(":");
	if (parts.length !== 5) return undefined;
	const port = Number(parts[2]);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
	return { port, password: parts[3] };
}

/** Lockfile absent or unreadable/malformed is silent (no client running) — never throws. */
export function discoverLcu(candidates?: readonly string[]): Lockfile | undefined {
	const path = findLockfilePath(candidates);
	if (!path) return undefined;
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	return parseLockfile(content);
}

// --- Transport ---------------------------------------------------------------

export interface LcuTarget {
	host: string;
	port: number;
	password: string;
}

/** Swappable for tests; the default speaks real TLS over the pinned CA agent. */
export type LcuTransport = (target: LcuTarget, path: string, agent: Agent) => Promise<{ status: number; text: string }>;

// ponytail: one inactivity bound for every LCU request, so a client that accepts the socket but never answers degrades to "no client" instead of stalling the caller.
const LCU_REQUEST_TIMEOUT_MS = 1500;

export function httpsTransport(target: LcuTarget, path: string, agent: Agent, timeoutMs = LCU_REQUEST_TIMEOUT_MS, send: typeof request = request): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const auth = Buffer.from(`riot:${target.password}`).toString("base64");
		let responded = false;
		const req = send({ hostname: target.host, port: target.port, path, method: "GET", agent, headers: { Authorization: `Basic ${auth}` } }, (res) => {
			responded = true;
			// Buffers, decoded once at the end: a multi-byte character can straddle two chunks.
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
			});
			res.on("end", () => {
				clearTimeout(timer);
				resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
			});
			res.on("error", reject);
		});
		// A wall-clock timer, not req.setTimeout: it covers the TLS handshake too. Bun emits only "close" (no "error") for a
		// request destroyed mid-connect, so "close" rejects as well; a settled promise ignores the extra call.
		const timeout = new Error(`lcu: ${path} timed out after ${timeoutMs}ms`);
		// The timer runs until the body ends and rejects itself: a response that stalls mid-body settles too.
		const timer = setTimeout(() => {
			req.destroy(timeout);
			reject(timeout);
		}, timeoutMs);
		req.on("error", reject);
		req.on("close", () => {
			// Bun emits the request's "close" before the response's "end" (Node after): once a response has arrived, its own events or the timer settle this.
			if (responded) return;
			clearTimeout(timer);
			reject(req.destroyed ? timeout : new Error(`lcu: ${path} closed before a response`));
		});
		req.end();
	});
}

// --- Wire types --------------------------------------------------------------
// What each endpoint actually returns, as far as the coach reads it. Every field is optional:
// the payload is untrusted, and the read* functions below normalise it into the app types.

export interface LcuSummonerWire {
	gameName?: string;
	tagLine?: string;
	summonerLevel?: number;
}

export interface LcuRankedQueueWire {
	tier?: string;
	division?: string;
	leaguePoints?: number;
	wins?: number;
	losses?: number;
}

export interface LcuRankedStatsWire {
	queueMap?: { RANKED_SOLO_5x5?: LcuRankedQueueWire };
}

export interface LcuChampSelectMemberWire {
	cellId?: number;
	championId?: number;
	championPickIntent?: number;
	assignedPosition?: string;
	spell1Id?: number;
	spell2Id?: number;
}

export interface LcuChampSelectActionWire {
	type?: string;
	completed?: boolean;
	championId?: number;
	isAllyAction?: boolean;
}

export interface LcuChampSelectSessionWire {
	myTeam?: LcuChampSelectMemberWire[];
	theirTeam?: LcuChampSelectMemberWire[];
	/** One array per action round (pick/ban phases). */
	actions?: LcuChampSelectActionWire[][];
	localPlayerCellId?: number;
	timer?: { phase?: string; adjustedTimeLeftInPhase?: number };
}

export interface LcuMatchHistoryWire {
	games?: { games?: { queueId?: number; participants?: { stats?: { win?: boolean } }[] }[] };
}

export interface LiveClientPlayerWire {
	championName?: string;
	team?: string;
	position?: string;
	level?: number;
	isDead?: boolean;
	respawnTimer?: number;
	/** "Name#Tag". */
	riotId?: string;
	riotIdGameName?: string;
	riotIdTagLine?: string;
	summonerName?: string;
	scores?: { kills?: number; deaths?: number; assists?: number; creepScore?: number; wardScore?: number };
	summonerSpells?: { summonerSpellOne?: { displayName?: string }; summonerSpellTwo?: { displayName?: string } };
	runes?: { keystone?: { displayName?: string } };
	items?: { itemID?: number; displayName?: string; slot?: number; count?: number }[];
}

/** The feed's event log: the objective rows (dragons, baron, herald, turrets, inhibitors) and the champion kills are read. */
export interface LiveClientEventWire {
	EventName?: string;
	EventTime?: number;
	KillerName?: string;
	VictimName?: string;
	Assisters?: string[];
	DragonType?: string;
	TurretKilled?: string;
	InhibKilled?: string;
}

export interface LiveClientAllGameDataWire {
	allPlayers?: LiveClientPlayerWire[];
	/** `mapTerrain` is the rift's element once the third dragon sets it ("Infernal"); "Default" before. */
	gameData?: { gameTime?: number; mapTerrain?: string };
	activePlayer?: {
		riotId?: string;
		riotIdGameName?: string;
		riotIdTagLine?: string;
		summonerName?: string;
		currentGold?: number;
		championStats?: { currentHealth?: number; maxHealth?: number };
		abilities?: Partial<Record<"Q" | "W" | "E" | "R", { abilityLevel?: number }>>;
		/** The active player's whole page: keystone, three primary, two secondary, in that order; shards by perk id. Other players carry a keystone only. */
		fullRunes?: { generalRunes?: { displayName?: string }[]; statRunes?: { id?: number }[] };
	};
	events?: { Events?: LiveClientEventWire[] };
}

/** Path → payload. Add a row here to read a new endpoint with a typed `client.get`. */
export interface LcuEndpoints {
	"/lol-gameflow/v1/gameflow-phase": string;
	"/lol-summoner/v1/current-summoner": LcuSummonerWire;
	"/lol-ranked/v1/current-ranked-stats": LcuRankedStatsWire;
	"/lol-champ-select/v1/session": LcuChampSelectSessionWire;
	"/lol-match-history/v1/products/lol/current-summoner/matches": LcuMatchHistoryWire;
	"/liveclientdata/allgamedata": LiveClientAllGameDataWire;
}

export type LcuPath = keyof LcuEndpoints;

export class LcuClient {
	private readonly agent: Agent;
	private readonly transport: LcuTransport;

	constructor(
		private readonly target: LcuTarget,
		opts: { agent?: Agent; transport?: LcuTransport } = {},
	) {
		this.agent = opts.agent ?? RIOT_CA_AGENT;
		this.transport = opts.transport ?? httpsTransport;
	}

	/** Typed by path (a query string may follow it); `undefined` on an empty body. The shape is a claim, not a check: readers still guard each field. */
	async get<P extends LcuPath>(path: P | `${P}?${string}`): Promise<LcuEndpoints[P] | undefined> {
		if (!isAllowedLcuHost(this.target.host)) throw new Error(`lcu: refusing non-loopback host "${this.target.host}"`);
		const { status, text } = await this.transport(this.target, path, this.agent);
		if (status < 200 || status >= 300) throw new Error(`lcu: ${path} returned ${status}`);
		return text ? (JSON.parse(text) as LcuEndpoints[P]) : undefined;
	}
}

// --- Reads (narrow shapes only — never the raw body) -------------------------

export interface Summoner {
	gameName: string;
	tagLine: string;
	summonerLevel: number;
}

export interface RankedSolo {
	tier: string;
	division: string;
	leaguePoints: number;
	wins: number;
	losses: number;
}

/** Every read tolerates a missing/unreachable client or an unexpected shape by returning `undefined`, never throwing. */
/** `Name#TAG` of the account signed into the open League client; undefined when it is closed. */
export async function readSignedInRiotId(discover: () => Lockfile | undefined = discoverLcu, makeClient: (target: LcuTarget) => LcuClient = (target) => new LcuClient(target)): Promise<string | undefined> {
	const lock = discover();
	if (!lock) return undefined;
	const summoner = await readSummoner(makeClient({ host: ALLOWED_HOST, port: lock.port, password: lock.password }));
	return summoner && `${summoner.gameName}#${summoner.tagLine}`;
}

const RANKED_SOLO_QUEUE = 420;

/** Win/loss of the signed-in player's last ranked solo games from the client's own match history, newest first. */
async function readRecentResults(client: LcuClient, limit = 5): Promise<boolean[]> {
	try {
		// ponytail: one page of 10 covers 5 ranked games for a ranked-only player; page further if the strip comes up short too often.
		const json = await client.get("/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=9");
		const games = Array.isArray(json?.games?.games) ? json.games.games : [];
		return games
			.filter((game) => game?.queueId === RANKED_SOLO_QUEUE)
			.map((game) => game?.participants?.[0]?.stats?.win === true)
			.slice(0, limit);
	} catch {
		// Left unlogged, deliberately: called on every footer poll (every 2-5s, AGENTS.md rule 3) alongside
		// readSummoner/readRankedSolo below, so a closed client or a lobby with no history yet would log a
		// warn line every poll for the cosmetic footer row -- the one failure that matters, gameflowPhase
		// itself being unreadable, already surfaces as the footer's own "LCU: ..." reason.
		return [];
	}
}

export async function readSummoner(client: LcuClient): Promise<Summoner | undefined> {
	try {
		const json = await client.get("/lol-summoner/v1/current-summoner");
		const gameName = typeof json?.gameName === "string" ? json.gameName : "";
		if (!gameName) return undefined;
		return {
			gameName,
			tagLine: typeof json?.tagLine === "string" ? json.tagLine : "",
			summonerLevel: typeof json?.summonerLevel === "number" ? json.summonerLevel : 0,
		};
	} catch {
		// Left unlogged, deliberately: same every-poll reasoning as readRecentResults above.
		return undefined;
	}
}

/** `undefined` covers both "client closed" and unranked/placements (no `tier` yet) — same "no row" bucket the footer wants. */
export async function readRankedSolo(client: LcuClient): Promise<RankedSolo | undefined> {
	try {
		const json = await client.get("/lol-ranked/v1/current-ranked-stats");
		const solo = json?.queueMap?.RANKED_SOLO_5x5;
		const tier = typeof solo?.tier === "string" ? solo.tier : "";
		if (!tier) return undefined;
		return {
			tier,
			division: typeof solo?.division === "string" ? solo.division : "",
			leaguePoints: typeof solo?.leaguePoints === "number" ? solo.leaguePoints : 0,
			wins: typeof solo?.wins === "number" ? solo.wins : 0,
			losses: typeof solo?.losses === "number" ? solo.losses : 0,
		};
	} catch {
		// Left unlogged, deliberately: an unranked or placements player (no tier yet) hits this every poll
		// for their whole session, same every-poll reasoning as readRecentResults above.
		return undefined;
	}
}

/** gameflow-phase is a bare string and answers on the home screen too; /session 404s until a lobby exists. Throws on any failure. */
async function gameflowPhase(client: LcuClient): Promise<string> {
	const json = await client.get("/lol-gameflow/v1/gameflow-phase");
	if (typeof json !== "string") throw new Error("lcu: gameflow-phase is not a string");
	return json;
}

export async function readGameflowPhase(client: LcuClient): Promise<string | undefined> {
	try {
		return await gameflowPhase(client);
	} catch (error) {
		logEvent("warn", "lcu", "gameflow-phase-failed", undefined, error);
		return undefined;
	}
}

// --- Champ select ------------------------------------------------------------

/** A team-slot row from `myTeam`/`theirTeam`; same shape for both. */
export interface ChampSelectMember {
	cellId: number;
	championId: number;
	championPickIntent: number;
	assignedPosition: string;
	spell1Id: number;
	spell2Id: number;
}

export interface ChampSelectBan {
	championId: number;
	isAllyBan: boolean;
}

export interface ChampSelectState {
	kind: "champSelect";
	myTeam: ChampSelectMember[];
	theirTeam: ChampSelectMember[];
	/** Completed ban actions only (a ban in progress has no `championId` yet). */
	bans: ChampSelectBan[];
	/** Total `ban`-type action slots regardless of completion — the denominator for a "bans 3/6" progress count. */
	banSlotsTotal: number;
	/** Ban slots that are done, a skipped one (no champion) included: the numerator of that count. `bans` leaves skipped slots out. */
	banSlotsDone: number;
	localPlayerCellId: number;
	timerPhase: string;
	secondsLeft: number;
}

function parseChampSelectMember(raw: LcuChampSelectMemberWire | undefined): ChampSelectMember {
	const r = raw ?? {};
	return {
		cellId: typeof r.cellId === "number" ? r.cellId : 0,
		championId: typeof r.championId === "number" ? r.championId : 0,
		championPickIntent: typeof r.championPickIntent === "number" ? r.championPickIntent : 0,
		assignedPosition: typeof r.assignedPosition === "string" ? r.assignedPosition : "",
		spell1Id: typeof r.spell1Id === "number" ? r.spell1Id : 0,
		spell2Id: typeof r.spell2Id === "number" ? r.spell2Id : 0,
	};
}

/** `undefined` covers both "client closed" and an unreachable/malformed session — never throws. */
export async function readChampSelect(client: LcuClient): Promise<ChampSelectState | undefined> {
	try {
		const json = await client.get("/lol-champ-select/v1/session");
		if (!json) return undefined;
		const myTeam = Array.isArray(json.myTeam) ? json.myTeam.map(parseChampSelectMember) : [];
		const theirTeam = Array.isArray(json.theirTeam) ? json.theirTeam.map(parseChampSelectMember) : [];
		const rounds = Array.isArray(json.actions) ? json.actions : [];
		const actions = rounds.flatMap((round) => (Array.isArray(round) ? round : []));
		const banActions = actions.filter((action) => action?.type === "ban");
		const bans: ChampSelectBan[] = banActions
			.filter((action) => action.completed === true && typeof action.championId === "number" && action.championId > 0)
			.map((action) => ({ championId: action.championId as number, isAllyBan: action.isAllyAction === true }));
		const timer = json.timer ?? {};
		return {
			kind: "champSelect",
			myTeam,
			theirTeam,
			bans,
			banSlotsTotal: banActions.length,
			banSlotsDone: banActions.filter((action) => action.completed === true).length,
			localPlayerCellId: typeof json.localPlayerCellId === "number" ? json.localPlayerCellId : 0,
			timerPhase: typeof timer.phase === "string" ? timer.phase : "",
			secondsLeft: typeof timer.adjustedTimeLeftInPhase === "number" ? Math.max(0, Math.round(timer.adjustedTimeLeftInPhase / 1000)) : 0,
		};
	} catch {
		// Left unlogged, deliberately: polled every 2s for the whole of champ select (AGENTS.md rule 3), same
		// every-poll reasoning as readRecentResults above; readComposition's own command-time call shares it.
		return undefined;
	}
}

/** Champion id → display name, keyed the way the champ-select session reports picks and bans. */
export type ChampionNames = ReadonlyMap<number, string>;

const DATA_DRAGON_BASE = "https://ddragon.leagueoflegends.com";
const championNamesCache = new Map<string, Promise<ChampionNames>>();

/**
 * Data Dragon's champion list for the latest patch, fetched once per process per base URL. A failed
 * fetch resolves to an empty map (labels fall back to `Champion <id>`) and is retried on the next call.
 */
export function loadChampionNames(fetchImpl: typeof fetch = fetch, base = DATA_DRAGON_BASE): Promise<ChampionNames> {
	let pending = championNamesCache.get(base);
	if (!pending) {
		pending = (async () => {
			const versions = (await (await fetchImpl(`${base}/api/versions.json`)).json()) as string[];
			const data = (await (await fetchImpl(`${base}/cdn/${versions[0]}/data/en_US/champion.json`)).json()) as { data?: Record<string, { key?: string; name?: string }> };
			return new Map(Object.values(data.data ?? {}).map((champion) => [Number(champion.key), String(champion.name ?? "")]));
		})().catch((error) => {
			logEvent("warn", "lcu", "champion-names-failed", { base }, error);
			championNamesCache.delete(base);
			return new Map<number, string>();
		});
		championNamesCache.set(base, pending);
	}
	return pending;
}

/** Item id → built gold cost (`gold.total`, 0 for a consumed item) and whether the Live Client `count` is copies (`stacks` above 1) rather than charges. Absent from the map means unknown. */
export type ItemPrices = ReadonlyMap<number, { gold: number; stackable: boolean }>;

const itemPricesCache = new Map<string, Promise<ItemPrices>>();

/** Data Dragon's item prices for the latest patch, fetched once per process per base URL. A failed fetch resolves to an empty map (no gold lead is stated) and is retried on the next call. */
export function loadItemPrices(fetchImpl: typeof fetch = fetch, base = DATA_DRAGON_BASE): Promise<ItemPrices> {
	let pending = itemPricesCache.get(base);
	if (!pending) {
		pending = (async () => {
			const versions = (await (await fetchImpl(`${base}/api/versions.json`)).json()) as string[];
			const data = (await (await fetchImpl(`${base}/cdn/${versions[0]}/data/en_US/item.json`)).json()) as { data?: Record<string, { gold?: { total?: number }; consumed?: boolean; stacks?: number }> };
			return new Map(
				Object.entries(data.data ?? {})
					.filter(([, item]) => typeof item?.gold?.total === "number")
					.map(([id, item]) => [Number(id), { gold: item.consumed === true ? 0 : (item.gold?.total as number), stackable: (item.stacks ?? 0) > 1 }] as const),
			);
		})().catch((error) => {
			logEvent("warn", "lcu", "item-prices-failed", { base }, error);
			itemPricesCache.delete(base);
			return new Map() as ItemPrices;
		});
		itemPricesCache.set(base, pending);
	}
	return pending;
}

function championLabel(championId: number, names?: ChampionNames): string | undefined {
	return championId > 0 ? (names?.get(championId) ?? `Champion ${championId}`) : undefined;
}

function effectiveChampionId(member: ChampSelectMember): number {
	return member.championId > 0 ? member.championId : member.championPickIntent;
}

/** LCU position → championRoles.json lane key. */
const LANE_KEYS: Readonly<Record<string, string>> = { top: "top", jungle: "jungle", middle: "middle", bottom: "bottom", utility: "support" };

/** championRoles.json lane key → the word coach.yaml prompts use for it (the only mapping to that word; reused for both the LCU position and the champion-primary-lane fallback). */
export const LANE_WORDS: Readonly<Record<string, string>> = { top: "top", jungle: "jungle", middle: "mid", bottom: "bot", support: "support" };

export function laneRate(championId: number, position: string): number {
	const lane = LANE_KEYS[position.toLowerCase()];
	return (lane && CHAMPION_ROLES.roles[String(championId)]?.[lane]) || 0;
}

/** LCU `assignedPosition` → the coaching lane word ("mid", not "middle"); undefined for an unassigned or unrecognized position. */
export function lanePositionWord(position: string): string | undefined {
	const lane = LANE_KEYS[position.toLowerCase()];
	return lane ? LANE_WORDS[lane] : undefined;
}

/** The champion's most-played lane as a championRoles.json key (e.g. "middle"), or undefined when the id has no data or every lane sits at 0. */
export function primaryLane(championId: number): string | undefined {
	const roles = CHAMPION_ROLES.roles[String(championId)];
	if (!roles) return undefined;
	const best = Object.entries(roles).sort((a, b) => b[1] - a[1])[0];
	return best && best[1] > 0 ? best[0] : undefined;
}

/** championRoles.json lane key → LCU position, in lane order. */
const LANE_POSITIONS: Readonly<Record<string, string>> = { top: "TOP", jungle: "JUNGLE", middle: "MIDDLE", bottom: "BOTTOM", support: "UTILITY" };

/**
 * Each champion's LCU position under the one-lane-each assignment with the highest summed play rate
 * (ranked champ select never shows enemy roles). Positions already taken are skipped; ids with no role data
 * still get a lane, the one left over. Brute force: at most 5! assignments.
 */
export function inferPositions(championIds: readonly number[], taken: readonly string[] = []): Map<number, string> {
	const lanes = Object.keys(LANE_POSITIONS).filter((lane) => !taken.includes(LANE_POSITIONS[lane]));
	let best: { score: number; lanes: string[] } = { score: -1, lanes: [] };
	const walk = (index: number, used: string[], score: number) => {
		if (index === championIds.length) {
			if (score > best.score) best = { score, lanes: [...used] };
			return;
		}
		for (const lane of lanes) if (!used.includes(lane)) walk(index + 1, [...used, lane], score + (CHAMPION_ROLES.roles[String(championIds[index])]?.[lane] ?? 0));
	};
	walk(0, [], 0);
	return new Map(best.lanes.map((lane, index) => [championIds[index], LANE_POSITIONS[lane]]));
}

/** A guess needs every enemy locked and a best candidate this likely to play the lane; below that the command asks for a name. */
const LANE_GUESS_MIN_RATE = 0.2;
const TEAM_SIZE = 5;

/**
 * The enemy pick in the player's own assigned role: by `assignedPosition` when the session carries one for the
 * enemy, else, once all five enemies are locked, the pick with the highest play rate in that lane (at least
 * `LANE_GUESS_MIN_RATE`), marked as a guess. `undefined` when the player has no assigned role (e.g. blind pick),
 * the enemy draft is still open, or no pick clears the floor.
 */
export function deriveEnemyLaner(state: ChampSelectState, names?: ChampionNames): string | undefined {
	const self = state.myTeam.find((member) => member.cellId === state.localPlayerCellId);
	if (!self?.assignedPosition) return undefined;
	const assigned = state.theirTeam.find((member) => member.assignedPosition === self.assignedPosition);
	if (assigned) return championLabel(effectiveChampionId(assigned), names);
	if (state.theirTeam.length !== TEAM_SIZE || state.theirTeam.some((member) => member.championId <= 0)) return undefined;
	const guess = [...inferPositions(state.theirTeam.map((member) => member.championId))].find(([, position]) => position === self.assignedPosition.toUpperCase())?.[0];
	return guess && laneRate(guess, self.assignedPosition) >= LANE_GUESS_MIN_RATE ? `${championLabel(guess, names)} (guessed by lane rate)` : undefined;
}

function champSelectMemberLine(member: ChampSelectMember, isSelf: boolean, names?: ChampionNames, position = member.assignedPosition): string {
	const role = position ? `${position.toUpperCase()} ` : "";
	const pick = championLabel(effectiveChampionId(member), names) ?? "open";
	// Only the player's own hover is marked, so no command reads it as a final pick. Allies and enemies print as before.
	const hovering = member.championId <= 0 && member.championPickIntent > 0;
	return `${role}${pick}${isSelf ? (hovering ? " (you, hovering)" : " (you)") : ""}`;
}

/**
 * Enemy positions by cell: the session's when it has them, else inferred from lane play rates over the locked picks.
 * An inferred lane the champion rarely plays (below `LANE_GUESS_MIN_RATE`) is `unsure`: an off-role pick, shown with "?".
 */
function enemyPositions(state: ChampSelectState): { positions: Map<number, string>; unsure: Set<number>; guessed: boolean } {
	const shown = state.theirTeam.filter((member) => member.assignedPosition);
	const hidden = state.theirTeam.filter((member) => !member.assignedPosition && member.championId > 0);
	const positions = new Map(shown.map((member) => [member.cellId, member.assignedPosition.toUpperCase()]));
	const inferred = inferPositions(hidden.map((member) => member.championId), [...positions.values()]);
	for (const member of hidden) positions.set(member.cellId, inferred.get(member.championId) ?? "");
	const unsure = new Set(hidden.filter((member) => laneRate(member.championId, positions.get(member.cellId)!) < LANE_GUESS_MIN_RATE).map((member) => member.cellId));
	return { positions, unsure, guessed: hidden.length > 0 };
}

function formatChampSelect(state: ChampSelectState, names?: ChampionNames): Composition {
	const self = state.myTeam.find((member) => member.cellId === state.localPlayerCellId);
	const mine = state.myTeam.map((member) => champSelectMemberLine(member, member.cellId === state.localPlayerCellId, names)).join(", ") || "none yet";
	const enemy = enemyPositions(state);
	const theirs = state.theirTeam.map((member) => champSelectMemberLine(member, false, names, `${enemy.positions.get(member.cellId) ?? ""}${enemy.unsure.has(member.cellId) ? "?" : ""}`)).join(", ") || "none yet";
	const lanes = state.myTeam
		.filter((member) => member.assignedPosition && effectiveChampionId(member) > 0)
		.map((member) => {
			const position = member.assignedPosition.toUpperCase();
			const opponent = state.theirTeam.find((other) => enemy.positions.get(other.cellId) === position);
			// An enemy who has not picked yet is no opponent to name: /pick reads a missing pairing as "not known yet", and "open" would read as a champion.
			const foe = opponent && championLabel(effectiveChampionId(opponent), names);
			return foe && `${position} ${championLabel(effectiveChampionId(member), names)} vs ${foe}${enemy.unsure.has(opponent.cellId) ? "?" : ""}`;
		})
		.filter((line): line is string => !!line);
	const bansOf = (ally: boolean) =>
		state.bans
			.filter((ban) => ban.isAllyBan === ally)
			.map((ban) => championLabel(ban.championId, names))
			.filter((label): label is string => !!label)
			.join(", ") || "none";
	const enemyLaner = deriveEnemyLaner(state, names);
	const text = [
		`Champ select, ${state.secondsLeft}s left in phase.`,
		`Your team: ${mine}`,
		`Enemy team${enemy.guessed ? " (roles guessed from lane play rates)" : ""}: ${theirs}`,
		...(lanes.length ? [`Lanes: ${lanes.join("; ")}`] : []),
		`Bans — yours: ${bansOf(true)}; theirs: ${bansOf(false)}`,
		// /comp reads only this text, so the lane opponent is written here or the model calls it an assumption.
		...(enemyLaner ? [`Your lane opponent: ${enemyLaner}`] : []),
	].join("\n");
	const selfChampion = self && effectiveChampionId(self) > 0 ? championLabel(effectiveChampionId(self), names) : undefined;
	return { text, enemyLaner, selfLane: self?.assignedPosition ? lanePositionWord(self.assignedPosition) : undefined, ...(selfChampion && { selfChampion }), ...((!self || effectiveChampionId(self) <= 0) && { selfOpen: true }) };
}

// --- Live (in-game) data ------------------------------------------------------

/** The fixed Live Client Data port — always this value, never the lockfile port. */
const LIVE_CLIENT_PORT = 2999;

export interface LiveGamePlayer {
	championName: string;
	team: string;
	position: string;
	level: number;
	isDead: boolean;
	respawnTimer: number;
	kills: number;
	deaths: number;
	assists: number;
	creepScore: number;
	wardScore: number;
	riotIdGameName: string;
	keystone: string;
	summonerSpells: string[];
	/** Item names in slot order, trinket (slot 6) excluded. */
	items: string[];
	/** The same items as Data Dragon ids with their stack sizes, for pricing. An item the feed gives no id for has none, so its price is unknown. */
	itemStacks: { id: number | undefined; count: number }[];
}

/** One objective event, attributed to the team that took it (undefined when the killer isn't a listed player). */
export interface LiveObjective {
	kind: "dragon" | "baron" | "herald" | "turret" | "inhibitor";
	timeSec: number;
	team?: string;
	/** Dragon type for dragons ("Earth", "Elder"). */
	detail?: string;
}

/** One champion kill from the event log; names are the feed's player names (a tower or monster name when no champion got the kill). */
export interface LiveKill {
	timeSec: number;
	killer: string;
	victim: string;
	assisters: string[];
}

export interface LiveGameState {
	kind: "liveGame";
	gameTimeSec: number;
	players: LiveGamePlayer[];
	/** The active player's game name, the way the event feed writes it: whose deaths the kill log holds. Two players can share it. */
	selfName: string;
	/** The active player's row in `players`, matched on name and tag by `findSelf`; -1 when no row is theirs. */
	selfIndex: number;
	/** Unspent gold — present only for the active player. The Live Client Data feed has no enemy-gold field; this is the only gold field on the whole shape. */
	selfGold?: number;
	/** Active player's current health as a percent, when the feed carries championStats. */
	selfHealthPct?: number;
	/** The active player's rune page in the build format's groups (primary tree, secondary tree, shards), when the feed carries it. */
	selfRunes?: string[][];
	/** The active player's ability ranks ("Q 5, W 3, E 5, R 3"), when the feed carries them. */
	selfSkills?: string;
	/** The rift's element, once it has one. */
	terrain?: string;
	objectives: LiveObjective[];
	kills: LiveKill[];
}

/** A player's game name the way the event feed writes it (`KillerName`, `VictimName`): no tag. `summonerName`, the fallback when `riotIdGameName` is empty, can be "Name#Tag". */
function liveGameName(raw: { riotIdGameName?: string; summonerName?: string } | undefined): string {
	const name = typeof raw?.riotIdGameName === "string" && raw.riotIdGameName ? raw.riotIdGameName : typeof raw?.summonerName === "string" ? raw.summonerName : "";
	return name.split("#")[0];
}

type LiveIdentityWire = { riotId?: string; riotIdGameName?: string; riotIdTagLine?: string; summonerName?: string };

/** A player's tag, when the feed carries one: `riotIdTagLine`, else what follows "#" in a name field. Compared in `findSelf` and kept nowhere. */
function liveTagLine(raw: LiveIdentityWire | undefined): string {
	if (typeof raw?.riotIdTagLine === "string" && raw.riotIdTagLine) return raw.riotIdTagLine;
	const full = [raw?.riotId, raw?.riotIdGameName, raw?.summonerName].find((id) => typeof id === "string" && id.includes("#"));
	return full ? full.slice(full.indexOf("#") + 1) : "";
}

/**
 * The active player's row in `allPlayers`. Two players can share a game name, so the tag decides: a row with the same name and the same tag,
 * else the first row with the same name where the row or the active player carries no tag. A row with another tag is another player. -1 when none.
 */
function findSelf(active: LiveIdentityWire | undefined, all: (LiveIdentityWire | undefined)[]): number {
	const name = liveGameName(active);
	if (!name) return -1;
	const tag = liveTagLine(active);
	const rows = all.map((raw, index) => ({ index, name: liveGameName(raw), tag: liveTagLine(raw) })).filter((row) => row.name === name);
	return ((tag && rows.find((row) => row.tag === tag)) || rows.find((row) => !tag || !row.tag))?.index ?? -1;
}

function parseLivePlayer(raw: LiveClientPlayerWire | undefined): LiveGamePlayer {
	const r = raw ?? {};
	const scores = r.scores ?? {};
	const summonerSpells = [r.summonerSpells?.summonerSpellOne?.displayName, r.summonerSpells?.summonerSpellTwo?.displayName].filter(
		(name): name is string => typeof name === "string" && name.length > 0,
	);
	const heldItems = (Array.isArray(r.items) ? r.items : []).filter((item) => item && item.slot !== 6 && typeof item.displayName === "string" && item.displayName);
	return {
		championName: typeof r.championName === "string" ? r.championName : "",
		team: typeof r.team === "string" ? r.team : "",
		position: typeof r.position === "string" ? r.position : "",
		level: typeof r.level === "number" ? r.level : 0,
		isDead: r.isDead === true,
		respawnTimer: typeof r.respawnTimer === "number" ? r.respawnTimer : 0,
		kills: typeof scores.kills === "number" ? scores.kills : 0,
		deaths: typeof scores.deaths === "number" ? scores.deaths : 0,
		assists: typeof scores.assists === "number" ? scores.assists : 0,
		creepScore: typeof scores.creepScore === "number" ? scores.creepScore : 0,
		wardScore: typeof scores.wardScore === "number" ? scores.wardScore : 0,
		riotIdGameName: liveGameName(r),
		keystone: typeof r.runes?.keystone?.displayName === "string" ? r.runes.keystone.displayName : "",
		summonerSpells,
		items: heldItems
			.map((item) => (typeof item.count === "number" && item.count > 1 ? `${item.displayName} x${item.count}` : String(item.displayName))),
		itemStacks: heldItems.map((item) => ({ id: typeof item.itemID === "number" ? item.itemID : undefined, count: typeof item.count === "number" && item.count > 1 ? item.count : 1 })),
	};
}

const OBJECTIVE_EVENTS: Record<string, LiveObjective["kind"]> = { DragonKill: "dragon", BaronKill: "baron", HeraldKill: "herald", TurretKilled: "turret", InhibKilled: "inhibitor" };

/** Turret and inhibitor names carry the owner (`Turret_T1_…`, `Barracks_T1_…` belong to ORDER), so the taker is the other side; other objectives use the killer's team. */
function parseObjectives(events: LiveClientEventWire[] | undefined, players: LiveGamePlayer[]): LiveObjective[] {
	// The feed names a killer without the tag, so a name shared across the two teams names neither.
	const teamOf = (name: unknown) => {
		const teams = new Set(players.filter((player) => player.riotIdGameName === name).map((player) => player.team));
		return teams.size === 1 ? [...teams][0] : undefined;
	};
	return (Array.isArray(events) ? events : []).flatMap((event): LiveObjective[] => {
		const kind = OBJECTIVE_EVENTS[String(event?.EventName)];
		if (!kind) return [];
		const structure = kind === "turret" ? event.TurretKilled : kind === "inhibitor" ? event.InhibKilled : undefined;
		const owner = structure?.includes("_T1_") ? "ORDER" : structure?.includes("_T2_") ? "CHAOS" : undefined;
		const team = owner ? (owner === "ORDER" ? "CHAOS" : "ORDER") : teamOf(event.KillerName);
		return [{ kind, timeSec: typeof event.EventTime === "number" ? event.EventTime : 0, ...(team ? { team } : {}), ...(kind === "dragon" && typeof event.DragonType === "string" ? { detail: event.DragonType } : {}) }];
	});
}

function parseKills(events: LiveClientEventWire[] | undefined): LiveKill[] {
	return (Array.isArray(events) ? events : []).flatMap((event): LiveKill[] =>
		event?.EventName === "ChampionKill" && typeof event.VictimName === "string" && event.VictimName
			? [{ timeSec: typeof event.EventTime === "number" ? event.EventTime : 0, killer: typeof event.KillerName === "string" ? event.KillerName : "", victim: event.VictimName, assisters: (Array.isArray(event.Assisters) ? event.Assisters : []).filter((name) => typeof name === "string") }]
			: [],
	);
}

/** `undefined` covers "not in a game" (unreachable port, or a body with no players and no clock) — never throws. */
export async function readLiveGame(client: LcuClient): Promise<LiveGameState | undefined> {
	try {
		const json = await client.get("/liveclientdata/allgamedata");
		if (!json) return undefined;
		const players = Array.isArray(json.allPlayers) ? json.allPlayers.map(parseLivePlayer) : [];
		const gameTimeSec = typeof json.gameData?.gameTime === "number" ? json.gameData.gameTime : 0;
		if (!players.length && !gameTimeSec) return undefined;
		const active = json.activePlayer;
		const selfName = liveGameName(active);
		const selfIndex = findSelf(active, Array.isArray(json.allPlayers) ? json.allPlayers : []);
		const selfGold = typeof active?.currentGold === "number" ? Math.max(0, Math.round(active.currentGold)) : undefined;
		const stats = active?.championStats;
		const selfHealthPct = typeof stats?.currentHealth === "number" && typeof stats?.maxHealth === "number" && stats.maxHealth > 0 ? Math.round((100 * stats.currentHealth) / stats.maxHealth) : undefined;
		const runeNames = (Array.isArray(active?.fullRunes?.generalRunes) ? active.fullRunes.generalRunes : []).map((rune) => rune?.displayName).filter((name): name is string => typeof name === "string" && name.length > 0);
		const shards = (Array.isArray(active?.fullRunes?.statRunes) ? active.fullRunes.statRunes : []).filter((shard) => typeof shard?.id === "number").map((shard) => statShardName(shard.id));
		const selfRunes = runeNames.length ? [runeNames.slice(0, 4), runeNames.slice(4), shards].filter((group) => group.length) : undefined;
		const selfSkills = (["Q", "W", "E", "R"] as const)
			.flatMap((key) => {
				const rank = active?.abilities?.[key]?.abilityLevel;
				return typeof rank === "number" ? [`${key} ${rank}`] : [];
			})
			.join(", ");
		const terrain = typeof json.gameData?.mapTerrain === "string" && json.gameData.mapTerrain !== "Default" ? json.gameData.mapTerrain : undefined;
		return { kind: "liveGame", gameTimeSec, players, selfName, selfIndex, selfGold, selfHealthPct, ...(selfRunes && { selfRunes }), ...(selfSkills && { selfSkills }), ...(terrain && { terrain }), objectives: parseObjectives(json.events?.Events, players), kills: parseKills(json.events?.Events) };
	} catch {
		// Left unlogged, deliberately: polled every 2-5s for a whole live game, same every-poll reasoning as
		// readRecentResults above; readComposition's own command-time call shares it.
		return undefined;
	}
}

function clock(sec: number): string {
	return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

function formatLiveGame(state: LiveGameState, prices?: ItemPrices): Composition {
	const self: LiveGamePlayer | undefined = state.players[state.selfIndex];
	const myTeam = self?.team ?? "";
	const enemyTeam = myTeam === "ORDER" ? "CHAOS" : myTeam === "CHAOS" ? "ORDER" : "";
	// Everyone else's keystone and summoner spells ride their row; the player's own are on the runes line.
	const loadout = (player: LiveGamePlayer) => {
		const names = player === self ? [] : [player.keystone, ...player.summonerSpells].filter(Boolean);
		return names.length ? ` [${names.join(", ")}]` : "";
	};
	const dead = (player: LiveGamePlayer) => (!player.isDead ? "" : player.respawnTimer > 0 ? ` (dead ${Math.ceil(player.respawnTimer)}s)` : " (dead)");
	const rosterOf = (team: string) =>
		state.players
			.filter((player) => player.team === team)
			.map((player) => `${player.championName} ${player.position || "?"} lvl ${player.level} ${player.kills}/${player.deaths}/${player.assists} ${player.creepScore} cs${dead(player)}${player === self ? " (you)" : ""}${loadout(player)}: ${player.items.join(", ") || "no items"}`)
			.join("\n  ") || "none";
	const side = (team?: string) => (team === myTeam ? "yours" : team === enemyTeam ? "theirs" : "?");
	// Every event time comes with how long ago it was, so a timer (a respawn, a buff running out) is one subtraction for the model, not two.
	// An event ahead of the clock (spectator delay, or an event log newer than the time read) gets no "ago": "0:00 ago" would be made up.
	const when = (timeSec: number) => (timeSec > state.gameTimeSec ? clock(timeSec) : `${clock(timeSec)} (${clock(state.gameTimeSec - timeSec)} ago)`);
	const dragonsOf = (team: string) => state.objectives.filter((objective) => objective.kind === "dragon" && objective.team === team).map((dragon) => dragon.detail ?? "?");
	const taken = (kind: LiveObjective["kind"], team: string) => state.objectives.filter((objective) => objective.kind === kind && objective.team === team).length;
	const last = (kind: LiveObjective["kind"]) => state.objectives.filter((objective) => objective.kind === kind).at(-1);
	const drake = last("dragon");
	const inhibitor = last("inhibitor");
	const baron = last("baron");
	const herald = last("herald");
	const objectives = [
		`drakes yours ${dragonsOf(myTeam).join("/") || "0"}, theirs ${dragonsOf(enemyTeam).join("/") || "0"}`,
		drake && `last drake at ${when(drake.timeSec)}`,
		state.terrain && `rift ${state.terrain}`,
		`towers taken yours ${taken("turret", myTeam)}, theirs ${taken("turret", enemyTeam)}`,
		inhibitor && `inhibitors taken yours ${taken("inhibitor", myTeam)}, theirs ${taken("inhibitor", enemyTeam)}, last at ${when(inhibitor.timeSec)}`,
		baron && `baron ${side(baron.team)} at ${when(baron.timeSec)}`,
		herald && `herald ${side(herald.team)} at ${when(herald.timeSec)}`,
	].filter(Boolean);
	const teamKills = (team: string) => state.players.filter((player) => player.team === team).reduce((sum, player) => sum + player.kills, 0);
	const kills = myTeam ? `Kills: yours ${teamKills(myTeam)}, theirs ${teamKills(enemyTeam)}.` : undefined;
	const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
	// A lane is one of the five the feed names. ARAM and other queues report "NONE" or "" for every player, and two enemies in one position is no lane either.
	const selfLane = self ? lanePositionWord(self.position) : undefined;
	const inLane = self && selfLane ? state.players.filter((player) => player.team === enemyTeam && player.position === self.position) : [];
	const laner = inLane.length === 1 ? inLane[0] : undefined;
	// Item cost only, from Data Dragon (no unspent gold, components at their built price). Unknown when any held item has no price: a partial sum would read as a lead.
	const itemGold = (player: LiveGamePlayer) => {
		let total = 0;
		for (const { id, count } of player.itemStacks) {
			const price = id === undefined ? undefined : prices?.get(id);
			if (price === undefined) return undefined;
			total += price.gold * (price.stackable ? count : 1);
		}
		return total;
	};
	const [mine, theirs] = self && laner ? [itemGold(self), itemGold(laner)] : [];
	const hasGold = mine !== undefined && theirs !== undefined;
	const lead = hasGold ? mine - theirs : 0;
	// A level of 0 is a field the feed left out (parseLivePlayer's default), not a level: no level or cs lead is worked out from it.
	const leads = self && laner ? [...(self.level > 0 && laner.level > 0 ? [`${signed(self.level - laner.level)} level`, `${signed(self.creepScore - laner.creepScore)} cs`] : []), ...(hasGold ? [`${lead >= 0 ? "+" : ""}${lead} gold`] : [])] : [];
	const lane = laner ? `Your lane opponent: ${laner.championName}${leads.length ? `; you are ${leads.join(", ")} on them` : ""}${hasGold ? ` (item gold ${mine} vs ${theirs})` : ""}.` : undefined;
	// Who has been killing the player, most often first, and the latest death with who was there: the threat named from the game, not guessed.
	const named = (name: string) => (name ? state.players.filter((player) => player.riotIdGameName === name) : []);
	const championOf = (name: string) => named(name)[0]?.championName ?? "a tower or monster";
	const selfDeaths = state.selfName ? state.kills.filter((kill) => kill.victim === state.selfName) : [];
	const killers = new Map<string, number>();
	for (const kill of selfDeaths) killers.set(championOf(kill.killer), (killers.get(championOf(kill.killer)) ?? 0) + 1);
	const lastDeath = selfDeaths.at(-1);
	// Only players assist: a minion or tower name among the assisters is dropped, and a champion is named once.
	const assisters = [...new Set((lastDeath?.assisters ?? []).flatMap((name) => named(name).slice(0, 1).map((player) => player.championName)))];
	// The event feed names players without their tag, so a name two players share cannot be told apart: no line, rather than one player's deaths on another.
	const sharedName = [state.selfName, ...selfDeaths.map((kill) => kill.killer), ...(lastDeath?.assisters ?? [])].some((name) => named(name).length > 1);
	const deaths = lastDeath && !sharedName
		? `Your deaths: ${[...killers].sort((a, b) => b[1] - a[1]).map(([champion, count]) => `${champion} ${count}`).join(", ")}; last at ${when(lastDeath.timeSec)} to ${championOf(lastDeath.killer)}${assisters.length ? ` with ${assisters.join(", ")}` : ""}.`
		: undefined;
	// Self gold and health only — the feed has no enemy-gold field to state even if we wanted to (spec §5).
	const gold = state.selfGold === undefined ? "" : ` Your gold: ${state.selfGold}.`;
	const health = state.selfHealthPct === undefined ? "" : ` Your health: ${state.selfHealthPct}%.`;
	// The page as taken, in the build format's order (summoners last), so a question about my runes is answered from it, never asked back.
	const runeGroups = state.selfRunes ? [...state.selfRunes, self?.summonerSpells ?? []].filter((group) => group.length) : [];
	const runes = runeGroups.length ? `Your runes: ${runeGroups.map((group) => group.join(", ")).join("; ")}.` : undefined;
	const skills = state.selfSkills ? `Your skill ranks: ${state.selfSkills}.` : undefined;
	// The feed reads 0:00 with 0 gold through the loading screen: said outright, so the zeros below read as the start, not the game.
	const loading = state.gameTimeSec === 0 ? " Loading screen: the game has not started, so every number below is the starting state." : "";
	const text = [`In game, ${clock(state.gameTimeSec)}.${loading}${gold}${health}`, runes, skills, kills, `Objectives: ${objectives.join("; ")}.`, lane, deaths, `Your team:\n  ${rosterOf(myTeam)}`, `Enemy team:\n  ${rosterOf(enemyTeam)}`].filter(Boolean).join("\n");
	const enemyLaner = laner?.championName;
	return { text, inGame: true, ...(enemyLaner ? { enemyLaner } : {}), ...(selfLane ? { selfLane } : {}), ...(self?.championName && { selfChampion: self.championName }) };
}

// --- Composition (compact text block for a command's user message) ----------

export interface Composition {
	text: string;
	/** A running game, not a draft: only this is attached to a plain question. */
	inGame?: boolean;
	/** The enemy pick sharing the player's own assigned role, undefined when roles aren't assigned yet. */
	enemyLaner?: string;
	/** The coaching lane word for the player's own assigned role ("mid", not "middle"); undefined before a role is assigned or for an unrecognized position. */
	selfLane?: string;
	/** The player's own champion (locked, hovered, or in game): what a routed command plans for when no main is set. */
	selfChampion?: string;
	/** Champ select only: the player's own slot has neither a lock nor a hover, so there is no pick to call. */
	selfOpen?: boolean;
}

/** Live-game rows already carry champion names; champ select only has ids, so `names` resolves those. */
export function formatComposition(state: ChampSelectState | LiveGameState, names?: ChampionNames, prices?: ItemPrices): Composition {
	return state.kind === "champSelect" ? formatChampSelect(state, names) : formatLiveGame(state, prices);
}

// --- Footer poller -----------------------------------------------------------

/**
 * `closed` covers: no lockfile, an unreachable client, a gameflow phase with nothing to show
 * (matchmaking, reconnecting, …), and unranked or in-placements (owner decision: no row until
 * placed).
 */
export type LcuFooterState =
	/** `reason` only when a client was found (lockfile present) but could not be read: the header shows it, so nobody has to probe by hand. */
	| { kind: "closed"; reason?: string }
	| { kind: "lobby"; summoner: Summoner; rank: RankedSolo; /** Newest first, true = win; empty when history is unavailable. */ recent: boolean[] }
	| {
			kind: "champSelect";
			summoner?: Summoner;
			secondsLeft: number;
			selfPosition?: string;
			picksMade: number;
			picksTotal: number;
			bansMade: number;
			bansTotal: number;
			/** Set once the player and at least four enemies have locked: both rosters' locked ids, so the fifth lock or a swap reads as a new key. */
			lockedDraft?: string;
			/** The player's own slot this poll: a lock, or the champion hovered. Absent while the slot is open. `pickKey` is derived from two consecutive ones. */
			selfPick?: SelfPick;
			/** Set when the pick call is due: a lock, or a hover seen on this poll and the one before. Keyed by champion, so a lock after that hover keeps the key. */
			pickKey?: string;
		}
	| { kind: "liveGame"; summoner?: Summoner; gameTimeSec: number; self?: Pick<LiveGamePlayer, "championName" | "position" | "kills" | "deaths" | "assists" | "creepScore" | "level"> };

/** The signed-in player's `Name#TAG` from any open-client state; undefined while the client is closed. */
export function lcuPlayerName(state: LcuFooterState | undefined): string | undefined {
	const summoner = state && state.kind !== "closed" ? state.summoner : undefined;
	return summoner && `${summoner.gameName}#${summoner.tagLine}`;
}

function champSelectFooterState(state: ChampSelectState): LcuFooterState {
	const self = state.myTeam.find((member) => member.cellId === state.localPlayerCellId);
	const allMembers = [...state.myTeam, ...state.theirTeam];
	const lockedDraft = lockedDraftKey(state);
	const selfPick = selfPickOf(state);
	return {
		kind: "champSelect",
		secondsLeft: state.secondsLeft,
		selfPosition: self?.assignedPosition || undefined,
		picksMade: allMembers.filter((member) => member.championId > 0).length,
		picksTotal: allMembers.length,
		bansMade: state.banSlotsDone,
		bansTotal: state.banSlotsTotal,
		...(lockedDraft && { lockedDraft }),
		...(selfPick && { selfPick }),
	};
}

/** The player's own champion in one champ-select read: locked, or the pick intent shown as a hover. */
export interface SelfPick {
	championId: number;
	locked: boolean;
}

export function selfPickOf(state: ChampSelectState): SelfPick | undefined {
	const self = state.myTeam.find((member) => member.cellId === state.localPlayerCellId);
	if (!self) return undefined;
	if (self.championId > 0) return { championId: self.championId, locked: true };
	return self.championPickIntent > 0 ? { championId: self.championPickIntent, locked: false } : undefined;
}

/**
 * The pick call's key from two consecutive reads: a lock fires at once, a hover only when the same champion was
 * already there on the previous read, a flick across champions never. Keyed by champion alone, so locking the
 * champion advised on as a hover is the same key.
 */
export function pickKey(previous: SelfPick | undefined, current: SelfPick | undefined): string | undefined {
	if (!current) return undefined;
	return current.locked || previous?.championId === current.championId ? String(current.championId) : undefined;
}

/** `next` with its `pickKey` set from the previous snapshot; any other state, or a previous that was not champ select, settles nothing. */
export function settlePick(previous: LcuFooterState | undefined, next: LcuFooterState): LcuFooterState {
	if (next.kind !== "champSelect") return next;
	const key = pickKey(previous?.kind === "champSelect" ? previous.selfPick : undefined, next.selfPick);
	return key ? { ...next, pickKey: key } : next;
}

/** Enemy locks that make a draft worth a call: four is enough to read the lanes, and it leaves the last pick's time for the answer. */
const LOCKED_DRAFT_MIN_ENEMIES = 4;

/**
 * The player's pick and the enemy's locked ids once the player and at least four enemies have locked; undefined before.
 * Hovers never count, and neither do teammates' locks, so the key moves only on the fifth enemy lock or a swap.
 */
export function lockedDraftKey(state: ChampSelectState): string | undefined {
	const self = state.myTeam.find((member) => member.cellId === state.localPlayerCellId);
	if (!self || self.championId <= 0 || state.theirTeam.filter((member) => member.championId > 0).length < LOCKED_DRAFT_MIN_ENEMIES) return undefined;
	return `${self.championId} vs ${state.theirTeam.map((member) => member.championId).join(",")}`;
}

function liveGameFooterState(state: LiveGameState): LcuFooterState {
	const self: LiveGamePlayer | undefined = state.players[state.selfIndex];
	return {
		kind: "liveGame",
		gameTimeSec: state.gameTimeSec,
		self: self && { championName: self.championName, position: self.position, kills: self.kills, deaths: self.deaths, assists: self.assists, creepScore: self.creepScore, level: self.level },
	};
}

const CLOSED: LcuFooterState = { kind: "closed" };
const LOBBY_PHASES = new Set(["None", "Lobby", "PreEndOfGame", "EndOfGame"]);

/** The cheap phase read gates which richer endpoint(s) get polled, so a closed or idle client costs one request, not several. */
export async function computeLcuFooterState(
	discover: () => Lockfile | undefined = discoverLcu,
	makeClient: (target: LcuTarget) => LcuClient = (target) => new LcuClient(target),
): Promise<LcuFooterState> {
	const lock = discover();
	if (!lock) return CLOSED;
	const client = makeClient({ host: ALLOWED_HOST, port: lock.port, password: lock.password });
	let phase: string;
	try {
		phase = await gameflowPhase(client);
	} catch (error) {
		return { kind: "closed", reason: `League client found on port ${lock.port} but unreadable: ${(error as Error).message}` };
	}
	// The post-game screen shows the lobby row too: that is where the player checks the LP the game just moved.
	if (LOBBY_PHASES.has(phase)) {
		const [summoner, rank, recent] = await Promise.all([readSummoner(client), readRankedSolo(client), readRecentResults(client)]);
		if (!summoner) return { kind: "closed", reason: `League client found on port ${lock.port} but the signed-in summoner is unreadable` };
		return rank ? { kind: "lobby", summoner, rank, recent } : CLOSED; // unranked/placements: no row to show, nothing to fix
	}
	if (phase === "ChampSelect") {
		const [champSelect, summoner] = await Promise.all([readChampSelect(client), readSummoner(client)]);
		return champSelect ? { ...champSelectFooterState(champSelect), ...(summoner && { summoner }) } : CLOSED;
	}
	if (phase === "InProgress" || phase === "WaitingForStats") {
		// Live Client Data is unauthenticated and lives on its own fixed port — never the lockfile port.
		const liveClient = makeClient({ host: ALLOWED_HOST, port: LIVE_CLIENT_PORT, password: "" });
		const [liveGame, summoner] = await Promise.all([readLiveGame(liveClient), readSummoner(client)]);
		return liveGame ? { ...liveGameFooterState(liveGame), ...(summoner && { summoner }) } : CLOSED;
	}
	return CLOSED;
}

// ponytail: fixed timeout, not a retry/backoff policy — a stuck client should degrade instantly, not delay the command further.
const LCU_COMPOSITION_TIMEOUT_MS = 1500;

/**
 * A Data Dragon load gives up on its own, at half the read's budget, so a slow download costs the names or the prices
 * (ids print as `Champion <id>`, the gold clause is left out) and never the draft the client already answered. The
 * load itself keeps running and stays cached for the next call. A plain timer cleared on settle (AGENTS.md rule 8).
 */
async function bounded<T>(load: Promise<T>, fallback: T, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});
	try {
		return await Promise.race([load, late]);
	} catch (error) {
		logEvent("warn", "lcu", "data-dragon-load-failed", {}, error);
		return fallback;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Command-time read: the current draft or live game as a `Composition`, or `undefined` when there's
 * nothing to show (client closed, or a phase with no draft/game — lobby included). Called once per
 * `/comp`, `/matchup`, or `/build` invocation, never on a poll. Bounded by `timeoutMs`: a client that
 * accepts the connection but never answers (stalled TLS handshake, auth hiccup) yields `undefined`
 * instead of hanging the command that awaited this.
 */
export async function readComposition(
	discover: () => Lockfile | undefined = discoverLcu,
	makeClient: (target: LcuTarget) => LcuClient = (target) => new LcuClient(target),
	timeoutMs = LCU_COMPOSITION_TIMEOUT_MS,
	loadNames: () => Promise<ChampionNames> = loadChampionNames,
	loadPrices: () => Promise<ItemPrices> = loadItemPrices,
): Promise<Composition | undefined> {
	const lock = discover();
	if (!lock) return undefined;
	const client = makeClient({ host: ALLOWED_HOST, port: lock.port, password: lock.password });
	const read = (async (): Promise<Composition | undefined> => {
		const phase = await readGameflowPhase(client);
		if (phase === "ChampSelect") {
			const [state, names] = await Promise.all([readChampSelect(client), bounded(loadNames(), new Map(), timeoutMs / 2)]);
			return state && formatComposition(state, names);
		}
		if (phase === "InProgress" || phase === "WaitingForStats") {
			const liveClient = makeClient({ host: ALLOWED_HOST, port: LIVE_CLIENT_PORT, password: "" });
			const [state, prices] = await Promise.all([readLiveGame(liveClient), bounded(loadPrices(), new Map(), timeoutMs / 2)]);
			return state && formatComposition(state, undefined, prices);
		}
		return undefined;
	})();
	// Not unref'd: Bun on Windows never fires a lone unref'd timer, so the race would hang instead of timing out.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs);
	});
	return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

/** What the answer panel shows from a running game: the clock (its phase split) and the player's own items (owned, then the next buy). */
export interface LivePanelFacts {
	gameTimeSec: number;
	ownedItems: string[];
}

/** One bounded read of the live client for the panel at a turn's end; undefined with no game, a failed read, or past `timeoutMs`. */
export async function readLivePanel(makeClient: (target: LcuTarget) => LcuClient = (target) => new LcuClient(target), timeoutMs = LCU_COMPOSITION_TIMEOUT_MS): Promise<LivePanelFacts | undefined> {
	const read = readLiveGame(makeClient({ host: ALLOWED_HOST, port: LIVE_CLIENT_PORT, password: "" })).then((state) =>
		state ? { gameTimeSec: state.gameTimeSec, ownedItems: (state.players[state.selfIndex]?.items ?? []).map((item) => item.replace(/\s+x\d+$/, "")) } : undefined,
	);
	// Not unref'd: Bun on Windows never fires a lone unref'd timer, so the race would hang instead of timing out.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs);
	});
	return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

export interface LcuFooterHandle {
	read(): LcuFooterState;
	stop(): void;
}

// ponytail: fixed 5s poll ceiling (owner decision over a phase-adaptive rate); raise this, not the design, if footer staleness becomes a real complaint.
const LCU_FOOTER_POLL_MS = 5000;

/** Started in `session_start`, stopped in `session_shutdown`. Never throws, never blocks the caller on a poll. */
// ponytail: a fixed faster poll while a draft is open, so an auto /comp starts within 2 s of the last lock.
const LCU_CHAMP_SELECT_POLL_MS = 2000;

export function createLcuFooterState(opts: {
	discover?: () => Lockfile | undefined;
	makeClient?: (target: LcuTarget) => LcuClient;
	intervalMs?: number;
	champSelectIntervalMs?: number;
	/** Called after a poll that changed the snapshot, so the header and footer repaint without waiting for a keypress. */
	onChange?: () => void;
} = {}): LcuFooterHandle {
	let state: LcuFooterState = CLOSED;
	const set = (next: LcuFooterState) => {
		const settled = settlePick(state, next);
		const changed = JSON.stringify(settled) !== JSON.stringify(state);
		state = settled;
		if (changed) opts.onChange?.();
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const tick = () => {
		computeLcuFooterState(opts.discover, opts.makeClient)
			.then(set)
			.catch((error) => {
				// computeLcuFooterState's own documented failures (client closed, an endpoint not ready yet) all
				// resolve, never reject: reaching this catch means something genuinely unanticipated happened.
				logEvent("warn", "lcu", "footer-poll-failed", undefined, error);
				set(CLOSED);
			})
			.finally(() => {
				if (stopped) return;
				timer = setTimeout(tick, state.kind === "champSelect" ? (opts.champSelectIntervalMs ?? LCU_CHAMP_SELECT_POLL_MS) : (opts.intervalMs ?? LCU_FOOTER_POLL_MS));
				timer.unref?.(); // housekeeping only — never keep the process alive for this poll
			});
	};
	tick();
	return {
		read: () => state,
		stop: () => {
			stopped = true;
			clearTimeout(timer);
		},
	};
}

// --- Lab: record and replay ----------------------------------------------------

/** Where the LCU reads come from: the real client, or a recorded frame. Both `readComposition` and the footer take one. */
export interface LcuSource {
	discover: () => Lockfile | undefined;
	makeClient: (target: LcuTarget) => LcuClient;
}

const SESSION_PATH = "/lol-champ-select/v1/session";
const LIVE_PATH = "/liveclientdata/allgamedata";

/** One recorded read: the draft or the live game exactly as the client returned it. */
export interface LcuFrame {
	ts?: string;
	path: typeof SESSION_PATH | typeof LIVE_PATH;
	body: string;
}

/**
 * Frames from an NDJSON file: `{ts, path, body}` lines as `recordingSource` writes them, or bare Live Client Data
 * bodies (one `allgamedata` JSON per line, as the desktop app's `live-client-raw.ndjson` holds them).
 */
export function parseFrames(text: string): LcuFrame[] {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const json = JSON.parse(line);
			return typeof json.path === "string" && typeof json.body === "string" ? (json as LcuFrame) : { path: LIVE_PATH, body: line };
		});
}

/** Answers like a client sitting on `frame` (a frame, or whichever one playback is on): the gameflow phase follows from it, every other endpoint 404s. */
export function replaySource(frame: LcuFrame | (() => LcuFrame)): LcuSource {
	const current = typeof frame === "function" ? frame : () => frame;
	const transport: LcuTransport = async (_target, path) => {
		const now = current();
		if (path === "/lol-gameflow/v1/gameflow-phase") return { status: 200, text: JSON.stringify(now.path === SESSION_PATH ? "ChampSelect" : "InProgress") };
		return path.split("?")[0] === now.path ? { status: 200, text: now.body } : { status: 404, text: "" };
	};
	return { discover: () => ({ port: 1, password: "" }), makeClient: (target) => new LcuClient(target, { transport }) };
}

// ponytail: fixed 30 s floor between live frames (the footer polls every 5 s); a draft frame is kept on every change.
const RECORD_LIVE_EVERY_MS = 30_000;

/** The real client, with every changed draft and a live-game frame every 30 s appended to `file` as it is read. */
export function recordingSource(file: string, now: () => number = Date.now, inner: LcuTransport = httpsTransport): LcuSource {
	let lastSession = "";
	let lastLiveAt = 0;
	const transport: LcuTransport = async (target, path, agent) => {
		const response = await inner(target, path, agent);
		const base = path.split("?")[0];
		const ok = response.status >= 200 && response.status < 300 && response.text;
		const keep = base === SESSION_PATH ? response.text !== lastSession : base === LIVE_PATH && now() - lastLiveAt >= RECORD_LIVE_EVERY_MS;
		if (ok && keep) {
			if (base === SESSION_PATH) lastSession = response.text;
			else lastLiveAt = now();
			appendFileSync(file, `${JSON.stringify({ ts: new Date(now()).toISOString(), path: base, body: response.text })}\n`);
		}
		return response;
	};
	return { discover: discoverLcu, makeClient: (target) => new LcuClient(target, { transport }) };
}

// ponytail: one fixed step per frame, not the recorded timestamps; a draft plays in about half a minute either way.
const REPLAY_STEP_MS = 3000;

/**
 * `VOXREN_LCU_REPLAY=<file>` plays the file's frames in order, one every `VOXREN_LCU_REPLAY_STEP_MS` (default 3 s),
 * then holds the last, so a whole draft runs through the footer and auto /draft with no client. `<file>#index` holds
 * one frame instead (a negative index counts from the end). `VOXREN_LCU_RECORD=<file>` records the real client.
 */
export function lcuSourceFromEnv(environment: Record<string, string | undefined>, now: () => number = Date.now): LcuSource {
	const replay = environment.VOXREN_LCU_REPLAY?.trim();
	if (replay) {
		const [file, index] = replay.split(/#(?=-?\d+$)/);
		const frames = parseFrames(readFileSync(file, "utf8"));
		if (index === undefined) {
			if (!frames.length) throw new Error(`VOXREN_LCU_REPLAY: ${file} has no frames`);
			const step = Number(environment.VOXREN_LCU_REPLAY_STEP_MS) || REPLAY_STEP_MS;
			const start = now();
			return replaySource(() => frames[Math.min(Math.floor((now() - start) / step), frames.length - 1)]);
		}
		const frame = frames.at(Number(index));
		if (!frame) throw new Error(`VOXREN_LCU_REPLAY: ${file} has no frame ${index}`);
		return replaySource(frame);
	}
	const record = environment.VOXREN_LCU_RECORD?.trim();
	return record ? recordingSource(record) : { discover: discoverLcu, makeClient: (target) => new LcuClient(target) };
}
