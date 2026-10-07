import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import { Agent, type request } from "node:https";
import { LcuClient, type LcuTarget, type LcuTransport, computeLcuFooterState, inferPositions, lcuSourceFromEnv, lockedDraftKey, parseFrames, pickKey, selfPickOf, settlePick, recordingSource, httpsTransport, laneRate, lanePositionWord, primaryLane, createLcuFooterState, type LcuFooterHandle, discoverLcu, findLockfilePath, formatComposition, type ItemPrices, isAllowedLcuHost, parseLockfile, readChampSelect, readComposition, readGameflowPhase, readLiveGame, readLivePanel, readRankedSolo, readSummoner } from "./lcu";

const PASSWORD = "s3cr3t-lockfile-pw";
let base: string;

function tempFile(name: string, content: string): string {
	const path = join(base, name);
	writeFileSync(path, content);
	return path;
}

afterAll(() => {
	if (base) rmSync(base, { recursive: true, force: true });
});

base = mkdtempSync(join(tmpdir(), "voxren-lcu-"));

/** A fake transport records every call it received, so a rejected request can be proven never to have fired. */
function fakeTransport(responses: Record<string, { status?: number; body: unknown }>) {
	const calls: string[] = [];
	const transport: LcuTransport = async (_target, path) => {
		calls.push(path);
		const entry = responses[path];
		if (!entry) return { status: 404, text: "" };
		return { status: entry.status ?? 200, text: JSON.stringify(entry.body) };
	};
	return { transport, calls };
}

function client(target: Partial<LcuTarget>, responses: Record<string, { status?: number; body: unknown }> = {}) {
	const { transport, calls } = fakeTransport(responses);
	const full: LcuTarget = { host: "127.0.0.1", port: 12345, password: PASSWORD, ...target };
	return { client: new LcuClient(full, { transport }), calls };
}

describe("lockfile parsing", () => {
	test("valid 5-field content yields port and password", () => {
		expect(parseLockfile("LeagueClientUx:12345:54321:abc123:https")).toEqual({ port: 54321, password: "abc123" });
	});

	test("wrong field count is rejected", () => {
		expect(parseLockfile("LeagueClientUx:12345:54321:abc123")).toBeUndefined();
		expect(parseLockfile("a:b:c:d:e:f")).toBeUndefined();
	});

	test("non-numeric port is rejected", () => {
		expect(parseLockfile("LeagueClientUx:12345:not-a-port:abc123:https")).toBeUndefined();
	});

	test("findLockfilePath returns the first existing candidate", () => {
		const real = tempFile("lockfile", "x:1:2:3:https");
		const missing = join(base, "does-not-exist");
		expect(findLockfilePath([missing, real])).toBe(real);
		expect(findLockfilePath([missing])).toBeUndefined();
	});

	test("discoverLcu reads and parses the discovered lockfile", () => {
		const path = tempFile("lockfile-good", "LeagueClientUx:1:54321:abc123:https");
		expect(discoverLcu([path])).toEqual({ port: 54321, password: "abc123" });
	});

	test("discoverLcu is undefined when no candidate exists (client not running)", () => {
		expect(discoverLcu([join(base, "nope")])).toBeUndefined();
	});

	test("discoverLcu is undefined when the lockfile content is malformed", () => {
		const path = tempFile("lockfile-bad", "garbage");
		expect(discoverLcu([path])).toBeUndefined();
	});
});

describe("host guard", () => {
	test("accepts 127.0.0.1 at any port, including the fixed live-client port 2999", () => {
		expect(isAllowedLcuHost("127.0.0.1")).toBe(true);
	});

	test("rejects localhost, ::1, and any other host", () => {
		expect(isAllowedLcuHost("localhost")).toBe(false);
		expect(isAllowedLcuHost("::1")).toBe(false);
		expect(isAllowedLcuHost("example.com")).toBe(false);
	});

	test("LcuClient.get throws for a disallowed host without ever calling the transport", async () => {
		const { client: c, calls } = client({ host: "localhost" });
		await expect(c.get("/lol-summoner/v1/current-summoner")).rejects.toThrow();
		expect(calls).toEqual([]);
	});
});

describe("lane words", () => {
	test("primaryLane: a known champion id's highest-play-rate lane, from data/championRoles.json", () => {
		expect(primaryLane(103)).toBe("middle"); // Ahri, 0.97
		expect(primaryLane(266)).toBe("top"); // Aatrox
		expect(primaryLane(999999)).toBeUndefined(); // no entry for this id
	});

	test("lanePositionWord: LCU assignedPosition -> the coaching word ('mid', not 'middle'); case-insensitive; unrecognized is undefined", () => {
		expect(lanePositionWord("top")).toBe("top");
		expect(lanePositionWord("jungle")).toBe("jungle");
		expect(lanePositionWord("middle")).toBe("mid");
		expect(lanePositionWord("bottom")).toBe("bot");
		expect(lanePositionWord("utility")).toBe("support");
		expect(lanePositionWord("UTILITY")).toBe("support");
		expect(lanePositionWord("")).toBeUndefined();
		expect(lanePositionWord("solo")).toBeUndefined();
	});
});

describe("readSummoner", () => {
	test("fixture: current-summoner response", async () => {
		const { client: c } = client(
			{},
			{ "/lol-summoner/v1/current-summoner": { body: { gameName: "jaden", tagLine: "NA1", summonerLevel: 132, puuid: "should-not-appear" } } },
		);
		expect(await readSummoner(c)).toEqual({ gameName: "jaden", tagLine: "NA1", summonerLevel: 132 });
	});

	test("missing gameName (unexpected shape) yields undefined, never throws", async () => {
		const { client: c } = client({}, { "/lol-summoner/v1/current-summoner": { body: {} } });
		expect(await readSummoner(c)).toBeUndefined();
	});

	test("client unreachable (404/closed) yields undefined", async () => {
		const { client: c } = client({}, {});
		expect(await readSummoner(c)).toBeUndefined();
	});
});

describe("readRankedSolo", () => {
	test("fixture: ranked solo queue present", async () => {
		const { client: c } = client(
			{},
			{ "/lol-ranked/v1/current-ranked-stats": { body: { queueMap: { RANKED_SOLO_5x5: { tier: "GOLD", division: "II", leaguePoints: 47, wins: 132, losses: 118 } } } } },
		);
		expect(await readRankedSolo(c)).toEqual({ tier: "GOLD", division: "II", leaguePoints: 47, wins: 132, losses: 118 });
	});

	test("unranked / in placements (no tier yet) yields undefined, per owner decision (no footer row)", async () => {
		const { client: c } = client({}, { "/lol-ranked/v1/current-ranked-stats": { body: { queueMap: { RANKED_SOLO_5x5: { tier: "", division: "NA" } } } } });
		expect(await readRankedSolo(c)).toBeUndefined();
	});

	test("queueMap missing entirely yields undefined", async () => {
		const { client: c } = client({}, { "/lol-ranked/v1/current-ranked-stats": { body: {} } });
		expect(await readRankedSolo(c)).toBeUndefined();
	});
});

describe("readGameflowPhase", () => {
	for (const phase of ["None", "Lobby", "ChampSelect", "InProgress", "WaitingForStats"]) {
		test(`fixture: phase "${phase}" passes through`, async () => {
			const { client: c } = client({}, { "/lol-gameflow/v1/gameflow-phase": { body: phase } });
			expect(await readGameflowPhase(c)).toBe(phase);
		});
	}

	test("client unreachable yields undefined", async () => {
		const { client: c } = client({}, {});
		expect(await readGameflowPhase(c)).toBeUndefined();
	});
});

// A trimmed, real-shaped champ-select session: one locked ally pick (TOP), one open enemy slot
// assigned the same role, one completed ally ban, one completed enemy ban, one in-progress
// (uncompleted) ban action.
const CHAMP_SELECT_BODY = {
	myTeam: [
		{ cellId: 0, championId: 84, championPickIntent: 0, assignedPosition: "top", spell1Id: 4, spell2Id: 7 },
		{ cellId: 1, championId: 0, championPickIntent: 64, assignedPosition: "jungle", spell1Id: 11, spell2Id: 4 },
	],
	theirTeam: [{ cellId: 5, championId: 0, championPickIntent: 0, assignedPosition: "top", spell1Id: 4, spell2Id: 14 }],
	localPlayerCellId: 0,
	actions: [
		[
			{ id: 1, actorCellId: 0, championId: 12, type: "ban", completed: true, isAllyAction: true },
			{ id: 2, actorCellId: 5, championId: 45, type: "ban", completed: true, isAllyAction: false },
			{ id: 3, actorCellId: 1, championId: 0, type: "ban", completed: false, isAllyAction: true },
		],
	],
	timer: { phase: "BAN_PICK", adjustedTimeLeftInPhase: 24000 },
};

