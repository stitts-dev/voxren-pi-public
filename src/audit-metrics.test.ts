import { describe, expect, test } from "bun:test";
import { auditGame, auditHabits, auditPassageText, CHART_MAX_KILLS, CHART_MAX_MINUTES, deathLine, participationText, summarizeAudit, type DeathMoment, type GameAudit } from "./audit-metrics";

const PUUID = "puuid-me";
const NAMES = { items: {}, runes: {}, summoners: {} };

/** One participant, no opponent (teamPosition has no match), so goldDiff/cs stay empty and only kills/deaths/items are in play. */
function minimalMatch(overrides: Record<string, unknown> = {}) {
	return {
		metadata: { matchId: "M1" },
		info: {
			gameVersion: "16.1.1",
			gameCreation: 1,
			gameDuration: 600,
			participants: [
				{
					participantId: 1,
					puuid: PUUID,
					teamId: 100,
					teamPosition: "MIDDLE",
					championName: "Fizz",
					win: true,
					kills: 0,
					deaths: 0,
					assists: 0,
					item0: 0, item1: 0, item2: 0, item3: 0, item4: 0, item5: 0,
					perks: { styles: [{ selections: [{ perk: 1 }] }] },
					summoner1Id: 4,
					summoner2Id: 14,
				},
			],
			...overrides,
		},
	};
}

describe("audit-metrics timeline caps", () => {
	test("caps kills the same way deaths and goldDiff already are", () => {
		const frames = Array.from({ length: CHART_MAX_KILLS + 10 }, (_, minute) => ({
			timestamp: minute * 60_000,
			participantFrames: {},
			events: [{ type: "CHAMPION_KILL", killerId: 1, victimId: 99, timestamp: minute * 60_000, position: { x: 0, y: 0 } }],
		}));
		const row = auditGame(minimalMatch(), { info: { frames } }, PUUID, NAMES);
		expect(row.timeline.kills.length).toBe(CHART_MAX_KILLS);
		expect(row.timeline.deaths).toEqual([]);
		expect(row.timeline.goldDiff).toEqual([]);
	});
});

