import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COACH_YAML } from "../contracts";
import { AGREEMENT_BAR, agreement, agreementReport, labelProblems, mergeLabels, parseLabels, type LabelQuestions, type Labels, type Scores } from "./labels";

const QUESTIONS: LabelQuestions = {
	quality: { type: "score", instructions: "grade", criteria: ["worst", "bad", "soft", "good", "best"] },
	hedges: { type: "noul", instructions: "hedges?", criteria: { true: "yes", false: "no" } },
};

/** `total` answers on one yes/no question: the first `agreeing` match the owner, the rest do not. */
function hedgeCase(agreeing: number, total: number): { labels: Labels; scores: Scores } {
	const labels: Labels = {};
	const scores: Scores = {};
	for (let i = 0; i < total; i++) {
		labels[`a${i}`] = { hedges: 1 };
		scores[`a${i}`] = { hedges: i < agreeing ? 0.9 : 0.1 };
	}
	return { labels, scores };
}

describe("label file", () => {
	test("the checked-in data/eval/labels.json validates against the answer rubric questions", () => {
		const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/eval/labels.json", import.meta.url)), "utf8"));
		expect(labelProblems(raw, COACH_YAML.jev.answerRubric as unknown as LabelQuestions)).toEqual([]);
	});
	test("an empty file and a partly labelled answer are valid", () => {
		expect(labelProblems({ labels: {} }, QUESTIONS)).toEqual([]);
		expect(labelProblems({ labels: { a: { hedges: 0 }, b: { quality: 4, hedges: 1 } } }, QUESTIONS)).toEqual([]);
	});
	test("a yes/no label is 0 or 1, a score label an integer inside the question's levels", () => {
		expect(labelProblems({ labels: { a: { hedges: 0.5 } } }, QUESTIONS)).toEqual(['labels["a"].hedges: 0.5 is not 0 or 1']);
		expect(labelProblems({ labels: { a: { hedges: "yes" } } }, QUESTIONS)).toEqual(['labels["a"].hedges: "yes" is not 0 or 1']);
		expect(labelProblems({ labels: { a: { quality: 5 } } }, QUESTIONS)).toEqual(['labels["a"].quality: 5 is not an integer from 0 to 4']);
		expect(labelProblems({ labels: { a: { quality: 2.5 } } }, QUESTIONS)).toEqual(['labels["a"].quality: 2.5 is not an integer from 0 to 4']);
		expect(labelProblems({ labels: { a: { quality: -1 } } }, QUESTIONS)).toEqual(['labels["a"].quality: -1 is not an integer from 0 to 4']);
	});
	test("names every problem at once: unknown question, unknown key, wrong shapes", () => {
		const problems = labelProblems({ labels: { a: { nonsense: 1, hedges: 7 }, b: "x" }, extra: 1 }, QUESTIONS);
		expect(problems).toHaveLength(4);
		expect(problems.join("\n")).toContain('unknown key "extra"');
		expect(problems.join("\n")).toContain('labels["a"].nonsense: not a question (known: quality, hedges)');
		expect(problems.join("\n")).toContain('labels["a"].hedges: 7 is not 0 or 1');
		expect(problems.join("\n")).toContain('labels["b"]: not an object');
		expect(labelProblems(null, QUESTIONS)).toEqual(["the file is not an object"]);
		expect(labelProblems({}, QUESTIONS)).toEqual(["labels is missing or not an object"]);
	});
	test("parseLabels returns the labels of a valid file and throws every problem of an invalid one", () => {
		expect(parseLabels({ labels: { a: { hedges: 1 } } }, QUESTIONS)).toEqual({ a: { hedges: 1 } });
		expect(() => parseLabels({ labels: { a: { hedges: 3, quality: 9 } } }, QUESTIONS)).toThrow(/hedges: 3 is not 0 or 1\n.*quality: 9/);
	});
	test("mergeLabels: the new label wins per answer and question, nothing else is lost", () => {
		const merged = mergeLabels({ a: { hedges: 1, quality: 2 }, b: { hedges: 0 } }, { a: { quality: 4 }, c: { hedges: 1 } });
		expect(merged).toEqual({ a: { hedges: 1, quality: 4 }, b: { hedges: 0 }, c: { hedges: 1 } });
	});
});