describe("readChampSelect", () => {
	test("fixture: champ-select session parses teams, completed-only bans, and the timer", async () => {
		const { client: c } = client({}, { "/lol-champ-select/v1/session": { body: CHAMP_SELECT_BODY } });
		expect(await readChampSelect(c)).toEqual({
			kind: "champSelect",
			myTeam: [
				{ cellId: 0, championId: 84, championPickIntent: 0, assignedPosition: "top", spell1Id: 4, spell2Id: 7 },
				{ cellId: 1, championId: 0, championPickIntent: 64, assignedPosition: "jungle", spell1Id: 11, spell2Id: 4 },
			],
			theirTeam: [{ cellId: 5, championId: 0, championPickIntent: 0, assignedPosition: "top", spell1Id: 4, spell2Id: 14 }],
			bans: [
				{ championId: 12, isAllyBan: true },
				{ championId: 45, isAllyBan: false },
			],
			banSlotsTotal: 3,
			banSlotsDone: 2,
			localPlayerCellId: 0,
			timerPhase: "BAN_PICK",
			secondsLeft: 24,
		});
	});

	test("client unreachable yields undefined", async () => {
		const { client: c } = client({}, {});
		expect(await readChampSelect(c)).toBeUndefined();
	});

	test("missing/malformed fields degrade to empty, never throw", async () => {
		const { client: c } = client({}, { "/lol-champ-select/v1/session": { body: {} } });
		expect(await readChampSelect(c)).toEqual({
			kind: "champSelect",
			myTeam: [],
			theirTeam: [],
			bans: [],
			banSlotsTotal: 0,
			banSlotsDone: 0,
			localPlayerCellId: 0,
			timerPhase: "",
			secondsLeft: 0,
		});
	});
});

// A trimmed, real-shaped `/liveclientdata/allgamedata` body: the active player plus one enemy.
const LIVE_GAME_BODY = {
	activePlayer: { riotIdGameName: "jaden", currentGold: 450, championStats: { currentHealth: 1234, maxHealth: 2000 } },
	gameData: { gameTime: 872 },
	events: {
		Events: [
			{ EventID: 0, EventName: "GameStart", EventTime: 0 },
			{ EventID: 1, EventName: "DragonKill", EventTime: 480, DragonType: "Earth", KillerName: "enemy1" },
			{ EventID: 2, EventName: "TurretKilled", EventTime: 600, TurretKilled: "Turret_T2_L_03_A", KillerName: "jaden" },
			{ EventID: 3, EventName: "HeraldKill", EventTime: 700, KillerName: "jaden" },
			{ EventID: 4, EventName: "ChampionKill", EventTime: 710, KillerName: "jaden" },
		],
	},
	allPlayers: [
		{
			championName: "Aatrox",
			team: "ORDER",
			position: "TOP",
			level: 11,
			isDead: false,
			respawnTimer: 0,
			riotIdGameName: "jaden",
			items: [
				{ itemID: 3078, displayName: "Trinity Force", slot: 0, count: 1 },
				{ itemID: 2003, displayName: "Health Potion", slot: 1, count: 2 },
				{ itemID: 3340, displayName: "Stealth Ward", slot: 6, count: 1 },
			],
			scores: { kills: 4, deaths: 1, assists: 6, creepScore: 122, wardScore: 2.5 },
			runes: { keystone: { displayName: "Conqueror" } },
			summonerSpells: { summonerSpellOne: { displayName: "Flash" }, summonerSpellTwo: { displayName: "Ignite" } },
		},
		{ championName: "Darius", team: "CHAOS", position: "TOP", level: 10, isDead: true, riotIdGameName: "enemy1", scores: { kills: 1, deaths: 4, assists: 0, creepScore: 90, wardScore: 1 } },
	],
};

describe("readLivePanel", () => {
	test("gives the game clock and the player's own items, stack counts dropped", async () => {
		const { client: c } = client({}, { "/liveclientdata/allgamedata": { body: LIVE_GAME_BODY } });
		expect(await readLivePanel(() => c)).toEqual({ gameTimeSec: 872, ownedItems: ["Trinity Force", "Health Potion"] });
	});
	test("no game running reads as nothing", async () => {
		const { client: c } = client({});
		expect(await readLivePanel(() => c)).toBeUndefined();
	});
	test("a live client that never answers is cut at the deadline", async () => {
		const hung = { get: () => new Promise(() => {}) } as unknown as LcuClient;
		expect(await readLivePanel(() => hung, 20)).toBeUndefined();
	});
});

describe("readLiveGame", () => {
	test("fixture: allgamedata parses the roster, self identity, and self gold only", async () => {
		const { client: c } = client({}, { "/liveclientdata/allgamedata": { body: LIVE_GAME_BODY } });
		const result = await readLiveGame(c);
		expect(result?.gameTimeSec).toBe(872);
		expect(result?.selfName).toBe("jaden");
		expect(result?.selfGold).toBe(450);
		expect(result?.players).toHaveLength(2);
		expect(result?.players[0]).toEqual({
			championName: "Aatrox",
			team: "ORDER",
			position: "TOP",
			level: 11,
			isDead: false,
			respawnTimer: 0,
			kills: 4,
			deaths: 1,
			assists: 6,
			creepScore: 122,
			wardScore: 2.5,
			riotIdGameName: "jaden",
			keystone: "Conqueror",
			summonerSpells: ["Flash", "Ignite"],
			items: ["Trinity Force", "Health Potion x2"],
			itemStacks: [{ id: 3078, count: 1 }, { id: 2003, count: 2 }],
		});
		expect(result?.selfHealthPct).toBe(62);
		expect(result?.objectives).toEqual([
			{ kind: "dragon", timeSec: 480, team: "CHAOS", detail: "Earth" },
			{ kind: "turret", timeSec: 600, team: "ORDER" },
			{ kind: "herald", timeSec: 700, team: "ORDER" },
		]);
	});

	test("no per-player gold field exists anywhere on the shape — the type itself can't carry an enemy gold value", async () => {
		const { client: c } = client({}, { "/liveclientdata/allgamedata": { body: LIVE_GAME_BODY } });
		const result = await readLiveGame(c);
		for (const player of result?.players ?? []) expect(Object.keys(player)).not.toContain("gold");
		expect(JSON.stringify(result?.players)).not.toContain("urrentGold"); // no stray currentGold/gold leaked from the enemy side
	});

	test("client unreachable (no match running) yields undefined", async () => {
		const { client: c } = client({}, {});
		expect(await readLiveGame(c)).toBeUndefined();
	});

	test("a zeroed pre-load body (no players, no clock) yields undefined", async () => {
		const { client: c } = client({}, { "/liveclientdata/allgamedata": { body: { activePlayer: {}, gameData: { gameTime: 0 }, allPlayers: [] } } });
		expect(await readLiveGame(c)).toBeUndefined();
	});
});

describe("httpsTransport", () => {
	test("a multi-byte character split across two chunks arrives whole", async () => {
		const sent = '{"n":"한국어플레이어"}';
		const bytes = Buffer.from(sent);
		// A fake `request`: the response arrives as 7-byte chunks, so a chunk boundary lands inside a character.
		const fakeRequest = ((_options: unknown, onResponse: (res: EventEmitter) => void) => {
			const req = Object.assign(new EventEmitter(), { end: () => {
				const res = Object.assign(new EventEmitter(), { statusCode: 200 });
				onResponse(res);
				for (let at = 0; at < bytes.length; at += 7) res.emit("data", bytes.subarray(at, at + 7));
				res.emit("end");
			}, destroy: () => {} });
			return req;
		}) as unknown as typeof request;
		const reply = await httpsTransport({ host: "127.0.0.1", port: 1, password: "x" }, "/a", new Agent(), 1000, fakeRequest);
		expect(reply.text).toBe(sent);
	});

	test("a client that accepts the socket but never answers rejects within the timeout instead of hanging", async () => {
		const server = createServer(() => {});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		try {
			const started = Date.now();
			await expect(httpsTransport({ host: "127.0.0.1", port, password: "x" }, "/lol-summoner/v1/current-summoner", new Agent(), 100)).rejects.toThrow("timed out");
			expect(Date.now() - started).toBeLessThan(2000);
		} finally {
			server.close();
		}
	});
});

