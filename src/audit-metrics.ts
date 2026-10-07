/**
 * Pure per-match metric extraction for voxren_player_audit.
 *
 * Input is one Riot match-v5 match plus its timeline, already parsed. Output
 * is a compact, model-facing row: no PUUIDs, no other players' identifiers
 * beyond champion names (the lane opponent's, and who was on each death), and
 * no raw payloads.
 */

import { damageLine, deathDamage, type DamageSource, type DeathDamage } from "./death-damage";
import { UNKNOWN_ZONE, laneOf, loadMapZones, zoneOf } from "./map-zones";
import { statShardName } from "./stat-shards";

export interface GameAudit {
	matchId: string;
	patch: string;
	playedAt: string;
	/** The game's start as epoch milliseconds: `playedAt` is a date only, so games on one day need this to keep their order. */
	playedAtMs: number | null;
	durationMin: number;
	win: boolean;
	/**
	 * Ended before it was a game: a remake, or a surrender before minute 15 (only possible after an AFK, since the normal
	 * vote opens at 15:00). Shown in the table, left out of every average. Duration alone never decides this.
	 */
	remake: boolean;
	champion: string;
	position: string;
	opponent: string;
	kills: number;
	deaths: number;
	assists: number;
	/** Deaths before game minute 6, not champion level 6: the one-trick reference counts `diesBefore6Pct` the same way. */
	deathsBefore6: number;
	deathsAt15: number;
	deathsAfter15: number;
	/** Kills and assists by minute 15 (the one-trick reference counts them the same way); the passage says "takedowns". */
	killsAt15: number;
	csAt10: number | null;
	csAt15: number | null;
	goldDiffAt10: number | null;
	goldDiffAt15: number | null;
	level6Min: number | null;
	firstBackMin: number | null;
	keystone: string;
	summoners: string[];
	skillOrder: string;
	skillMax: string;
	itemTimingMin: Record<string, number>;
	finalItems: string[];
	build: GameBuild;
	timeline: GameTimeline;
	play: GamePlay;
}

/** How the game was played beyond lane numbers: the death shapes habits are spotted from, farm and the lead over time, objectives, and macro. */
export interface GamePlay {
	/** Each death in context, capped at CHART_MAX_DEATHS, earliest first: what the coach reads to say what else the player could have done. */
	deaths: DeathMoment[];
	/** Each kill and assist in context, capped at CHART_MAX_KILLS, earliest first: what the coach reads to say where a lead came from. */
	kills: KillMoment[];
	/** My kills plus assists over my team's kills, percent; null when the team got none. */
	killParticipationPct: number | null;
	/** My champion damage over my team's, percent; null when the team dealt none. */
	damageSharePct: number | null;
	visionPerMin: number;
	visionScore: number;
	wardsPlaced: number;
	/** Enemy wards cleared. */
	wardsKilled: number;
	controlWards: number;
	/** Damage to champions, in total and per minute. */
	damageToChampions: number;
	damagePerMin: number;
	/** Damage taken, in total and as a share of my team's, percent; null when the team took none. */
	damageTaken: number;
	damageTakenSharePct: number | null;
	/** Turret plates I took. */
	plates: number;
	/** My team's takes of each objective: [the ones I was on as killer or assist, all of them]. */
	participation: Participation;
	/** Creep score per minute up to minute 15, and from 15 to the end; after-15 is null for a game shorter than 16 minutes. */
	csPerMinTo15: number | null;
	csPerMinAfter15: number | null;
	/** The gold lead over the lane opponent at 20, at its peak (and that minute), and at the end; null without an opponent or that minute. */
	goldDiffAt20: number | null;
	leadPeak: number | null;
	leadPeakMin: number | null;
	leadEnd: number | null;
	/** Epic monsters and towers, my team's count first. */
	objectives: Objectives;
	/** My team's epic monster kills (dragons, Barons, Heralds, grubs, Atakhan) I was on as killer or assist, of all of them. */
	epicTakesOn: number;
	epicTakes: number;
	/** Share of the game spent dead, percent. */
	deadPct: number;
	/** Towers I destroyed or assisted on. */
	turretTakedowns: number;
}

export type Participation = Record<"dragon" | "herald" | "baron" | "tower", [number, number]>;

export interface Objectives {
	dragons: [number, number];
	barons: [number, number];
	heralds: [number, number];
	grubs: [number, number];
	towers: [number, number];
}

export interface DeathMoment {
	min: number;
	/** Where, from the player's side, in data/map-zones.json's words: "own base", "enemy top jungle", "top river", "Baron pit", "mid lane, enemy side", or "unknown" when Riot sent no position. */
	zone: string;
	/** Unspent gold at the minute before; null when that frame is missing. */
	gold: number | null;
	/** Gold ahead (+) or behind (-) the lane opponent at that minute; null without one. */
	lead: number | null;
	afterAllyDeath: boolean;
	traded: boolean;
	/** The enemy jungler was on the kill. */
	jungler: boolean;
	/** What the enemy took within PUNISH_WINDOW_MS after: epic monsters and the player's buildings, in order. */
	enemyTook: string[];
	/** The enemy champions on the kill, the killer first; empty for an execute (a tower, minions, or a monster). */
	killers: string[];
	/**
	 * A death worth taking, never held against the player: the fight around it went the team's way (more enemies than
	 * allies fell near it, this death counted), or the team took an objective after it and lost none.
	 */
	worth: boolean;
	/** More enemies than allies fell in the fight around it, this death counted: why it was worth taking, where it was. */
	wonFight: boolean;
	/** What did the damage and of which type; absent when the kill event carried none. */
	damage?: DeathDamage;
}

export interface KillMoment {
	min: number;
	/** Where the enemy fell, in the same words as a death's zone. */
	zone: string;
	victim: string;
	/** The player landed the kill; false for an assist. */
	mine: boolean;
	/** Allied champions on it besides the player, the killer first when that was not the player. */
	allies: string[];
	/** What the team took within PUNISH_WINDOW_MS after: epic monsters and enemy buildings, in order. */
	teamTook: string[];
}

/** Minute-level shape of one game, for the audit charts and for grounding "why did I die" claims. Capped so one long game cannot blow out the chart payload. */
export interface GameTimeline {
	/** My total gold minus my lane opponent's, one entry per timeline frame (minute), capped at CHART_MAX_MINUTES; empty without an opponent. */
	goldDiff: number[];
	/** Capped at CHART_MAX_DEATHS, earliest first. */
	deaths: DeathMark[];
	/** Minutes of my kills and assists. */
	kills: number[];
}

export interface DeathMark {
	min: number;
	/** Map position, Summoner's Rift units (0..MAP_SIZE). */
	x: number;
	y: number;
	/** A teammate died within ALLY_WINDOW_MS before, within ALLY_RANGE units: the "went in after a lost fight" shape. */
	afterAllyDeath: boolean;
	/** My team took a kill, objective, or tower within TRADE_WINDOW_MS after. */
	traded: boolean;
	/** Who else was around, for the per-death map; absent when Riot sent no place for the death or no frame with positions. */
	scene?: DeathScene;
	/** What did the damage, largest first; absent when the kill event carried none. */
	damage?: DamageSource[];
}

/**
 * The champions around one death. Riot sends the death's own place exactly, and everyone else's only once a minute,
 * so the others come from the frame nearest the death and carry how far off it was: never drawn as the death's instant.
 */
export interface DeathScene {
	/** The enemy champions on the kill, the killer first; empty for an execute. */
	killers: string[];
	/** Seconds from the death to the frame the positions come from: negative when the frame is before it. */
	offsetSec: number;
	/** Every other champion that frame puts inside the SCENE_SPAN square centred on the death, less any killed in the ALLY_WINDOW_MS before it. */
	champions: Array<{ name: string; ally: boolean; x: number; y: number }>;
}