describe("agreement", () => {
	test("a yes/no question agrees when the judge's probability is on the owner's side of the threshold, 0.5 unless set", () => {
		const labels: Labels = { a: { hedges: 1 }, b: { hedges: 0 }, c: { hedges: 1 }, d: { hedges: 0 } };
		const scores: Scores = { a: { hedges: 0.9 }, b: { hedges: 0.2 }, c: { hedges: 0.4 }, d: { hedges: 0.5 } };
		const [row] = agreement(labels, scores, { hedges: QUESTIONS.hedges });
		// a and b agree; c (0.4 against yes) and d (0.5 reads as yes against no) do not.
		expect(row).toMatchObject({ question: "hedges", labelled: 4, agree: 2, agreement: 0.5, excluded: true });
		const [raised] = agreement(labels, scores, { hedges: QUESTIONS.hedges }, { hedges: 0.7 });
		// At 0.7 d now reads as no, so it agrees; c still does not.
		expect(raised).toMatchObject({ labelled: 4, agree: 3, agreement: 0.75, excluded: true });
	});
	test("a score question agrees within one level, the edge included, unless set", () => {
		const labels: Labels = { a: { quality: 3 }, b: { quality: 1 }, c: { quality: 4 } };
		const scores: Scores = { a: { quality: 2.2 }, b: { quality: 2.5 }, c: { quality: 3 } };
		const [row] = agreement(labels, scores, { quality: QUESTIONS.quality });
		// a is 0.8 off, b 1.5 off, c exactly 1 off.
		expect(row).toMatchObject({ question: "quality", labelled: 3, agree: 2 });
		expect(row.agreement).toBeCloseTo(2 / 3, 10);
		const [exact] = agreement(labels, scores, { quality: QUESTIONS.quality }, { quality: 0.5 });
		expect(exact).toMatchObject({ labelled: 3, agree: 0, agreement: 0 });
		// A one-decimal gap equal to a one-decimal tolerance agrees although 3 - 2.3 is 0.7000000000000002 in floats.
		const [edge] = agreement({ a: { quality: 3 } }, { a: { quality: 2.3 } }, { quality: QUESTIONS.quality }, { quality: 0.7 });
		expect(edge).toMatchObject({ labelled: 1, agree: 1 });
	});
	test("0.8 is the bar: exactly at it stays in, under it is excluded", () => {
		expect(AGREEMENT_BAR).toBe(0.8);
		for (const [agreeing, total, excluded] of [[8, 10, false], [7, 10, true], [4, 5, false], [24, 30, false], [23, 30, true], [80, 100, false], [79, 100, true], [10, 10, false]] as const) {
			const { labels, scores } = hedgeCase(agreeing, total);
			const [row] = agreement(labels, scores, { hedges: QUESTIONS.hedges });
			expect(row).toMatchObject({ labelled: total, agree: agreeing, excluded });
		}
	});
	test("a question nobody labelled is excluded: unmeasured is not a ruler", () => {
		const rows = agreement({ a: { hedges: 1 } }, { a: { hedges: 0.9 } }, QUESTIONS);
		expect(rows.map((row) => row.question)).toEqual(["quality", "hedges"]);
		expect(rows[0]).toMatchObject({ labelled: 0, agree: 0, agreement: null, excluded: true });
		expect(rows[1]).toMatchObject({ labelled: 1, agree: 1, agreement: 1, excluded: false });
	});
	test("a label with no stored judge score is counted as unscored, not as a disagreement", () => {
		const [row] = agreement({ a: { hedges: 1 }, b: { hedges: 1 } }, { a: { hedges: 0.9 } }, { hedges: QUESTIONS.hedges });
		expect(row).toMatchObject({ labelled: 1, agree: 1, unscored: 1, agreement: 1, excluded: false });
	});
	test("an answer the owner did not label for a question is left out of it", () => {
		const [row] = agreement({ a: { hedges: 1 }, b: { quality: 2 } }, { a: { hedges: 0.9 }, b: { hedges: 0.9 } }, { hedges: QUESTIONS.hedges });
		expect(row).toMatchObject({ labelled: 1, agree: 1 });
	});
	test("the report names every excluded question and the bar", () => {
		const { labels, scores } = hedgeCase(7, 10);
		const text = agreementReport(agreement(labels, scores, QUESTIONS));
		expect(text).toContain("Excluded from keep decisions: quality, hedges.");
		expect(text).toContain("7/10");
		const all = hedgeCase(10, 10);
		const full = agreementReport(agreement({ ...all.labels }, { ...all.scores }, { hedges: QUESTIONS.hedges }));
		expect(full).toContain("Excluded from keep decisions: none.");
		expect(full).toContain("0.8");
	});
	test("the report says how many labelled answers had no stored score", () => {
		const text = agreementReport(agreement({ a: { hedges: 1 }, b: { hedges: 1 } }, { a: { hedges: 0.9 } }, { hedges: QUESTIONS.hedges }));
		expect(text).toContain("1 labelled answer has no stored score for hedges");
	});
});
