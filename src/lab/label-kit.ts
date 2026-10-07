/**
 * The label kit for #93, three steps and no model call. A lab, not a test.
 *
 *   bun run src/lab/label-kit.ts sheet  --answers <answers.json> --out <private dir> [--seed 93]
 *   bun run src/lab/label-kit.ts import --sheet <filled sheet.md> --key <key.json> [--labels data/eval/labels.json]
 *   bun run src/lab/label-kit.ts agree  --scores <results.json> [--labels data/eval/labels.json] [--setting <question>=<n> ...]
 *
 * sheet: writes sheet.md (the stored answers, shuffled, no ids and no judge or
 *   agent labels, one score line per question) and key.json (sheet id to stored
 *   answer id) to <private dir>, which must be outside this repository or
 *   git-ignored: the answers carry Riot IDs and typed questions. --answers is
 *   an answers.json ({ id: text }) or a corpus file ({ id: { answer } }).
 * import: reads the filled sheet through the key and merges its scores into the
 *   label file (data/eval/labels.json); the owner commits that file.
 * agree: per question, how often the judge's stored scores agree with the labels,
 *   and which questions fall under the 0.8 bar. --scores is a results.json
 *   ({ grades: [{ query: <answer id>, <question>: n }] }) or { id: { question: n } }.
 *   --setting sets a question's yes threshold (default 0.5) or its score
 *   tolerance in levels (default 1), e.g. --setting hedges=0.7.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COACH_YAML } from "../contracts";
import { buildSheet, labelsFromSheet, refusePublicPath } from "./label-sheet";
import { agreement, agreementReport, mergeLabels, parseLabels, type LabelQuestions, type Scores } from "./labels";

const QUESTIONS = COACH_YAML.jev.answerRubric as unknown as LabelQuestions;
const LABELS = join(fileURLToPath(new URL("../..", import.meta.url)), "data", "eval", "labels.json");
/** The default shuffle seed, so a sheet made twice from the same answers has the same order. */
const SEED = 93;

const argv = process.argv.slice(2);
const values = (name: string) => argv.flatMap((item, i) => (item === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
function need(name: string): string {
	const value = values(name)[0];
	if (!value) throw new Error(`${name} is required (see the usage at the top of src/lab/label-kit.ts)`);
	return value;
}
const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));

function readScores(path: string): Scores {
	const raw = readJson(path);
	return Array.isArray(raw.grades) ? Object.fromEntries(raw.grades.map(({ query, ...scores }: { query: string }) => [query, scores])) : raw;
}

function settings(): Record<string, number> {
	return Object.fromEntries(
		values("--setting").map((pair) => {
			const [name, value] = pair.split("=");
			if (!Object.hasOwn(QUESTIONS, name) || value === undefined || !Number.isFinite(Number(value))) throw new Error(`--setting ${pair}: want <question>=<number>, a question of jev.answerRubric`);
			return [name, Number(value)];
		}),
	);
}

function main() {
	const labelsPath = values("--labels")[0] ?? LABELS;
	if (argv[0] === "sheet") {
		const out = need("--out");
		refusePublicPath(out);
		const seed = Number(values("--seed")[0] ?? SEED);
		if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
		const { sheet, key } = buildSheet(readJson(need("--answers")), QUESTIONS, seed);
		mkdirSync(out, { recursive: true, mode: 0o700 });
		writeFileSync(join(out, "sheet.md"), sheet, { mode: 0o600 });
		writeFileSync(join(out, "key.json"), `${JSON.stringify(key, null, "\t")}\n`, { mode: 0o600 });
		console.log(`${Object.keys(key).length} answers. Fill in ${join(out, "sheet.md")}; keep ${join(out, "key.json")} out of sight until you are done.`);
	} else if (argv[0] === "import") {
		const base = existsSync(labelsPath) ? parseLabels(readJson(labelsPath), QUESTIONS) : {};
		const { labels, problems } = labelsFromSheet(readFileSync(need("--sheet"), "utf8"), readJson(need("--key")), QUESTIONS);
		if (problems.length) throw new Error(`the sheet has problems, nothing written:\n${problems.join("\n")}`);
		const merged = mergeLabels(base, labels);
		const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)));
		writeFileSync(labelsPath, `${JSON.stringify({ labels: sorted }, null, "\t")}\n`);
		console.log(`${Object.keys(labels).length} answers read from the sheet; ${labelsPath} now labels ${Object.keys(sorted).length}.`);
	} else if (argv[0] === "agree") {
		const labels = parseLabels(readJson(labelsPath), QUESTIONS);
		console.log(agreementReport(agreement(labels, readScores(need("--scores")), QUESTIONS, settings())));
	} else {
		throw new Error("usage: label-kit.ts sheet|import|agree (see the top of src/lab/label-kit.ts)");
	}
}

if (import.meta.main) main();
