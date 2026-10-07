/**
 * The persona critics behind `just ui --shoot`: three sonnet calls per run, in parallel, each reading every contact sheet
 * as images (stream-json input, so no tool is needed) and answering in JSON. Prompts are in data/lab/ui-critics.json: they
 * are lab prompts, not coach prompts. A critic only advises: a failed call or an unreadable reply is a line in the report,
 * never an exit code. Findings with no view or no row are dropped; the rest are merged by view with the critics side by side.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Finding {
	critic: string;
	view: string;
	row: string;
	severity: "bug" | "rough" | "nit";
	says: string;
	fix: string;
}

interface Run {
	critic: string;
	findings: Finding[];
	dropped: number;
	usd: number;
	input: number;
	output: number;
	seconds: number;
	problem?: string;
}

const CRITICS = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/lab/ui-critics.json", import.meta.url)), "utf8")) as { common: string; icons: string; critics: Record<string, string> };
const SEVERITIES = ["bug", "rough", "nit"] as const;

/** The `claude` children running now, so an interrupted run can stop them instead of leaving them to finish. */
const running = new Set<ReturnType<typeof spawn>>();
export function killCritics(): void {
	for (const child of running) child.kill();
	running.clear();
}

/** One `claude -p` call: the sheets as images, then the prompt. Resolves with what it could read; never rejects. */
function ask(critic: string, sheets: string[], manifest: string, cwd: string, zooms: Array<{ name: string; file: string }>): Promise<Run> {
	const started = Date.now();
	const run: Run = { critic, findings: [], dropped: 0, usd: 0, input: 0, output: 0, seconds: 0 };
	// The design-system critic also gets one zoomed crop per icon-bearing view (after the sheets) and its icon questions.
	const zoomed = critic === "design-system" ? zooms : [];
	const content = [
		...[...sheets, ...zoomed.map((zoom) => zoom.file)].map((file) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: readFileSync(file).toString("base64") } })),
		{ type: "text", text: `${CRITICS.common}\n\n${CRITICS.critics[critic]}${zoomed.length ? `\n\n${CRITICS.icons}\n\nAfter the sheets come ${zoomed.length} zoomed crops, in this order, one per icon-bearing view: ${zoomed.map((zoom) => zoom.name).join("; ")}.` : ""}\n\nManifest:\n${manifest}` },
	];
	return new Promise((done) => {
		const child = spawn("claude", ["-p", "--model", "sonnet", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
		running.add(child);
		let text = "";
		const timer = setTimeout(() => child.kill(), 240_000);
		child.stdout.on("data", (chunk) => (text += chunk));
		child.on("error", () => done({ ...run, problem: "claude not found", seconds: (Date.now() - started) / 1000 }));
		child.on("close", () => {
			running.delete(child);
			clearTimeout(timer);
			run.seconds = (Date.now() - started) / 1000;
			const last = text.split("\n").filter((line) => line.includes('"type":"result"')).pop();
			if (!last) return done({ ...run, problem: "no result from claude" });
			try {
				const reply = JSON.parse(last) as { result?: string; total_cost_usd?: number; usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } };
				run.usd = reply.total_cost_usd ?? 0;
				run.input = (reply.usage?.input_tokens ?? 0) + (reply.usage?.cache_creation_input_tokens ?? 0) + (reply.usage?.cache_read_input_tokens ?? 0);
				run.output = reply.usage?.output_tokens ?? 0;
				const raw = reply.result ?? "";
				const body = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
				const parsed = JSON.parse(body) as { findings?: Array<Partial<Finding>> };
				for (const entry of parsed.findings ?? []) {
					const view = typeof entry.view === "string" ? entry.view.trim() : "";
					const row = typeof entry.row === "string" ? entry.row.trim() : "";
					if (!view || !row || typeof entry.says !== "string") {
						run.dropped++;
						continue;
					}
					const severity = SEVERITIES.find((value) => value === entry.severity) ?? "nit";
					run.findings.push({ critic, view, row, severity, says: entry.says.trim(), fix: String(entry.fix ?? "").trim() });
				}
			} catch (error) {
				run.problem = `reply was not JSON (${error instanceof Error ? error.message : "error"})`;
			}
			done(run);
		});
		child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
	});
}