describe("formatComposition", () => {
	test("champ select: my-team/their-team/ban lines and the correct enemyLaner (matched by assignedPosition)", async () => {
		const { client: c } = client({}, { "/lol-champ-select/v1/session": { body: CHAMP_SELECT_BODY } });
		const state = await readChampSelect(c);
		const composition = formatComposition(state!);
		expect(composition.text).toContain("Your team: TOP Champion 84 (you), JUNGLE Champion 64");
		expect(composition.text).toContain("Enemy team: TOP open");
		expect(composition.text).toContain("Bans — yours: Champion 12; theirs: Champion 45");
		// their TOP (cellId 5) has no champion locked or hovered — enemyLaner is undefined, not a fabricated pick.
		expect(composition.enemyLaner).toBeUndefined();
		expect(composition.text).not.toContain("lane opponent");
		// The local player (cellId 0) is assigned top — selfLane is the coaching word, not the raw LCU position.
		expect(composition.selfLane).toBe("top");
	});

	test("champ select: the player's own line says hovering for a pick intent with no lock; a lock, an open slot, and a teammate's hover stay plain", async () => {
		const text = async (self: object) => {
			const { client: c } = client({}, { "/lol-champ-select/v1/session": { body: { ...CHAMP_SELECT_BODY, myTeam: [{ ...CHAMP_SELECT_BODY.myTeam[0], ...self }, CHAMP_SELECT_BODY.myTeam[1]] } } });
			return formatComposition((await readChampSelect(c))!, new Map([[84, "Akali"], [64, "Lee Sin"]])).text;
		};
		// The teammate (cell 1) hovers Lee Sin in every case and is never marked.
		expect(await text({ championId: 0, championPickIntent: 84 })).toContain("Your team: TOP Akali (you, hovering), JUNGLE Lee Sin\n");
		expect(await text({ championId: 84, championPickIntent: 84 })).toContain("Your team: TOP Akali (you), JUNGLE Lee Sin\n");
		expect(await text({ championId: 0, championPickIntent: 0 })).toContain("Your team: TOP open (you), JUNGLE Lee Sin\n");
	});

	test("champ select: selfLane is the coaching word for the local player's assigned position, undefined with no assigned role", async () => {
		const middle = { ...CHAMP_SELECT_BODY, myTeam: [{ ...CHAMP_SELECT_BODY.myTeam[0], assignedPosition: "middle" }, CHAMP_SELECT_BODY.myTeam[1]] };
		const { client: c } = client({}, { "/lol-champ-select/v1/session": { body: middle } });
		expect(formatComposition((await readChampSelect(c))!).selfLane).toBe("mid");
		const unassigned = { ...CHAMP_SELECT_BODY, myTeam: [{ ...CHAMP_SELECT_BODY.myTeam[0], assignedPosition: "" }, CHAMP_SELECT_BODY.myTeam[1]] };
		const { client: d } = client({}, { "/lol-champ-select/v1/session": { body: unassigned } });
		expect(formatComposition((await readChampSelect(d))!).selfLane).toBeUndefined();
	});

	test("champ select: enemyLaner resolves to the enemy pick sharing the local player's role", async () => {
		const body = { ...CHAMP_SELECT_BODY, theirTeam: [{ cellId: 5, championId: 234, championPickIntent: 0, assignedPosition: "top", spell1Id: 4, spell2Id: 14 }] };
		const { client: c } = client({}, { "/lol-champ-select/v1/session": { body } });
		const state = await readChampSelect(c);
		expect(formatComposition(state!).enemyLaner).toBe("Champion 234");
		// With Data Dragon names, ids resolve everywhere they appear; unknown ids keep the placeholder.
		const names = new Map([[234, "Viego"], [84, "Akali"], [12, "Alistar"]]);
		const named = formatComposition(state!, names);
		expect(named.enemyLaner).toBe("Viego");
		expect(named.text).toContain("TOP Akali (you)");
		expect(named.text).toContain("Bans — yours: Alistar; theirs: Champion 45");
		// The /comp prompt reads the text, not enemyLaner, so the lane opponent has to be written into it.
		expect(named.text).toContain("Your lane opponent: Viego");
	});

	test("champ select: a fully locked enemy team without roles is guessed by lane play rate, marked as a guess; a real assignedPosition still wins", async () => {
		const enemy = (cellId: number, championId: number) => ({ cellId, championId, championPickIntent: 0, assignedPosition: "", spell1Id: 4, spell2Id: 14 });
		// 103 Ahri (top 0.01), 266 Aatrox (top 1.0), 64 Lee Sin, 222 Jinx, 412 Thresh: the player is top, so Aatrox, by rate.
		const theirTeam = [enemy(5, 103), enemy(6, 266), enemy(7, 64), enemy(8, 222), enemy(9, 412)];
		const { client: c } = client({}, { "/lol-champ-select/v1/session": { body: { ...CHAMP_SELECT_BODY, theirTeam } } });
		const state = await readChampSelect(c);
		expect(formatComposition(state!).enemyLaner).toBe("Champion 266 (guessed by lane rate)");
		expect(formatComposition(state!, new Map([[266, "Aatrox"]])).enemyLaner).toBe("Aatrox (guessed by lane rate)");
		// A session that does assign the enemy role is never second-guessed by rate.
		const assigned = { ...state!, theirTeam: [...state!.theirTeam, { ...enemy(10, 103), assignedPosition: "top" }] };
		expect(formatComposition(assigned).enemyLaner).toBe("Champion 103");
		expect(laneRate(103, "middle")).toBeGreaterThan(0.9);
		expect(laneRate(103, "utility")).toBeLessThan(0.1);
		expect(laneRate(999999, "top")).toBe(0);
	});

	test("champ select: no guess mid-draft (an open enemy slot, even with a hover) or when the best candidate is under the 0.2 floor", async () => {
		const enemy = (cellId: number, championId: number, championPickIntent = 0) => ({ cellId, championId, championPickIntent, assignedPosition: "", spell1Id: 4, spell2Id: 14 });
		// Ahri (top 0.01) is locked while the real top laner (Aatrox) is only hovered: no guess, not Ahri.
		const midDraft = [enemy(5, 103), enemy(6, 0, 266), enemy(7, 64), enemy(8, 222), enemy(9, 412)];
		const { client: c } = client({}, { "/lol-champ-select/v1/session": { body: { ...CHAMP_SELECT_BODY, theirTeam: midDraft } } });
		expect(formatComposition((await readChampSelect(c))!).enemyLaner).toBeUndefined();
		// All five locked, but the best top rate on the team is Ahri's 0.01: below the floor, no guess.
		const belowFloor = [enemy(5, 103), enemy(6, 64), enemy(7, 222), enemy(8, 412), enemy(9, 999999)];
		const { client: d } = client({}, { "/lol-champ-select/v1/session": { body: { ...CHAMP_SELECT_BODY, theirTeam: belowFloor } } });
		expect(formatComposition((await readChampSelect(d))!).enemyLaner).toBeUndefined();
	});

	test("loadChampionNames maps Data Dragon key → name for the latest version, once per process", async () => {
		const { loadChampionNames } = await import("./lcu");
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			const body = url.endsWith("/api/versions.json") ? ["16.19.1", "16.18.1"] : { data: { Fizz: { key: "105", name: "Fizz" }, Akali: { key: "84", name: "Akali" } } };
			return { json: async () => body } as Response;
		}) as unknown as typeof fetch;
		const names = await loadChampionNames(fetchImpl, "https://dd.test");
		expect(names.get(105)).toBe("Fizz");
		expect(calls).toEqual(["https://dd.test/api/versions.json", "https://dd.test/cdn/16.19.1/data/en_US/champion.json"]);
		await loadChampionNames(fetchImpl, "https://dd.test");
		expect(calls).toHaveLength(2);
	});

	test("loadItemPrices prices a consumed item at 0 and a permanent potion at its cost", async () => {
		const { loadItemPrices } = await import("./lcu");
		const fetchImpl = (async (url: string) => {
			const body = url.endsWith("/api/versions.json")
				? ["16.19.1"]
				: {
						data: {
							"3078": { gold: { total: 3333 } },
							"2003": { gold: { total: 50 }, tags: ["Consumable"], consumed: true, stacks: 5 },
							"2031": { gold: { total: 150 }, tags: ["Consumable"] },
							"2033": { gold: { total: 500 }, tags: ["Consumable"], stacks: 1 },
							"1055": { gold: { total: 450 } },
							"9999": {},
						},
					};
			return { json: async () => body } as Response;
		}) as unknown as typeof fetch;
		const prices = await loadItemPrices(fetchImpl, "https://dd-items.test");
		expect([3078, 2003, 2031, 2033, 1055].map((id) => prices.get(id)?.gold)).toEqual([3333, 0, 150, 500, 450]);
		expect([2003, 2031, 3078].map((id) => prices.get(id)?.stackable)).toEqual([true, false, false]);
		expect(prices.has(9999)).toBe(false);
	});

	test("loadItemPrices resolves to an empty map when Data Dragon fails", async () => {
		const { loadItemPrices } = await import("./lcu");
		const fetchImpl = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		expect((await loadItemPrices(fetchImpl, "https://dd-down.test")).size).toBe(0);
	});

	test("champ select: no assigned role (e.g. blind pick) yields no enemyLaner", async () => {
		const body = { ...CHAMP_SELECT_BODY, myTeam: [{ ...CHAMP_SELECT_BODY.myTeam[0], assignedPosition: "" }] };
		const { client: c } = client({}, { "/lol-champ-select/v1/session": { body } });
		const state = await readChampSelect(c);
		expect(formatComposition(state!).enemyLaner).toBeUndefined();
	});

	test("live game at the loading screen: the 0:00 read says the game has not started, a running game does not", async () => {
		const body = { ...LIVE_GAME_BODY, gameData: { ...LIVE_GAME_BODY.gameData, gameTime: 0 } };
		const { client: c } = client({}, { "/liveclientdata/allgamedata": { body } });
		expect(formatComposition((await readLiveGame(c))!).text).toContain("In game, 0:00. Loading screen: the game has not started");
		const { client: running } = client({}, { "/liveclientdata/allgamedata": { body: LIVE_GAME_BODY } });
		expect(formatComposition((await readLiveGame(running))!).text).not.toContain("Loading screen");
	});

	test("live game: clock, self gold and health, objectives, per-player level/KDA/CS/items, and the enemy in the player's position", async () => {
		const { client: c } = client({}, { "/liveclientdata/allgamedata": { body: LIVE_GAME_BODY } });
		const state = await readLiveGame(c);
		const composition = formatComposition(state!);
		expect(composition.text).toContain("In game, 14:32. Your gold: 450. Your health: 62%.");
		expect(composition.text).toContain("Kills: yours 4, theirs 1.");
		expect(composition.text).toContain("Objectives: drakes yours 0, theirs Earth; last drake at 8:00 (6:32 ago); towers taken yours 1, theirs 0; herald yours at 11:40 (2:52 ago).");
		expect(composition.text).toContain("Your lane opponent: Darius; you are +1 level, +32 cs on them.");
		expect(composition.text).toContain("Your team:\n  Aatrox TOP lvl 11 4/1/6 122 cs (you): Trinity Force, Health Potion x2");
		expect(composition.text).toContain("Enemy team:\n  Darius TOP lvl 10 1/4/0 90 cs (dead): no items");
		expect(composition.text).not.toContain("Your deaths");
		expect(composition.enemyLaner).toBe("Darius");
		expect(composition.selfLane).toBe("top");
	});

	test("live game: respawn timers, enemy keystone and spells, skill ranks, the rift, inhibitors, and who has been killing the player", async () => {
		const [self, darius] = LIVE_GAME_BODY.allPlayers;
		// Field and event names as in Riot's published samples (liveclientdata_sample.json, liveclientdata_events.json).
		const body = {
			activePlayer: { ...LIVE_GAME_BODY.activePlayer, abilities: { Passive: {}, Q: { abilityLevel: 5 }, W: { abilityLevel: 1 }, E: { abilityLevel: 3 }, R: { abilityLevel: 2 } } },
			gameData: { gameTime: 872, mapTerrain: "Infernal" },
			allPlayers: [self, { ...darius, respawnTimer: 23.4, runes: { keystone: { displayName: "Conqueror" } }, summonerSpells: { summonerSpellOne: { displayName: "Flash" }, summonerSpellTwo: { displayName: "Ghost" } } }, { championName: "Lee Sin", team: "CHAOS", position: "JUNGLE", level: 9, riotIdGameName: "enemy2" }],
			events: {
				Events: [
					...LIVE_GAME_BODY.events.Events,
					{ EventName: "ChampionKill", EventTime: 300, KillerName: "enemy2", VictimName: "jaden", Assisters: ["enemy1"] },
					{ EventName: "ChampionKill", EventTime: 500, KillerName: "enemy1", VictimName: "jaden", Assisters: [] },
					{ EventName: "ChampionKill", EventTime: 800, KillerName: "enemy2", VictimName: "jaden", Assisters: ["enemy1"] },
					{ EventName: "ChampionKill", EventTime: 810, KillerName: "jaden", VictimName: "enemy1", Assisters: [] },
					{ EventName: "InhibKilled", EventTime: 860, InhibKilled: "Barracks_T2_L1", KillerName: "Minion_T1" },
				],
			},
		};
		const { client: c } = client({}, { "/liveclientdata/allgamedata": { body } });
		const text = formatComposition((await readLiveGame(c))!).text;
		expect(text).toContain("Your skill ranks: Q 5, W 1, E 3, R 2.");
		expect(text).toContain("rift Infernal; towers taken yours 1, theirs 0; inhibitors taken yours 1, theirs 0, last at 14:20 (0:12 ago); herald");
		expect(text).toContain("Your deaths: Lee Sin 2, Darius 1; last at 13:20 (1:12 ago) to Lee Sin with Darius.");
		expect(text).toContain("  Darius TOP lvl 10 1/4/0 90 cs (dead 24s) [Conqueror, Flash, Ghost]: no items");
	});

	describe("live game: what the feed does not say is left out, not made up", () => {
		const [aatrox, darius] = LIVE_GAME_BODY.allPlayers;
		const read = async (body: unknown, prices?: ItemPrices) => {
			const { client: c } = client({}, { "/liveclientdata/allgamedata": { body } });
			return formatComposition((await readLiveGame(c))!, undefined, prices);
		};
		const laneLine = (composition: { text: string }) => composition.text.split("\n").find((line) => line.startsWith("Your lane opponent"));
		const death = (EventTime: number, KillerName: string | undefined, Assisters: string[] = []) => ({ EventName: "ChampionKill", EventTime, ...(KillerName && { KillerName }), VictimName: "jaden", Assisters });

		// ARAM and other queues with no lanes report every player's position as "NONE" or "".
		for (const position of ["NONE", ""]) {
			test(`every position "${position}" (ARAM): no lane opponent is named and no lead is worked out`, async () => {
				const body = { ...LIVE_GAME_BODY, allPlayers: [{ ...aatrox, position }, { ...darius, position }, { ...darius, position, championName: "Lux", riotIdGameName: "enemy2", level: 3 }] };
				const composition = await read(body);
				expect(composition.text).not.toContain("lane opponent");
				expect(composition.enemyLaner).toBeUndefined();
				expect(composition.selfLane).toBeUndefined();
				// The rest of the block still stands.
				expect(composition.text).toContain("Kills: yours 4, theirs 2.");
			});
		}

		test("two enemies reported in the player's position: neither is named the lane opponent", async () => {
			const composition = await read({ ...LIVE_GAME_BODY, allPlayers: [aatrox, darius, { ...darius, championName: "Lee Sin", riotIdGameName: "enemy2" }] });
			expect(composition.text).not.toContain("lane opponent");
			expect(composition.enemyLaner).toBeUndefined();
			expect(composition.selfLane).toBe("top");
		});

		test("a side with no level gets no level or cs lead; the item gold lead still stands", async () => {
			const body = { ...LIVE_GAME_BODY, allPlayers: [aatrox, { ...darius, level: undefined, scores: undefined, items: [{ itemID: 1055, displayName: "Doran's Blade", slot: 0, count: 1 }] }] };
			expect(laneLine(await read(body))).toBe("Your lane opponent: Darius.");
			// Fixture prices, not Data Dragon's.
			const prices: ItemPrices = new Map([[3078, { gold: 3333, stackable: false }], [2003, { gold: 0, stackable: true }], [1055, { gold: 450, stackable: false }]]);
			expect(laneLine(await read(body, prices))).toBe("Your lane opponent: Darius; you are +2883 gold on them (item gold 3333 vs 450).");
		});

		test("a game name two players share: no deaths line, and an objective that name took goes to neither team", async () => {
			const lux = { ...darius, championName: "Lux", position: "MIDDLE", riotIdGameName: "enemy2" };
			const Events = [death(300, "enemy1"), { EventName: "BaronKill", EventTime: 800, KillerName: "jaden" }];
			const body = (third: object) => ({ ...LIVE_GAME_BODY, events: { Events }, allPlayers: [aatrox, darius, third] });
			// An enemy with the player's own game name (another tag): the feed's "jaden" could be either.
			const sharedSelf = await read(body({ ...lux, riotIdGameName: "jaden" }));
			expect(sharedSelf.text).not.toContain("Your deaths");
			expect(sharedSelf.text).toContain("baron ? at 13:20 (1:12 ago)");
			// Two enemies sharing the killer's name: which champion got the kill is unknown.
			expect((await read(body({ ...lux, riotIdGameName: "enemy1" }))).text).not.toContain("Your deaths");
			// The same events with every name held once.
			const distinct = await read(body(lux));
			expect(distinct.text).toContain("Your deaths: Darius 1; last at 5:00 (9:32 ago) to Darius.");
			expect(distinct.text).toContain("baron yours at 13:20 (1:12 ago)");
		});

		test("names that come only as summonerName with a tag match the event feed's bare names", async () => {
			const tagged = <T extends { riotIdGameName: string }>(player: T) => ({ ...player, riotIdGameName: "", summonerName: `${player.riotIdGameName}#NA1` });
			const body = {
				...LIVE_GAME_BODY,
				activePlayer: tagged(LIVE_GAME_BODY.activePlayer),
				allPlayers: [tagged(aatrox), tagged(darius)],
				events: { Events: [...LIVE_GAME_BODY.events.Events, death(300, "enemy1")] },
			};
			const { client: c } = client({}, { "/liveclientdata/allgamedata": { body } });
			expect((await readLiveGame(c))?.selfName).toBe("jaden");
			const text = (await read(body)).text;
			expect(text).toContain("Objectives: drakes yours 0, theirs Earth; last drake at 8:00 (6:32 ago); towers taken yours 1, theirs 0; herald yours at 11:40 (2:52 ago).");
			expect(text).toContain("Your deaths: Darius 1; last at 5:00 (9:32 ago) to Darius.");
			expect(text).toContain("Aatrox TOP lvl 11 4/1/6 122 cs (you)");
		});

		test("two players with one game name and different tags: the tag picks the player's row, on the other team and second in the list", async () => {
			// "jaden#NA1" plays Aatrox on ORDER and is listed first; the player is "jaden#EUW", Darius on CHAOS.
			const body = (active: object, first: object, second: object) => ({
				...LIVE_GAME_BODY,
				activePlayer: { ...LIVE_GAME_BODY.activePlayer, ...active },
				allPlayers: [{ ...aatrox, ...first }, { ...darius, riotIdGameName: "jaden", ...second }],
				events: { Events: [...LIVE_GAME_BODY.events.Events, death(300, "enemy1")] },
			});
			const tag = (riotIdTagLine: string) => ({ riotIdTagLine });
			const riotId = (tagLine: string) => ({ riotId: `jaden#${tagLine}` });
			// The tag as its own field, as the end of `riotId` alone, and on the player's row but not the other one.
			for (const game of [body(tag("EUW"), tag("NA1"), tag("EUW")), body(riotId("EUW"), riotId("NA1"), riotId("EUW")), body(tag("EUW"), tag("NA1"), {})]) {
				const composition = await read(game);
				const marked = composition.text.split("\n").filter((line) => line.includes("(you)"));
				expect(marked).toEqual(["  Darius TOP lvl 10 1/4/0 90 cs (dead) (you): no items"]);
				expect(composition.text).toContain("Kills: yours 1, theirs 4.");
				expect(composition.text).toContain("Your team:\n  Darius");
				expect(composition.text).toContain("Enemy team:\n  Aatrox");
				expect(composition.enemyLaner).toBe("Aatrox");
				// The event feed says "jaden" for both of them: whose deaths, and whose herald, stays unsaid.
				expect(composition.text).not.toContain("Your deaths");
				expect(composition.text).toContain("herald ? at 11:40");
				const { transport } = fakeTransport({ "/lol-gameflow/v1/gameflow-phase": { body: "InProgress" }, "/liveclientdata/allgamedata": { body: game } });
				const footer = await computeLcuFooterState(() => ({ port: 12345, password: PASSWORD }), (target) => new LcuClient(target, { transport }));
				expect(footer).toMatchObject({ kind: "liveGame", self: { championName: "Darius", kills: 1, deaths: 4 } });
			}
			// No tag on the active player, or on no row: the name decides, the first row that has it.
			for (const game of [body({}, tag("NA1"), tag("EUW")), body(tag("EUW"), {}, {})]) expect((await read(game)).text).toContain("Aatrox TOP lvl 11 4/1/6 122 cs (you)");
		});

		test("an execute with minions among the assisters: only players are named, each once", async () => {
			const withDeath = (kill: object) => read({ ...LIVE_GAME_BODY, events: { Events: [kill] } });
			expect((await withDeath(death(800, "Turret_T2_L_03_A", ["Minion_T200L0S0", "enemy1", "Minion_T200L1S2", "enemy1"]))).text).toContain("Your deaths: a tower or monster 1; last at 13:20 (1:12 ago) to a tower or monster with Darius.");
			expect((await withDeath(death(800, undefined, ["Minion_T200L0S0", "Minion_T200L1S2"]))).text).toContain("Your deaths: a tower or monster 1; last at 13:20 (1:12 ago) to a tower or monster.");
		});

		test("an event ahead of the game clock (spectator delay) gets its time and no 'ago'; one at the clock reads 0:00 ago", async () => {
			const Events = [{ EventName: "DragonKill", EventTime: 900, DragonType: "Earth", KillerName: "enemy1" }, { EventName: "HeraldKill", EventTime: 872, KillerName: "jaden" }, death(880, "enemy1")];
			const text = (await read({ ...LIVE_GAME_BODY, events: { Events } })).text;
			expect(text).toContain("Objectives: drakes yours 0, theirs Earth; last drake at 15:00; towers taken yours 0, theirs 0; herald yours at 14:32 (0:00 ago).");
			expect(text).toContain("Your deaths: Darius 1; last at 14:40 to Darius.");
		});
	});

	describe("gold lead on the lane opponent", () => {
		// Fixture prices, not Data Dragon's: 3078 Trinity Force, 3071 Black Cleaver, 1055 Doran's Blade, 2003 Health Potion (consumable).
		const PRICES: ItemPrices = new Map([[3078, 3333], [3071, 3000], [1055, 450], [2003, 0], [2033, 500], [4001, 100]].map(([id, gold]) => [id, { gold, stackable: id === 4001 || id === 2003 }]));
		const darius = LIVE_GAME_BODY.allPlayers[1];
		const withEnemyItems = (items: unknown[], extra: unknown[] = []) => ({
			...LIVE_GAME_BODY,
			allPlayers: [LIVE_GAME_BODY.allPlayers[0], { ...darius, items }, ...extra],
		});
		const laneLine = async (body: unknown, prices?: ItemPrices) => {
			const { client: c } = client({}, { "/liveclientdata/allgamedata": { body } });
			return formatComposition((await readLiveGame(c))!, undefined, prices).text.split("\n").find((line) => line.startsWith("Your lane opponent"));
		};

		test("item gold of both laners, consumables and the trinket not counted, with the sign and both totals", async () => {
			const enemy = [{ itemID: 3071, displayName: "Black Cleaver", slot: 0, count: 1 }, { itemID: 1055, displayName: "Doran's Blade", slot: 1, count: 1 }, { itemID: 3340, displayName: "Stealth Ward", slot: 6, count: 1 }];
			expect(await laneLine(withEnemyItems(enemy), PRICES)).toBe("Your lane opponent: Darius; you are +1 level, +32 cs, -117 gold on them (item gold 3333 vs 3450).");
			const behind = [{ itemID: 1055, displayName: "Doran's Blade", slot: 0, count: 1 }];
			expect(await laneLine(withEnemyItems(behind), PRICES)).toContain("+2883 gold on them (item gold 3333 vs 450).");
		});

		test("a stackable item counts every copy", async () => {
			expect(await laneLine(withEnemyItems([{ itemID: 4001, displayName: "Stackable", slot: 0, count: 3 }]), PRICES)).toContain("+3033 gold on them (item gold 3333 vs 300).");
		});

		test("a permanent potion's count is charges, so it is priced once", async () => {
			expect(await laneLine(withEnemyItems([{ itemID: 2033, displayName: "Corrupting Potion", slot: 0, count: 2 }]), PRICES)).toContain("+2833 gold on them (item gold 3333 vs 500).");
		});

		test("an even count reads +0, not a bare 0", async () => {
			expect(await laneLine(withEnemyItems([{ itemID: 3078, displayName: "Trinity Force", slot: 0, count: 1 }]), PRICES)).toContain("+0 gold on them (item gold 3333 vs 3333).");
		});

		test("an item with no price leaves the clause out, as does no price data", async () => {
			const unknown = [{ itemID: 7777, displayName: "Patch Item", slot: 0, count: 1 }];
			const today = "Your lane opponent: Darius; you are +1 level, +32 cs on them.";
			expect(await laneLine(withEnemyItems(unknown), PRICES)).toBe(today);
			expect(await laneLine(withEnemyItems([]), new Map())).toBe(today);
			expect(await laneLine(withEnemyItems([]))).toBe(today);
		});

		test("the opponent is the enemy in the player's position, not another enemy", async () => {
			const jungle = { championName: "Lee Sin", team: "CHAOS", position: "JUNGLE", level: 9, riotIdGameName: "enemy2", items: [{ itemID: 3078, displayName: "Trinity Force", slot: 0, count: 1 }] };
			const line = await laneLine(withEnemyItems([{ itemID: 1055, displayName: "Doran's Blade", slot: 0, count: 1 }], [jungle]), PRICES);
			expect(line).toContain("Darius");
			expect(line).toContain("vs 450");
		});
	});

	test("live game: the rune page the player took is listed in the build format's order, so a rune question never has to ask for it", async () => {
		const fullRunes = {
			generalRunes: ["Electrocute", "Sudden Impact", "Grisly Mementos", "Ultimate Hunter", "Presence of Mind", "Legend: Haste"].map((displayName) => ({ displayName })),
			statRunes: [{ id: 5008 }, { id: 5008 }, { id: 5001 }],
		};
		const body = { ...LIVE_GAME_BODY, activePlayer: { ...LIVE_GAME_BODY.activePlayer, fullRunes } };
		const { client: c } = client({}, { "/liveclientdata/allgamedata": { body } });
		const state = await readLiveGame(c);
		expect(formatComposition(state!).text).toContain(
			"Your runes: Electrocute, Sudden Impact, Grisly Mementos, Ultimate Hunter; Presence of Mind, Legend: Haste; Adaptive Force, Adaptive Force, Health Scaling; Flash, Ignite.",
		);
	});

	test("live game: no rune line when the feed carries no rune page", async () => {
		const { client: c } = client({}, { "/liveclientdata/allgamedata": { body: LIVE_GAME_BODY } });
		expect(formatComposition((await readLiveGame(c))!).text).not.toContain("Your runes");
	});

	test("live game: self gold is stated only when present, and no enemy figure is ever produced (the field doesn't exist on an enemy player)", async () => {
		const noGold = { ...LIVE_GAME_BODY, activePlayer: { riotIdGameName: "jaden" } };
		const { client: c } = client({}, { "/liveclientdata/allgamedata": { body: noGold } });
		const state = await readLiveGame(c);
		expect(state?.selfGold).toBeUndefined();
		expect(formatComposition(state!).text).not.toContain("gold");
		expect(state?.players.every((player) => !("currentGold" in player) && !("gold" in player))).toBe(true);
	});
});

