import { logEvent } from "./coach-log";
import { COACH_YAML } from "./contracts";
import type { FetchLike } from "./policy";
import { JudgeFailure, MAX_JUDGE_REQUEST_BYTES, SYSTEMONE_MODEL, SystemOneClient, TYPESAFE_SYSTEMONE_URL, noul, shown, systemOneBody, type JudgeFailureReason, type Question } from "./systemone";

/**
 * Opt-in passage screen for live web_search results, backed by Jev (TypeSafe
 * System One, `POST /v1/systemone`). Jev never writes text: for each
 * query-passage pair it answers three yes/no ("noul") questions with a
 * probability, and this module turns those numbers into a route in code.
 *
 * Boundaries:
 *  - one request per passage, state is the query, the public patch label, and
 *    that passage only; Riot IDs, approved account names, and match ids are
 *    scrubbed before anything leaves the process;
 *  - web_search passages and OP.GG summaries are judged; Data Dragon facts
 *    and audit rows never reach TypeSafe;
 *  - every failure (no key, timeout, HTTP error, malformed reply) resolves to
 *    `status: "unavailable"`, and the caller keeps the unjudged passages, so
 *    the screen can withhold but never vouch.
 */

export { TYPESAFE_SYSTEMONE_URL, MAX_JUDGE_REQUEST_BYTES };
export const PASSAGE_JUDGE_MODEL = SYSTEMONE_MODEL;
export const PASSAGE_JUDGE_TIMEOUT_MS = 3000;
export const MAX_JUDGED_PASSAGES = 9;

/**
 * Cookbook starting points (docs.typesafe.ai/cookbooks/classifying_rag_passages), kept after src/lab/passage-judge-lab.ts on
 * 2026-09-27 (jev-1.13.0, 54 real passages, 8 planted): 4 of 4 injections withheld, 0 controls or real passages withheld,
 * injection scored 0.93 to 0.98 on planted attacks and at most 0.57 elsewhere. Relevance and support await hand labels.
 */
export const PASSAGE_THRESHOLDS = { injectionMax: 0.7, relevantMin: 0.45, supportMin: 0.55 } as const;

/** Three atomic nouls from coach.yaml `jev.passage`; the ids are local, TypeSafe does not see them. */
export const PASSAGE_QUESTIONS = COACH_YAML.jev.passage;

export interface PassageInput {
	id: string;
	title: string;
	domain: string;
	/** The link and date the model reads beside the text, so the judge reads them too (#281). */
	url?: string;
	date?: string;
	text: string;
}

export interface PassageScores {
	relevant: number;
	support: number;
	injection: number;
}

export type PassageRoute = "evidence" | "weak" | "off_topic" | "withheld";

export interface PassageVerdict {
	id: string;
	route: PassageRoute;
	p: PassageScores;
}

export type PassageJudgeFailure = JudgeFailureReason;

export type PassageJudgment =
	| { status: "judged"; judge: string; model: string; latencyMs: number; inputTokens: number; verdicts: PassageVerdict[] }
	| { status: "unavailable"; judge: string; model: string; reason: PassageJudgeFailure; latencyMs: number };

export interface PassageContext {
	patch?: string;
	/** Approved Riot IDs (Name#TAG); scrubbed from every request. */
	accounts?: string[];
}

export interface PassageJudgeOptions {
	apiKey: string;
	fetchImpl?: FetchLike;
	url?: string;
	model?: string;
	timeoutMs?: number;
	thresholds?: typeof PASSAGE_THRESHOLDS;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A name as a whole phrase: spaces match any run of spaces, and only a letter, digit, or underscore next to it counts as part of a longer word. */
function namePattern(name: string): RegExp {
	return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name).replace(/ +/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "giu");
}