/** Side of the square a per-death map shows, in map units: about a third of the Rift, a lane and the jungle beside it. */
export const SCENE_SPAN = 5_000;

// ponytail: fixed windows chosen by eye (a fight is ~20s, a trade lands within ~30s); tune against real games if the labels misfire.
const ALLY_WINDOW_MS = 20_000;
const ALLY_RANGE = 3_000;
const TRADE_WINDOW_MS = 30_000;
// ponytail: one back's worth of gold.
const HELD_GOLD = 1_000;
const ZONES = loadMapZones();
// ponytail: a minute covers the enemy turning a death into an objective or a tower; shorten it if "enemy took" starts naming unrelated takes.
const PUNISH_WINDOW_MS = 60_000;
// Riot event constants outside Data Dragon (no data file carries them), named the way players say them.
const EPIC_MONSTERS: Record<string, string> = { DRAGON: "a dragon", BARON_NASHOR: "Baron", RIFTHERALD: "Rift Herald", HORDE: "voidgrubs", ATAKHAN: "Atakhan" };
// Chart payload caps: a normal game never approaches these (60 min, 30 deaths, 30 kills); only a stalled or malformed game would.
export const CHART_MAX_MINUTES = 60;
export const CHART_MAX_DEATHS = 30;
export const CHART_MAX_KILLS = 30;

/** The setup itself, as a player copying it needs it: what was bought in what order, the whole rune page, and the level-up path. */
export interface GameBuild {
	/** Finished items and boots in purchase order, undo-aware, with the minute of each buy; components and consumables are folded away. */
	itemOrder: Array<{ name: string; min: number }>;
	runes: RunePage;
	/** First ten level-ups as slot letters, e.g. "QEWQQRQWQQ". */
	skills: string;
}

export interface RunePage {
	primary: string;
	keystone: string;
	primaryRunes: string[];
	secondary: string;
	secondaryRunes: string[];
	/** Offense, flex, defense stat shards. */
	shards: string[];
}

export interface AuditNames {
	items: Record<number, string>;
	runes: Record<number, string>;
	summoners: Record<number, string>;
	/** Summoner spell names by Data Dragon id, lowercased ("summonerdot"): how a kill event's damage list spells one. Absent leaves them unnamed. */
	spells?: Record<string, string>;
	/** Item ids worth listing in a build: finished items and boots, never components, consumables, or trinkets. Absent means every purchase is listed. */
	listed?: Set<number>;
}


const SLOT_LETTERS = ["", "Q", "W", "E", "R"];
const MINUTE = 60_000;

function minutes(ms: number): number {
	return Math.round((ms / MINUTE) * 10) / 10;
}

function shortPatch(version: unknown): string {
	const match = /^(\d+)\.(\d+)/.exec(typeof version === "string" ? version : "");
	return match ? `${match[1]}.${match[2]}` : "unknown";
}

/**
 * Riot match data and Data Dragon carry game version 16.N; the public patch
 * notes call the same patch 26.N (year-based numbering since 2025). Models
 * read the two as a mismatch unless told they are one patch.
 */
export function publicPatch(version: unknown): string {
	const match = /^(\d+)\.(\d+)/.exec(typeof version === "string" ? version : "");
	if (!match) return "unknown";
	const major = Number(match[1]);
	return major >= 15 ? `${major + 10}.${match[2]}` : `${major}.${match[2]}`;
}

/** A timeline position Riot actually sent: a missing one must never read as the map corner at (0, 0). */
function placed(position: any): boolean {
	return typeof position?.x === "number" && typeof position?.y === "number";
}

function frameAt(timeline: any, minute: number): any | undefined {
	const frames = Array.isArray(timeline?.info?.frames) ? timeline.info.frames : [];
	return frames.find((frame: any) => Math.round((frame?.timestamp ?? -1) / MINUTE) === minute);
}

function cs(frame: any): number {
	return (frame?.minionsKilled ?? 0) + (frame?.jungleMinionsKilled ?? 0);
}

