/**
 * The conductor's scores file (the team-player plugin's K2): one JSON file that says how this checkout scores right now, so a change can be compared with the
 * one before it. `just score` runs the quick tiers (typecheck, `bun test`, the UI catalogue tier T1 from `just ui`, and every other `tier.json` found); `just score --full` adds the story run (`just stories
 * --panes 4 --no-notes`); `just score --stories` runs only that. Never loaded by the coach.
 *
 *   just score [--quick | --full | --stories] [--out <file>]
 *
 * Writes `.claude/conductor/scores.json` (or --out) and prints the same tiers as `conductor-tier {json}` lines and the metrics as `conductor-metric {json}` lines,
 * which `conductor/cli.ts score` of the plugin reads. A `tier.json` under `data/lab/` or `.claude/conductor/tiers/` is `{ "name", "pass", "fail", "skipped"?,
 * "seconds"?, "costUsd"?, "metrics"? }`: how a lab tier (T1, T2) reports once it exists; none present is fine.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface Finding {
	key?: string;
	title: string;
	body?: string;
}
export interface TierScore {
	pass: number;
	fail: number;
	skipped: number;
	seconds: number;
	costUsd: number;
	findings?: Finding[];
}
export interface Metric {
	value: number;
	better: "higher" | "lower";
	tolerance?: number;
}
export interface Scores {
	commit: string;
	ts: number;
	tiers: Record<string, TierScore>;
	metrics: Record<string, Metric>;
}

/** What `bun test` prints at its end: ` 73 pass`, ` 0 fail`, and ` 3 skip` when tests were skipped. A crash with no counts is one failure. */
export function parseBunTest(output: string, exitCode: number, seconds: number): TierScore {
	const count = (word: string) => Number(new RegExp(`^\\s*(\\d+)\\s+${word}\\b`, "m").exec(output)?.[1] ?? 0);
	const pass = count("pass");
	const fail = count("fail") || (exitCode === 0 ? 0 : 1);

	return { pass, fail, skipped: count("skip"), seconds, costUsd: 0 };
}

/** `tsc --noEmit`: one pass when clean; when not, one failure per `error TS` line (at least one). */
export function parseTsc(output: string, exitCode: number, seconds: number): TierScore {
	const errors = (output.match(/error TS\d+/g) ?? []).length;
	if (exitCode === 0) return { pass: 1, fail: 0, skipped: 0, seconds, costUsd: 0 };

	return { pass: 0, fail: Math.max(1, errors), skipped: 0, seconds, costUsd: 0 };
}

/** One `tier.json`'s content as a tier and its metrics, or a message that says what is wrong with it. */
export function parseTierFile(text: string): { name: string; tier: TierScore; metrics: Record<string, Metric> } | string {
	const data = JSON.parse(text) as Record<string, unknown>;
	// The UI catalogue's tier.json (`just ui --json`) names its tier in `tier`; its `findings` is a count, which is not a list of findings.
	const name = typeof data.name === "string" && data.name ? data.name : typeof data.tier === "string" && data.tier ? data.tier : undefined;
	if (!name) return "needs a string `name`";
	if (typeof data.pass !== "number" || typeof data.fail !== "number") return "needs numbers `pass` and `fail`";
	const metrics: Record<string, Metric> = {};
	for (const [key, raw] of Object.entries((data.metrics ?? {}) as Record<string, Metric>)) {
		if (typeof raw?.value === "number" && (raw.better === "higher" || raw.better === "lower")) metrics[key] = raw;
	}

	return { name, tier: { pass: data.pass, fail: data.fail, skipped: Number(data.skipped ?? 0), seconds: Number(data.seconds ?? 0), costUsd: Number(data.costUsd ?? 0) }, metrics };
}

/** The story run's stats.json as one tier named `stories` (a PASS verdict is a pass), its cost and wall seconds, a finding for each failed story, and two metrics. */
export function storiesTier(stats: { summary: { costUsd: number; wallSeconds: number; medianSeconds: number }; stories: Array<{ id: string; verdict: string; failures?: string[] }> }): { tier: TierScore; metrics: Record<string, Metric> } {
	const failed = stats.stories.filter((story) => story.verdict !== "PASS");

	return {
		tier: {
			pass: stats.stories.length - failed.length,
			fail: failed.length,
			skipped: 0,
			seconds: stats.summary.wallSeconds,
			costUsd: stats.summary.costUsd,
			...(failed.length ? { findings: failed.map((story) => ({ key: `story:${story.id}`, title: `Story ${story.id} fails in the real coach`, body: story.failures?.length ? `${story.failures.join("; ")}. See report.md of the story run for the screen.` : "See report.md of the story run for the gate and the screen." })) } : {}),
		},
		metrics: {
			"stories-median-seconds": { value: stats.summary.medianSeconds, better: "lower", tolerance: 5 },
			"stories-cost-usd": { value: stats.summary.costUsd, better: "lower", tolerance: 0.05 },
		},
	};
}

