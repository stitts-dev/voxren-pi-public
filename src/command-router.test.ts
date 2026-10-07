import { describe, expect, test } from "bun:test";
import { setLogSink } from "./coach-log";
import { commandPhase, createGameEvents, GAME_START_WINDOW_SEC, phaseQuestion, routeCommand, routeEvent, routeGameEvent, type GameEvent } from "./command-router";
import { COACH_COMMANDS, COACH_YAML } from "./contracts";
import type { LcuFooterState } from "./lcu";
import type { RouteJudge } from "./model-router";
import { JudgeFailure } from "./systemone";

function jev(probabilities: Record<string, number>, fail?: JudgeFailure) {
	const asked: Array<Record<string, any>> = [];
	const judge: RouteJudge = {
		model: "jev-latest",
		ask: async (_state, questions) => {
			asked.push(questions);
			if (fail) throw fail;
			return { judge: "jev", model: "jev-1", inputTokens: 10, answers: { command: { type: "choice", choice: Object.keys(probabilities)[0], probabilities } } };
		},
	};
	return { judge, asked };
}

const ASK = { text: "how do I lane vs Kassadin", phase: "champSelect" as const, accounts: ["Player01#NA1"] };

describe("routeCommand", () => {
	test("a confident pick runs that command", async () => {
		const { judge, asked } = jev({ matchup: 0.85, none: 0.1, draft: 0.05 });
		expect((await routeCommand(ASK, judge)).command).toBe("matchup");
		// Jev sees only the phase's choices: review is a lobby command, never offered in champ select.
		expect(Object.keys(asked[0].command.criteria)).toEqual(["none", "pick", "draft", "matchup", "build", "comp"]);
	});
	test("below 0.7, none, or a command outside the phase is a plain turn", async () => {
		expect((await routeCommand(ASK, jev({ matchup: 0.6, none: 0.4 }).judge)).command).toBeUndefined();
		expect((await routeCommand(ASK, jev({ none: 0.9, matchup: 0.1 }).judge)).command).toBeUndefined();
		expect((await routeCommand({ ...ASK, phase: "liveGame" }, jev({ draft: 0.95 }).judge)).command).toBeUndefined();
	});
	test("no judge, a failed call, or a timeout is a plain turn with the cause", async () => {
		expect(await routeCommand(ASK, undefined)).toEqual({ failure: "off" });
		expect((await routeCommand(ASK, jev({}, new JudgeFailure("network")).judge)).failure).toBe("network");
		const slow: RouteJudge = { model: "jev-latest", ask: () => new Promise(() => {}) };
		expect((await routeCommand(ASK, slow, 20)).failure).toBe("timeout");
	});
	test("a question naming a player (op.gg link or Riot ID) is a plain turn, never asked of Jev", async () => {
		const { judge, asked } = jev({ build: 0.9 });
		const link = "otp https://op.gg/lol/summoners/kr/%EB%81%9D-never play and wr (unique) build";
		expect(await routeCommand({ ...ASK, text: link }, judge)).toEqual({ failure: "player", by: "jev-latest" });
		expect((await routeCommand({ ...ASK, text: "what does Faker#KR1 build on Ahri" }, judge)).failure).toBe("player");
		expect(asked).toHaveLength(0);
	});
	test("phases: closed and lobby route as the lobby, and no client means no routing", () => {
		expect(commandPhase({ kind: "closed" } as any)).toBe("lobby");
		expect(commandPhase({ kind: "liveGame" } as any)).toBe("liveGame");
		expect(commandPhase(undefined)).toBeUndefined();
		expect(Object.keys(phaseQuestion("lobby").criteria)).toContain("review");
	});
});

describe("routeEvent", () => {
	test("a lock with a new draft runs draft, a lock with only the player's pick runs pick", () => {
		expect(routeEvent({ event: "locked", draft: true })).toBe("draft");
		expect(routeEvent({ event: "locked", draft: false })).toBe("pick");
	});
});

describe("routeGameEvent", () => {
	test("game start runs /comp with the opener question, game end runs /review 1", () => {
		const start = routeGameEvent({ event: "gameStart" });
		expect(start).toEqual({ command: "comp", args: COACH_YAML.prompts.gameStart.trim() });
		expect(routeGameEvent({ event: "gameEnd" })).toEqual({ command: "review", args: "1" });
		expect(COACH_COMMANDS.find((c) => c.name === "comp")?.acceptsArgs(start.args)).toBe(true);
		expect(COACH_COMMANDS.find((c) => c.name === "review")?.prompt("1", { accounts: [] } as any)).toContain("last 1 ranked");
	});
});

const live = (gameTimeSec: number): LcuFooterState => ({ kind: "liveGame", gameTimeSec }) as LcuFooterState;
const select: LcuFooterState = { kind: "champSelect", secondsLeft: 30, picksMade: 10, picksTotal: 10, bansMade: 10, bansTotal: 10 } as LcuFooterState;
const lobby: LcuFooterState = { kind: "lobby", summoner: { gameName: "A", tagLine: "B", summonerLevel: 1 }, rank: { tier: "GOLD", division: "I", leaguePoints: 0, wins: 0, losses: 0 }, recent: [] } as LcuFooterState;
const closed: LcuFooterState = { kind: "closed" };

