/**
 * Route lab: runs 60 hand-labelled prompts across lobby, champ select and live
 * game, each with a command label, through live Jev via `routeCommand` and
 * `routePrompt` together, and reports command and tier accuracy per phase, so
 * `ROUTE_SWITCH_P` and the criteria text in coach.yaml can be tuned from
 * numbers, not guesswork.
 *
 *   bun src/lab/route-lab.ts [--out <dir>]
 *
 * With --out it also writes results.json into that folder: one row per prompt
 * (its label, the tier it was routed to, every tier's probability, whether it
 * switched, was held or fell back, and the call's time in ms).
 *
 * Environment (read by name, never printed): TYPESAFE_API_KEY. Without it
 * there is nothing to route against, so the script prints a message and exits.
 *
 * Offline: never imported by the coach, writes nothing to disk without --out.
 */
import type { TierName } from "../contracts";
import { routeCommand } from "../command-router";
import { createRouteJudge, ROUTE_SWITCH_P, routePrompt } from "../model-router";
import { labRow, phaseAccuracyLines, recordProbabilities, routeRow, writeRouteRows, type LabRow, type RouteRow } from "./judge-tally";
import { ROUTE_PROMPTS } from "./route-prompts";

const TIERS: readonly TierName[] = ["quick", "standard", "deep"];

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
	if (process.argv.includes("--out") && !arg("--out")) throw new Error("--out needs a folder");
	const out = arg("--out");
	const judge = createRouteJudge(process.env);
	if (!judge) {
		process.stdout.write("TYPESAFE_API_KEY is not set; nothing to route against. Set it and rerun.\n");
		return;
	}
	const recorded = recordProbabilities(judge);

	const rows: Array<{ label: TierName; prompt: string; tier: TierName; source: string; failure?: string }> = [];
	const detail: RouteRow[] = [];
	const labRows: LabRow[] = [];
	for (const entry of ROUTE_PROMPTS) {
		const { label, prompt } = entry;
		// The command call takes the plain judge: the recorder keeps one call's tier probabilities, and two parallel calls through it would overwrite each other.
		const [command, route] = await Promise.all([
			routeCommand({ text: prompt, phase: entry.phase, accounts: [] }, judge),
			routePrompt({ prompt, pinned: false, accounts: [], current: { model: "gpt-6-sol", thinking: "medium" } }, recorded.judge),
		]);
		const tier = route.tier ?? "standard";
		rows.push({ label, prompt, tier, source: route.source, failure: route.failure });
		detail.push(routeRow(label, prompt, route, recorded.take()));
		labRows.push(labRow(entry, command, route));
		process.stderr.write(`${label} -> ${tier} (${route.source}${route.failure ? ` ${route.failure}` : ""}) | ${entry.command} -> ${command.command ?? "none"} (${entry.phase}): ${prompt}\n`);
	}
	if (out) process.stderr.write(`wrote ${writeRouteRows(out, detail, labRows)}\n`);

	const matrix = new Map<TierName, Map<TierName, number>>(TIERS.map((label) => [label, new Map(TIERS.map((tier) => [tier, 0]))]));
	for (const row of rows) matrix.get(row.label)!.set(row.tier, (matrix.get(row.label)!.get(row.tier) ?? 0) + 1);

	process.stdout.write("\nConfusion matrix (label rows x routed tier columns):\n");
	process.stdout.write(`${["label".padEnd(10), ...TIERS.map((tier) => tier.padStart(10))].join("")}\n`);
	for (const label of TIERS) {
		process.stdout.write(`${[label.padEnd(10), ...TIERS.map((tier) => String(matrix.get(label)!.get(tier) ?? 0).padStart(10))].join("")}\n`);
	}

	const switched = rows.filter((row) => row.source === "jev").length;
	const held = rows.filter((row) => row.source === "held").length;
	const fallback = rows.filter((row) => row.source === "fallback").length;
	process.stdout.write(`\nSwitch rate at ${ROUTE_SWITCH_P}: ${switched} switched, ${held} held below threshold, ${fallback} fell back, out of ${rows.length}.\n`);

	const misses = rows.filter((row) => row.label === "deep" && row.source === "jev" && row.tier === "quick");
	process.stdout.write(`\nDeep prompts routed to quick/Luna at >= ${ROUTE_SWITCH_P} (drive to zero): ${misses.length}\n`);
	for (const miss of misses) process.stdout.write(`- ${miss.prompt}\n`);

	process.stdout.write("\nAccuracy by phase (a failed call is left out of its own count and shown apart):\n\n");
	process.stdout.write(`${phaseAccuracyLines(labRows).join("\n")}\n`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