export function buildScores(commit: string, ts: number, parts: Array<{ name: string; tier: TierScore; metrics?: Record<string, Metric> }>): Scores {
	const scores: Scores = { commit, ts, tiers: {}, metrics: {} };
	for (const part of parts) {
		scores.tiers[part.name] = part.tier;
		Object.assign(scores.metrics, part.metrics ?? {});
	}

	return scores;
}

function run(command: string, args: string[]): { output: string; code: number; seconds: number } {
	const started = Date.now();
	const done = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

	return { output: `${done.stdout}\n${done.stderr}`, code: done.status ?? 1, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

function tierFiles(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (!existsSync(dir) || depth > 4) return;
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path, depth + 1);
			else if (name === "tier.json") found.push(path);
		}
	};
	walk(join(root, "data", "lab"), 0);
	walk(join(root, ".claude", "conductor", "tiers"), 0);

	return found.sort();
}

if (import.meta.main) {
	const flag = (name: string) => process.argv.includes(name);
	const at = process.argv.indexOf("--out");
	const root = resolve(import.meta.dir, "..", "..");
	const out = resolve(root, at >= 0 ? (process.argv[at + 1] ?? "") : join(".claude", "conductor", "scores.json"));
	const parts: Array<{ name: string; tier: TierScore; metrics?: Record<string, Metric> }> = [];
	if (!flag("--stories")) {
		const tsc = run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]);
		parts.push({ name: "typecheck", tier: parseTsc(tsc.output, tsc.code, tsc.seconds) });
		const test = run(process.execPath, ["test"]);
		parts.push({ name: "unit", tier: parseBunTest(test.output, test.code, test.seconds) });
		// T1, the UI catalogue (#218): every view and state through the real renderers, no model, under a second. Run fresh, not read from a stale file.
		if (existsSync(join(root, "src", "lab", "ui-shoot.ts"))) {
			const uiFile = join(mkdtempSync(join(tmpdir(), "voxren-score-ui-")), "tier.json");
			run(process.execPath, [join(root, "src", "lab", "ui-shoot.ts"), "--json", uiFile, "--out", dirname(uiFile)]);
			const ui = existsSync(uiFile) ? parseTierFile(readFileSync(uiFile, "utf8")) : "wrote no tier.json";
			if (typeof ui === "string") parts.push({ name: "ui", tier: { pass: 0, fail: 1, skipped: 0, seconds: 0, costUsd: 0, findings: [{ key: "tier:ui", title: `just ui did not produce a tier file: ${ui}` }] } });
			else parts.push({ name: "ui", tier: ui.tier, metrics: ui.metrics });
		}
		for (const file of tierFiles(root)) {
			const parsed = parseTierFile(readFileSync(file, "utf8"));
			if (typeof parsed === "string") parts.push({ name: `tier-file-${file}`, tier: { pass: 0, fail: 1, skipped: 0, seconds: 0, costUsd: 0, findings: [{ key: `tier-file:${file}`, title: `${file} is not a tier file: ${parsed}` }] } });
			else if (parsed.name !== "ui") parts.push({ name: parsed.name, tier: parsed.tier, metrics: parsed.metrics });
		}
	}
	if (flag("--full") || flag("--stories")) {
		const dir = mkdtempSync(join(tmpdir(), "voxren-score-"));
		const stories = run(process.execPath, ["run", join(root, "src", "lab", "story-runner.ts"), "--panes", "4", "--no-notes", "--out", dir]);
		const statsPath = join(dir, "stats.json");
		if (!existsSync(statsPath)) parts.push({ name: "stories", tier: { pass: 0, fail: 1, skipped: 0, seconds: stories.seconds, costUsd: 0, findings: [{ key: "stories:no-stats", title: "The story run wrote no stats.json", body: stories.output.slice(-2000) }] } });
		else {
			const done = storiesTier(JSON.parse(readFileSync(statsPath, "utf8")));
			parts.push({ name: "stories", tier: done.tier, metrics: done.metrics });
		}
	}
	const commit = run("git", ["rev-parse", "--short", "HEAD"]).output.trim().split("\n")[0] ?? "unknown";
	const scores = buildScores(commit, Date.now(), parts);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(scores, null, "\t")}\n`);
	for (const [name, tier] of Object.entries(scores.tiers)) console.log(`conductor-tier ${JSON.stringify({ name, ...tier })}`);
	for (const [name, metric] of Object.entries(scores.metrics)) console.log(`conductor-metric ${JSON.stringify({ name, ...metric })}`);
	console.error(`wrote ${out}`);
	process.exit(Object.values(scores.tiers).some((tier) => tier.fail > 0) ? 1 : 0);
}
