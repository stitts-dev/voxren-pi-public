import type { FetchLike } from "./policy";

/**
 * Transport for TypeSafe System One (Jev): one POST per ask, bearer auth,
 * byte caps both ways, and a fixed failure taxonomy. Judges build the state
 * and the questions and route on the answers; this file never decides anything.
 */

export const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
export const SYSTEMONE_MODEL = "jev-latest";
/** What a result calls the decision model behind the client; a second provider (#157) passes its own. */
export const SYSTEMONE_NAME = "jev";
/** Room for the audit's passage (live-gateway.ts AUDIT_PASSAGE_CHARS) with the one-trick reference and a claim beside it. */
export const MAX_JUDGE_REQUEST_BYTES = 64_000;
export const MAX_JUDGE_RESPONSE_BYTES = 32_768;

export type NoulQuestion = { type: "noul"; instructions: string; criteria: { true: string; false: string } };
/** Choice: `criteria` maps option key to description (up to 255). Answer: `{ type: "choice", choice, probabilities, confidence }`. */
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
/** Score: `criteria` is an ordered list of 2 to 10 level descriptions; the answer's `score` is the expected level index (0 to n-1). */
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type JudgeFailureReason = "timeout" | "network" | "authentication" | "rate_limited" | "server" | "response" | "input";

export class JudgeFailure extends Error {
	constructor(readonly reason: JudgeFailureReason) {
		super(reason);
	}
}

export interface AskResult {
	/** The client's name, so a result says who judged it. */
	judge: string;
	/** The model the reply names, "unknown" when it names none. */
	model: string;
	inputTokens: number;
	answers: Record<string, unknown>;
}

export interface SystemOneOptions {
	apiKey: string;
	fetchImpl?: FetchLike;
	url?: string;
	model?: string;
	name?: string;
}

/** The exact request body; throws `input` above the byte cap. */
export function systemOneBody(model: string, state: Record<string, unknown>, questions: Record<string, Question>): string {
	const body = JSON.stringify({ model, state, questions });
	if (Buffer.byteLength(body, "utf8") > MAX_JUDGE_REQUEST_BYTES) throw new JudgeFailure("input");
	return body;
}

/** A probability as shown (cards, logs, the model): 2 dp. Never compare this against a threshold. */
export function shown(p: number): number {
	return Math.round(p * 100) / 100;
}

/** The raw probability, validated; routing compares it as is. */
export function noul(value: unknown): number {
	const answer = value as { type?: unknown; noul?: unknown } | undefined;
	if (!answer || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
		throw new JudgeFailure("response");
	}
	return answer.noul;
}

export function choice(value: unknown, keys: readonly string[]): string {
	const answer = value as { type?: unknown; choice?: unknown } | undefined;
	if (!answer || answer.type !== "choice" || typeof answer.choice !== "string" || !keys.includes(answer.choice)) throw new JudgeFailure("response");
	return answer.choice;
}

/** A choice answer's per-option probabilities, rounded to 2 dp; undefined when the reply carries none. */
export function choiceProbabilities(value: unknown): Record<string, number> | undefined {
	const answer = value as { probabilities?: unknown } | undefined;
	if (!answer || !answer.probabilities || typeof answer.probabilities !== "object") return undefined;
	const out: Record<string, number> = {};
	for (const [key, p] of Object.entries(answer.probabilities as Record<string, unknown>)) if (typeof p === "number" && Number.isFinite(p)) out[key] = Math.round(p * 100) / 100;
	return out;
}

/** Reads the body through its stream, cancelling as soon as the total crosses the cap so an oversized reply never buffers in full. Falls back to `text()` when the body carries no stream. */
async function readCappedBody(response: Response): Promise<string> {
	if (!response.body) {
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > MAX_JUDGE_RESPONSE_BYTES) throw new JudgeFailure("response");
		return text;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_JUDGE_RESPONSE_BYTES) {
			await reader.cancel();
			throw new JudgeFailure("response");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8").decode(bytes);
}

export class SystemOneClient {
	private readonly fetchImpl: FetchLike;
	private readonly url: string;
	readonly model: string;
	readonly name: string;

	constructor(private readonly options: SystemOneOptions) {
		this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
		this.url = options.url ?? TYPESAFE_SYSTEMONE_URL;
		this.model = options.model ?? SYSTEMONE_MODEL;
		this.name = options.name ?? SYSTEMONE_NAME;
	}

	async ask(state: Record<string, unknown>, questions: Record<string, Question>, signal: AbortSignal): Promise<AskResult> {
		if (!this.options.apiKey) throw new JudgeFailure("authentication");
		const body = systemOneBody(this.model, state, questions);
		let response: Response;
		try {
			response = await this.fetchImpl(this.url, {
				method: "POST",
				redirect: "error",
				headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${this.options.apiKey}` },
				body,
				signal,
			});
		} catch {
			throw new JudgeFailure(signal.aborted ? "timeout" : "network");
		}
		if (response.status === 401 || response.status === 403) throw new JudgeFailure("authentication");
		if (response.status === 429) throw new JudgeFailure("rate_limited");
		// 400/422: our request failed validation (docs.typesafe.ai/api); that is an input fault, not an upstream one.
		if (response.status === 400 || response.status === 422) throw new JudgeFailure("input");
		if (response.status < 200 || response.status >= 300) throw new JudgeFailure("server");
		const contentLength = response.headers.get("content-length");
		if (contentLength !== null && Number(contentLength) > MAX_JUDGE_RESPONSE_BYTES) {
			await response.body?.cancel();
			throw new JudgeFailure("response");
		}
		let text: string;
		try {
			text = await readCappedBody(response);
		} catch (error) {
			if (error instanceof JudgeFailure) throw error;
			throw new JudgeFailure(signal.aborted ? "timeout" : "network");
		}
		let raw: any;
		try {
			raw = JSON.parse(text);
		} catch {
			throw new JudgeFailure("response");
		}
		if (!raw || typeof raw !== "object" || !raw.answers || typeof raw.answers !== "object") throw new JudgeFailure("response");
		return {
			judge: this.name,
			model: typeof raw.model === "string" ? raw.model : "unknown",
			inputTokens: typeof raw.usage?.input_tokens === "number" ? raw.usage.input_tokens : 0,
			answers: raw.answers,
		};
	}
}