describe("audit-metrics death scenes", () => {
	const me = minimalMatch().info.participants[0];
	const others = [
		{ participantId: 2, teamId: 100, teamPosition: "JUNGLE", championName: "Vi" },
		{ participantId: 6, teamId: 200, teamPosition: "MIDDLE", championName: "Hwei" },
		{ participantId: 7, teamId: 200, teamPosition: "JUNGLE", championName: "LeeSin" },
	];
	const frame = (timestamp: number, places: Record<string, { x: number; y: number }>, events: any[] = []) => ({ timestamp, participantFrames: Object.fromEntries(Object.entries(places).map(([id, position]) => [id, { participantId: Number(id), position }])), events });

	test("a death carries who killed it and where the nearest minute frame put everyone near it, with how far off that frame is", () => {
		// Death at 6:06, 6 s after the 6:00 frame and 54 s before the 7:00 one: the 6:00 frame is read.
		const death = { type: "CHAMPION_KILL", killerId: 6, victimId: 1, assistingParticipantIds: [7], timestamp: 366_000, position: { x: 7_000, y: 7_000 } };
		const frames = [
			frame(360_000, { "1": { x: 6_800, y: 6_900 }, "2": { x: 2_000, y: 12_000 }, "6": { x: 7_400, y: 7_300 }, "7": { x: 8_900, y: 6_100 } }, [death]),
			frame(420_000, { "1": { x: 500, y: 500 }, "2": { x: 7_000, y: 7_000 }, "6": { x: 7_000, y: 7_000 }, "7": { x: 7_000, y: 7_000 } }),
		];
		const row = auditGame(minimalMatch({ participants: [me, ...others] }), { info: { frames } }, PUUID, NAMES);
		expect(row.timeline.deaths[0].scene).toEqual({
			killers: ["Hwei", "LeeSin"],
			offsetSec: -6,
			// Vi is across the map and stays off it; the player is the death itself, never a second mark.
			champions: [{ name: "Hwei", ally: false, x: 7_400, y: 7_300 }, { name: "LeeSin", ally: false, x: 8_900, y: 6_100 }],
		});
	});

	test("a later frame is read when it is the nearer one, and a death Riot did not place gets no scene", () => {
		const late = { type: "CHAMPION_KILL", killerId: 6, victimId: 1, timestamp: 402_000, position: { x: 7_000, y: 7_000 } };
		const unplaced = { type: "CHAMPION_KILL", killerId: 6, victimId: 1, timestamp: 425_000 };
		const frames = [frame(360_000, { "2": { x: 7_100, y: 7_100 } }, [late]), frame(420_000, { "2": { x: 9_000, y: 9_000 } }, [unplaced])];
		const row = auditGame(minimalMatch({ participants: [me, ...others] }), { info: { frames } }, PUUID, NAMES);
		expect(row.timeline.deaths[0].scene).toEqual({ killers: ["Hwei"], offsetSec: 18, champions: [{ name: "Vi", ally: true, x: 9_000, y: 9_000 }] });
		expect(row.timeline.deaths[1].scene).toBeUndefined();
	});

	test("a teammate killed seconds before the death is not drawn as an ally near it, though the frame still puts them there", () => {
		const ally = { type: "CHAMPION_KILL", killerId: 6, victimId: 2, timestamp: 362_000, position: { x: 7_100, y: 7_100 } };
		const mine = { type: "CHAMPION_KILL", killerId: 6, victimId: 1, timestamp: 370_000, position: { x: 7_000, y: 7_000 } };
		const frames = [frame(360_000, { "2": { x: 7_100, y: 7_100 }, "6": { x: 7_300, y: 7_200 } }, [ally, mine])];
		const row = auditGame(minimalMatch({ participants: [me, ...others] }), { info: { frames } }, PUUID, NAMES);
		expect(row.timeline.deaths[0].afterAllyDeath).toBe(true);
		expect(row.timeline.deaths[0].scene!.champions.map((champion) => champion.name)).toEqual(["Hwei"]);
	});

	test("a death says what killed it: on the chart mark, and in the line the coach reads; a kill event with no damage list says nothing", () => {
		const hit = (participantId: number, spellSlot: number, magicDamage: number, physicalDamage = 0, basic = false) => ({ participantId, spellSlot, basic, type: "OTHER", magicDamage, physicalDamage, trueDamage: 0 });
		const recap = { type: "CHAMPION_KILL", killerId: 6, victimId: 1, assistingParticipantIds: [7], timestamp: 366_000, position: { x: 7_000, y: 7_000 }, victimDamageReceived: [hit(6, 3, 500), hit(6, 0, 300), hit(7, -1, 0, 200, true)] };
		const bare = { type: "CHAMPION_KILL", killerId: 6, victimId: 1, timestamp: 425_000, position: { x: 7_000, y: 7_000 } };
		const row = auditGame(minimalMatch({ participants: [me, ...others] }), { info: { frames: [frame(360_000, {}, [recap]), frame(420_000, {}, [bare])] } }, PUUID, NAMES);
		expect(row.timeline.deaths[0].damage).toEqual([{ from: "Hwei", how: "R", pct: 50 }, { from: "Hwei", how: "Q", pct: 30 }, { from: "LeeSin", how: "autos", pct: 20 }]);
		expect(deathLine(row.play.deaths[0])).toEndWith("nothing traded back; killing damage: Hwei R 50%, Hwei Q 30%, LeeSin autos 20% (80% magic, 20% physical).");
		expect(row.timeline.deaths[1].damage).toBeUndefined();
		expect(deathLine(row.play.deaths[1])).not.toContain("killing damage");
	});
});

describe("audit-metrics start time", () => {
	test("the game's start time is kept beside its date, and is null when Riot sends none", () => {
		const row = auditGame(minimalMatch({ gameCreation: Date.UTC(2026, 9, 3, 21, 5) }), { info: { frames: [] } }, PUUID, NAMES);
		expect(row.playedAt).toBe("2026-10-03");
		expect(row.playedAtMs).toBe(Date.UTC(2026, 9, 3, 21, 5));
		expect(auditGame(minimalMatch({ gameCreation: undefined }), { info: { frames: [] } }, PUUID, NAMES).playedAtMs).toBeNull();
	});
});

describe("audit-metrics remake detection", () => {
	test("gameEndedInEarlySurrender marks a remake regardless of duration", () => {
		const row = auditGame(minimalMatch({ gameDuration: 468, participants: [{ ...minimalMatch().info.participants[0], gameEndedInEarlySurrender: true }] }), { info: { frames: [] } }, PUUID, NAMES);
		expect(row.remake).toBe(true);
	});

	test("a short game without the flag is not a remake: duration alone is never the signal", () => {
		const row = auditGame(minimalMatch({ gameDuration: 468 }), { info: { frames: [] } }, PUUID, NAMES);
		expect(row.remake).toBe(false);
	});

	test("a surrender before minute 15 is an AFK early surrender (Riot flags it as a plain surrender): remake; a surrender at 20 minutes is a real game", () => {
		// NA1_5649188298: 7:46, gameEndedInSurrender true, gameEndedInEarlySurrender false.
		const early = auditGame(minimalMatch({ gameDuration: 466, participants: [{ ...minimalMatch().info.participants[0], gameEndedInSurrender: true }] }), { info: { frames: [] } }, PUUID, NAMES);
		expect(early.remake).toBe(true);
		const late = auditGame(minimalMatch({ gameDuration: 1200, participants: [{ ...minimalMatch().info.participants[0], gameEndedInSurrender: true }] }), { info: { frames: [] } }, PUUID, NAMES);
		expect(late.remake).toBe(false);
	});
});