/** Remove Riot IDs, approved account names, and match ids before text leaves the process. */
export function scrubIdentifiers(text: string, accounts: string[] = []): string {
	// NFKC first, so a fullwidth ＃ or Latin letter is matched as the plain character it stands for.
	let out = text.normalize("NFKC");
	for (const account of accounts.map((entry) => entry.normalize("NFKC"))) {
		const [gameName] = account.split("#");
		out = out.replace(new RegExp(escapeRegExp(account).replace(/ +/g, "\\s+"), "giu"), "[riot-id]");
		if (gameName && gameName.length >= 3) out = out.replace(namePattern(gameName), "[riot-id]");
	}
	// A name is 1-16 characters, spaces included, starting at a word start and not ending in a space (`rank #1234` is not an id).
	// Only an ASCII word character stops the tag (`word#toolongtag`, `#faq_v2` are not tags); Korean text glues particles
	// straight onto a name (`플레이어#한글1에서`), and leaking that id to the judge is worse than over-redacting.
	return out.replace(/(?<![^\s])[^\n#]{0,15}[^\s#]#[\p{L}\p{N}]{3,5}(?![A-Za-z0-9_])/gu, "[riot-id]").replace(/\b[A-Z]{2,4}[0-9]?_[0-9]{6,}\b/g, "[match-id]");
}

export function routeFor(p: PassageScores, thresholds = PASSAGE_THRESHOLDS): PassageRoute {
	if (p.injection >= thresholds.injectionMax) return "withheld";
	if (p.relevant < thresholds.relevantMin) return "off_topic";
	return p.support >= thresholds.supportMin ? "evidence" : "weak";
}

/** The exact request body for one query-passage pair; throws `input` above the byte cap. */
export function judgeRequestBody(query: string, context: PassageContext, passage: PassageInput, model = PASSAGE_JUDGE_MODEL): string {
	return systemOneBody(model, judgeState(query, context, passage), PASSAGE_QUESTIONS as Record<string, Question>);
}

function judgeState(query: string, context: PassageContext, passage: PassageInput): Record<string, unknown> {
	const accounts = context.accounts ?? [];
	return {
		query: scrubIdentifiers(query, accounts),
		...(context.patch ? { patch: context.patch } : {}),
		passage: {
			title: scrubIdentifiers(passage.title, accounts),
			domain: passage.domain,
			...(passage.url ? { url: scrubIdentifiers(passage.url, accounts) } : {}),
			...(passage.date ? { date: scrubIdentifiers(passage.date, accounts) } : {}),
			text: scrubIdentifiers(passage.text, accounts),
		},
	};
}

export class PassageJudge {
	private readonly client: SystemOneClient;
	private readonly timeoutMs: number;
	private readonly thresholds: typeof PASSAGE_THRESHOLDS;

	constructor(options: PassageJudgeOptions) {
		this.client = new SystemOneClient({ apiKey: options.apiKey, fetchImpl: options.fetchImpl, url: options.url, model: options.model });
		this.timeoutMs = options.timeoutMs ?? PASSAGE_JUDGE_TIMEOUT_MS;
		this.thresholds = options.thresholds ?? PASSAGE_THRESHOLDS;
	}

	/** All-or-nothing: one failed passage makes the whole batch unavailable, so a mixed judged/unjudged set never reaches the model. */
	async judge(query: string, context: PassageContext, passages: PassageInput[], signal?: AbortSignal): Promise<PassageJudgment> {
		const started = Date.now();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			// Race the batch against the abort so a transport that ignores the signal cannot hang the tool call.
			const aborted = new Promise<never>((_resolve, reject) => {
				const fail = () => reject(new JudgeFailure("timeout"));
				if (controller.signal.aborted) fail();
				else controller.signal.addEventListener("abort", fail, { once: true });
			});
			const answers = await Promise.race([Promise.all(passages.slice(0, MAX_JUDGED_PASSAGES).map((passage) => this.one(query, context, passage, controller.signal))), aborted]);
			return {
				status: "judged",
				judge: answers[0]?.judge ?? this.client.name,
				model: answers[0]?.model ?? this.client.model,
				latencyMs: Date.now() - started,
				inputTokens: answers.reduce((sum, answer) => sum + answer.inputTokens, 0),
				verdicts: answers.map((answer, index) => ({ id: passages[index].id, route: routeFor(answer.p, this.thresholds), p: { relevant: shown(answer.p.relevant), support: shown(answer.p.support), injection: shown(answer.p.injection) } })),
			};
		} catch (error) {
			const reason = error instanceof JudgeFailure ? error.reason : controller.signal.aborted ? "timeout" : "network";
			logEvent("warn", "passage-judge", "judge-failed", { judge: this.client.name, model: this.client.model, reason, passages: passages.length }, error);
			return { status: "unavailable", judge: this.client.name, model: this.client.model, reason, latencyMs: Date.now() - started };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private async one(query: string, context: PassageContext, passage: PassageInput, signal: AbortSignal) {
		const reply = await this.client.ask(judgeState(query, context, passage), PASSAGE_QUESTIONS as Record<string, Question>, signal);
		return {
			judge: reply.judge,
			model: reply.model,
			inputTokens: reply.inputTokens,
			p: { relevant: noul(reply.answers.relevant), support: noul(reply.answers.support), injection: noul(reply.answers.injection) },
		};
	}
}

/** On when `TYPESAFE_API_KEY` is non-empty; without it web_search is exactly as it was. */
export function createPassageJudge(environment: Record<string, string | undefined>, overrides: Partial<PassageJudgeOptions> = {}): PassageJudge | undefined {
	const apiKey = environment.TYPESAFE_API_KEY?.trim();
	if (!apiKey) return undefined;
	return new PassageJudge({ apiKey, ...overrides });
}
