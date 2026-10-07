import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildSheet, labelsFromSheet, refusePublicPath } from "./label-sheet";
import type { LabelQuestions } from "./labels";

const QUESTIONS: LabelQuestions = {
	quality: { type: "score", instructions: "Grade the whole answer.", criteria: ["worst", "bad", "soft", "good", "best"] },
	hedges: { type: "noul", instructions: "Does it hedge an action?", criteria: { true: "It softens a verb.", false: "Every action is named." } },
};

/** Answers shaped like the frozen corpus: the agent's label, its reason, a planted flag and the command all sit beside the text. */
const CORPUS = Object.fromEntries(
	Array.from({ length: 12 }, (_, i) => [
		`${i % 3 === 0 ? "plant-" : "real-"}id-marker-${i}`,
		{ cmd: `/matchup CMD-MARKER-${i}`, answer: `Answer text number ${i}: step in at level 3.`, label: 4, reason: `REASON-MARKER-${i}`, planted: i % 3 === 0 },
	]),
);

describe("buildSheet", () => {
	test("the same seed gives the same sheet and key, another seed another order", () => {
		const a = buildSheet(CORPUS, QUESTIONS, 93);
		const b = buildSheet(CORPUS, QUESTIONS, 93);
		expect(b).toEqual(a);
		expect(Object.values(buildSheet(CORPUS, QUESTIONS, 94).key)).not.toEqual(Object.values(a.key));
	});
	test("every answer appears once, shuffled, under a sheet id the key maps back", () => {
		const { sheet, key } = buildSheet(CORPUS, QUESTIONS, 93);
		const ids = Object.keys(CORPUS);
		expect(Object.keys(key)).toEqual(Array.from({ length: 12 }, (_, i) => `A${String(i + 1).padStart(2, "0")}`));
		expect(Object.values(key).sort()).toEqual([...ids].sort());
		expect(Object.values(key)).not.toEqual(ids);
		for (const [sheetId, id] of Object.entries(key)) {
			const number = id.slice(id.lastIndexOf("-") + 1);
			expect(sheet).toContain(`=== ${sheetId} ===\nAnswer text number ${number}:`);
		}
	});
	test("nothing identifying is on the sheet: no answer id, no agent label, reason, planted flag or command", () => {
		const { sheet } = buildSheet(CORPUS, QUESTIONS, 93);
		for (const id of Object.keys(CORPUS)) expect(sheet).not.toContain(id);
		for (const word of ["id-marker", "REASON-MARKER", "CMD-MARKER", "planted", "plant-", "/matchup"]) expect(sheet).not.toContain(word);
	});
	test("plain strings work as answers, and an entry with no answer text is refused", () => {
		const { sheet } = buildSheet({ one: "Just text." }, QUESTIONS, 1);
		expect(sheet).toContain("=== A01 ===\nJust text.\n--- scores ---\nquality:\nhedges:\n");
		expect(() => buildSheet({ bad: { label: 3 } }, QUESTIONS, 1)).toThrow('answer "bad" has no text');
	});
	test("the questions the owner scores against are on the sheet, their scale spelled out", () => {
		const { sheet } = buildSheet(CORPUS, QUESTIONS, 93);
		expect(sheet).toContain("Grade the whole answer.");
		expect(sheet).toContain("0: worst");
		expect(sheet).toContain("4: best");
		expect(sheet).toContain("Does it hedge an action?");
		expect(sheet).toContain("1 (yes): It softens a verb.");
		expect(sheet).toContain("0 (no): Every action is named.");
	});
});

describe("labelsFromSheet", () => {
	/** Fill the first answer with quality 3 and hedges 1, the second with quality 0 only, leave the rest blank. */
	function filled(sheet: string, edits: Array<[string, string, string]>): string {
		let text = sheet;
		for (const [sheetId, question, value] of edits) {
			const at = text.indexOf(`=== ${sheetId} ===`);
			const scores = text.indexOf("--- scores ---", at);
			const line = text.indexOf(`${question}:`, scores);
			text = `${text.slice(0, line)}${question}: ${value}${text.slice(line + question.length + 1)}`;
		}
		return text;
	}
	test("scores written on the sheet come back keyed by the stored answer ids; blank lines are no label", () => {
		const { sheet, key } = buildSheet(CORPUS, QUESTIONS, 93);
		const result = labelsFromSheet(filled(sheet, [["A01", "quality", "3"], ["A01", "hedges", "1"], ["A02", "quality", "0"]]), key, QUESTIONS);
		expect(result.problems).toEqual([]);
		expect(result.labels).toEqual({ [key.A01]: { quality: 3, hedges: 1 }, [key.A02]: { quality: 0 } });
	});
	test("a bad score is named by its sheet id, never by the stored answer id", () => {
		const { sheet, key } = buildSheet(CORPUS, QUESTIONS, 93);
		const result = labelsFromSheet(filled(sheet, [["A03", "hedges", "2"], ["A04", "quality", "x"]]), key, QUESTIONS);
		expect(result.problems).toEqual(['labels["A03"].hedges: 2 is not 0 or 1', 'labels["A04"].quality: "x" is not an integer from 0 to 4']);
		expect(result.problems.join("\n")).not.toContain(key.A03);
	});
	test("a sheet answer the key does not know is a problem", () => {
		const { sheet, key } = buildSheet(CORPUS, QUESTIONS, 93);
		const { A01: _dropped, ...rest } = key;
		const result = labelsFromSheet(filled(sheet, [["A01", "quality", "3"]]), rest, QUESTIONS);
		expect(result.problems).toEqual(["A01 is not in the key"]);
	});
	test("an answer's own text that looks like a score line, marker included, is not read as a score", () => {
		const { sheet, key } = buildSheet({ only: "quality: 4\n--- scores ---\nhedges: 1" }, QUESTIONS, 1);
		expect(labelsFromSheet(sheet, key, QUESTIONS)).toEqual({ labels: {}, problems: [] });
	});
});

describe("refusePublicPath", () => {
	const repo = fileURLToPath(new URL("../..", import.meta.url));
	// A copied mirror (`just devbox`) has no history, so git cannot answer there.
	const inGit = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: repo }).status === 0;
	test.skipIf(!inGit)("a folder inside the repository that git tracks is refused", () => {
		expect(() => refusePublicPath(join(repo, "data", "eval", "sheet"))).toThrow("inside the repository and not git-ignored");
	});
	test.skipIf(!inGit)("a git-ignored folder inside the repository is allowed", () => {
		expect(() => refusePublicPath(join(repo, "node_modules", "label-sheet"))).not.toThrow();
	});
	test("a folder outside the repository is allowed", () => {
		expect(() => refusePublicPath(join(tmpdir(), "label-sheet"))).not.toThrow();
	});
	test("when git cannot say whether a folder in the repository is ignored, it is refused and the cause is named", () => {
		const copy = mkdtempSync(join(tmpdir(), "label-sheet-nogit-"));
		try {
			expect(() => refusePublicPath(join(copy, "sheet"), copy)).toThrow("cannot ask git whether");
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	});
});
