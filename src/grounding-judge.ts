import { logEvent } from "./coach-log";
import { COACH_YAML } from "./contracts";
import type { FetchLike } from "./policy";
import { scrubIdentifiers } from "./passage-judge";
import { JudgeFailure, SystemOneClient, choice, choiceProbabilities, noul, shown, type JudgeFailureReason, type Question } from "./systemone";

/**
 * Grounding gate for voxren_strategy_frame: for each claim the coach intends
 * to state, Jev answers whether the cited passages support it, contradict it,
 * and which passage is the source. Code routes on the probabilities. The gate
 * flags; it never removes a claim, and any failure marks every claim not judged.
 */

export const GROUNDING_TIMEOUT_MS = 3000;
export const MAX_GROUNDED_CLAIMS = 8;
/**
 * Set from src/lab/grounding-lab.ts on 2026-09-27 (jev-1.13.0, 10 planted pairs): supported ranged 0.83 to 0.97 on
 * true pairs and 0.01 to 0.17 on false ones (one mixed pair at 0.59); contradicted ranged 0.95 to 0.97 against 0.04 to 0.22.
 * Both cuts sit inside those gaps with room on each side; rerun the lab with a labelled corpus before moving them.
 */
export const GROUNDING_THRESHOLDS = { supportedMin: 0.5, contradictedMin: 0.6 } as const;

export type ClaimRoute = "grounded" | "unsupported" | "contradicted" | "disputed";

export interface ClaimScores {
	supported: number;
	contradicted: number;
}

export interface GroundingPassage {
	id: string;
	text: string;
}

export interface ClaimVerdict {
	claim: string;
	route: ClaimRoute;
	p: ClaimScores;
	source?: string;
	/** Per-option probability of the source choice (cited ids plus `none`), for the card. */
	sourceP?: Record<string, number>;
	/** The cited passage id that disagrees with the claim, when the answer wasn't `none`. A disputed claim carries both this and `source`. */
	contradictedBy?: string;
}

export type GroundingJudgment =
	| { status: "judged"; judge: string; model: string; latencyMs: number; inputTokens: number; verdicts: ClaimVerdict[] }
	| { status: "unavailable"; judge: string; model: string; reason: JudgeFailureReason; latencyMs: number };

export interface GroundingJudgeOptions {
	apiKey: string;
	fetchImpl?: FetchLike;
	url?: string;
	model?: string;
	timeoutMs?: number;
	thresholds?: typeof GROUNDING_THRESHOLDS;
}

const NONE = "none";

/**
 * Grounded requires both enough support and a cited passage as the source; a source of `none` is never grounded.
 * Contradicted is held to the same bar: a score with no passage Jev can name as the one that disagrees is not a flag.
 * When both bars are met and the two passages differ, one source states the claim and another opposes it: disputed,
 * naming both, never contradicted (the opposed score no longer outranks a stating source, #202).
 */
export function routeClaim(p: ClaimScores, source: string, contradictedBy: string, thresholds = GROUNDING_THRESHOLDS): ClaimRoute {
	const opposed = p.contradicted >= thresholds.contradictedMin && contradictedBy !== NONE;
	const stated = p.supported >= thresholds.supportedMin && source !== NONE;
	if (opposed && stated && source !== contradictedBy) return "disputed";
	if (opposed) return "contradicted";
	return stated ? "grounded" : "unsupported";
}

/** The yaml questions, with the choice options built from the cited ids. */
export function groundingQuestions(ids: string[]): Record<string, Question> {
	const { supported, contradicted, source, contradictedBy } = COACH_YAML.jev.grounding;
	const idCriteria: Record<string, string> = Object.fromEntries(ids.map((id) => [id, `passage ${id}`]));
	return {
		supported,
		contradicted,
		source: { type: "choice", instructions: source.instructions, criteria: { ...idCriteria, [NONE]: source.none } },
		contradictedBy: { type: "choice", instructions: contradictedBy.instructions, criteria: { ...idCriteria, [NONE]: contradictedBy.none } },
	};
}

