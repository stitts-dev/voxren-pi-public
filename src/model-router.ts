// Model routing: Jev grades a typed prompt quick / standard / deep; code picks the model and thinking level.
import { logEvent } from "./coach-log";
import { COACH_TIERS, ROUTE_QUESTION, TIER_NAMES, type TierName } from "./contracts";
import { scrubIdentifiers } from "./passage-judge";
import { JudgeFailure, SystemOneClient, choiceProbabilities, type JudgeFailureReason } from "./systemone";

/** The winning tier must reach this probability before the model changes; below it the model stays (and keeps its prompt cache). */
export const ROUTE_SWITCH_P = 0.7;
export const ROUTE_DEADLINE_MS = 1500;
/** Only the start of a long prompt is sent: enough to grade it, and far under the judge's request cap. */
export const ROUTE_PROMPT_CHARS = 4000;

export type RouteSource = "command" | "jev" | "held" | "fallback" | "pinned";
export interface Route {
	model: string;
	thinking: string;
	source: RouteSource;
	tier?: TierName;
	/** "off" when there is no judge; a JudgeFailureReason after a failed call. Only on source "fallback". */
	failure?: "off" | JudgeFailureReason;
	/** The winning tier's probability, on sources "jev" and "held". */
	p?: number;
	/** How long the Jev call took, whenever Jev was called (failures included). */
	ms?: number;
	/** The decision model that graded: the reply's model, or the one asked when the call failed. Absent when there is no judge. */
	by?: string;
}
export interface RouteInput {
	prompt: string;
	commandTier?: TierName;
	pinned: boolean;
	accounts: string[];
	current: { model: string; thinking: string };
}
export type RouteJudge = Pick<SystemOneClient, "ask" | "model">;

/** On when `TYPESAFE_API_KEY` is non-empty, like the passage screen and the grounding gate. */
export function createRouteJudge(environment: Record<string, string | undefined>): RouteJudge | undefined {
	const apiKey = environment.TYPESAFE_API_KEY?.trim();
	return apiKey ? new SystemOneClient({ apiKey }) : undefined;
}

function tierRoute(tier: TierName, source: RouteSource, failure?: Route["failure"]): Route {
	return { ...COACH_TIERS[tier], source, tier, ...(failure && { failure }) };
}

/** A failed Jev call keeps the current model (no flip on an intermittent timeout) at standard's thinking. */
function failedRoute(input: RouteInput, failure: JudgeFailureReason, by: string, ms?: number): Route {
	return { model: input.current.model, thinking: COACH_TIERS.standard.thinking, source: "fallback", tier: "standard", failure, by, ...(ms !== undefined && { ms }) };
}

export async function routePrompt(input: RouteInput, judge: RouteJudge | undefined, deadlineMs = ROUTE_DEADLINE_MS): Promise<Route> {
	if (input.pinned) return { ...input.current, source: "pinned" };
	if (input.commandTier) return tierRoute(input.commandTier, "command");
	if (!judge) return tierRoute("standard", "fallback", "off");
	const message = scrubIdentifiers(input.prompt, input.accounts).trim().slice(0, ROUTE_PROMPT_CHARS);
	if (!message) return failedRoute(input, "input", judge.model);
	const controller = new AbortController();
	const started = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Race the call so a transport that ignores the signal cannot hold the turn. Not unref'd: Bun on Windows never fires a lone unref'd timer.
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new JudgeFailure("timeout"));
		}, deadlineMs);
	});
	try {
		const result = await Promise.race([judge.ask({ message }, { route: ROUTE_QUESTION }, controller.signal), timeout]);
		const probabilities = choiceProbabilities(result.answers.route);
		if (!probabilities) throw new JudgeFailure("response");
		const [tier, p] = TIER_NAMES.map((name) => [name, probabilities[name] ?? 0] as const).sort((a, b) => b[1] - a[1])[0];
		if (p <= 0) throw new JudgeFailure("response");
		const ms = Date.now() - started;
		if (p >= ROUTE_SWITCH_P) return { ...tierRoute(tier, "jev"), p, ms, by: result.model };
		return { model: input.current.model, thinking: COACH_TIERS[tier].thinking, source: "held", tier, p, ms, by: result.model };
	} catch (error) {
		const reason = error instanceof JudgeFailure ? error.reason : "network";
		logEvent("warn", "model-router", "route-failed", { judge: judge.model, reason }, error);
		return failedRoute(input, reason, judge.model, Date.now() - started);
	} finally {
		clearTimeout(timer);
	}
}
