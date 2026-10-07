import type { NoulQuestion, ScoreQuestion } from "../systemone";

/**
 * Hand labels for the Jev answer rubric (#93) and the per-question agreement
 * with them. A judge is a ruler only once it agrees with the owner: a question
 * under the bar is excluded from keep decisions until its criteria are fixed.
 * Pure functions; src/lab/label-kit.ts is the command, src/lab/label-sheet.ts
 * draws the blind sheet the labels come from. No model call here.
 *
 * data/eval/labels.json: `{ "labels": { "<answer id>": { "<question>": n } } }`.
 * A yes/no (`noul`) question is labelled 0 (no) or 1 (yes); a `score` question
 * an integer from 0 to its last level. An answer need not carry every question.
 */

/** The spec's bar (2026-09-27-coach-knowledge-design.md, Calibration): under this agreement a question is excluded. */
export const AGREEMENT_BAR = 0.8;
export type LabelQuestion = NoulQuestion | ScoreQuestion;
export type LabelQuestions = Record<string, LabelQuestion>;
/** Answer id, then question, then the owner's label. */
export type Labels = Record<string, Record<string, number>>;
/** Answer id, then question, then the judge's stored score (a probability for a yes/no question, a level for a score). */
export type Scores = Record<string, Record<string, number>>;

export interface Agreement {
	question: string;
	/** How a judge score is compared with a label, as printed. */
	rule: string;
	/** Answers with both a label and a stored judge score for this question. */
	labelled: number;
	agree: number;
	/** Labelled answers the judge has no stored score for: left out of `labelled`. */
	unscored: number;
	/** `agree / labelled`, null when nothing is labelled. */
	agreement: number | null;
	excluded: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function labelProblem(question: LabelQuestion, value: unknown): string | undefined {
	if (question.type === "noul") return value === 0 || value === 1 ? undefined : `${JSON.stringify(value)} is not 0 or 1`;
	const last = question.criteria.length - 1;
	return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= last ? undefined : `${JSON.stringify(value)} is not an integer from 0 to ${last}`;
}

/** Every reason `raw` is not a label file for these questions, all at once; empty when it is one. */
export function labelProblems(raw: unknown, questions: LabelQuestions): string[] {
	if (!isRecord(raw)) return ["the file is not an object"];
	const problems = Object.keys(raw).filter((key) => key !== "labels").map((key) => `unknown key ${JSON.stringify(key)}`);
	if (!isRecord(raw.labels)) return [...problems, "labels is missing or not an object"];
	for (const [id, entry] of Object.entries(raw.labels)) {
		const at = `labels[${JSON.stringify(id)}]`;
		if (!isRecord(entry)) {
			problems.push(`${at}: not an object`);
			continue;
		}
		for (const [name, value] of Object.entries(entry)) {
			const question = Object.hasOwn(questions, name) ? questions[name] : undefined;
			const problem = question ? labelProblem(question, value) : `not a question (known: ${Object.keys(questions).join(", ")})`;
			if (problem) problems.push(`${at}.${name}: ${problem}`);
		}
	}
	return problems;
}

/** The labels of a valid file; throws every problem of an invalid one. */
export function parseLabels(raw: unknown, questions: LabelQuestions): Labels {
	const problems = labelProblems(raw, questions);
	if (problems.length) throw new Error(problems.join("\n"));
	return (raw as { labels: Labels }).labels;
}

/** `extra` over `base`, per answer and question; nothing else is lost. */
export function mergeLabels(base: Labels, extra: Labels): Labels {
	const merged: Labels = {};
	for (const id of new Set([...Object.keys(base), ...Object.keys(extra)])) merged[id] = { ...base[id], ...extra[id] };
	return merged;
}

/**
 * Per question, how often the judge's stored score agrees with the owner's
 * label, in the order of `questions`. `settings` sets one number per question:
 * the probability at which a yes/no judge reads as yes (default 0.5), or how
 * many levels a score may differ from the label (default 1). A question with
 * no labels is excluded too: unmeasured is not a ruler.
 */
export function agreement(labels: Labels, scores: Scores, questions: LabelQuestions, settings: Record<string, number> = {}): Agreement[] {
	return Object.entries(questions).map(([question, definition]) => {
		const yesNo = definition.type === "noul";
		const setting = settings[question] ?? (yesNo ? 0.5 : 1);
		let labelled = 0;
		let agree = 0;
		let unscored = 0;
		for (const [id, owner] of Object.entries(labels)) {
			const label = owner[question];
			if (label === undefined) continue;
			const judged = scores[id]?.[question];
			if (typeof judged !== "number") {
				unscored++;
				continue;
			}
			labelled++;
			// The epsilon keeps a one-decimal gap equal to a one-decimal tolerance from tipping over on float error.
			if (yesNo ? (judged >= setting) === (label === 1) : Math.abs(judged - label) <= setting + 1e-9) agree++;
		}
		const ratio = labelled ? agree / labelled : null;
		const rule = yesNo ? `yes at ${setting} or more` : `within ${setting} level${setting === 1 ? "" : "s"}`;
		return { question, rule, labelled, agree, unscored, agreement: ratio, excluded: ratio === null || ratio < AGREEMENT_BAR };
	});
}

/** The rows as a table, then the questions the bar excludes. */
export function agreementReport(rows: Agreement[]): string {
	const excluded = rows.filter((row) => row.excluded).map((row) => row.question);
	return [
		"| question | rule | agree | agreement | |",
		"|---|---|---|---|---|",
		...rows.map((row) => `| ${row.question} | ${row.rule} | ${row.agree}/${row.labelled} | ${row.agreement === null ? "no labels" : row.agreement.toFixed(3)} | ${row.excluded ? "excluded" : ""} |`),
		"",
		...rows.filter((row) => row.unscored).map((row) => `${row.unscored} labelled answer${row.unscored === 1 ? " has" : "s have"} no stored score for ${row.question}.`),
		`Bar ${AGREEMENT_BAR}. Excluded from keep decisions: ${excluded.length ? `${excluded.join(", ")}.` : "none."}`,
	].join("\n");
}
