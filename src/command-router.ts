// Command routing: Jev picks the coach command a typed question runs, from the commands that fit the client phase.
import { logEvent } from "./coach-log";
import { COACH_YAML, GAME_EVENT_COMMANDS, type CommandPhase } from "./contracts";
import type { LcuFooterState } from "./lcu";
import { ROUTE_DEADLINE_MS, ROUTE_PROMPT_CHARS, ROUTE_SWITCH_P, type RouteJudge } from "./model-router";
import { scrubIdentifiers } from "./passage-judge";
import { JudgeFailure, choiceProbabilities, type JudgeFailureReason } from "./systemone";

export interface CommandRoute {
	/** The command to run; absent means a plain turn. */
	command?: string;
	/** The winning choice's probability, when Jev answered. */
	p?: number;
	ms?: number;
	by?: string;
	failure?: "off" | "player" | JudgeFailureReason;
}

/** An op.gg summoner link: the player named an account, not only a champion. */
const OPGG_SUMMONER = /op\.gg\/(?:lol\/)?summoners\//i;

/** The phase the router offers choices for; undefined when there is no client state to route on (print mode). */
export function commandPhase(state: LcuFooterState | undefined): CommandPhase | undefined {
	if (!state) return undefined;
	return state.kind === "champSelect" || state.kind === "liveGame" ? state.kind : "lobby";
}

/** The two commands an automatic champ-select call runs. */
export type AutoCall = "pick" | "draft";

/** A champ-select lock the footer saw: draft is true when the player and four enemies have locked a draft not run yet, false when only the player's own pick is due. */
export interface LockEvent { event: "locked"; draft: boolean }

/** The command a game event runs. An event takes no judge, so it never asks Jev: the phase default decides (spec 2026-10-06 piece A, Auto events): draft once the player and four enemies have locked, else pick. The default lives here in code, not in an `agent.routeDefaults` yaml key, because no such key exists (#458 put its phase table in `jev.command.phases`). */
export function routeEvent(event: LockEvent): AutoCall {
	return event.draft ? "draft" : "pick";
}

/** A game event the footer saw: the first live read past 0:00, or the footer leaving a game for the lobby. */
export interface GameEvent { event: "gameStart" | "gameEnd" }

const GAME_END_REVIEW_COUNT = "1";

// ponytail: fixed 120 s, not a setting; past it the opener would plan waves already played, so a coach started inside a game sends none.
export const GAME_START_WINDOW_SEC = 120;

/** The command and arguments a game event runs. Pure and never asks Jev, like routeEvent (decision log #475 D8). */
export function routeGameEvent(event: GameEvent): { command: string; args: string } {
	return event.event === "gameStart" ? { command: GAME_EVENT_COMMANDS.gameStart, args: COACH_YAML.prompts.gameStart.trim() } : { command: GAME_EVENT_COMMANDS.gameEnd, args: GAME_END_REVIEW_COUNT };
}

/**
 * Turns footer reads into game events, each once a game and only while the coach is idle. `run` returns the call's outcome;
 * 'busy' refunds the event so the next poll retries it. A 'closed' read changes nothing: a failed live read must not reset the game.
 */
export function createGameEvents(run: (event: GameEvent) => unknown, on: (event: GameEvent["event"]) => boolean = () => true): (state: LcuFooterState, idle: boolean) => void {
	let started = false;
	let playing = false;
	let game = 0;
	const send = (event: GameEvent, refund: () => void) => {
		const mine = game;
		const result = run(event);
		if (result instanceof Promise)
			void result
				.then((outcome) => {
					if (outcome !== "busy" && outcome !== "typed" && outcome !== "stale") return;
					const retry = outcome === "busy" && mine === game;
					if (retry) refund();
					logEvent("info", "command-router", "game-event-dropped", { event: event.event, reason: outcome === "busy" ? "the coach was busy" : outcome === "typed" ? "a typed turn is running and wins" : "superseded", retry });
				})
				.catch((error) => logEvent("warn", "command-router", "game-event-failed", { event: event.event }, error));
	};
	return (state, idle) => {
		if (state.kind === "champSelect") {
			started = false;
			playing = false;
			game++;
			return;
		}
		if (state.kind === "liveGame") {
			if (state.gameTimeSec <= 0) return;
			playing = true;
			if (started) return;
			if (state.gameTimeSec > GAME_START_WINDOW_SEC) {
				started = true;
				logEvent("info", "command-router", "game-event-skipped", { event: "gameStart", reason: "the first live read was past the opening window", gameTimeSec: state.gameTimeSec });
				return;
			}
			if (!idle || !on("gameStart")) return;
			started = true;
			send({ event: "gameStart" }, () => (started = false));
			return;
		}
		if (state.kind === "lobby" && playing) {
			if (!on("gameEnd")) {
				playing = false;
				return;
			}
			if (!idle) return;
			playing = false;
			send({ event: "gameEnd" }, () => (playing = true));
		}
	};
}

/** The Jev question for one phase: only that phase's criteria, so Jev never picks a command the phase cannot run. */
export function phaseQuestion(phase: CommandPhase) {
	const { type, instructions, criteria, phases } = COACH_YAML.jev.command;
	return { type, instructions, criteria: Object.fromEntries(phases[phase].map((name) => [name, criteria[name]])) };
}

/**
 * Any failure, or a pick below ROUTE_SWITCH_P, is a plain turn: the question goes out as it would have before the router existed.
 * The tier grade starts beside this call in the input hook (src/index.ts), so a plain turn waits one deadline.
 */
export async function routeCommand(input: { text: string; phase: CommandPhase; accounts: string[] }, judge: RouteJudge | undefined, deadlineMs = ROUTE_DEADLINE_MS): Promise<CommandRoute> {
	if (!judge) return { failure: "off" };
	const message = scrubIdentifiers(input.text, input.accounts).trim().slice(0, ROUTE_PROMPT_CHARS);
	if (!message) return { failure: "input", by: judge.model };
	// A question that names a player (a Riot ID or an op.gg link) is about that player's games: no frame here reads them, and /build's
	// would swap the OP.GG average in for their build. A plain turn calls voxren_otp_build or voxren_player_audit (system prompt).
	if (message.includes("[riot-id]") || OPGG_SUMMONER.test(input.text)) return { failure: "player", by: judge.model };
	const controller = new AbortController();
	const started = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Not unref'd: Bun on Windows never fires a lone unref'd timer (AGENTS.md rule 8).
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new JudgeFailure("timeout"));
		}, deadlineMs);
	});
	try {
		const result = await Promise.race([judge.ask({ message }, { command: phaseQuestion(input.phase) }, controller.signal), timeout]);
		const probabilities = choiceProbabilities(result.answers.command);
		if (!probabilities) throw new JudgeFailure("response");
		const [name, p] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? ["none", 0];
		const ms = Date.now() - started;
		const allowed = COACH_YAML.jev.command.phases[input.phase].includes(name);
		return { ...(allowed && name !== "none" && p >= ROUTE_SWITCH_P && { command: name }), p, ms, by: result.model };
	} catch (error) {
		const reason = error instanceof JudgeFailure ? error.reason : "network";
		logEvent("warn", "command-router", "route-command-failed", { judge: judge.model, reason }, error);
		return { failure: reason, by: judge.model, ms: Date.now() - started };
	} finally {
		clearTimeout(timer);
	}
}