export function groundingState(claim: string, passages: GroundingPassage[], accounts: string[]) {
	return { claim: scrubIdentifiers(claim, accounts), passages: passages.map((passage) => ({ id: passage.id, text: scrubIdentifiers(passage.text, accounts) })) };
}

export class GroundingJudge {
	private readonly client: SystemOneClient;
	private readonly timeoutMs: number;
	private readonly thresholds: typeof GROUNDING_THRESHOLDS;

	constructor(options: GroundingJudgeOptions) {
		this.client = new SystemOneClient({ apiKey: options.apiKey, fetchImpl: options.fetchImpl, url: options.url, model: options.model });
		this.timeoutMs = options.timeoutMs ?? GROUNDING_TIMEOUT_MS;
		this.thresholds = options.thresholds ?? GROUNDING_THRESHOLDS;
	}

	/** All-or-nothing: one failed claim makes the whole batch unavailable, so a mixed judged/unjudged frame never reaches the model. */
	async judge(claims: string[], passages: GroundingPassage[], accounts: string[], signal?: AbortSignal): Promise<GroundingJudgment> {
		const started = Date.now();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (!passages.length) throw new JudgeFailure("input");
			const ids = passages.map((passage) => passage.id);
			const questions = groundingQuestions(ids);
			const aborted = new Promise<never>((_resolve, reject) => {
				const fail = () => reject(new JudgeFailure("timeout"));
				if (controller.signal.aborted) fail();
				else controller.signal.addEventListener("abort", fail, { once: true });
			});
			const answers = await Promise.race([
				Promise.all(claims.slice(0, MAX_GROUNDED_CLAIMS).map((claim) => this.one(claim, passages, accounts, questions, ids, controller.signal))),
				aborted,
			]);
			return {
				status: "judged",
				judge: answers[0]?.judge ?? this.client.name,
				model: answers[0]?.model ?? this.client.model,
				latencyMs: Date.now() - started,
				inputTokens: answers.reduce((sum, answer) => sum + answer.inputTokens, 0),
				verdicts: answers.map((answer) => answer.verdict),
			};
		} catch (error) {
			const reason = error instanceof JudgeFailure ? error.reason : controller.signal.aborted ? "timeout" : "network";
			logEvent("warn", "grounding-judge", "judge-failed", { judge: this.client.name, model: this.client.model, reason, claims: claims.length, passages: passages.length }, error);
			return { status: "unavailable", judge: this.client.name, model: this.client.model, reason, latencyMs: Date.now() - started };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private async one(claim: string, passages: GroundingPassage[], accounts: string[], questions: Record<string, Question>, ids: string[], signal: AbortSignal) {
		const reply = await this.client.ask(groundingState(claim, passages, accounts), questions, signal);
		const p = { supported: noul(reply.answers.supported), contradicted: noul(reply.answers.contradicted) };
		const source = choice(reply.answers.source, [...ids, NONE]);
		const sourceP = choiceProbabilities(reply.answers.source);
		const contradictedBy = choice(reply.answers.contradictedBy, [...ids, NONE]);
		const verdict: ClaimVerdict = {
			claim,
			route: routeClaim(p, source, contradictedBy, this.thresholds),
			p: { supported: shown(p.supported), contradicted: shown(p.contradicted) },
			...(source !== NONE ? { source } : {}),
			...(sourceP ? { sourceP } : {}),
			...(contradictedBy !== NONE ? { contradictedBy } : {}),
		};
		return { judge: reply.judge, model: reply.model, inputTokens: reply.inputTokens, verdict };
	}
}

/** On when `TYPESAFE_API_KEY` is non-empty; without it the frame reports every claim not judged. */
export function createGroundingJudge(environment: Record<string, string | undefined>, overrides: Partial<GroundingJudgeOptions> = {}): GroundingJudge | undefined {
	const apiKey = environment.TYPESAFE_API_KEY?.trim();
	if (!apiKey) return undefined;
	return new GroundingJudge({ apiKey, ...overrides });
}