/** Build one audit row. Throws when the account is not in the match. */
export function auditGame(match: any, timeline: any, puuid: string, names: AuditNames): GameAudit {
	const info = match?.info ?? {};
	const participants: any[] = Array.isArray(info.participants) ? info.participants : [];
	const me = participants.find((participant) => participant?.puuid === puuid);
	if (!me) throw new Error("participant missing");
	const opponent = participants.find((participant) => participant !== me && participant.teamId !== me.teamId && participant.teamPosition === me.teamPosition);
	const myId: number = me.participantId;
	const oppId: number | undefined = opponent?.participantId;

	const events: any[] = [];
	for (const frame of Array.isArray(timeline?.info?.frames) ? timeline.info.frames : []) {
		for (const event of Array.isArray(frame?.events) ? frame.events : []) events.push(event);
	}
	events.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

	let deathsBefore6 = 0;
	let deathsAt15 = 0;
	let deathsAfter15 = 0;
	let killsAt15 = 0;
	let level6Min: number | null = null;
	let firstBackMin: number | null = null;
	const skillSequence: number[] = [];
	const skillRanks = [0, 0, 0, 0, 0];
	const maxedOrder: string[] = [];
	const itemTimingMin: Record<string, number> = {};
	const undoable: Array<{ itemId: number; name: string }> = [];
	const purchases: Array<{ itemId: number; name: string; min: number }> = [];

	for (const event of events) {
		const at: number = event.timestamp ?? 0;
		switch (event.type) {
			case "CHAMPION_KILL": {
				if (event.victimId === myId) {
					if (at < 6 * MINUTE) deathsBefore6 += 1;
					if (at <= 15 * MINUTE) deathsAt15 += 1;
					else deathsAfter15 += 1;
				}
				const assisted = Array.isArray(event.assistingParticipantIds) && event.assistingParticipantIds.includes(myId);
				if ((event.killerId === myId || assisted) && at <= 15 * MINUTE) killsAt15 += 1;
				break;
			}
			case "LEVEL_UP":
				if (event.participantId === myId && event.level === 6 && level6Min === null) level6Min = minutes(at);
				break;
			case "SKILL_LEVEL_UP": {
				if (event.participantId !== myId) break;
				const slot: number = event.skillSlot ?? 0;
				if (slot >= 1 && slot <= 4) {
					skillSequence.push(slot);
					skillRanks[slot] += 1;
					if (slot !== 4 && skillRanks[slot] === 5) maxedOrder.push(SLOT_LETTERS[slot]);
				}
				break;
			}
			case "ITEM_PURCHASED": {
				if (event.participantId !== myId) break;
				const name = names.items[event.itemId] ?? "";
				// First non-starter purchase after the opening shop approximates the first recall.
				if (firstBackMin === null && at > 90_000) firstBackMin = minutes(at);
				if (name && itemTimingMin[name] === undefined) itemTimingMin[name] = minutes(at);
				undoable.push({ itemId: event.itemId, name });
				purchases.push({ itemId: event.itemId, name, min: minutes(at) });
				break;
			}
			case "ITEM_UNDO": {
				if (event.participantId !== myId) break;
				const last = undoable.pop();
				if (last && event.beforeId === last.itemId) {
					purchases.pop();
					// Re-derive the name's timing from what's left, so undoing one purchase never erases an earlier still-valid one of the same name.
					if (last.name) {
						const remaining = purchases.filter((purchase) => purchase.name === last.name).map((purchase) => purchase.min);
						if (remaining.length === 0) delete itemTimingMin[last.name];
						else itemTimingMin[last.name] = Math.min(...remaining);
					}
				}
				break;
			}
			default:
				break;
		}
	}

	const frames: any[] = Array.isArray(timeline?.info?.frames) ? timeline.info.frames : [];
	const fullDiff = oppId === undefined ? [] : frames.map((frame) => (frame?.participantFrames?.[String(myId)]?.totalGold ?? 0) - (frame?.participantFrames?.[String(oppId)]?.totalGold ?? 0));
	// Only the chart array is capped; the lead's peak and end read every frame.
	const goldDiff = fullDiff.slice(0, CHART_MAX_MINUTES);
	const teamOf = new Map(participants.map((participant) => [participant.participantId, participant.teamId]));
	const ally = (id: unknown) => id !== myId && teamOf.get(id as number) === me.teamId;
	const near = (a: any, b: any) => placed(a) && placed(b) && Math.hypot(a.x - b.x, a.y - b.y) <= ALLY_RANGE;
	// The frame at a death's minute is the last one before it; a death after the last frame has no gold to read.
	const goldAt = (at: number): number | null => {
		const gold = frames[Math.floor(at / MINUTE)]?.participantFrames?.[String(myId)]?.currentGold;
		return typeof gold === "number" ? gold : null;
	};
	const championOf = new Map(participants.map((participant) => [participant.participantId, participant.championName]));
	const enemy = (id: unknown) => typeof id === "number" && id > 0 && teamOf.has(id) && teamOf.get(id) !== me.teamId;
	const enemyJungler = participants.find((participant) => participant.teamId !== me.teamId && participant.teamPosition === "JUNGLE")?.participantId;
	const junglerOn = (event: any) => enemyJungler !== undefined && (event.killerId === enemyJungler || (Array.isArray(event.assistingParticipantIds) && event.assistingParticipantIds.includes(enemyJungler)));
	// Epic monsters and buildings one side took within PUNISH_WINDOW_MS after: mine is what a kill or a death can buy, theirs what a death hands over.
	const tookAfter = (at: number, mine: boolean): string[] => [
		...new Set(
			events
				.filter((other) => other.timestamp > at && other.timestamp <= at + PUNISH_WINDOW_MS)
				.map((other) => {
					if (other.type === "ELITE_MONSTER_KILL" && (other.killerTeamId === me.teamId) === mine) return other.monsterSubType === "ELDER_DRAGON" ? "Elder Dragon" : (EPIC_MONSTERS[other.monsterType] ?? "an epic monster");
					// teamId is the building's owner.
					if (other.type === "BUILDING_KILL" && (other.teamId !== me.teamId) === mine) return other.buildingType === "INHIBITOR_BUILDING" ? "an inhibitor" : "a tower";
					return "";
				})
				.filter(Boolean),
		),
	];
	// The frames a per-death map can read: a timestamp and at least one champion's place.
	const positioned = frames.filter((frame) => typeof frame?.timestamp === "number" && Object.values<any>(frame?.participantFrames ?? {}).some((entry) => placed(entry?.position)));
	const kills: number[] = [];
	const killMoments: KillMoment[] = [];
	const deathMarks: DeathMark[] = [];
	const moments: DeathMoment[] = [];
	for (const event of events) {
		if (event.type !== "CHAMPION_KILL") continue;
		const at: number = event.timestamp ?? 0;
		if ((event.killerId === myId || (Array.isArray(event.assistingParticipantIds) && event.assistingParticipantIds.includes(myId))) && kills.length < CHART_MAX_KILLS) {
			kills.push(minutes(at));
			killMoments.push({
				min: minutes(at),
				zone: zoneOf(event.position, me.teamId, ZONES),
				victim: String(championOf.get(event.victimId) ?? "unknown"),
				mine: event.killerId === myId,
				allies: [event.killerId, ...(event.assistingParticipantIds ?? [])].filter(ally).map((id) => String(championOf.get(id as number) ?? "unknown")),
				teamTook: tookAfter(at, true),
			});
		}
		if (event.victimId !== myId || deathMarks.length >= CHART_MAX_DEATHS) continue;
		const afterAllyDeath = events.some((other) => other.type === "CHAMPION_KILL" && ally(other.victimId) && other.timestamp >= at - ALLY_WINDOW_MS && other.timestamp <= at && near(other.position, event.position));
		const traded = events.some((other) => {
			if (other.timestamp <= at || other.timestamp > at + TRADE_WINDOW_MS) return false;
			if (other.type === "CHAMPION_KILL") return ally(other.killerId) && near(other.position, event.position);
			if (other.type === "ELITE_MONSTER_KILL") return other.killerTeamId === me.teamId;
			if (other.type === "BUILDING_KILL") return other.teamId !== me.teamId; // teamId is the building's owner
			return false;
		});
		// The fight around the death, netted: every kill near it from ALLY_WINDOW_MS before to TRADE_WINDOW_MS after, this one included.
		const fight = events.filter((other) => other.type === "CHAMPION_KILL" && other.timestamp >= at - ALLY_WINDOW_MS && other.timestamp <= at + TRADE_WINDOW_MS && (other === event || near(other.position, event.position)));
		const fell = fight.filter((other) => !enemy(other.victimId)).length;
		const wonFight = fight.length - fell > fell;
		const took = tookAfter(at, false);
		const assisting: unknown[] = Array.isArray(event.assistingParticipantIds) ? event.assistingParticipantIds : [];
		const killers = [event.killerId, ...assisting].filter(enemy).map((id) => String(championOf.get(id as number) ?? "unknown"));
		const frame = placed(event.position) ? positioned.reduce<any>((best, other) => (best === undefined || Math.abs(other.timestamp - at) < Math.abs(best.timestamp - at) ? other : best), undefined) : undefined;
		// A champion killed in the ALLY_WINDOW_MS before this death was dead at it, wherever the frame still puts them: the teammate
		// the player followed in is not "an ally near". (The timeline has no respawn event, so a longer absence cannot be told.)
		const justDied = new Set(events.filter((other) => other.type === "CHAMPION_KILL" && other !== event && other.timestamp >= at - ALLY_WINDOW_MS && other.timestamp <= at).map((other) => other.victimId));
		const scene: DeathScene | undefined = frame && {
			killers,
			offsetSec: Math.round((frame.timestamp - at) / 1000),
			champions: Object.entries<any>(frame.participantFrames)
				.filter(([id, entry]) => Number(id) !== myId && !justDied.has(Number(id)) && teamOf.has(Number(id)) && placed(entry?.position) && Math.max(Math.abs(entry.position.x - event.position.x), Math.abs(entry.position.y - event.position.y)) <= SCENE_SPAN / 2)
				.map(([id, entry]) => ({ name: String(championOf.get(Number(id)) ?? "unknown"), ally: teamOf.get(Number(id)) === me.teamId, x: entry.position.x, y: entry.position.y })),
		};
		const damage = deathDamage(event, championOf, names.spells);
		deathMarks.push({ min: minutes(at), x: event.position?.x ?? 0, y: event.position?.y ?? 0, afterAllyDeath, traded, ...(scene ? { scene } : {}), ...(damage ? { damage: damage.sources } : {}) });
		moments.push({
			min: minutes(at),
			zone: zoneOf(event.position, me.teamId, ZONES),
			gold: goldAt(at),
			lead: oppId === undefined ? null : (goldDiff[Math.floor(at / MINUTE)] ?? null),
			afterAllyDeath,
			traded,
			jungler: junglerOn(event),
			enemyTook: took,
			killers,
			worth: wonFight || (took.length === 0 && tookAfter(at, true).length > 0),
			wonFight,
			...(damage ? { damage } : {}),
		});
	}

	const frame10 = frameAt(timeline, 10);
	const frame15 = frameAt(timeline, 15);
	const mine10 = frame10?.participantFrames?.[String(myId)];
	const mine15 = frame15?.participantFrames?.[String(myId)];
	const theirs10 = oppId === undefined ? undefined : frame10?.participantFrames?.[String(oppId)];
	const theirs15 = oppId === undefined ? undefined : frame15?.participantFrames?.[String(oppId)];

	const team = participants.filter((participant) => participant.teamId === me.teamId);
	const teamKills = team.reduce((total, participant) => total + (participant.kills ?? 0), 0);
	const teamDamage = team.reduce((total, participant) => total + (participant.totalDamageDealtToChampions ?? 0), 0);
	const durationMin = (info.gameDuration ?? 0) / 60;
	const csEnd = (me.totalMinionsKilled ?? 0) + (me.neutralMinionsKilled ?? 0);
	const csAt15 = mine15 ? cs(mine15) : null;
	const teams: any[] = Array.isArray(info.teams) ? info.teams : [];
	const ours = teams.find((entry) => entry?.teamId === me.teamId)?.objectives;
	const theirs = teams.find((entry) => entry?.teamId !== me.teamId)?.objectives;
	const score = (key: string): [number, number] => [ours?.[key]?.kills ?? 0, theirs?.[key]?.kills ?? 0];
	const epic = events.filter((event) => event.type === "ELITE_MONSTER_KILL" && event.killerTeamId === me.teamId);
	const peak = fullDiff.length ? Math.max(...fullDiff) : null;
	const perMin = (value: number) => Math.round(value * 10) / 10;
	const teamTaken = team.reduce((total, participant) => total + (participant.totalDamageTaken ?? 0), 0);
	const onIt = (event: any) => event.killerId === myId || (Array.isArray(event.assistingParticipantIds) && event.assistingParticipantIds.includes(myId));
	const participation: Participation = { dragon: [0, 0], herald: [0, 0], baron: [0, 0], tower: [0, 0] };
	const tally2 = (key: keyof Participation, event: any) => {
		participation[key][1] += 1;
		if (onIt(event)) participation[key][0] += 1;
	};
	const MONSTER_KEYS: Record<string, keyof Participation> = { DRAGON: "dragon", RIFTHERALD: "herald", BARON_NASHOR: "baron" };
	for (const event of epic) if (MONSTER_KEYS[event.monsterType]) tally2(MONSTER_KEYS[event.monsterType], event);
	// teamId on a building event is the building's owner: the enemy's towers are the ones my team took.
	for (const event of events) if (event.type === "BUILDING_KILL" && event.buildingType === "TOWER_BUILDING" && event.teamId !== me.teamId) tally2("tower", event);
	const play: GamePlay = {
		deaths: moments,
		kills: killMoments,
		killParticipationPct: teamKills > 0 ? Math.round((((me.kills ?? 0) + (me.assists ?? 0)) / teamKills) * 100) : null,
		damageSharePct: teamDamage > 0 ? Math.round(((me.totalDamageDealtToChampions ?? 0) / teamDamage) * 100) : null,
		visionPerMin: durationMin > 0 ? Math.round(((me.visionScore ?? 0) / durationMin) * 100) / 100 : 0,
		visionScore: me.visionScore ?? 0,
		wardsPlaced: me.wardsPlaced ?? 0,
		wardsKilled: me.wardsKilled ?? 0,
		controlWards: me.visionWardsBoughtInGame ?? 0,
		damageToChampions: me.totalDamageDealtToChampions ?? 0,
		damagePerMin: durationMin > 0 ? Math.round((me.totalDamageDealtToChampions ?? 0) / durationMin) : 0,
		damageTaken: me.totalDamageTaken ?? 0,
		damageTakenSharePct: teamTaken > 0 ? Math.round(((me.totalDamageTaken ?? 0) / teamTaken) * 100) : null,
		plates: me.challenges?.turretPlatesTaken ?? 0,
		participation,
		csPerMinTo15: csAt15 === null ? null : perMin(csAt15 / 15),
		csPerMinAfter15: csAt15 === null || durationMin < 16 ? null : perMin((csEnd - csAt15) / (durationMin - 15)),
		goldDiffAt20: goldDiff.length > 20 ? goldDiff[20] : null,
		leadPeak: peak,
		leadPeakMin: peak === null ? null : fullDiff.indexOf(peak),
		leadEnd: fullDiff.length ? fullDiff[fullDiff.length - 1] : null,
		objectives: { dragons: score("dragon"), barons: score("baron"), heralds: score("riftHerald"), grubs: score("horde"), towers: score("tower") },
		epicTakesOn: epic.filter((event) => event.killerId === myId || (Array.isArray(event.assistingParticipantIds) && event.assistingParticipantIds.includes(myId))).length,
		epicTakes: epic.length,
		deadPct: info.gameDuration ? Math.round(((me.totalTimeSpentDead ?? 0) / info.gameDuration) * 100) : 0,
		turretTakedowns: me.turretTakedowns ?? 0,
	};


	const styles: any[] = Array.isArray(me.perks?.styles) ? me.perks.styles : [];
	const keystoneId = styles[0]?.selections?.[0]?.perk;
	const finalItemIds: number[] = [me.item0, me.item1, me.item2, me.item3, me.item4, me.item5].filter((id: unknown): id is number => typeof id === "number" && id > 0);
	const finalItems = finalItemIds.map((id) => names.items[id] ?? `item ${id}`);
	const runeName = (id: unknown) => (typeof id === "number" ? (names.runes[id] ?? `rune ${id}`) : "unknown");
	const selections = (style: any, from: number) => (Array.isArray(style?.selections) ? style.selections.slice(from) : []).map((selection: any) => runeName(selection?.perk));
	const statPerks = me.perks?.statPerks ?? {};
	const build: GameBuild = {
		// Finished items, plus anything still held at the end (a Dark Seal that was never turned into Mejai's is a real choice).
		itemOrder: purchases.filter((purchase) => purchase.name && ((names.listed?.has(purchase.itemId) ?? true) || finalItemIds.includes(purchase.itemId))).map(({ name, min }) => ({ name, min })),
		runes: {
			primary: runeName(styles[0]?.style),
			keystone: runeName(keystoneId),
			primaryRunes: selections(styles[0], 1),
			secondary: runeName(styles[1]?.style),
			secondaryRunes: selections(styles[1], 0),
			shards: [statPerks.offense, statPerks.flex, statPerks.defense].map((id: unknown) => (typeof id === "number" ? statShardName(id) : "unknown")),
		},
		skills: skillSequence.slice(0, 10).map((slot) => SLOT_LETTERS[slot]).join(""),
	};

	return {
		matchId: typeof match?.metadata?.matchId === "string" ? match.metadata.matchId : "unknown",
		patch: shortPatch(info.gameVersion),
		playedAt: typeof info.gameCreation === "number" ? new Date(info.gameCreation).toISOString().slice(0, 10) : "unknown",
		playedAtMs: typeof info.gameCreation === "number" ? info.gameCreation : null,
		durationMin: Math.round(((info.gameDuration ?? 0) / 60) * 10) / 10,
		win: me.win === true,
		remake: me.gameEndedInEarlySurrender === true || (me.gameEndedInSurrender === true && (info.gameDuration ?? 0) < 15 * 60),
		champion: typeof me.championName === "string" ? me.championName : "unknown",
		position: typeof me.teamPosition === "string" ? me.teamPosition : "unknown",
		opponent: typeof opponent?.championName === "string" ? opponent.championName : "unknown",
		kills: me.kills ?? 0,
		deaths: me.deaths ?? 0,
		assists: me.assists ?? 0,
		deathsBefore6,
		deathsAt15,
		deathsAfter15,
		killsAt15,
		csAt10: mine10 ? cs(mine10) : null,
		csAt15,
		goldDiffAt10: mine10 && theirs10 ? (mine10.totalGold ?? 0) - (theirs10.totalGold ?? 0) : null,
		goldDiffAt15: mine15 && theirs15 ? (mine15.totalGold ?? 0) - (theirs15.totalGold ?? 0) : null,
		level6Min,
		firstBackMin,
		keystone: typeof keystoneId === "number" ? (names.runes[keystoneId] ?? `rune ${keystoneId}`) : "unknown",
		summoners: [me.summoner1Id, me.summoner2Id].map((id: unknown) => (typeof id === "number" ? (names.summoners[id] ?? `spell ${id}`) : "unknown")),
		skillOrder: skillSequence.slice(0, 3).map((slot) => SLOT_LETTERS[slot]).join(""),
		skillMax: maxedOrder.join(">"),
		itemTimingMin,
		finalItems,
		build,
		timeline: { goldDiff, deaths: deathMarks, kills },
		play,
	};
}

