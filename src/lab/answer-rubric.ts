import { COACH_YAML, enforcedDoctrineIds } from "../contracts";
import { choice, noul, type Question, type SystemOneClient } from "../systemone";
import type { Story } from "./stories.ts";

/** Score answer: `{ type: "score", score, legend, probabilities, confidence }`; `score` is the expected level index, 0 to criteria.length - 1 (docs.typesafe.ai/primitives/score). */
function score(value: unknown): number {
	const answer = value as { type?: unknown; score?: unknown } | undefined;
	if (!answer || answer.type !== "score" || typeof answer.score !== "number" || !Number.isFinite(answer.score)) throw new Error("malformed score answer");
	return Math.round(answer.score * 10) / 10;
}

export interface Grade {
	quality: number;
	has_intro_or_closing: number;
	hedges: number;
	unsourced_number: number;
	inputTokens: number;
}

/** Jev's `jev.answerRubric` questions on one answer: the story runner's grade of one answer. Throws JudgeFailure when Jev is unreachable. */
export async function gradeAnswer(client: SystemOneClient, answer: string, timeoutMs = 5000): Promise<Grade> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const questions = COACH_YAML.jev.answerRubric as unknown as Record<string, Question>;
		const reply = await client.ask({ answer: answer.slice(0, 12_000) }, questions, controller.signal);
		return { quality: score(reply.answers.quality), has_intro_or_closing: noul(reply.answers.has_intro_or_closing), hedges: noul(reply.answers.hedges), unsourced_number: noul(reply.answers.unsourced_number), inputTokens: reply.inputTokens };
	} finally {
		clearTimeout(timer);
	}
}

/** Jev's `jev.storyChecks` questions on one answer: the noul (0 to 1, how sure the answer is a yes) of each named check. Throws JudgeFailure when Jev is unreachable. */
export async function checkAnswer(client: SystemOneClient, answer: string, names: string[], timeoutMs = 5000): Promise<{ noul: Record<string, number>; inputTokens: number }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const all = COACH_YAML.jev.storyChecks as unknown as Record<string, Question>;
		const missing = names.find((name) => !all[name]);
		if (missing) throw new Error(`no jev.storyChecks.${missing} in coach.yaml`);
		const questions = Object.fromEntries(names.map((name) => [name, all[name]]));
		const reply = await client.ask({ answer: answer.slice(0, 12_000) }, questions, controller.signal);
		return { noul: Object.fromEntries(names.map((name) => [name, noul(reply.answers[name])])), inputTokens: reply.inputTokens };
	} finally {
		clearTimeout(timer);
	}
}

/** At or over this a doctrine question counts as followed. No hand labels measure Jev's agreement on these questions yet, so the scores are report-only. */
export const DOCTRINE_FOLLOWED_AT = 0.5;

/** The doctrine questions the runner asks of a story's answers: the ones its `applies` names (each once, in its order), or every question when it names none. A rule an answer had no occasion for reads as not followed, which is why a story names its own. */
export function doctrineQuestionsFor(story: Pick<Story, "applies">): string[] {
	return story.applies?.length ? [...new Set(story.applies)] : Object.keys(COACH_YAML.jev.doctrine);
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export interface DoctrineGrade {
	/** Per yes/no question, how sure Jev is the rule was followed, 0 to 1: its noul, or one minus it on a `violation` question. */
	followed: Record<string, number>;
	/** Per choice question, the option Jev picked (tier_fit: the band of tiers the advice is written for). */
	picked: Record<string, string>;
	inputTokens: number;
}

/** Jev's `jev.doctrine` questions (all of them, or the named ones) on one answer. Jev gets each question alone: `enforces` and `violation` are ours. Throws JudgeFailure when Jev is unreachable or answers off the question. */
export async function gradeDoctrine(client: SystemOneClient, answer: string, names: string[] = Object.keys(COACH_YAML.jev.doctrine), timeoutMs = 5000): Promise<DoctrineGrade> {
	const all = COACH_YAML.jev.doctrine;
	const missing = names.find((name) => !all[name]);
	if (missing) throw new Error(`no jev.doctrine.${missing} in coach.yaml`);
	const questions = Object.fromEntries(
		names.map((name) => {
			const { enforces: _enforces, violation: _violation, ...question } = all[name] as typeof all[string] & { violation?: boolean };
			return [name, question as Question];
		}),
	);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const reply = await client.ask({ answer: answer.slice(0, 12_000) }, questions, controller.signal);
		const grade: DoctrineGrade = { followed: {}, picked: {}, inputTokens: reply.inputTokens };
		for (const name of names) {
			const question = all[name];
			if (question.type === "choice") grade.picked[name] = choice(reply.answers[name], Object.keys(question.criteria));
			else grade.followed[name] = round3(question.violation ? 1 - noul(reply.answers[name]) : noul(reply.answers[name]));
		}
		return grade;
	} finally {
		clearTimeout(timer);
	}
}

export interface DoctrineSummary {
	/** Mean `followed` over the yes/no questions, 0 to 1; null when none was asked. */
	score: number | null;
	/** The questions under the mark, worst first, each with the doctrine ids its score points at. */
	failed: { question: string; followed: number; rules: string[] }[];
	picked: Record<string, string>;
	/** What the grading call cost, in Jev input tokens. */
	inputTokens: number;
}

/** One answer's doctrine grade as the report and stats.json carry it: the score, and for every question under the mark the doctrine rows to edit. */
export function summarizeDoctrine(grade: DoctrineGrade, doctrine: typeof COACH_YAML.jev.doctrine = COACH_YAML.jev.doctrine): DoctrineSummary {
	const entries = Object.entries(grade.followed);
	return {
		score: entries.length ? Math.round((entries.reduce((sum, [, value]) => sum + value, 0) / entries.length) * 100) / 100 : null,
		failed: entries
			.filter(([, value]) => value < DOCTRINE_FOLLOWED_AT)
			.sort((a, b) => a[1] - b[1])
			.map(([question, followed]) => ({ question, followed, rules: enforcedDoctrineIds(doctrine[question].enforces) })),
		picked: grade.picked,
		inputTokens: grade.inputTokens,
	};
}
