/**
 * Prints recent coach.log.ndjson lines: warnings and errors by default (--all for info too), newest last,
 * optionally filtered to one run (--run <id>, a runId a line already carries -- the exact ts of its matching
 * line in exchanges.ndjson). `just logs` is the usual way in; never loaded by the coach.
 *
 *   bun run src/lab/show-logs.ts [--run <id>] [--all] [-n <count>]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { realCoachHome } from "./lab-home";

function arg(flag: string): string | undefined {
	const at = process.argv.indexOf(flag);
	return at >= 0 ? process.argv[at + 1] : undefined;
}

const runId = arg("--run");
const all = process.argv.includes("--all");
const limit = Number(arg("-n") ?? "50");

const path = join(realCoachHome(), "coach.log.ndjson");
if (!existsSync(path)) {
	console.log(`No ${path} yet: nothing has logged a warning or error in this coach home.`);
	process.exit(0);
}

const lines = readFileSync(path, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => {
		try {
			return JSON.parse(line) as Record<string, unknown>;
		} catch {
			return undefined; // a half-written last line (crash mid-append): skipped, not fatal to the rest
		}
	})
	.filter((entry): entry is Record<string, unknown> => entry !== undefined && (all || entry.level !== "info") && (!runId || entry.runId === runId))
	.slice(-Math.max(1, limit));

for (const entry of lines) console.log(JSON.stringify(entry));
console.log(`\n${lines.length} line${lines.length === 1 ? "" : "s"}${runId ? ` for run ${runId}` : ""}${all ? "" : " (warn/error only; --all for info too)"}.`);