describe("redaction", () => {
	test("no read function's output ever contains the lockfile password", async () => {
		const { client: c } = client(
			{},
			{
				"/lol-summoner/v1/current-summoner": { body: { gameName: "jaden", tagLine: "NA1", summonerLevel: 132, note: PASSWORD } },
				"/lol-ranked/v1/current-ranked-stats": { body: { queueMap: { RANKED_SOLO_5x5: { tier: "GOLD", division: "II", leaguePoints: 47, wins: 1, losses: 1 } } } },
				"/lol-gameflow/v1/gameflow-phase": { body: "Lobby" },
				"/lol-champ-select/v1/session": { body: { ...CHAMP_SELECT_BODY, myTeam: [{ ...CHAMP_SELECT_BODY.myTeam[0], note: PASSWORD }] } },
				"/liveclientdata/allgamedata": { body: { ...LIVE_GAME_BODY, activePlayer: { ...LIVE_GAME_BODY.activePlayer, note: PASSWORD } } },
			},
		);
		const [summoner, rank, phase, champSelect, liveGame] = await Promise.all([readSummoner(c), readRankedSolo(c), readGameflowPhase(c), readChampSelect(c), readLiveGame(c)]);
		const results = [summoner, rank, phase, champSelect, liveGame, champSelect && formatComposition(champSelect), liveGame && formatComposition(liveGame)];
		for (const result of results) expect(JSON.stringify(result ?? null)).not.toContain(PASSWORD);
	});
});

