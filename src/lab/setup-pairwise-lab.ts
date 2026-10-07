/**
 * Setup pairwise lab: blind A/B judge on /comp's setup row only, comparing two models on the same
 * scenario and repeat. Reads an existing draft-lab sweep's results.ndjson (no new coach calls) and
 * asks TypeSafe System One (Jev) which row gives a teammate more useful, actionable coaching for
 * that draft. Every pair is judged in BOTH slot orders (A/B swapped) — round 6's first pass judged
 * each pair once with a random order and found the judge itself biased toward slot A (65% of 40
 * pairs, any model); a win only counts when both orders agree on the same winner, which cancels
 * that bias instead of just noting it (comp-lab.md's A2 verification pass).
 *
 *   bun run src/lab/setup-pairwise-lab.ts <draft-lab out dir>... --out <dir>
 *
 * Environment: TYPESAFE_API_KEY (required). A lab, not a test: never under `bun test`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SystemOneClient, choice, type Question } from "../systemone";

interface Result {
	id: string;
	scenario: string;
	at: string;
	model: string;
	prompt?: string;
	answer: string;
}

interface Judgment {
	scenario: string;
	at: string;
	modelLeft: string;
	modelRight: string;
	winnerOrder1: string;
	winnerOrder2: string;
	agree: boolean;
	winnerModel: string | "disagree";
	wordsLeft: number;
	wordsRight: number;
	longerModel: string;
}

function args() {
	const argv = process.argv.slice(2);
	const flag = (name: string) => {
		const index = argv.indexOf(name);
		return index >= 0 ? argv.splice(index, 2)[1] : undefined;
	};
	const out = flag("--out");
	if (!out) throw new Error("--out <dir> is required");
	if (!argv.length) throw new Error("at least one draft-lab out dir is required");
	return { dirs: argv, out };
}

// /comp answers only: the setup row is the answer's last row, as draft-lab.ts's score() reads an unlabelled answer.
function setupRow(answer: string): string {
	const rows = answer.trim().split(/\n+/).filter(Boolean);
	return (rows.at(-1) ?? "").replaceAll("’", "'");
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

// The composition block only, not the full /comp prompt (identical boilerplate on every run).
function composition(prompt: string | undefined): string {
	if (!prompt) return "";
	const marker = prompt.includes("Given the composition above") ? "Given the composition above" : prompt.includes("In game, open with") ? "In game, open with" : undefined;
	return (marker ? prompt.slice(0, prompt.indexOf(marker)) : prompt.slice(0, 800)).trim();
}

const QUESTIONS: Record<string, Question> = {
	winner: {
		type: "choice",
		instructions:
			"Two candidate closing 'setup' rows from a League of Legends draft coach, for the same draft. Each should name one item, summoner, or swap and the enemy threat it answers, or say the standard setup holds and why. Which gives a teammate more useful, specific coaching for this draft?",
		criteria: { A: "Row A is the more useful, specific setup call for this draft.", B: "Row B is the more useful, specific setup call for this draft." },
	},
};

/** One judge call with a fixed A/B assignment; returns the model that won. */
async function askOnce(client: SystemOneClient, draft: string, a: Result, b: Result): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000);
	try {
		const reply = await client.ask({ draft, rowA: setupRow(a.answer), rowB: setupRow(b.answer) }, QUESTIONS, controller.signal);
		return choice(reply.answers.winner, ["A", "B"]) === "A" ? a.model : b.model;
	} finally {
		clearTimeout(timer);
	}
}

async function main() {
	const opts = args();
	if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
	mkdirSync(opts.out, { recursive: true, mode: 0o700 });

	const results: Result[] = opts.dirs.flatMap((dir) =>
		readFileSync(join(dir, "results.ndjson"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Result),
	);

	// Pair same (scenario, at, rep) across exactly two models; rep is the id's trailing run index.
	const byKey = new Map<string, Result[]>();
	for (const result of results) {
		const rep = result.id.match(/-(\d+)$/)?.[1] ?? "0";
		byKey.set(`${result.scenario}|${result.at}|${rep}`, [...(byKey.get(`${result.scenario}|${result.at}|${rep}`) ?? []), result]);
	}
	const pairs = [...byKey.values()].filter((group) => group.length === 2 && new Set(group.map((r) => r.model)).size === 2);

	const client = new SystemOneClient({ apiKey: process.env.TYPESAFE_API_KEY });
	const judgments: Judgment[] = [];

	for (const [left, right] of pairs) {
		process.stderr.write(`judge ${left.scenario} (${left.model} vs ${right.model}), both orders\n`);
		try {
			const [winnerOrder1, winnerOrder2] = await Promise.all([askOnce(client, composition(left.prompt ?? right.prompt), left, right), askOnce(client, composition(left.prompt ?? right.prompt), right, left)]);
			const agree = winnerOrder1 === winnerOrder2;
			const wordsLeft = words(setupRow(left.answer));
			const wordsRight = words(setupRow(right.answer));
			judgments.push({
				scenario: left.scenario,
				at: left.at,
				modelLeft: left.model,
				modelRight: right.model,
				winnerOrder1,
				winnerOrder2,
				agree,
				winnerModel: agree ? winnerOrder1 : "disagree",
				wordsLeft,
				wordsRight,
				longerModel: wordsLeft === wordsRight ? "tie" : wordsLeft > wordsRight ? left.model : right.model,
			});
		} catch (error) {
			process.stderr.write(`  skipped (${error instanceof Error ? error.message : String(error)})\n`);
		}
	}

	const confirmed = judgments.filter((j) => j.agree);
	const models = [...new Set(judgments.flatMap((j) => [j.modelLeft, j.modelRight]))];
	const wins = new Map(models.map((model) => [model, confirmed.filter((j) => j.winnerModel === model).length]));
	const longerWon = confirmed.filter((j) => j.longerModel !== "tie" && j.winnerModel === j.longerModel).length;
	const longerJudged = confirmed.filter((j) => j.longerModel !== "tie").length;

	const summary = [
		`# Setup pairwise lab, both-orders (${new Date().toISOString()})`,
		"",
		`${judgments.length} pairs judged, ${confirmed.length} agree across both slot orders (${Math.round((confirmed.length / (judgments.length || 1)) * 100)}% agreement — the disagreement rate is the judge's own noise floor).`,
		"",
		"| model | confirmed wins | of confirmed |",
		"| --- | --- | --- |",
		...models.map((model) => `| ${model} | ${wins.get(model)} | ${confirmed.length ? Math.round(((wins.get(model) ?? 0) / confirmed.length) * 100) : 0}% |`),
		"",
		`Length check: of ${longerJudged} confirmed pairs with a clear longer row, the longer row's model won ${longerWon} (${longerJudged ? Math.round((longerWon / longerJudged) * 100) : 0}%). Near 50% means the judge isn't just rewarding length.`,
		"",
		"| scenario | at | left | right | order1 | order2 | agree | winner |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
		...judgments.map((j) => `| ${j.scenario} | ${j.at} | ${j.modelLeft} | ${j.modelRight} | ${j.winnerOrder1} | ${j.winnerOrder2} | ${j.agree ? "yes" : "no"} | ${j.winnerModel} |`),
	];
	writeFileSync(join(opts.out, "judgments.ndjson"), judgments.map((j) => JSON.stringify(j)).join("\n") + "\n", { mode: 0o600 });
	writeFileSync(join(opts.out, "summary.md"), `${summary.join("\n")}\n`, { mode: 0o600 });
	process.stdout.write(`${summary.join("\n")}\n`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