/** Most frequent values first, as `value ×count`, for a build aggregate the model can quote. */
export function frequency(values: string[]): Array<{ value: string; count: number }> {
	const counts = new Map<string, number>();
	for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

export interface AuditSummary {
	games: number;
	wins: number;
	winRatePct: number;
	avgKills: number;
	avgDeaths: number;
	avgAssists: number;
	gamesWithDeathBefore6: number;
	gamesWithMax3Deaths: number;
	avgDeathsAt15: number;
	avgDeathsAfter15: number;
	avgKillsAt15: number;
	avgCsAt10: number | null;
	avgCsAt15: number | null;
	avgGoldDiffAt10: number | null;
	avgGoldDiffAt15: number | null;
	avgLevel6Min: number | null;
	avgFirstBackMin: number | null;
	avgDurationMin: number;
	keystones: Record<string, number>;
	skillOrders: Record<string, number>;
	opponents: Record<string, number>;
	medianItemTimingMin: Record<string, number>;
	/** Games in which each tracked item was bought at all; a median over 3 of 10 games is weak evidence. */
	itemPurchaseCount: Record<string, number>;
	/** Reference rule "ahead at 15: stop dying" measured directly: games with gold diff at 15 > 0, split by result. */
	aheadAt15: { games: number; wins: number; avgDeathsAfter15Won: number | null; avgDeathsAfter15Lost: number | null };
	avgKillParticipationPct: number | null;
	avgDamageSharePct: number | null;
	avgVisionPerMin: number | null;
	avgCsPerMinTo15: number | null;
	avgCsPerMinAfter15: number | null;
	avgGoldDiffAt20: number | null;
	avgDeadPct: number | null;
	/** Per game, my team's count first. */
	avgObjectives: Record<keyof Objectives, [number | null, number | null]>;
	/** The player's own medians over these games, all and split by result: the only baseline the payload holds (no rank or role norm is fetched). */
	medians: { all: OwnMedians; won: OwnMedians; lost: OwnMedians };
	/** Objective takes across these games: [the ones the player was on, all of the team's]. */
	participation: Participation;
	/** The same averages over wins and over losses, so what changes between them is a read, not a guess. */
	byResult: { won: ResultAverages; lost: ResultAverages };
}

export interface ResultAverages {
	games: number;
	deaths: number | null;
	deathsAfter15: number | null;
	csAt15: number | null;
	goldDiffAt15: number | null;
	killParticipationPct: number | null;
	visionPerMin: number | null;
	csPerMinAfter15: number | null;
	goldDiffAt20: number | null;
	deadPct: number | null;
	dragons: [number | null, number | null];
	towers: [number | null, number | null];
}

export interface OwnMedians {
	games: number;
	visionScore: number | null;
	wardsPlaced: number | null;
	wardsKilled: number | null;
	controlWards: number | null;
	damagePerMin: number | null;
	damageTakenSharePct: number | null;
	plates: number | null;
}

function ownMedians(games: GameAudit[]): OwnMedians {
	const of = (pick: (game: GameAudit) => number | null) => {
		const present = games.map(pick).filter((value): value is number => value !== null);
		return present.length ? median(present) : null;
	};
	return {
		games: games.length,
		visionScore: of((game) => game.play.visionScore),
		wardsPlaced: of((game) => game.play.wardsPlaced),
		wardsKilled: of((game) => game.play.wardsKilled),
		controlWards: of((game) => game.play.controlWards),
		damagePerMin: of((game) => game.play.damagePerMin),
		damageTakenSharePct: of((game) => game.play.damageTakenSharePct),
		plates: of((game) => game.play.plates),
	};
}

function objectiveAverage(games: GameAudit[], key: keyof Objectives): [number | null, number | null] {
	return [average(games.map((game) => game.play.objectives[key][0])), average(games.map((game) => game.play.objectives[key][1]))];
}

function resultAverages(games: GameAudit[]): ResultAverages {
	return {
		games: games.length,
		deaths: average(games.map((game) => game.deaths)),
		deathsAfter15: average(games.map((game) => game.deathsAfter15)),
		csAt15: average(games.map((game) => game.csAt15)),
		goldDiffAt15: average(games.map((game) => game.goldDiffAt15)),
		killParticipationPct: average(games.map((game) => game.play.killParticipationPct)),
		visionPerMin: average(games.map((game) => game.play.visionPerMin)),
		csPerMinAfter15: average(games.map((game) => game.play.csPerMinAfter15)),
		goldDiffAt20: average(games.map((game) => game.play.goldDiffAt20)),
		deadPct: average(games.map((game) => game.play.deadPct)),
		dragons: objectiveAverage(games, "dragons"),
		towers: objectiveAverage(games, "towers"),
	};
}

/** One repeated pattern, counted over every game and over the losses alone: a habit that lives in the losses is one that costs games. */
export interface Habit {
	habit: string;
	unit: "deaths" | "games" | "takes" | "takedowns" | "kills";
	count: number;
	of: number;
	lossCount: number;
	lossOf: number;
}

/** The deaths held against the player: every one in context except those worth taking. */
const costly = (game: GameAudit, when: (death: DeathMoment) => boolean = () => true) => game.play.deaths.filter((death) => !death.worth && when(death));
const early = (death: DeathMoment) => death.min <= 15;
const late = (death: DeathMoment) => death.min > 15;

const HABITS: Array<{ habit: string; unit: Habit["unit"]; count: (game: GameAudit) => number; of: (game: GameAudit) => number }> = [
	{ habit: "died holding 1000+ unspent gold", unit: "deaths", count: (game) => costly(game, (death) => (death.gold ?? 0) >= HELD_GOLD).length, of: (game) => costly(game).length },
	{ habit: "died soon after a teammate died nearby", unit: "deaths", count: (game) => costly(game, (death) => death.afterAllyDeath).length, of: (game) => costly(game).length },
	{ habit: "died with nothing taken back by the team", unit: "deaths", count: (game) => costly(game, (death) => !death.traded).length, of: (game) => costly(game).length },
	{ habit: "died to the enemy jungler by minute 15", unit: "deaths", count: (game) => costly(game, (death) => early(death) && death.jungler).length, of: (game) => costly(game, early).length },
	{ habit: "died past the river after minute 15", unit: "deaths", count: (game) => costly(game, (death) => late(death) && /\benemy\b/.test(death.zone)).length, of: (game) => costly(game, late).length },
	// ponytail: per game, not per death, so a worth-taking death before minute 6 still counts here.
	{ habit: "died before minute 6", unit: "games", count: (game) => (game.deathsBefore6 > 0 ? 1 : 0), of: () => 1 },
	{ habit: "died right before the enemy took an objective or tower", unit: "deaths", count: (game) => costly(game, (death) => death.enemyTook.length > 0).length, of: (game) => costly(game).length },
	// ponytail: 1500 gold is about a kill and a wave ahead, 1 cs a minute is about a wave every two minutes; tune on real reviews.
	{ habit: "led by 1500+ gold, then lost", unit: "games", count: (game) => ((game.play.leadPeak ?? 0) >= 1500 && !game.win ? 1 : 0), of: (game) => ((game.play.leadPeak ?? 0) >= 1500 ? 1 : 0) },
	{ habit: "cs per minute fell by 1+ after minute 15", unit: "games", count: (game) => (game.play.csPerMinAfter15 !== null && game.play.csPerMinTo15 !== null && game.play.csPerMinAfter15 <= game.play.csPerMinTo15 - 1 ? 1 : 0), of: (game) => (game.play.csPerMinAfter15 !== null && game.play.csPerMinTo15 !== null ? 1 : 0) },
	{ habit: "enemy took more dragons", unit: "games", count: (game) => (game.play.objectives.dragons[1] > game.play.objectives.dragons[0] ? 1 : 0), of: () => 1 },
	{ habit: "not on the team's epic monster takes", unit: "takes", count: (game) => game.play.epicTakes - game.play.epicTakesOn, of: (game) => game.play.epicTakes },
	{ habit: "bought no control ward", unit: "games", count: (game) => (game.play.controlWards === 0 ? 1 : 0), of: () => 1 },
	{ habit: "in fewer than 40% of the team's kills", unit: "games", count: (game) => (game.play.killParticipationPct !== null && game.play.killParticipationPct < 40 ? 1 : 0), of: () => 1 },
];

/**
 * Every pattern the audit can count, best evidenced first (Wilson lower bound of the rate), so the coach names habits from counts instead of guessing from a
 * table. A pattern with no occurrences, or nothing to count it against, is left out.
 */
export function auditHabits(games: GameAudit[]): Habit[] {
	return countPatterns(HABITS, games);
}

function countPatterns(patterns: typeof HABITS, games: GameAudit[]): Habit[] {
	const losses = games.filter((game) => !game.win);
	const total = (list: GameAudit[], pick: (game: GameAudit) => number) => list.reduce((sum, game) => sum + pick(game), 0);
	return patterns.map(({ habit, unit, count, of }) => ({ habit, unit, count: total(games, count), of: total(games, of), lossCount: total(losses, count), lossOf: total(losses, of) }))
		.filter((entry) => entry.count > 0 && entry.of > 0)
		.sort((a, b) => wilsonLower(b.count, b.of) - wilsonLower(a.count, a.of) || b.count - a.count || a.habit.localeCompare(b.habit));
}

/**
 * Lower end of the 95% Wilson score interval for count of of: the rate we can be that sure of. A pattern seen once ranks
 * below one seen 18 times in 19, and equal rates order by their evidence. Ties after that go by count, then by name.
 */
function wilsonLower(count: number, of: number): number {
	const z = 1.96;
	const p = count / of;
	return (p + (z * z) / (2 * of) - z * Math.sqrt((p * (1 - p)) / of + (z * z) / (4 * of * of))) / (1 + (z * z) / of);
}

const takedowns = (game: GameAudit, when: (kill: KillMoment) => boolean = () => true) => game.play.kills.filter(when);
/** A takedown by minute 15 that Riot placed, for a player with a lane (a jungler has none); `away` keeps the ones outside that lane. */
const laning = (game: GameAudit, away: boolean) => {
	const lane = laneOf(game.position);
	return (kill: KillMoment) => lane !== undefined && kill.min <= 15 && kill.zone !== UNKNOWN_ZONE && !(away && kill.zone.startsWith(`${lane} lane`));
};

// Counted over play.kills, so over at most CHART_MAX_KILLS takedowns a game.
const KILL_PATTERNS: typeof HABITS = [
	{ habit: "kills and assists the team turned into an objective or tower within a minute", unit: "takedowns", count: (game) => takedowns(game, (kill) => kill.teamTook.length > 0).length, of: (game) => takedowns(game).length },
	{ habit: "kills landed alone", unit: "kills", count: (game) => takedowns(game, (kill) => kill.mine && kill.allies.length === 0).length, of: (game) => takedowns(game, (kill) => kill.mine).length },
	{ habit: "kills and assists away from the player's own lane by minute 15", unit: "takedowns", count: (game) => takedowns(game, laning(game, true)).length, of: (game) => takedowns(game, laning(game, false)).length },
	// ponytail: a minute is PUNISH_WINDOW_MS, the same reach a death's "enemy then took" has; a death worth taking is a won fight, not an overstay.
	{ habit: "kills and assists followed within a minute by a death not worth taking", unit: "takedowns", count: (game) => takedowns(game, (kill) => costly(game, (death) => death.min > kill.min && death.min <= kill.min + 1).length > 0).length, of: (game) => takedowns(game).length },
];

/**
 * The counted patterns in the kills and assists, best evidenced first: where the lead comes from and what a kill becomes, so
 * the coach reads a count instead of tallying the kill lists. A pattern with no occurrences is left out.
 */
export function auditKillPatterns(games: GameAudit[]): Habit[] {
	return countPatterns(KILL_PATTERNS, games);
}

/** One kill pattern as the model and the grounding passage both read it: its count, and its split between wins and losses when the games have both. */
export function killPatternText(entry: Habit): string {
	const winOf = entry.of - entry.lossOf;
	const split = winOf > 0 && entry.lossOf > 0 ? `; ${entry.count - entry.lossCount} of ${winOf} in wins, ${entry.lossCount} of ${entry.lossOf} in losses` : "";
	return `${entry.habit}: ${entry.count} of ${entry.of} ${entry.unit}${split}`;
}

/** One habit as the model and the grounding passage both read it, so the two never state a count differently. */
export function habitText(entry: Habit): string {
	return `${entry.habit}: ${entry.count} of ${entry.of} ${entry.unit}${entry.lossOf > 0 ? `, ${entry.lossCount} of ${entry.lossOf} in losses` : ""}`;
}

/** A game's epic monsters and towers as the model and the grounding passage both read them, my team's count first; a 0-0 pair is left out. */
export function participationText(part: Participation): string {
	const names = { dragon: "dragons", herald: "heralds", baron: "Barons", tower: "towers" };
	// An objective the team never took says nothing: left out.
	return (Object.keys(names) as Array<keyof Participation>).filter((key) => part[key][1] > 0).map((key) => `${part[key][0]} of ${part[key][1]} ${names[key]}`).join(", ") || "no objective takes";
}

function medianText(m: OwnMedians): string {
	const n = (value: number | null) => (value === null ? "?" : String(value));
	return `${m.games} games: vision score ${n(m.visionScore)}, ${n(m.wardsPlaced)} wards placed, ${n(m.wardsKilled)} cleared, ${n(m.controlWards)} control wards, ${n(m.damagePerMin)} damage per minute, ${n(m.damageTakenSharePct)}% of team damage taken, ${n(m.plates)} plates`;
}

export function objectivesText(objectives: Objectives): string {
	const names: Record<keyof Objectives, string> = { dragons: "dragons", barons: "Barons", heralds: "Heralds", grubs: "grubs", towers: "towers" };
	return (Object.keys(names) as Array<keyof Objectives>)
		.filter((key) => objectives[key][0] + objectives[key][1] > 0)
		.map((key) => `${names[key]} ${objectives[key][0]}-${objectives[key][1]}`)
		.join(", ");
}

/** Deaths the team got nothing back for: a death worth taking is never one, even when nothing followed it (the fight was already won). */
export function untradedDeaths(game: GameAudit): number {
	return game.play.deaths.filter((death) => !death.traded && !death.worth).length;
}

/** One death without its game, as a game's own list of deaths reads it; a death worth taking says so. */
export function deathLine(death: DeathMoment): string {
	const facts: string[] = [];
	if (death.killers.length) facts.push(`killed by ${death.killers[0]}${death.killers.length > 1 ? ` with ${death.killers.slice(1).join(" and ")}` : ""}`);
	if (death.gold !== null) facts.push(`${death.gold} gold unspent`);
	if (death.lead !== null) facts.push(death.lead >= 0 ? `${death.lead} gold ahead of the lane opponent` : `${-death.lead} gold behind the lane opponent`);
	if (death.afterAllyDeath) facts.push("just after a teammate died nearby");
	if (death.jungler) facts.push("enemy jungler on the kill");
	// A death worth taking gives its reason instead: "nothing traded back" beside "worth taking" reads as a contradiction when
	// the fight was won before the death, or by the player's own kills.
	if (!death.worth) facts.push(death.traded ? "team traded back" : "nothing traded back");
	const damage = death.damage ? `; killing damage: ${damageLine(death.damage)}` : "";
	const took = death.enemyTook.length ? `; enemy then took ${death.enemyTook.join(", ")}` : "";
	return `minute ${death.min}, ${death.zone === "unknown" ? "place unknown" : death.zone}: ${facts.join(", ")}${damage}${took}${death.worth ? `; worth taking: ${death.wonFight ? "the team won the fight around it" : "the team took an objective after"}` : ""}.`;
}

/** One death as the model and the grounding passage both read it. */
export function deathText(game: GameAudit, death: DeathMoment): string {
	return `vs ${game.opponent} (${game.win ? "win" : "loss"}), ${deathLine(death)}`;
}

/** One kill or assist as the model and the grounding passage both read it. */
export function killText(kill: KillMoment): string {
	const who = kill.mine ? `killed ${kill.victim}${kill.allies.length ? ` with ${kill.allies.join(" and ")}` : " alone"}` : `assist on ${kill.victim}${kill.allies.length ? ` with ${kill.allies.join(" and ")}` : ""}`;
	return `minute ${kill.min}, ${kill.zone === "unknown" ? "place unknown" : kill.zone}: ${who}${kill.teamTook.length ? `; team then took ${kill.teamTook.join(", ")}` : ""}.`;
}

/** Every death and every kill or assist of one game, as the model and the grounding passage both read them. */
export function gameMoments(game: GameAudit): { deaths: string[]; kills: string[] } {
	return { deaths: game.play.deaths.map(deathLine), kills: game.play.kills.map(killText) };
}

/** The deaths most worth coaching, costliest first: the enemy took something, the team got nothing back, the game was lost, gold went unspent, a teammate had just fallen. A death worth taking is never one of them. */
export function keyDeaths(games: GameAudit[], max: number): string[] {
	// ponytail: hand weights, a lost objective counting double; retune once real reviews show which deaths the coach leans on.
	const cost = (game: GameAudit, death: DeathMoment) => (death.enemyTook.length ? 2 : 0) + (death.traded ? 0 : 1) + (game.win ? 0 : 1) + ((death.gold ?? 0) >= HELD_GOLD ? 1 : 0) + (death.afterAllyDeath ? 1 : 0);
	return games
		.flatMap((game) => costly(game).map((death) => ({ game, death, cost: cost(game, death) })))
		.sort((a, b) => b.cost - a.cost || b.death.min - a.death.min)
		.slice(0, max)
		.map(({ game, death }) => deathText(game, death));
}

/** The passage the frame judges a claim about the player's own games against: the averages first, then one line per game, then every death and kill of the `detailed` games, so a clipped passage keeps the totals. No Riot ID, match id, or date: nothing in it names the player. */
export function auditPassageText(games: GameAudit[], summary: AuditSummary, deaths: string[] = [], detailed: GameAudit[] = []): string {
	// Every number exactly as the model reads it: a rounded copy (1.9 for 1.86) reads to the judge as a contradiction.
	const n = (value: number | null) => (value === null ? "?" : String(value));
	const sum = (pick: (game: GameAudit) => number) => games.reduce((total, game) => total + pick(game), 0);
	const untradedIn = (game: GameAudit) => untradedDeaths(game);
	const afterAllyIn = (game: GameAudit) => game.timeline.deaths.filter((death) => death.afterAllyDeath).length;
	const worthIn = (game: GameAudit) => game.play.deaths.filter((death) => death.worth).length;
	const ahead = summary.aheadAt15;
	// Every number the model reads from the audit is stated here too: a fact the passage lacks comes back unsupported even when it is true.
	const head = [
		`The player's last ${summary.games} ranked games, ${summary.wins} wins (${summary.winRatePct}%).`,
		`Averages per game: ${n(summary.avgKills)}/${n(summary.avgDeaths)}/${n(summary.avgAssists)} KDA, ${n(summary.avgDeathsAt15)} deaths by minute 15, ${n(summary.avgDeathsAfter15)} deaths after 15, ${n(summary.avgKillsAt15)} takedowns (kills and assists) by 15, ${n(summary.avgCsAt10)} cs at 10, ${n(summary.avgCsAt15)} cs at 15, ${n(summary.avgGoldDiffAt10)} gold diff at 10, ${n(summary.avgGoldDiffAt15)} gold diff at 15, level 6 at minute ${n(summary.avgLevel6Min)}, first back at minute ${n(summary.avgFirstBackMin)}, ${n(summary.avgDurationMin)} min long.`,
		`Totals across the ${summary.games} games: ${sum((game) => game.deaths)} deaths, ${sum((game) => game.deathsAt15)} by minute 15, ${sum((game) => game.deathsAfter15)} after 15, ${sum(untradedIn)} untraded, ${sum(afterAllyIn)} shortly after an ally died nearby, ${sum(worthIn)} worth taking (the team won the fight or took an objective after).`,
		`Died before minute 6 in ${summary.gamesWithDeathBefore6} of ${summary.games} games; ${summary.gamesWithMax3Deaths} games with 3 or fewer deaths.`,
		`Ahead in gold at 15 in ${ahead.games} games, won ${ahead.wins} of them; deaths after 15 in those: ${n(ahead.avgDeathsAfter15Won)} when won, ${n(ahead.avgDeathsAfter15Lost)} when lost.`,
		`Kill participation ${n(summary.avgKillParticipationPct)}%, team damage share ${n(summary.avgDamageSharePct)}%, vision score ${n(summary.avgVisionPerMin)} per minute.`,
		`Medians over these games, with the games won and the games lost beside them (the player's own, not a rank norm): ${medianText(summary.medians.all)}; won ${medianText(summary.medians.won)}; lost ${medianText(summary.medians.lost)}.`,
		`Objective takes the player was on, of the team's: ${participationText(summary.participation)}.`,
		`Farm: ${n(summary.avgCsPerMinTo15)} cs per minute by 15, ${n(summary.avgCsPerMinAfter15)} after 15. Gold diff ${n(summary.avgGoldDiffAt20)} at 20. Dead for ${n(summary.avgDeadPct)}% of the game.`,
		`Per game, the team against the enemy: ${(Object.keys(summary.avgObjectives) as Array<keyof Objectives>).map((key) => `${key} ${n(summary.avgObjectives[key][0])} to ${n(summary.avgObjectives[key][1])}`).join(", ")}.`,
		...(["won", "lost"] as const).map((result) => {
			const side = summary.byResult[result];
			return `In the ${side.games} games ${result}: ${n(side.deaths)} deaths, ${n(side.deathsAfter15)} after 15, ${n(side.csAt15)} cs at 15, ${n(side.csPerMinAfter15)} cs per minute after 15, ${n(side.goldDiffAt15)} gold diff at 15, ${n(side.goldDiffAt20)} at 20, dead for ${n(side.deadPct)}% of the game, kill participation ${n(side.killParticipationPct)}%, vision score ${n(side.visionPerMin)} per minute, dragons ${n(side.dragons[0])} to ${n(side.dragons[1])}, towers ${n(side.towers[0])} to ${n(side.towers[1])}.`;
		}),
		...auditHabits(games).map((entry) => `Habit: ${habitText(entry)}.`),
		...auditKillPatterns(games).map((entry) => `Kill pattern: ${killPatternText(entry)}.`),
		...(deaths.length ? [`Costly deaths: ${deaths.join(" ")}`] : []),
	].join(" ");
	const items = Object.entries(summary.itemPurchaseCount).map(([item, count]) => `${item} bought in ${count} of ${summary.games} games (median minute ${summary.medianItemTimingMin[item]})`).join("; ");
	const rows = games.map(
		(game) =>
			`${game.champion} vs ${game.opponent}, ${game.win ? "win" : "loss"}${game.remake ? " (remake)" : ""}, ${game.kills}/${game.deaths}/${game.assists}, ${game.durationMin} min: ${game.deathsBefore6} deaths before minute 6, ${game.deathsAt15} by 15, ${game.deathsAfter15} after 15, ${untradedIn(game)} untraded, ${afterAllyIn(game)} shortly after an ally died nearby, ${worthIn(game)} worth taking; ${game.killsAt15} takedowns (kills and assists) by 15; cs ${game.csAt10 ?? "?"} at 10, ${game.csAt15 ?? "?"} at 15; gold diff ${game.goldDiffAt10 ?? "?"} at 10, ${game.goldDiffAt15 ?? "?"} at 15; level 6 at minute ${game.level6Min ?? "?"}, first back at ${game.firstBackMin ?? "?"}; cs per minute ${game.play.csPerMinTo15 ?? "?"} by 15, ${game.play.csPerMinAfter15 ?? "?"} after; gold diff ${game.play.goldDiffAt20 ?? "?"} at 20, peak ${game.play.leadPeak ?? "?"} at minute ${game.play.leadPeakMin ?? "?"}, ${game.play.leadEnd ?? "?"} at the end; ${objectivesText(game.play.objectives) || "no objectives"}; on ${game.play.epicTakesOn} of the team's ${game.play.epicTakes} epic monster kills; dead for ${game.play.deadPct}% of the game; ${game.play.turretTakedowns} tower takedowns; kill participation ${game.play.killParticipationPct ?? "?"}%, damage share ${game.play.damageSharePct ?? "?"}%, ${game.play.controlWards} control wards, vision score ${game.play.visionScore}, ${game.play.wardsPlaced} wards placed, ${game.play.wardsKilled} wards cleared, ${game.play.damagePerMin} damage to champions per minute, ${game.play.damageTakenSharePct ?? "?"}% of the team's damage taken, ${game.play.plates} turret plates; on ${participationText(game.play.participation)}; keystone ${game.keystone}; skills ${game.skillOrder} max ${game.skillMax || "?"}; items ${game.build.itemOrder.map((entry) => `${entry.name} at ${entry.min}`).join(", ") || "none"}.`,
	);
	// Last, so a clipped passage loses the oldest game's moments before any game's row.
	const moments = detailed.map((game) => {
		const { deaths: died, kills } = gameMoments(game);
		return `${game.champion} vs ${game.opponent}, ${game.win ? "win" : "loss"}, ${game.durationMin} min. Every death: ${died.join(" ") || "none."} Every kill and assist: ${kills.join(" ") || "none."}`;
	});
	return [head, items, ...rows, ...moments].filter(Boolean).join(" ");
}

function average(values: Array<number | null>): number | null {
	const present = values.filter((value): value is number => typeof value === "number");
	if (present.length === 0) return null;
	return Math.round((present.reduce((sum, value) => sum + value, 0) / present.length) * 100) / 100;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
}

function tally(values: string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}

/** `itemGames` scopes the item-timing aggregates (default: every game); the rest of the summary always covers every game. */
export function summarizeAudit(games: GameAudit[], trackedItems: string[], itemGames: GameAudit[] = games): AuditSummary {
	const wins = games.filter((game) => game.win).length;
	const medianItemTimingMin: Record<string, number> = {};
	const itemPurchaseCount: Record<string, number> = {};
	for (const item of trackedItems) {
		const timings = itemGames.map((game) => game.itemTimingMin[item]).filter((value): value is number => typeof value === "number");
		if (timings.length > 0) {
			medianItemTimingMin[item] = median(timings);
			itemPurchaseCount[item] = timings.length;
		}
	}
	const ahead = games.filter((game) => typeof game.goldDiffAt15 === "number" && game.goldDiffAt15 > 0);
	const aheadAt15 = {
		games: ahead.length,
		wins: ahead.filter((game) => game.win).length,
		avgDeathsAfter15Won: average(ahead.filter((game) => game.win).map((game) => game.deathsAfter15)),
		avgDeathsAfter15Lost: average(ahead.filter((game) => !game.win).map((game) => game.deathsAfter15)),
	};
	return {
		games: games.length,
		wins,
		winRatePct: games.length ? Math.round((wins / games.length) * 100) : 0,
		avgKills: average(games.map((game) => game.kills)) ?? 0,
		avgDeaths: average(games.map((game) => game.deaths)) ?? 0,
		avgAssists: average(games.map((game) => game.assists)) ?? 0,
		gamesWithDeathBefore6: games.filter((game) => game.deathsBefore6 > 0).length,
		gamesWithMax3Deaths: games.filter((game) => game.deaths <= 3).length,
		avgDeathsAt15: average(games.map((game) => game.deathsAt15)) ?? 0,
		avgDeathsAfter15: average(games.map((game) => game.deathsAfter15)) ?? 0,
		avgKillsAt15: average(games.map((game) => game.killsAt15)) ?? 0,
		avgCsAt10: average(games.map((game) => game.csAt10)),
		avgCsAt15: average(games.map((game) => game.csAt15)),
		avgGoldDiffAt10: average(games.map((game) => game.goldDiffAt10)),
		avgGoldDiffAt15: average(games.map((game) => game.goldDiffAt15)),
		avgLevel6Min: average(games.map((game) => game.level6Min)),
		avgFirstBackMin: average(games.map((game) => game.firstBackMin)),
		avgDurationMin: average(games.map((game) => game.durationMin)) ?? 0,
		keystones: tally(games.map((game) => game.keystone)),
		skillOrders: tally(games.map((game) => game.skillOrder || "?")),
		opponents: tally(games.map((game) => game.opponent)),
		medianItemTimingMin,
		itemPurchaseCount,
		aheadAt15,
		avgKillParticipationPct: average(games.map((game) => game.play.killParticipationPct)),
		avgDamageSharePct: average(games.map((game) => game.play.damageSharePct)),
		avgVisionPerMin: average(games.map((game) => game.play.visionPerMin)),
		avgCsPerMinTo15: average(games.map((game) => game.play.csPerMinTo15)),
		avgCsPerMinAfter15: average(games.map((game) => game.play.csPerMinAfter15)),
		avgGoldDiffAt20: average(games.map((game) => game.play.goldDiffAt20)),
		avgDeadPct: average(games.map((game) => game.play.deadPct)),
		avgObjectives: { dragons: objectiveAverage(games, "dragons"), barons: objectiveAverage(games, "barons"), heralds: objectiveAverage(games, "heralds"), grubs: objectiveAverage(games, "grubs"), towers: objectiveAverage(games, "towers") },
		medians: { all: ownMedians(games), won: ownMedians(games.filter((game) => game.win)), lost: ownMedians(games.filter((game) => !game.win)) },
		participation: (["dragon", "herald", "baron", "tower"] as const).reduce((total, key) => ({ ...total, [key]: [games.reduce((sum, game) => sum + game.play.participation[key][0], 0), games.reduce((sum, game) => sum + game.play.participation[key][1], 0)] }), {} as Participation),
		byResult: { won: resultAverages(games.filter((game) => game.win)), lost: resultAverages(games.filter((game) => !game.win)) },
	};
}