describe("computeLcuFooterState", () => {
	const LOCK = { port: 12345, password: PASSWORD };
	const SUMMONER_BODY = { gameName: "jaden", tagLine: "NA1", summonerLevel: 132 };
	const RANK_BODY = { queueMap: { RANKED_SOLO_5x5: { tier: "GOLD", division: "II", leaguePoints: 47, wins: 132, losses: 118 } } };

	function fixture(responses: Record<string, { status?: number; body: unknown }>) {
		const { transport, calls } = fakeTransport(responses);
		return { discover: () => LOCK, makeClient: (target: LcuTarget) => new LcuClient(target, { transport }), calls };
	}

	test("no lockfile (client closed) yields the closed bucket, no requests made", async () => {
		const { calls } = fixture({});
		expect(await computeLcuFooterState(() => undefined, () => new LcuClient({ host: "127.0.0.1", port: 1, password: "x" }))).toEqual({ kind: "closed" });
		expect(calls).toEqual([]);
	});

	for (const phase of ["None", "Lobby", "PreEndOfGame", "EndOfGame"]) {
		test(`phase "${phase}" with summoner and rank present yields the lobby bucket`, async () => {
			const { discover, makeClient } = fixture({
				"/lol-gameflow/v1/gameflow-phase": { body: phase },
				"/lol-summoner/v1/current-summoner": { body: SUMMONER_BODY },
				"/lol-ranked/v1/current-ranked-stats": { body: RANK_BODY },
			});
			expect(await computeLcuFooterState(discover, makeClient)).toEqual({
				kind: "lobby",
				summoner: { gameName: "jaden", tagLine: "NA1", summonerLevel: 132 },
				rank: { tier: "GOLD", division: "II", leaguePoints: 47, wins: 132, losses: 118 },
				recent: [],
			});
		});
	}

	test("lobby recent form: last five ranked solo results newest first from the client's match history, other queues skipped", async () => {
		const game = (queueId: number, win: boolean) => ({ queueId, participants: [{ stats: { win } }] });
		const { discover, makeClient } = fixture({
			"/lol-gameflow/v1/gameflow-phase": { body: "None" },
			"/lol-summoner/v1/current-summoner": { body: SUMMONER_BODY },
			"/lol-ranked/v1/current-ranked-stats": { body: RANK_BODY },
			"/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=9": {
				body: { games: { games: [game(420, true), game(450, true), game(420, false), game(420, true), game(420, true), game(420, false), game(420, true)] } },
			},
		});
		const state = await computeLcuFooterState(discover, makeClient);
		expect(state.kind === "lobby" && state.recent).toEqual([true, false, true, true, false]);
	});

	test("a lockfile whose client refuses the phase read yields closed with a reason naming the port and the failure", async () => {
		const { discover, makeClient } = fixture({});
		expect(await computeLcuFooterState(discover, makeClient)).toEqual({ kind: "closed", reason: "League client found on port 12345 but unreadable: lcu: /lol-gameflow/v1/gameflow-phase returned 404" });
		const noSummoner = fixture({ "/lol-gameflow/v1/gameflow-phase": { body: "Lobby" }, "/lol-ranked/v1/current-ranked-stats": { body: RANK_BODY } });
		expect(await computeLcuFooterState(noSummoner.discover, noSummoner.makeClient)).toEqual({ kind: "closed", reason: "League client found on port 12345 but the signed-in summoner is unreadable" });
	});

	// The check that ships with the project: with a League client open on this machine, the real lockfile, TLS pin, and
	// endpoints answer the footer poll. Skipped without a client; a failure prints the reason the header would show.
	test.skipIf(!findLockfilePath())("the open League client on this machine answers the footer poll", async () => {
		const state = await computeLcuFooterState();
		expect(state.kind === "closed" ? (state.reason ?? "closed") : state.kind).not.toStartWith("League client found");
	});

	test("a phase this step doesn't render (e.g. matchmaking) yields closed, without ever reading summoner/rank", async () => {
		const { discover, makeClient, calls } = fixture({ "/lol-gameflow/v1/gameflow-phase": { body: "Matchmaking" } });
		expect(await computeLcuFooterState(discover, makeClient)).toEqual({ kind: "closed" });
		expect(calls).toEqual(["/lol-gameflow/v1/gameflow-phase"]);
	});

	test("phase ChampSelect reads the champ-select session and yields the champSelect bucket", async () => {
		const { discover, makeClient, calls } = fixture({
			"/lol-gameflow/v1/gameflow-phase": { body: "ChampSelect" },
			"/lol-champ-select/v1/session": {
				body: {
					myTeam: [{ cellId: 0, championId: 84, championPickIntent: 0, assignedPosition: "top", spell1Id: 4, spell2Id: 7 }],
					theirTeam: [{ cellId: 5, championId: 0, championPickIntent: 0, assignedPosition: "", spell1Id: 4, spell2Id: 14 }],
					localPlayerCellId: 0,
					actions: [],
					timer: { phase: "BAN_PICK", adjustedTimeLeftInPhase: 24000 },
				},
			},
		});
		expect(await computeLcuFooterState(discover, makeClient)).toEqual({
			kind: "champSelect",
			secondsLeft: 24,
			selfPosition: "top",
			picksMade: 1,
			picksTotal: 2,
			bansMade: 0,
			bansTotal: 0,
			selfPick: { championId: 84, locked: true },
		});
		expect(calls).toEqual(["/lol-gameflow/v1/gameflow-phase", "/lol-champ-select/v1/session", "/lol-summoner/v1/current-summoner"]); // the header name is read alongside
	});

	test("a skipped ban is a used slot: the footer's ban count completes, the named list stays free of it", async () => {
		const ban = (id: number, championId: number) => ({ id, actorCellId: id, championId, type: "ban", completed: true, isAllyAction: true });
		const { discover, makeClient } = fixture({
			"/lol-gameflow/v1/gameflow-phase": { body: "ChampSelect" },
			"/lol-champ-select/v1/session": { body: { ...CHAMP_SELECT_BODY, actions: [[ban(1, 12), ban(2, 0), ban(3, 0)]] } },
		});
		const state = await computeLcuFooterState(discover, makeClient);
		expect(state.kind === "champSelect" && [state.bansMade, state.bansTotal]).toEqual([3, 3]);
		const { client: c } = client({}, { "/lol-champ-select/v1/session": { body: { ...CHAMP_SELECT_BODY, actions: [[ban(1, 12), ban(2, 0), ban(3, 0)]] } } });
		expect((await readChampSelect(c))?.bans).toEqual([{ championId: 12, isAllyBan: true }]);
	});

	test("champ-select session unreachable (e.g. torn down mid-poll) yields closed", async () => {
		const { discover, makeClient } = fixture({ "/lol-gameflow/v1/gameflow-phase": { body: "ChampSelect" } });
		expect(await computeLcuFooterState(discover, makeClient)).toEqual({ kind: "closed" });
	});

	for (const phase of ["InProgress", "WaitingForStats"]) {
		test(`phase "${phase}" reads the fixed live-client port (never the lockfile port) and yields the liveGame bucket`, async () => {
			const { discover, makeClient, calls } = fixture({
				"/lol-gameflow/v1/gameflow-phase": { body: phase },
				"/liveclientdata/allgamedata": {
					body: {
						activePlayer: { riotIdGameName: "jaden", currentGold: 450 },
						gameData: { gameTime: 872 },
						allPlayers: [{ championName: "Aatrox", team: "ORDER", position: "TOP", level: 11, riotIdGameName: "jaden", scores: { kills: 4, deaths: 1, assists: 6, creepScore: 122 } }],
					},
				},
			});
			expect(await computeLcuFooterState(discover, makeClient)).toEqual({
				kind: "liveGame",
				gameTimeSec: 872,
				self: { championName: "Aatrox", position: "TOP", level: 11, kills: 4, deaths: 1, assists: 6, creepScore: 122 },
			});
			expect(calls).toEqual(["/lol-gameflow/v1/gameflow-phase", "/liveclientdata/allgamedata", "/lol-summoner/v1/current-summoner"]); // the header name is read alongside
		});
	}

	test("live client unreachable (no match running) yields closed", async () => {
		const { discover, makeClient } = fixture({ "/lol-gameflow/v1/gameflow-phase": { body: "InProgress" } });
		expect(await computeLcuFooterState(discover, makeClient)).toEqual({ kind: "closed" });
	});

	test("unranked / in placements (no tier) yields closed, per owner decision — no row until placed", async () => {
		const { discover, makeClient } = fixture({
			"/lol-gameflow/v1/gameflow-phase": { body: "Lobby" },
			"/lol-summoner/v1/current-summoner": { body: SUMMONER_BODY },
			"/lol-ranked/v1/current-ranked-stats": { body: { queueMap: { RANKED_SOLO_5x5: { tier: "", division: "NA" } } } },
		});
		expect(await computeLcuFooterState(discover, makeClient)).toEqual({ kind: "closed" });
	});

	test("client unreachable (gameflow read fails) yields closed, with the reason", async () => {
		const { discover, makeClient } = fixture({});
		expect((await computeLcuFooterState(discover, makeClient)).kind).toBe("closed");
	});
});