describe("audit-metrics ITEM_UNDO", () => {
	test("undoing a second same-named purchase keeps the earlier purchase's timing", () => {
		const names = { items: { 1001: "Boots" }, runes: {}, summoners: {} };
		const events = [
			{ type: "ITEM_PURCHASED", participantId: 1, itemId: 1001, timestamp: 300_000 }, // 5:00
			{ type: "ITEM_PURCHASED", participantId: 1, itemId: 1001, timestamp: 720_000 }, // 12:00
			{ type: "ITEM_UNDO", participantId: 1, beforeId: 1001, timestamp: 720_500 },
		];
		const timeline = { info: { frames: [{ timestamp: 0, participantFrames: {}, events }] } };
		const row = auditGame(minimalMatch(), timeline, PUUID, names);
		expect(row.itemTimingMin["Boots"]).toBe(5);
		expect(row.build.itemOrder).toEqual([{ name: "Boots", min: 5 }]);
	});

	test("undoing the only purchase of an item clears its timing", () => {
		const names = { items: { 1001: "Boots" }, runes: {}, summoners: {} };
		const events = [
			{ type: "ITEM_PURCHASED", participantId: 1, itemId: 1001, timestamp: 300_000 }, // 5:00
			{ type: "ITEM_UNDO", participantId: 1, beforeId: 1001, timestamp: 300_500 },
		];
		const timeline = { info: { frames: [{ timestamp: 0, participantFrames: {}, events }] } };
		const row = auditGame(minimalMatch(), timeline, PUUID, names);
		expect(row.itemTimingMin["Boots"]).toBeUndefined();
		expect(row.build.itemOrder).toEqual([]);
	});
});

describe("audit-metrics vision, damage and objective participation", () => {
	const mate = { participantId: 2, puuid: "mate", teamId: 100, teamPosition: "JUNGLE", championName: "Vi", kills: 4, totalDamageDealtToChampions: 20_000, totalDamageTaken: 20_000 };
	const foe = { participantId: 6, puuid: "foe", teamId: 200, teamPosition: "TOP", championName: "Hwei", kills: 2, totalDamageDealtToChampions: 10_000, totalDamageTaken: 20_000 };
	const match = () => {
		const base = minimalMatch({ gameDuration: 1200 });
		Object.assign(base.info.participants[0], { kills: 3, assists: 1, visionScore: 30, wardsPlaced: 9, wardsKilled: 4, visionWardsBoughtInGame: 2, totalDamageDealtToChampions: 20_000, totalDamageTaken: 10_000, challenges: { turretPlatesTaken: 3 } });
		base.info.participants.push(mate as any, foe as any);
		return base;
	};
	const ev = (type: string, extra: Record<string, unknown>, timestamp: number) => ({ type, timestamp, ...extra });
	const timeline = {
		info: {
			frames: [
				{ timestamp: 0, participantFrames: {}, events: [
					ev("ELITE_MONSTER_KILL", { monsterType: "DRAGON", killerTeamId: 100, killerId: 2, assistingParticipantIds: [1] }, 300_000),
					ev("ELITE_MONSTER_KILL", { monsterType: "DRAGON", killerTeamId: 100, killerId: 2 }, 600_000),
					ev("ELITE_MONSTER_KILL", { monsterType: "DRAGON", killerTeamId: 200, killerId: 6 }, 650_000),
					ev("ELITE_MONSTER_KILL", { monsterType: "RIFTHERALD", killerTeamId: 100, killerId: 1 }, 700_000),
					ev("BUILDING_KILL", { buildingType: "TOWER_BUILDING", teamId: 200, killerId: 2, assistingParticipantIds: [1] }, 800_000),
					ev("BUILDING_KILL", { buildingType: "TOWER_BUILDING", teamId: 200, killerId: 2 }, 900_000),
					ev("BUILDING_KILL", { buildingType: "TOWER_BUILDING", teamId: 100, killerId: 6 }, 950_000),
				] },
			],
		},
	};

	test("vision, damage and participation are read from the payload we already fetch", () => {
		const { play } = auditGame(match(), timeline, PUUID, NAMES);
		expect(play).toMatchObject({ visionScore: 30, wardsPlaced: 9, wardsKilled: 4, controlWards: 2, damageToChampions: 20_000, damageTaken: 10_000, plates: 3 });
		// 20000 over 20 minutes; 10000 of the team's 30000 damage taken.
		expect(play.damagePerMin).toBe(1000);
		expect(play.damageTakenSharePct).toBe(33);
		// On the first of my team's two dragons (an assist), not the second; the enemy's dragon is not ours to be on.
		expect(play.participation).toEqual({ dragon: [1, 2], herald: [1, 1], baron: [0, 0], tower: [1, 2] });
	});

	test("a missing field reads as zero, never NaN", () => {
		const { play } = auditGame(minimalMatch(), { info: { frames: [] } }, PUUID, NAMES);
		expect(play).toMatchObject({ visionScore: 0, wardsKilled: 0, damagePerMin: 0, damageTakenSharePct: null, plates: 0 });
		expect(play.participation).toEqual({ dragon: [0, 0], herald: [0, 0], baron: [0, 0], tower: [0, 0] });
	});

	test("the text leaves out an objective the team never took, and keeps one the player missed", () => {
		expect(participationText({ dragon: [0, 5], herald: [0, 0], baron: [0, 0], tower: [2, 3] })).toBe("0 of 5 dragons, 2 of 3 towers");
		expect(participationText({ dragon: [0, 0], herald: [0, 0], baron: [0, 0], tower: [0, 0] })).toBe("no objective takes");
	});
});

