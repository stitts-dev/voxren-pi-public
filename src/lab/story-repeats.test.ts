import { describe, expect, test } from "bun:test";
import type { Grade } from "./answer-rubric.ts";
import { aggregateTurns, median } from "./story-repeats.ts";

describe("aggregateTurns", () => {
	const grade = (quality: number, flags: Partial<Grade> = {}): Grade => ({ quality, has_intro_or_closing: 0, hedges: 0, unsourced_number: 0, inputTokens: 1, ...flags });
	test("median of odd and even lists, null when empty", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([1, 2, 3, 4])).toBe(2.5);
		expect(median([])).toBeNull();
	});
	test("per turn: median quality, raw repeats, flag counts, strict pass", () => {
		const [turn] = aggregateTurns([[grade(4)], [grade(3, { hedges: 0.9 })], [grade(2)]]);
		expect(turn).toMatchObject({ turn: 1, medianQuality: 3, qualities: [4, 3, 2], flags: { intro: 0, hedges: 1, unsourced: 0 }, strictPass: false });
	});
	test("strict pass: every repeat at the threshold and no flag; the threshold is a parameter", () => {
		const repeats = [[grade(3)], [grade(4)]];
		expect(aggregateTurns(repeats)[0].strictPass).toBe(true);
		expect(aggregateTurns(repeats, 4)[0].strictPass).toBe(false);
		expect(aggregateTurns([[grade(4, { has_intro_or_closing: 0.5 })]])[0].strictPass).toBe(false);
	});
	test("null scores (no Jev key) give null numbers and no strict verdict", () => {
		const [turn] = aggregateTurns([[null], [null]]);
		expect(turn).toMatchObject({ medianQuality: null, qualities: [null, null], flags: { intro: 0, hedges: 0, unsourced: 0 }, strictPass: null });
	});
	test("a repeat with fewer turns counts as null on the missing turn; a partial null is no strict verdict", () => {
		const turns = aggregateTurns([[grade(4), grade(4)], [grade(4)]]);
		expect(turns).toHaveLength(2);
		expect(turns[1]).toMatchObject({ qualities: [4, null], medianQuality: 4, strictPass: null });
	});
});
