/**
 * Freeze one real session: its runs in the exchange log (exchange-log.ts) written as a story file (stories.ts) that types
 * the same lines in order and waits for each run, so the story runner replays it. No model call.
 *
 *   just freeze <sessionId> --split train|holdout [--name <id>] [--from <exchanges.ndjson>] [--out <dir>]
 *
 * The file carries the player's typed lines, so it is written to --out (default `<coach home>/frozen-stories`, outside
 * the repository) and never to a folder git tracks (refusePublicPath); Riot IDs, the player's known account names, and
 * keys are scrubbed first, with the scrubbers the coach already uses. An automatic run (`draft:auto`) was never typed and
 * is left out, with a note. A command run logged before the log kept the typed line (`input`) is reported and left
 * out: its arguments are unknown. A typed question from that time freezes as its prompt, which is what it was.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "../coach-log";
import { loadProfile, resolveKnownAccounts } from "../config";
import { liveQuestionPrompt } from "../contracts";
import type { Exchange } from "../exchange-log";
import { parseAuditAccounts } from "../live-gateway";
import { scrubIdentifiers } from "../passage-judge";
import { realCoachHome } from "./lab-home.ts";
import { refusePublicPath } from "./label-sheet.ts";
import { SPLITS, validateStory, type Split, type Story } from "./stories.ts";

/** The fields of an exchange-log line that freezing reads. */
export type Logged = Pick<Exchange, "ts" | "prompt"> & Partial<Pick<Exchange, "sessionId" | "command" | "input">>;

export interface Skipped {
	ts: string;
	kind: "auto" | "old-format";
	note: string;
}

export interface Frozen {
	story: Story;
	skipped: Skipped[];
}

/** The most one `send` may wait for its run (the session lab spec's 180 s), per typed turn. */
const SECONDS_PER_TURN = 180;

/** What coach.yaml puts between the live game read and the question; a logged line holding it was typed in a game, with the read above it. */
const LIVE_QUESTION_LEAD = liveQuestionPrompt("", "");
const questionIn = (line: string) => {
	const at = line.lastIndexOf(LIVE_QUESTION_LEAD);
	return at < 0 ? line : line.slice(at + LIVE_QUESTION_LEAD.length).trim();
};

const turnsOf = (count: number) => `${count} typed turn${count === 1 ? "" : "s"}`;

/** One session's story: its typed lines in log order, scrubbed (`accounts`: the player's known Riot IDs, whose bare names go too). */
export function freezeSession(entries: Logged[], options: { sessionId: string; split: Split; name?: string; accounts?: string[] }): Frozen {
	const { sessionId, split, accounts = [] } = options;
	const lines: string[] = [];
	const skipped: Skipped[] = [];
	for (const { ts, command, input, prompt } of entries.filter((entry) => entry.sessionId === sessionId)) {
		if (command?.endsWith(":auto")) skipped.push({ ts, kind: "auto", note: `automatic ${command.slice(0, -":auto".length)} run, not typed` });
		else if (input === undefined && command !== undefined) skipped.push({ ts, kind: "old-format", note: `${command} run logged before the typed line was kept: its arguments are unknown` });
		else lines.push(scrubIdentifiers(redactSecrets(questionIn(input ?? prompt)), accounts).trim());
	}
	const story: Story = {
		// The whole id: Pi's session ids are UUIDv7, so their first 8 characters are a timestamp that two sessions a minute apart share.
		id: options.name ?? `frozen-${sessionId}`,
		title: `Frozen session ${sessionId}, ${turnsOf(lines.length)}`,
		split,
		steps: lines.flatMap((line) => [{ send: line }, { idle: true as const }]),
		gates: { maxSeconds: SECONDS_PER_TURN * (lines.length || 1) },
	};
	return { story, skipped };
}

/** Each session in the log once, in the order its first run was logged. */
export function sessionsIn(entries: Logged[]): { sessionId: string; first: string; runs: number }[] {
	const found = new Map<string, { sessionId: string; first: string; runs: number }>();
	for (const { sessionId, ts } of entries) {
		if (!sessionId) continue;
		const session = found.get(sessionId) ?? { sessionId, first: ts, runs: 0 };
		session.runs++;
		found.set(sessionId, session);
	}
	return [...found.values()];
}

/** Writes `<dir>/<id>.json` and returns its path. Throws, writing nothing, when the story would not load, the file exists, or `dir` is a folder git tracks. */
export function writeFrozen({ story }: Frozen, dir: string): string {
	const problems = validateStory(story, `${story.id}.json`);
	if (problems.length) throw new Error(problems.join("\n"));
	const file = join(dir, `${story.id}.json`);
	refusePublicPath(file);
	if (existsSync(file)) throw new Error(`${file} exists already: freeze with --name <id> to write another file, or delete it first`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(file, `${JSON.stringify(story, null, "\t")}\n`, { mode: 0o600 });
	return file;
}

function main() {
	const argv = process.argv.slice(2);
	const value = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
	const sessionId = argv[0]?.startsWith("--") ? undefined : argv[0];
	const split = value("--split");
	const usage = `usage: freeze.ts <sessionId> --split ${SPLITS.join("|")} [--name <id>] [--from <exchanges.ndjson>] [--out <dir>]`;
	if (!sessionId) throw new Error(usage);
	if (!(SPLITS as readonly string[]).includes(split ?? "")) throw new Error(`--split must be ${SPLITS.join(" or ")}${split === undefined ? "" : `, not ${JSON.stringify(split)}`}\n${usage}`);
	const from = value("--from") ?? join(realCoachHome(), "exchanges.ndjson");
	const entries = readFileSync(from, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Logged);
	if (!entries.some((entry) => entry.sessionId === sessionId)) {
		throw new Error(`no runs for session ${sessionId} in ${from}. It holds:\n${sessionsIn(entries).map((session) => `${session.sessionId}  ${session.first}  ${session.runs} runs`).join("\n")}`);
	}
	// The profile sits beside the exchange log in the coach home, and names the player's Riot IDs.
	const accounts = resolveKnownAccounts(undefined, loadProfile(join(dirname(from), "profile.json")), parseAuditAccounts(process.env.VOXREN_COACH_ACCOUNTS));
	const frozen = freezeSession(entries, { sessionId, split: split as Split, name: value("--name"), accounts });
	const leftOut = frozen.skipped.map((item) => `left out ${item.ts}: ${item.note}`);
	// A session with no typed turn has no story: say why, with what was left out, instead of the loader's "steps must be a non-empty list".
	if (!frozen.story.steps.length) throw new Error([`session ${sessionId} has no typed turn, nothing written`, ...leftOut].join("\n"));
	for (const line of leftOut) console.log(line);
	const path = writeFrozen(frozen, value("--out") ?? join(realCoachHome(), "frozen-stories"));
	console.log(`wrote ${path}: ${turnsOf(frozen.story.steps.filter((step) => "send" in step).length)} from session ${sessionId}`);
}

if (import.meta.main) main();