describe("readComposition", () => {
	const NO_NAMES = async () => new Map<number, string>();
	const LOCK = { port: 12345, password: PASSWORD };

	function fixture(responses: Record<string, { status?: number; body: unknown }>) {
		const { transport, calls } = fakeTransport(responses);
		return { discover: () => LOCK, makeClient: (target: LcuTarget) => new LcuClient(target, { transport }), calls };
	}

	test("no lockfile (client closed) yields undefined, no requests made", async () => {
		const { calls, makeClient } = fixture({});
		expect(await readComposition(() => undefined, makeClient, undefined, NO_NAMES)).toBeUndefined();
		expect(calls).toEqual([]);
	});

	for (const phase of ["None", "Lobby", "Matchmaking"]) {
		test(`phase "${phase}" (no draft or game yet) yields undefined`, async () => {
			const { discover, makeClient } = fixture({ "/lol-gameflow/v1/gameflow-phase": { body: phase } });
			expect(await readComposition(discover, makeClient, undefined, NO_NAMES)).toBeUndefined();
		});
	}

	test("phase ChampSelect yields the formatted champ-select composition", async () => {
		const { discover, makeClient, calls } = fixture({
			"/lol-gameflow/v1/gameflow-phase": { body: "ChampSelect" },
			"/lol-champ-select/v1/session": { body: CHAMP_SELECT_BODY },
		});
		const composition = await readComposition(discover, makeClient, undefined, NO_NAMES);
		expect(composition?.text).toContain("Your team: TOP Champion 84 (you), JUNGLE Champion 64");
		expect(composition?.enemyLaner).toBeUndefined();
		expect(calls).toEqual(["/lol-gameflow/v1/gameflow-phase", "/lol-champ-select/v1/session"]);
	});

	test("champ-select session unreachable mid-poll yields undefined", async () => {
		const { discover, makeClient } = fixture({ "/lol-gameflow/v1/gameflow-phase": { body: "ChampSelect" } });
		expect(await readComposition(discover, makeClient, undefined, NO_NAMES)).toBeUndefined();
	});

	for (const phase of ["InProgress", "WaitingForStats"]) {
		test(`phase "${phase}" reads the fixed live-client port and yields the live-game composition`, async () => {
			const { discover, makeClient, calls } = fixture({
				"/lol-gameflow/v1/gameflow-phase": { body: phase },
				"/liveclientdata/allgamedata": { body: LIVE_GAME_BODY },
			});
			const composition = await readComposition(discover, makeClient, undefined, NO_NAMES);
			expect(composition?.text).toContain("In game, 14:32. Your gold: 450.");
			expect(calls).toEqual(["/lol-gameflow/v1/gameflow-phase", "/liveclientdata/allgamedata"]);
		});
	}

	test("live client unreachable (no match running) yields undefined", async () => {
		const { discover, makeClient } = fixture({ "/lol-gameflow/v1/gameflow-phase": { body: "InProgress" } });
		expect(await readComposition(discover, makeClient, undefined, NO_NAMES)).toBeUndefined();
	});

	test("a Data Dragon name load that never finishes still returns the draft, ids unnamed", async () => {
		const { discover, makeClient } = fixture({
			"/lol-gameflow/v1/gameflow-phase": { body: "ChampSelect" },
			"/lol-champ-select/v1/session": { body: CHAMP_SELECT_BODY },
		});
		const composition = await readComposition(discover, makeClient, 100, () => new Promise(() => {}));
		expect(composition?.text).toContain("Your team: TOP Champion 84 (you)");
	});

	test("a Data Dragon price load that never finishes still returns the live game, without the gold clause", async () => {
		const { discover, makeClient } = fixture({
			"/lol-gameflow/v1/gameflow-phase": { body: "InProgress" },
			"/liveclientdata/allgamedata": { body: LIVE_GAME_BODY },
		});
		const composition = await readComposition(discover, makeClient, 100, NO_NAMES, () => new Promise(() => {}));
		expect(composition?.text).toContain("Your lane opponent: Darius; you are +1 level, +32 cs on them.");
	});

	test("a transport that never settles still yields undefined promptly, via the timeout", async () => {
		const hangingTransport: LcuTransport = () => new Promise(() => {});
		const makeClient = (target: LcuTarget) => new LcuClient(target, { transport: hangingTransport });
		const started = Date.now();
		expect(await readComposition(() => LOCK, makeClient, 20, NO_NAMES)).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe("createLcuFooterState", () => {
	test("onChange fires once when the snapshot changes, not on every poll", async () => {
		const { transport } = fakeTransport({ "/lol-gameflow/v1/gameflow-phase": { body: "Lobby" }, "/lol-summoner/v1/current-summoner": { body: { gameName: "jaden", tagLine: "NA1", summonerLevel: 1 } }, "/lol-ranked/v1/current-ranked-stats": { body: { queueMap: { RANKED_SOLO_5x5: { tier: "GOLD", division: "II", leaguePoints: 1, wins: 1, losses: 1 } } } } });
		let changes = 0;
		const handle = createLcuFooterState({ discover: () => ({ port: 1, password: PASSWORD }), makeClient: (target: LcuTarget) => new LcuClient(target, { transport }), intervalMs: 5, onChange: () => changes++ });
		await new Promise((resolve) => setTimeout(resolve, 40));
		handle.stop();
		expect(handle.read().kind).toBe("lobby");
		expect(changes).toBe(1);
	});

	test("polls on an interval, exposes the latest snapshot, and stops cleanly", async () => {
		let calls = 0;
		const discover = () => {
			calls += 1;
			return undefined;
		};
		const handle = createLcuFooterState({ discover, intervalMs: 5 });
		expect(handle.read()).toEqual({ kind: "closed" });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(calls).toBeGreaterThan(1);
		handle.stop();
		const callsAtStop = calls;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls).toBe(callsAtStop);
	});

	test("a champ select polls on its own, faster interval", async () => {
		let sessions = 0;
		const transport: LcuTransport = async (_target, path) => {
			if (path === "/lol-champ-select/v1/session") sessions += 1;
			return path === "/lol-gameflow/v1/gameflow-phase" ? { status: 200, text: '"ChampSelect"' } : path === "/lol-champ-select/v1/session" ? { status: 200, text: JSON.stringify(CHAMP_SELECT_BODY) } : { status: 404, text: "" };
		};
		const handle = createLcuFooterState({ discover: () => ({ port: 1, password: PASSWORD }), makeClient: (target) => new LcuClient(target, { transport }), intervalMs: 10_000, champSelectIntervalMs: 5 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		handle.stop();
		expect(sessions).toBeGreaterThan(2);
	});

	test("a hover settles on the second poll, a flick across champions never does, and onChange fires when the key lands", async () => {
		const script = [10, 20, 30, 30, 30, 30]; // a flick, then a hover that stays
		let reads = 0;
		const body = () => ({ myTeam: [{ cellId: 0, championId: 0, championPickIntent: script[Math.min(reads - 1, script.length - 1)], assignedPosition: "middle", spell1Id: 4, spell2Id: 7 }], theirTeam: [], localPlayerCellId: 0, actions: [], timer: { phase: "BAN_PICK", adjustedTimeLeftInPhase: 20000 } });
		const transport: LcuTransport = async (_target, path) => {
			if (path === "/lol-champ-select/v1/session") reads += 1;
			return path === "/lol-gameflow/v1/gameflow-phase" ? { status: 200, text: '"ChampSelect"' } : path === "/lol-champ-select/v1/session" ? { status: 200, text: JSON.stringify(body()) } : { status: 404, text: "" };
		};
		const seen: Array<{ read: number; key?: string }> = [];
		const handle: LcuFooterHandle = createLcuFooterState({
			discover: () => ({ port: 1, password: PASSWORD }),
			makeClient: (target) => new LcuClient(target, { transport }),
			champSelectIntervalMs: 5,
			onChange: () => {
				const state = handle.read();
				seen.push({ read: reads, key: state.kind === "champSelect" ? state.pickKey : undefined });
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		handle.stop();
		expect(seen.filter((entry) => entry.key).map((entry) => [entry.read, entry.key])).toEqual([[4, "30"]]); // the 3rd read is the first of the hover, the 4th settles it
	});
});

describe("lockedDraftKey", () => {
	const member = (cellId: number, championId: number, championPickIntent = 0) => ({ cellId, championId, championPickIntent, assignedPosition: "", spell1Id: 0, spell2Id: 0 });
	const state = (self: number, enemies: number[]) => ({
		kind: "champSelect" as const,
		myTeam: [member(0, self, 157), member(1, 64)],
		theirTeam: enemies.map((id, index) => member(5 + index, id)),
		bans: [],
		banSlotsTotal: 10,
		banSlotsDone: 10,
		localPlayerCellId: 0,
		timerPhase: "BAN_PICK",
		secondsLeft: 20,
	});

	test("is set once the player and four enemies have locked, and changes with the fifth lock or a swap", () => {
		expect(lockedDraftKey(state(0, [1, 2, 3, 4, 5]))).toBeUndefined(); // the player only hovers
		expect(lockedDraftKey(state(105, [1, 2, 3, 0, 0]))).toBeUndefined(); // two enemies still picking
		expect(lockedDraftKey(state(105, [1, 2, 3, 4, 0]))).toBe("105 vs 1,2,3,4,0");
		expect(lockedDraftKey(state(105, [1, 2, 3, 4, 5]))).toBe("105 vs 1,2,3,4,5");
		expect(lockedDraftKey(state(105, [1, 2, 3, 4, 6]))).not.toBe(lockedDraftKey(state(105, [1, 2, 3, 4, 5])));
	});
});

describe("pickKey", () => {
	const member = (cellId: number, championId: number, championPickIntent = 0) => ({ cellId, championId, championPickIntent, assignedPosition: "", spell1Id: 0, spell2Id: 0 });
	const read = (self: { championId?: number; intent?: number }) =>
		selfPickOf({ kind: "champSelect", myTeam: [member(0, self.championId ?? 0, self.intent ?? 0), member(1, 64)], theirTeam: [], bans: [], banSlotsTotal: 10, banSlotsDone: 10, localPlayerCellId: 0, timerPhase: "BAN_PICK", secondsLeft: 20 });
	const hover = (id: number) => read({ intent: id });
	const lock = (id: number) => read({ championId: id, intent: id });

	test("a lock is a key at once, and a slot with neither lock nor hover has none", () => {
		expect(pickKey(undefined, lock(105))).toBe("105");
		expect(pickKey(hover(238), lock(105))).toBe("105");
		expect(pickKey(hover(105), read({}))).toBeUndefined();
	});

	test("a hover is a key only on the second read of the same champion", () => {
		expect(pickKey(undefined, hover(105))).toBeUndefined();
		expect(pickKey(hover(105), hover(105))).toBe("105");
		expect(pickKey(hover(105), hover(238))).toBeUndefined();
	});

	test("a flick across champions yields no key, and the key of a settled hover is the key of its lock", () => {
		const flick = [hover(1), hover(2), hover(3), hover(1)];
		expect(flick.slice(1).map((current, index) => pickKey(flick[index], current))).toEqual([undefined, undefined, undefined]);
		expect(pickKey(hover(105), lock(105))).toBe(pickKey(hover(105), hover(105)));
	});

	test("settlePick puts the key on the second champ-select snapshot and only there", () => {
		const select = (selfPick?: { championId: number; locked: boolean }) => ({ kind: "champSelect" as const, secondsLeft: 20, picksMade: 0, picksTotal: 10, bansMade: 10, bansTotal: 10, ...(selfPick && { selfPick }) });
		const first = settlePick({ kind: "closed" }, select({ championId: 105, locked: false }));
		expect(first).not.toHaveProperty("pickKey");
		expect(settlePick(first, select({ championId: 105, locked: false }))).toHaveProperty("pickKey", "105");
		expect(settlePick({ kind: "closed" }, { kind: "closed" })).toEqual({ kind: "closed" });
	});
});

describe("enemy roles", () => {
	// 111 Nautilus, 72 Skarner, 245 Ekko, 78 Poppy, 145 Kai'Sa: Poppy's best single lane is support (0.54), but the
	// best whole-team assignment puts Nautilus there and Poppy top.
	test("inferPositions picks the one-lane-each assignment with the highest summed play rate", () => {
		expect(Object.fromEntries(inferPositions([111, 72, 245, 78, 145]))).toEqual({ 111: "UTILITY", 72: "JUNGLE", 245: "MIDDLE", 78: "TOP", 145: "BOTTOM" });
		// A lane the session already shows is never handed out again.
		expect(inferPositions([111, 78], ["UTILITY"]).get(78)).toBe("TOP");
	});

	test("champ select lists guessed enemy roles and pairs each lane with its opponent", async () => {
		const enemy = (cellId: number, championId: number) => ({ cellId, championId, championPickIntent: 0, assignedPosition: "", spell1Id: 4, spell2Id: 14 });
		const theirTeam = [enemy(5, 111), enemy(6, 72), enemy(7, 245), enemy(8, 78), enemy(9, 145)];
		const { client: c } = client({}, { "/lol-champ-select/v1/session": { body: { ...CHAMP_SELECT_BODY, theirTeam } } });
		const names = new Map([[84, "Akali"], [64, "Lee Sin"], [78, "Poppy"], [72, "Skarner"], [111, "Nautilus"]]);
		const { text } = formatComposition((await readChampSelect(c))!, names);
		expect(text).toContain("Enemy team (roles guessed from lane play rates): UTILITY Nautilus, JUNGLE Skarner");
		expect(text).toContain("Lanes: TOP Akali vs Poppy; JUNGLE Lee Sin vs Skarner");
	});

	test("an enemy with a role but no pick yet leaves the Lanes line out, never 'vs undefined'", async () => {
		const mid = (cellId: number, championId: number) => ({ cellId, championId, championPickIntent: 0, assignedPosition: "MIDDLE", spell1Id: 4, spell2Id: 14 });
		const body = { ...CHAMP_SELECT_BODY, myTeam: [mid(0, 103)], theirTeam: [mid(5, 0)] };
		const { client: c } = client({}, { "/lol-champ-select/v1/session": { body } });
		const { text } = formatComposition((await readChampSelect(c))!);
		expect(text).not.toContain("undefined");
		expect(text).not.toContain("Lanes:");
	});

	test("an off-role pick forced into the lane left over is marked unsure", async () => {
		const enemy = (cellId: number, championId: number) => ({ cellId, championId, championPickIntent: 0, assignedPosition: "", spell1Id: 4, spell2Id: 14 });
		// 157 Yasuo, 62 Wukong, 222 Jinx, 90 Malzahar, 122 Darius: nobody here plays support, Yasuo is left with it.
		const theirTeam = [enemy(5, 157), enemy(6, 62), enemy(7, 222), enemy(8, 90), enemy(9, 122)];
		const { client: c } = client({}, { "/lol-champ-select/v1/session": { body: { ...CHAMP_SELECT_BODY, theirTeam } } });
		const { text } = formatComposition((await readChampSelect(c))!);
		expect(text).toContain("UTILITY? Champion 157");
		expect(text).toContain("TOP Champion 122");
	});
});

describe("record and replay", () => {
	const session = JSON.stringify(CHAMP_SELECT_BODY);

	test("a recorded draft frame replays through readComposition like the live client", async () => {
		const file = tempFile("draft.ndjson", `${JSON.stringify({ path: "/lol-champ-select/v1/session", body: session })}\n`);
		const source = lcuSourceFromEnv({ VOXREN_LCU_REPLAY: file });
		const composition = await readComposition(source.discover, source.makeClient, undefined, async () => new Map());
		expect(composition?.text).toContain("Your team: TOP Champion 84 (you), JUNGLE Champion 64");
	});

	test("a bare allgamedata line is a live frame; a plain file plays frame by frame and holds the last, #index holds one", async () => {
		const live = (seconds: number) => JSON.stringify({ gameData: { gameTime: seconds }, allPlayers: [] });
		const file = tempFile("live.ndjson", `${live(60)}\n${live(600)}\n`);
		expect(parseFrames(`${live(60)}\n`)[0].path).toBe("/liveclientdata/allgamedata");
		const read = (replay: string) => {
			const source = lcuSourceFromEnv({ VOXREN_LCU_REPLAY: replay });
			return readComposition(source.discover, source.makeClient);
		};
		expect((await read(`${file}#0`))?.text).toContain("In game, 1:00.");
		let clock = 0;
		const playing = lcuSourceFromEnv({ VOXREN_LCU_REPLAY: file, VOXREN_LCU_REPLAY_STEP_MS: "1000" }, () => clock);
		const at = async (ms: number) => ((clock = ms), (await readComposition(playing.discover, playing.makeClient))?.text);
		expect(await at(0)).toContain("In game, 1:00.");
		expect(await at(1000)).toContain("In game, 10:00.");
		expect(await at(60_000)).toContain("In game, 10:00."); // holds the last frame
		expect((await read(`${file}#-2`))?.text).toContain("In game, 1:00.");
		expect(() => lcuSourceFromEnv({ VOXREN_LCU_REPLAY: `${file}#5` })).toThrow("has no frame 5");
	});

	test("recording keeps each changed draft once and a live frame at most every 30 s", async () => {
		const file = join(base, "recorded.ndjson");
		let now = 0;
		let body = session;
		const inner: LcuTransport = async () => ({ status: 200, text: body });
		const { makeClient } = recordingSource(file, () => now, inner);
		const c = makeClient({ host: "127.0.0.1", port: 1, password: "" });
		await c.get("/lol-champ-select/v1/session");
		await c.get("/lol-champ-select/v1/session");
		body = JSON.stringify({ ...CHAMP_SELECT_BODY, localPlayerCellId: 1 });
		await c.get("/lol-champ-select/v1/session");
		for (const at of [30_000, 40_000, 60_000]) {
			now = at;
			await c.get("/liveclientdata/allgamedata");
		}
		await c.get("/lol-gameflow/v1/gameflow-phase");
		const frames = parseFrames(readFileSync(file, "utf8"));
		expect(frames.map((frame) => frame.path)).toEqual(["/lol-champ-select/v1/session", "/lol-champ-select/v1/session", "/liveclientdata/allgamedata", "/liveclientdata/allgamedata"]);
	});
});