describe("audit habit ranking (#337)", () => {
	const base = auditGame(minimalMatch(), { info: { frames: [] } }, PUUID, NAMES);
	const death = (min: number, over: Partial<DeathMoment> = {}): DeathMoment => ({ min, zone: "enemy top jungle", gold: 0, lead: null, afterAllyDeath: true, traded: false, jungler: false, enemyTook: [], killers: [], worth: false, wonFight: false, ...over });
	const withDeaths = (deaths: DeathMoment[]): GameAudit => ({ ...base, play: { ...base.play, deaths } });

	test("a pattern seen once does not outrank a well-evidenced one", () => {
		const games = [withDeaths([death(5, { jungler: true })]), ...Array.from({ length: 9 }, () => withDeaths([death(20), death(22)]))];
		const order = auditHabits(games).map((habit) => habit.habit);
		expect(order[0]).not.toBe("died to the enemy jungler by minute 15");
		expect(order.indexOf("died to the enemy jungler by minute 15")).toBeGreaterThan(order.indexOf("died past the river after minute 15"));
	});

	test("equal rates order by count, not by array order", () => {
		const one = withDeaths([death(5, { jungler: true })]);
		const ten = Array.from({ length: 10 }, () => withDeaths([death(22)]));
		const order = auditHabits([one, ...ten]).map((habit) => habit.habit);
		// jungler by 15: 1 of 1; past the river after 15: 10 of 10.
		expect(order.indexOf("died past the river after minute 15")).toBeLessThan(order.indexOf("died to the enemy jungler by minute 15"));
	});
});

describe("audit takedowns by 15 (#338)", () => {
	test("a player with 0 kills and 3 assists is read as 3 takedowns, not 3 kills", () => {
		const frames = [3, 4, 5].map((minute) => ({ timestamp: minute * 60_000, participantFrames: {}, events: [{ type: "CHAMPION_KILL", killerId: 2, victimId: 99, assistingParticipantIds: [1], timestamp: minute * 60_000, position: { x: 0, y: 0 } }] }));
		const row = auditGame(minimalMatch(), { info: { frames } }, PUUID, NAMES);
		expect(row.kills).toBe(0);
		expect(row.killsAt15).toBe(3);
		const text = auditPassageText([row], summarizeAudit([row], []));
		expect(text).toContain("3 takedowns (kills and assists) by 15");
		expect(text).not.toContain("3 kills by 15");
	});
});

describe("audit lead at the end of a long game (#341)", () => {
	test("leadEnd is the last frame and leadPeak covers the whole game", () => {
		const match = minimalMatch();
		match.info.participants.push({ ...match.info.participants[0], participantId: 6, puuid: "opp", teamId: 200 } as any);
		const frames = Array.from({ length: 71 }, (_, minute) => ({ timestamp: minute * 60_000, participantFrames: { "1": { totalGold: minute * 100 }, "6": { totalGold: 0 } }, events: [] }));
		const row = auditGame(match, { info: { frames } }, PUUID, NAMES);
		expect(row.timeline.goldDiff.length).toBe(CHART_MAX_MINUTES);
		expect(row.play.leadEnd).toBe(7000);
		expect(row.play.leadPeak).toBe(7000);
		expect(row.play.leadPeakMin).toBe(70);
	});
});
