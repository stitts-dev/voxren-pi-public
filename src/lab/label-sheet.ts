import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { labelProblems, type LabelQuestions, type Labels } from "./labels";

/**
 * The blind labelling sheet for #93: stored answers with the judge's scores,
 * any agent's labels and the answer ids stripped, shuffled with a fixed seed,
 * one block per answer for the owner to score. The key maps a sheet id back to
 * the stored answer id. The sheet carries real answers (Riot IDs, typed
 * questions): it is written outside the tree or to a git-ignored path.
 */

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const MARKER = "--- scores ---";

/** mulberry32: the same sequence on every machine for one seed. */
function random(seed: number): () => number {
	let a = seed | 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled<T>(items: T[], seed: number): T[] {
	const next = random(seed);
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function legend(questions: LabelQuestions): string[] {
	return Object.entries(questions).flatMap(([name, question]) =>
		question.type === "noul"
			? [`### ${name} (1 = yes, 0 = no)`, question.instructions, `1 (yes): ${question.criteria.true}`, `0 (no): ${question.criteria.false}`, ""]
			: [`### ${name} (a number from 0 to ${question.criteria.length - 1})`, question.instructions, ...question.criteria.map((level, i) => `${i}: ${level}`), ""],
	);
}

/**
 * `answers` maps a stored answer id to its text, or to an object with an
 * `answer` text (the corpus files); anything else on the object is dropped.
 * The sheet ids (A01, A02 ...) follow the shuffled order; the key maps each
 * back to the stored id.
 */
export function buildSheet(answers: Record<string, unknown>, questions: LabelQuestions, seed: number): { sheet: string; key: Record<string, string> } {
	const texts = Object.entries(answers).map(([id, entry]) => {
		const text = typeof entry === "string" ? entry : (entry as { answer?: unknown } | null)?.answer;
		if (typeof text !== "string" || !text.trim()) throw new Error(`answer ${JSON.stringify(id)} has no text`);
		return [id, text] as const;
	});
	const key: Record<string, string> = {};
	const blocks = shuffled(texts, seed).map(([id, text], i) => {
		const sheetId = `A${String(i + 1).padStart(2, "0")}`;
		key[sheetId] = id;
		return [`=== ${sheetId} ===`, text.trimEnd(), MARKER, ...Object.keys(questions).map((name) => `${name}:`), ""].join("\n");
	});
	const header = [
		"# Labelling sheet",
		"",
		`Score each answer below from its text alone, on every question listed here. Write one number after each colon under "${MARKER}". Leave a line empty to skip a question for that answer. Look at no judge scores and no earlier labels while you do. The key that maps A01, A02 and the rest back to the stored answers is a separate file.`,
		"",
		"## Questions",
		"",
		...legend(questions),
		"## Answers",
		"",
	].join("\n");
	return { sheet: [header, ...blocks].join("\n"), key };
}

/**
 * The scores written on a filled sheet, keyed by stored answer id through the
 * key. A blank line is no label. Problems are named by sheet id, which is all
 * the owner sees; with any, `labels` is empty.
 */
export function labelsFromSheet(sheet: string, key: Record<string, string>, questions: LabelQuestions): { labels: Labels; problems: string[] } {
	const bySheetId: Labels = {};
	const problems: string[] = [];
	const parts = sheet.split(/^=== (A\d+) ===$/m);
	for (let i = 1; i < parts.length; i += 2) {
		const sheetId = parts[i];
		const body = parts[i + 1];
		if (!Object.hasOwn(key, sheetId)) problems.push(`${sheetId} is not in the key`);
		const at = body.lastIndexOf(MARKER);
		if (at < 0) {
			problems.push(`${sheetId} has no "${MARKER}" line`);
			continue;
		}
		for (const raw of body.slice(at + MARKER.length).split(/\r?\n/)) {
			const line = raw.trim();
			if (!line) continue;
			const [, name, value] = /^(\w+):\s*(.*)$/.exec(line) ?? [];
			if (name === undefined) problems.push(`${sheetId}: cannot read the line ${JSON.stringify(line)}`);
			else if (value) (bySheetId[sheetId] ??= {})[name] = (/^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value) as number;
		}
	}
	problems.push(...labelProblems({ labels: bySheetId }, questions));
	if (problems.length) return { labels: {}, problems };
	return { labels: Object.fromEntries(Object.entries(bySheetId).map(([sheetId, scores]) => [key[sheetId], scores])), problems };
}

/**
 * Throws when `dir` is inside the repository (`repo`, this one unless a test
 * says otherwise) and git does not ignore it, or when git cannot say: a copy
 * with no `.git` (the `just devbox` mirror) refuses too, naming that cause.
 */
export function refusePublicPath(dir: string, repo = REPO): void {
	const full = resolve(dir);
	const inside = relative(repo, full);
	if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return;
	const asked = spawnSync("git", ["check-ignore", "-q", "--", full], { cwd: repo, encoding: "utf8" });
	// git check-ignore: 0 is ignored, 1 is not ignored, anything else is git failing to answer.
	if (asked.status === 0) return;
	if (asked.status !== 1) throw new Error(`cannot ask git whether ${dir} is ignored (not a git checkout?): ${asked.error?.message ?? asked.stderr.trim()}`);
	throw new Error(`${dir} is inside the repository and not git-ignored; the sheet carries real answers, so write it outside the tree`);
}