function events(result: unknown = "sent", on?: (event: GameEvent["event"]) => boolean) {
	const calls: GameEvent[] = [];
	const feed = createGameEvents((event) => (calls.push(event), typeof result === "string" ? Promise.resolve(result) : result), on);
	return { calls, feed };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createGameEvents", () => {
	test("a game sends one start and one end", () => {
		const { calls, feed } = events();
		for (const state of [select, live(0), live(7), live(12), closed, lobby, lobby]) feed(state, true);
		expect(calls).toEqual([{ event: "gameStart" }, { event: "gameEnd" }]);
		feed(live(17), true);
		expect(calls).toHaveLength(2);
	});
	test("a closed read mid-game does not send a second start and the lobby still ends", () => {
		const { calls, feed } = events();
		for (const state of [live(7), closed, live(12), lobby]) feed(state, true);
		expect(calls).toEqual([{ event: "gameStart" }, { event: "gameEnd" }]);
	});
	test("a busy coach waits: the next idle poll sends", () => {
		const { calls, feed } = events();
		feed(live(5), false);
		expect(calls).toEqual([]);
		feed(live(6), true);
		expect(calls).toHaveLength(1);
		feed(lobby, false);
		expect(calls).toHaveLength(1);
		feed(lobby, true);
		expect(calls).toEqual([{ event: "gameStart" }, { event: "gameEnd" }]);
	});
	test("a busy answer retries, a sent answer does not", async () => {
		const busy = events("busy");
		busy.feed(live(5), true);
		await tick();
		busy.feed(live(6), true);
		expect(busy.calls).toHaveLength(2);
		const sent = events();
		sent.feed(live(5), true);
		await tick();
		sent.feed(live(6), true);
		expect(sent.calls).toHaveLength(1);
	});
	test("a live read at 0:00 sends nothing, the first call arrives at 0:07", () => {
		const { calls, feed } = events();
		feed(live(0), true);
		expect(calls).toEqual([]);
		feed(live(7), true);
		expect(calls).toEqual([{ event: "gameStart" }]);
	});
	test("a busy answer on the end retries at the next lobby poll, a sent answer does not", async () => {
		const busy = events("busy");
		busy.feed(live(5), true);
		await tick();
		busy.feed(lobby, true);
		await tick();
		busy.feed(lobby, true);
		expect(busy.calls.filter((c) => c.event === "gameEnd")).toHaveLength(2);
		const sent = events();
		sent.feed(live(5), true);
		sent.feed(lobby, true);
		await tick();
		sent.feed(lobby, true);
		expect(sent.calls.filter((c) => c.event === "gameEnd")).toHaveLength(1);
	});
	test("a busy answer for an earlier game does not refund the new game's start", async () => {
		const releases: ((outcome: string) => void)[] = [];
		const calls: GameEvent[] = [];
		const feed = createGameEvents((event) => (calls.push(event), new Promise<string>((resolve) => releases.push(resolve))));
		feed(live(5), true);
		feed(select, true);
		feed(live(5), true);
		expect(calls).toHaveLength(2);
		releases[0]("busy");
		await tick();
		feed(live(6), true);
		expect(calls).toHaveLength(2);
	});
	test("a coach started past the opening window sends no start, logs it, and still sends the end", () => {
		const lines: string[] = [];
		setLogSink((line) => lines.push(line));
		try {
			const { calls, feed } = events();
			feed(live(GAME_START_WINDOW_SEC + 1), true);
			feed(live(GAME_START_WINDOW_SEC + 5), true);
			expect(calls).toEqual([]);
			expect(lines.some((line) => line.includes("game-event-skipped"))).toBe(true);
			feed(lobby, true);
			expect(calls).toEqual([{ event: "gameEnd" }]);
		} finally {
			setLogSink(undefined);
		}
	});
	test("a switched-off event sends nothing, and turning it on later in the same lobby is too late", () => {
		let startOn = false;
		let endOn = false;
		const { calls, feed } = events("sent", (event) => (event === "gameStart" ? startOn : endOn));
		feed(live(5), true);
		expect(calls).toEqual([]);
		feed(lobby, true);
		endOn = true;
		startOn = true;
		feed(lobby, true);
		expect(calls).toEqual([]);
	});
	test("a lobby with no game seen sends nothing", () => {
		const { calls, feed } = events();
		feed(lobby, true);
		feed(lobby, true);
		expect(calls).toEqual([]);
	});
	test("champ select resets: a second game sends a second pair, an abandoned game sends no end", () => {
		const { calls, feed } = events();
		for (const state of [live(5), lobby, select, live(5), lobby]) feed(state, true);
		expect(calls.map((c) => c.event)).toEqual(["gameStart", "gameEnd", "gameStart", "gameEnd"]);
		const abandoned = events();
		for (const state of [live(5), select, lobby]) abandoned.feed(state, true);
		expect(abandoned.calls.map((c) => c.event)).toEqual(["gameStart"]);
	});
});
