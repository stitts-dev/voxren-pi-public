import { describe, expect, test } from "bun:test";
import { COACH_YAML } from "../contracts.ts";
import { JudgeFailure, SystemOneClient } from "../systemone.ts";
import { DOCTRINE_FOLLOWED_AT, doctrineQuestionsFor, gradeDoctrine, summarizeDoctrine } from "./answer-rubric.ts";

const ALL = Object.keys(COACH_YAML.jev.doctrine);

/** A fake Jev: records every request body and answers each asked question from `answers` (a noul, or a choice key). */
function fake(answers: Record<string, number | string>, requests: { questions: Record<string, Record<string, unknown>>; state: { answer: string } }[] = []) {
	return new SystemOneClient({
		apiKey: "k",
		fetchImpl: async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			requests.push(body);
			const reply = Object.fromEntries(Object.keys(body.questions).map((name) => [name, typeof answers[name] === "string" ? { type: "choice", choice: answers[name] } : { type: "noul", noul: answers[name] ?? 0.5 }]));
			return new Response(JSON.stringify({ model: "jev", usage: { input_tokens: 321 }, answers: reply }));
		},
	});
}

describe("gradeDoctrine", () => {
	test("asks every doctrine question by default, each as Jev's own question with no enforces or violation", async () => {
		const requests: Parameters<typeof fake>[1] = [];
		await gradeDoctrine(fake({ tier_fit: "iron_silver" }, requests), "Lane: trade after the Charm");
		expect(Object.keys(requests![0].questions)).toEqual(ALL);
		for (const question of Object.values(requests![0].questions)) {
			expect(question).not.toHaveProperty("enforces");
			expect(question).not.toHaveProperty("violation");
			expect(question).toHaveProperty("instructions");
		}
		expect(requests![0].state.answer).toBe("Lane: trade after the Charm");
	});

	test("asks only the questions it is given", async () => {
		const requests: Parameters<typeof fake>[1] = [];
		await gradeDoctrine(fake({}, requests), "x", ["names_tradeoff", "death_as_trade"]);
		expect(Object.keys(requests![0].questions)).toEqual(["names_tradeoff", "death_as_trade"]);
	});

	test("a yes is the rule followed, except on a violation question, where it is the rule broken", async () => {
		const grade = await gradeDoctrine(fake({ generic_copout: 0.9, names_tradeoff: 0.8, tier_fit: "gold_platinum" }), "x", ["generic_copout", "names_tradeoff", "tier_fit"]);
		expect(grade.followed).toEqual({ generic_copout: 0.1, names_tradeoff: 0.8 });
		expect(grade.picked).toEqual({ tier_fit: "gold_platinum" });
		expect(grade.inputTokens).toBe(321);
	});

	test("an unknown question name throws before Jev is asked", async () => {
		const requests: Parameters<typeof fake>[1] = [];
		await expect(gradeDoctrine(fake({}, requests), "x", ["names_tradeoff", "no_such_question"])).rejects.toThrow("no jev.doctrine.no_such_question in coach.yaml");
		expect(requests).toHaveLength(0);
	});

	test("a choice outside the question's options is a failed judgment, never a pick", async () => {
		await expect(gradeDoctrine(fake({ tier_fit: "bronze" }), "x", ["tier_fit"])).rejects.toBeInstanceOf(JudgeFailure);
	});
});

describe("summarizeDoctrine", () => {
	test("the score is the mean followed; each question under the mark is listed worst first with the doctrine ids to edit", () => {
		const summary = summarizeDoctrine({ followed: { generic_copout: 0.4, death_as_trade: 0.9, names_tradeoff: 0.2 }, picked: { tier_fit: "iron_silver" }, inputTokens: 900 });
		expect(summary.score).toBe(0.5);
		expect(summary.failed).toEqual([
			{ question: "names_tradeoff", followed: 0.2, rules: ["craft.give-up"] },
			{ question: "generic_copout", followed: 0.4, rules: ["craft.specific"] },
		]);
		expect(summary.picked).toEqual({ tier_fit: "iron_silver" });
		expect(summary.inputTokens).toBe(900);
	});

	test("a question exactly at the mark counts as followed", () => {
		expect(DOCTRINE_FOLLOWED_AT).toBe(0.5);
		expect(summarizeDoctrine({ followed: { names_tradeoff: 0.5 }, picked: {}, inputTokens: 0 }).failed).toEqual([]);
	});

	test("the score is rounded to two places", () => {
		expect(summarizeDoctrine({ followed: { names_tradeoff: 1, death_as_trade: 0, generic_copout: 0 }, picked: {}, inputTokens: 0 }).score).toBe(0.33);
	});

	test("a prefix question lists every row its prefix names", () => {
		const doctrine = { ...COACH_YAML.jev.doctrine, names_tradeoff: { ...COACH_YAML.jev.doctrine.names_tradeoff, enforces: ["calibration.*"] } };
		const calibration = COACH_YAML.doctrine.basics.concat(COACH_YAML.doctrine.mastery).map((row) => row.id).filter((id) => id.startsWith("calibration."));
		expect(calibration.length).toBeGreaterThan(1);
		expect(summarizeDoctrine({ followed: { names_tradeoff: 0 }, picked: {}, inputTokens: 0 }, doctrine).failed[0].rules).toEqual(calibration);
	});

	test("with no yes/no question asked there is no score", () => {
		expect(summarizeDoctrine({ followed: {}, picked: { tier_fit: "master_plus" }, inputTokens: 5 }).score).toBeNull();
	});
});

describe("doctrineQuestionsFor", () => {
	test("a story that names doctrine questions is graded on those, in the order it names them", () => {
		expect(doctrineQuestionsFor({ applies: ["tier_fit", "names_tradeoff"] })).toEqual(["tier_fit", "names_tradeoff"]);
	});

	test("a story that names none, or an empty list, is graded on every question", () => {
		expect(doctrineQuestionsFor({})).toEqual(ALL);
		expect(doctrineQuestionsFor({ applies: [] })).toEqual(ALL);
	});

	test("a name written twice is asked once", () => {
		expect(doctrineQuestionsFor({ applies: ["names_tradeoff", "death_as_trade", "names_tradeoff"] })).toEqual(["names_tradeoff", "death_as_trade"]);
	});

	test("the list it gives is the one Jev is asked: only the named questions reach the request", async () => {
		const requests: Parameters<typeof fake>[1] = [];
		const grade = await gradeDoctrine(fake({ death_as_trade: 0.9, tier_fit: "gold_platinum" }, requests), "x", doctrineQuestionsFor({ applies: ["death_as_trade", "tier_fit"] }));
		expect(Object.keys(requests![0].questions)).toEqual(["death_as_trade", "tier_fit"]);
		expect(grade.followed).toEqual({ death_as_trade: 0.9 });
		expect(grade.picked).toEqual({ tier_fit: "gold_platinum" });
	});
});