/** The view name a finding means: the manifest's own name when the critic quoted it or part of it. */
function canonical(view: string, names: string[]): string {
	const lower = view.toLowerCase();
	return names.find((name) => name.toLowerCase() === lower) ?? names.find((name) => lower.includes(name.toLowerCase()) || name.toLowerCase().includes(lower)) ?? view;
}

const cell = (text: string) => text.replace(/\|/g, "/").replace(/\n/g, " ");
const money = (usd: number) => `$${usd.toFixed(3)}`;

/** Runs the three critics in parallel, writes critique.json beside the sheets, returns the report section. */
export async function runCritics(sheets: string[], manifest: string, names: string[], out: string, zooms: Array<{ name: string; file: string }> = []): Promise<{ report: string; usd: number; findings: number }> {
	const runs = await Promise.all(Object.keys(CRITICS.critics).map((critic) => ask(critic, sheets, manifest, out, zooms)));
	const findings = runs.flatMap((run) => run.findings.map((finding) => ({ ...finding, view: canonical(finding.view, names) })));
	writeFileSync(join(out, "critique.json"), `${JSON.stringify({ runs: runs.map(({ findings: _, ...rest }) => rest), findings }, null, "\t")}\n`);
	const critics = runs.map((run) => run.critic);
	const views = [...new Set([...names.filter((name) => findings.some((finding) => finding.view === name)), ...findings.map((finding) => finding.view)])];
	const rank = { bug: 0, rough: 1, nit: 2 };
	const lines = ["## Critique (advisory: the critics never fail a run)", ""];
	if (!findings.length) lines.push("No findings.", "");
	else
		for (const view of views) {
			const here = findings.filter((finding) => finding.view === view);
			const worst = [...here].sort((a, b) => rank[a.severity] - rank[b.severity])[0].severity;
			lines.push(`### ${view} (${worst})`, "", `| ${critics.join(" | ")} |`, `|${critics.map(() => "---").join("|")}|`, `| ${critics.map((critic) => cell(here.filter((finding) => finding.critic === critic).sort((a, b) => rank[a.severity] - rank[b.severity]).map((finding) => `**${finding.severity}** \`${finding.row}\`: ${finding.says}${finding.fix ? ` Fix: ${finding.fix}` : ""}`).join("<br>") || "-")).join(" | ")} |`, "");
		}
	const total = runs.reduce((sum, run) => sum + run.usd, 0);
	lines.push("### Critics", "", "| critic | findings | dropped | tokens in/out | cost | seconds | problem |", "|---|---|---|---|---|---|---|", ...runs.map((run) => `| ${run.critic} | ${run.findings.length} | ${run.dropped} | ${run.input}/${run.output} | ${money(run.usd)} | ${run.seconds.toFixed(0)} | ${run.problem ?? "-"} |`), "", `Total: ${money(total)}, ${runs.reduce((sum, run) => sum + run.input, 0)} tokens in, ${runs.reduce((sum, run) => sum + run.output, 0)} out.`);
	return { report: lines.join("\n"), usd: total, findings: findings.length };
}

/** What `just ui` leaves for the scoring step: <out>/tier.json (and --json's file). `skipped` is every entry this run did not draw (--only, or unchanged under --changed). */
export interface TierResult {
	tier: "ui";
	pass: number;
	fail: number;
	skipped: number;
	seconds: number;
	costUsd: number;
	findings: number;
}

export function tierResult(run: { total: number; checked: number; failed: number; seconds: number; costUsd?: number; findings?: number }): TierResult {
	return { tier: "ui", pass: run.checked - run.failed, fail: run.failed, skipped: run.total - run.checked, seconds: Math.round(run.seconds * 10) / 10, costUsd: Math.round((run.costUsd ?? 0) * 1e4) / 1e4, findings: run.findings ?? 0 };
}
