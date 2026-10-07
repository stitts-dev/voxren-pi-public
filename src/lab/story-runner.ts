/**
 * QA story runner: user stories (data/lab/stories/*.json) fired into the real coach, up to nine at once in ONE WezTerm
 * window split into a 3x3 grid of 80x24 panes (2x2 of 100x30 when the screen cannot hold nine at font 10), each judged by the deterministic gates (stories.ts `judge`), then Jev's answer
 * rubric, then an advisory sonnet taste note that never changes the verdict.
 *
 *   just stories [--split train|holdout|all] [--only id1,id2] [--repeat N] [--strict-quality 3] [--panes 1|4|9] [--max-model 4] [--no-notes] [--out <dir>] [--compare <old stats.json>]
 *
 * Output in --out (default: a tmp dir, never inside the repo): per story <id>.screen.txt, <id>.exchange.json, <id>.png
 * (the window at story end), report.md (cost and speed per story, totals), and stats.json. Exit code 1 when any story fails. The window and every throwaway home are
 * removed at exit, Ctrl+C included. Window opening is wezterm.ts `open`; this file only splits it and types into panes.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findWezterm } from "../../bin/coach.mjs";
import { SystemOneClient, JudgeFailure } from "../systemone";
import { BANNER, cli, closeWindow, everything, fail, g, initGrid, openWindow, PROMPT, quitCoach, resetHome, settle, sleep, socket, startCoach, type, viewport, waitIdle, waitScreen, wez, type Pane } from "./grid.ts";
import { checkAnswer, doctrineQuestionsFor, gradeAnswer, gradeDoctrine, type DoctrineGrade, type Grade } from "./answer-rubric.ts";
import { ANSWER_TABLE, answerRow, withDoctrine } from "./story-stats.ts";
import { buildLines } from "../build-lines";
import { buildLabelRow, dataDragonKnown, iconEvidence, imageSize, paneMetrics, type IconEvidence } from "./icon-check.ts";
import { writeDraftReplay } from "./drafts.ts";
import { labHome, realCoachHome } from "./lab-home.ts";
import { aggregateTurns, STRICT_QUALITY } from "./story-repeats.ts";
import { compareStats, compareTurns, groundingSummary, splitLine, splitSummaries, turnCompareHeading, turnCompareLine, unverifiedNote, runSummary, storyStats, withJudgeCosts, JEV_USD_PER_INPUT_TOKEN, type StoryStats, type StoryTurns } from "./story-stats.ts";
import { answerNotFailures, hasIdle, iconVerdict, judge, toolFailures, KEY_BYTES, loadStories, rubricFailure, SPLIT_CHOICES, storiesFor, wantsRubric, type Failure, type IconOutcome, type Run, type SplitChoice, type Step, type Story } from "./stories.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
/**
 * The lowest quality score (0 to 4) Jev's `answerRubric.quality` may give before a story fails. Unset on purpose: the
 * rubric is report-only until a mark separates good answers from bad ones. Measured 2026-10-04 on a frozen corpus (docs/jev.md):
 * no mark keeps every good answer and fails every planted bad one, so it stays unset.
 * A three-part gate (quality < 1.0, has_intro_or_closing >= 0.5, hedges >= 0.7, fitted on that corpus) kept all 14 good holdout
 * answers but failed only 3 of 5 new planted bad ones: wrong-lane and contradicting-number answers score 2.5, since the rubric
 * judges format, not facts. So it stays unset.
 */
export const RUBRIC_PASS_QUALITY: number | undefined = undefined;
const DEFAULT_MAX_SECONDS = 120;
const STEP_WAIT_SECONDS = 20;

const argv = process.argv.slice(2);
const flag = (name: string) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv.splice(index, 2)[1] : undefined;
};
const has = (name: string) => {
	const index = argv.indexOf(name);
	return index >= 0 && argv.splice(index, 1).length > 0;
};

const compare = flag("--compare");
const maxModelFlag = Number(flag("--max-model") ?? 4);
const only = flag("--only")?.split(",").map((id) => id.trim()).filter(Boolean);
const splitFlag = flag("--split");
const repeat = Number(flag("--repeat") ?? 1);
const strictQuality = Number(flag("--strict-quality") ?? STRICT_QUALITY);
const paneCount = Number(flag("--panes") ?? 9);
const notes = !has("--no-notes");
const out = resolve(flag("--out") ?? mkdtempSync(join(tmpdir(), "voxren-stories-out-")));
if (splitFlag !== undefined && !(SPLIT_CHOICES as readonly string[]).includes(splitFlag)) fail(`--split is ${SPLIT_CHOICES.join(", ")}.`);
if (!Number.isInteger(repeat) || repeat < 1) fail("--repeat is a whole number from 1.");
if (![1, 4, 9].includes(paneCount)) fail("--panes is 1, 4, or 9.");
if (!(maxModelFlag >= 1)) fail("--max-model is a number from 1.");
if (out.startsWith(`${REPO}/`) || out === REPO) fail("--out must be outside the repo.");
const gui = findWezterm() ?? fail("WezTerm is not installed (npm run setup installs it).");
const base = storiesFor(loadStories(join(REPO, "data", "lab", "stories")), splitFlag as SplitChoice | undefined, only);
if (only) for (const id of only) if (!base.some((story) => story.id === id)) fail(`No story "${id}"${splitFlag ? ` in the ${splitFlag} split` : ""}.`);
/** With --repeat N each story runs N times as `<id>.r1` ... `<id>.rN`: its own pane, files and row. */
const stories = repeat === 1 ? base : base.flatMap((story) => Array.from({ length: repeat }, (_, i) => ({ ...story, id: `${story.id}.r${i + 1}` })));
if (!stories.length) fail(splitFlag ? `No stories in the ${splitFlag} split.` : "No stories.");
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "voxren-stories-"));
initGrid(gui, scratch);

// --- the window -------------------------------------------------------------------------------------------------

const runStarted = Date.now();
const ERASE = "\x1b[K";

/** What the strip knows about one story: a cell per story, in story order. */
interface Cell {
	id: string;
	state: "queued" | "running" | "judging" | "done";
	pane?: number;
	startedAt?: number;
	seconds?: number;
	/** Pi's footer cost while the story runs; the final number is the exchange log's. */
	liveCost: number;
	stats?: StoryStats;
	verdict?: "PASS" | "FAIL";
	gate?: string;
	rubric?: string;
	warn?: string;
	grounding?: { grounded: number; contradicted: number };
	icons?: { status: IconOutcome["status"]; expected: number; placed: number; blank: number };
}
const cells = new Map<string, Cell>();

// The coach's own palette (themes/tidal.json), so the strip reads as part of the same tool.
const TIDAL = (JSON.parse(readFileSync(join(REPO, "themes", "tidal.json"), "utf8")) as { colors: Record<string, string> }).colors;
const fg = (role: string, text: string) => {
	const hex = TIDAL[role] ?? "";
	return `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m${text}\x1b[0m`;
};
const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
const CELL_WIDTH = 56;
const MAX_CELL_ROWS = 9;
const cellsPerRow = (totalCols: number) => Math.max(1, Math.floor((totalCols + 1) / (CELL_WIDTH + 1)));
/** Rows of the strip: the run-total line and one row per line of cells. */
const statusRows = (grid: number, cols: number) => 1 + Math.min(MAX_CELL_ROWS, Math.ceil(stories.length / cellsPerRow(grid * cols + grid - 1)));
const money = (usd: number) => `$${usd.toFixed(usd >= 1 ? 2 : 3)}`;

/** One cell: icon, id, total $ and seconds, then the judges' tags (first failed gate, grounding counts, rubric score, warning). Tags are dropped from the right when the cell is too narrow. */
function renderCell(cell: Cell): string {
	const total = cell.stats?.totalUsd ?? cell.liveCost;
	const role = cell.state === "queued" ? "dim" : cell.state === "done" ? (cell.verdict === "PASS" ? (cell.rubric?.startsWith("skipped") || cell.warn ? "warning" : "success") : "error") : "warning";
	const icon = cell.state === "queued" ? "\u00b7" : cell.state === "running" ? SPINNER[Math.floor(Date.now() / 100) % SPINNER.length] : cell.state === "judging" ? "\u25d0" : cell.verdict === "FAIL" ? "\u2718" : role === "warning" ? "\u2013" : "\u2714";
	const seconds = cell.seconds ?? (cell.startedAt ? (Date.now() - cell.startedAt) / 1000 : undefined);
	const parts: { text: string; role: string }[] = [{ text: icon, role }, { text: ` ${cell.id}`, role: cell.state === "queued" ? "dim" : "text" }];
	if (cell.state !== "queued") parts.push({ text: ` ${money(total)} ${Math.round(seconds ?? 0)}s`, role: "muted" });
	if (cell.gate) parts.push({ text: ` ${cell.gate}`, role: "error" });
	if (cell.grounding) parts.push({ text: ` ${cell.grounding.grounded}\u2713${cell.grounding.contradicted ? ` ${cell.grounding.contradicted}\u2717` : ""}`, role: cell.grounding.contradicted ? "error" : "success" });
	if (cell.icons) parts.push({ text: cell.icons.status === "skipped" ? " ic skipped" : ` ic ${cell.icons.placed}/${cell.icons.expected}${cell.icons.blank ? ` ${cell.icons.blank} blank` : ""}`, role: cell.icons.status === "pass" ? "success" : cell.icons.status === "fail" ? "error" : "warning" });
	if (cell.rubric) parts.push({ text: ` r${cell.rubric.replace("/4", "")}`, role: cell.rubric.startsWith("skipped") ? "warning" : "accent" });
	if (cell.warn) parts.push({ text: ` ${cell.warn}`, role: "warning" });
	let width = parts.reduce((sum, part) => sum + [...part.text].length, 0);
	while (width > CELL_WIDTH && parts.length > 3) width -= [...(parts.pop()?.text ?? "")].length;
	const text = parts.map((part) => fg(part.role, part.text)).join("");
	return text + " ".repeat(Math.max(0, CELL_WIDTH - width));
}

function drawStatus() {
	if (!g.statusFile) return;
	const all = [...cells.values()];
	const sum = (pick: (cell: Cell) => number) => all.reduce((total, cell) => total + pick(cell), 0);
	const model = sum((cell) => cell.stats?.costUsd ?? cell.liveCost);
	const jev = sum((cell) => cell.stats?.jevUsd ?? 0);
	const notes = sum((cell) => cell.stats?.noteUsd ?? 0);
	const count = (test: (cell: Cell) => boolean) => all.filter(test).length;
	const wall = Math.round((Date.now() - runStarted) / 1000);
	const totals = `${fg("accent", "STORIES")} ${fg("success", `${count((c) => c.verdict === "PASS")} passed`)} \u00b7 ${fg("error", `${count((c) => c.verdict === "FAIL")} failed`)} \u00b7 ${fg("warning", `${count((c) => c.state === "running" || c.state === "judging")} running`)} \u00b7 ${fg("dim", `${count((c) => c.state === "queued")} queued`)}   ${fg("text", money(model + jev + notes))} ${fg("muted", `(model ${money(model)} \u00b7 Jev ${money(jev)} \u00b7 notes ${money(notes)})`)} \u00b7 ${wall}s${g.statusNote ? `  ${fg("warning", g.statusNote)}` : ""}`;
	const per = cellsPerRow(g.GRID * g.COLS + g.GRID - 1);
	let shown = all;
	// More stories than the strip has room for: the queued ones at the end are left out (the totals line counts them).
	for (let i = shown.length - 1; shown.length > per * MAX_CELL_ROWS && i >= 0; i--) if (shown[i].state === "queued") shown = shown.filter((_, index) => index !== i);
	const rows = [totals];
	for (let at = 0; at < shown.length; at += per) rows.push(shown.slice(at, at + per).map(renderCell).join(" "));
	writeFileSync(g.statusFile, `${rows.map((row) => `${row}${ERASE}`).join("\n")}\x1b[J`);
}



// --- driving a pane ---------------------------------------------------------------------------------------------




/**
 * Writes straight to the pane's terminal device, so the terminal draws it as program output and nothing is typed into the
 * shell: the pane's title (OSC 2) and the result banner after a story. The coach's own output is never touched.
 */
function ttyWrite(pane: Pane, text: string) {
	try {
		appendFileSync(pane.tty, text);
	} catch (error) {
		console.error(`could not write to ${pane.tty}: ${error instanceof Error ? error.message : error}`);
	}
}
const title = (pane: Pane, text: string) => ttyWrite(pane, `\x1b]2;${text}\x07`);
/** After a story: the pane cleared (scrollback too) and one result line until the next story takes it. */
function resultBanner(pane: Pane, ok: boolean, text: string) {
	ttyWrite(pane, `\x1b[2J\x1b[3J\x1b[H${ok ? "\x1b[1;32m\u2714" : "\x1b[1;31m\u2718"} ${text.slice(0, g.COLS - 3)}\x1b[0m\r\n`);
}

/** The session cost Pi's own footer shows (`$0.011 sub`), read from the pane: the live number while a run is in progress. */
const footerCost = (pane: Pane): number | undefined => {
	const match = /\$(\d+\.\d+) sub/.exec(viewport(pane));
	return match ? Number(match[1]) : undefined;
};

const exchanges = (pane: Pane): Run[] => {
	const log = join(pane.home, "exchanges.ndjson");
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Run) : [];
};

// --- one story --------------------------------------------------------------------------------------------------

interface Result {
	story: Story;
	failures: Failure[];
	seconds: number;
	rubric: string;
	/** Jev grade per model run of the exchange log; null where unscored. */
	grades: (Grade | null)[];
	/** Jev's doctrine questions per model run, null where ungraded; `doctrineSkipped` says why grading stopped. */
	doctrine: (DoctrineGrade | null)[];
	doctrineSkipped?: string;
	note: string;
	screen: string;
	exchange: Run[];
	stats: StoryStats;
	icons?: IconEvidence & IconOutcome;
}

/** The icon gate's evidence for a story with `gates.icons`: the answer's names, the bytes Pi wrote, the pane's pixels. */
async function collectIcons(story: Story, pane: Pane, screen: string, exchange: Run[], shot: string, viewport: string, list: unknown): Promise<IconEvidence & IconOutcome> {
	const answer = [...exchange].reverse().map((run) => run.answer ?? "").find((text) => buildLines(text)) ?? "";
	const logDir = join(pane.dir, "tui-log");
	const bytes = existsSync(logDir) ? readdirSync(logDir).sort().map((file) => readFileSync(join(logDir, file), "utf8")).join("") : "";
	writeFileSync(join(out, `${story.id}.tui-log.bin`), bytes);
	const coachLog = join(pane.home, "coach.log.ndjson");
	const supported = !/pictures off/.test(screen) && !(existsSync(coachLog) && /pictures off/.test(readFileSync(coachLog, "utf8")));
	const size = existsSync(shot) ? imageSize(shot) : undefined;
	const metrics = size ? paneMetrics(list, pane.id, size) : undefined;
	const evidence = iconEvidence({ answer, known: supported ? await dataDragonKnown(answer) : undefined, bytes, screen, viewport, shot: size ? { png: shot, metrics } : undefined, supported });
	const outcome = iconVerdict(story.gates.icons ?? {}, evidence);
	writeFileSync(join(out, `${story.id}.icons.json`), `${JSON.stringify({ ...evidence, ...outcome }, null, "\t")}\n`);
	return { ...evidence, ...outcome };
}

/** The pane's visible rows exactly as WezTerm holds them, none trimmed (`cli` trims, and a blank first row would shift every row index the icon gate crops by). */
function rawText(pane: Pane): string {
	const result = spawnSync(join(dirname(g.gui), process.platform === "win32" ? "wezterm.exe" : "wezterm"), ["cli", "--no-auto-start", "get-text", "--pane-id", String(pane.id), "--start-line", "0", "--end-line", String(g.ROWS - 1)], { encoding: "utf8", timeout: 10_000, env: { ...process.env, WEZTERM_UNIX_SOCKET: socket() } });
	return result.stdout ?? "";
}

/** The report's icon column: expected / placed / blank, `skipped (no image support)`, or `-` for a story with no icon gate. */
const iconCell = (stats: StoryStats) => (!stats.icons ? "-" : stats.icons.status === "skipped" ? "skipped (no image support)" : `${stats.icons.expected} / ${stats.icons.placed} / ${stats.icons.blank}${stats.icons.unchecked ? ` (${stats.icons.unchecked} not cropped)` : ""}`);


/** Reshoots of a window whose placed icons crop blank, and the pause between them: about 10 s for WezTerm to repaint. */
const PAINT_ATTEMPTS = 10;
const PAINT_WAIT_MS = 1000;

/** Longest the runner waits for the build strip after the turn settles: Data Dragon load plus the icon fetches, which are bounded at a few seconds each. */
const STRIP_WAIT_SECONDS = 30;

async function runStory(story: Story, pane: Pane, position: number): Promise<Result> {
	const failures: Failure[] = [];
	const started = Date.now();
	const maxSeconds = story.gates.maxSeconds ?? DEFAULT_MAX_SECONDS;
	resetHome(pane, story);
	const replay = story.replay ? (story.replay.endsWith(".json") ? await writeDraftReplay(join(REPO, story.replay), join(pane.dir, "draft.ndjson")) : join(REPO, story.replay)) : undefined;
	const cell = cells.get(story.id)!;
	Object.assign(cell, { state: "running", pane: pane.index + 1, startedAt: started, liveCost: 0 });
	drawStatus();
	// Pi's own footer is the live cost; the exchange log is written only when a run ends.
	const ticker = setInterval(() => {
		cell.liveCost = footerCost(pane) ?? cell.liveCost;
	}, 1000);
	// Everything Pi writes to the terminal goes to a log the icon gate reads (src/lab/icon-check.ts).
	const writeLog = join(pane.dir, "tui-log");
	rmSync(writeLog, { recursive: true, force: true });
	mkdirSync(writeLog, { recursive: true });
	const logged: Story = { ...story, env: { ...story.env, PI_TUI_WRITE_LOG: writeLog } };
	if (!(await startCoach(pane, logged, replay, `${BANNER}${story.id} \u00b7 ${story.title} \u00b7 story ${position}/${stories.length} \u00b7 pane ${pane.index + 1}`))) failures.push({ gate: "step", detail: "the coach header did not draw within 60 s" });
	else
		for (const [index, step] of story.steps.entries()) {
			const problem = await runStep(pane, step, story, replay, maxSeconds);
			if (problem) {
				failures.push({ gate: "step", detail: `step ${index + 1} ${JSON.stringify(step)}: ${problem}` });
				break;
			}
		}
	clearInterval(ticker);
	const footer = footerCost(pane);
	cell.state = "judging";
	// The coach draws the build strip after the turn settles (it fetches the icons first, `void showBuildStrip` in src/index.ts), so "idle" is not "drawn": wait for the strip's BUILD row before the screen, bytes, and shot are read.
	if (story.gates.icons && exchanges(pane).some((run) => buildLines(run.answer ?? ""))) await waitScreen(pane, (text) => buildLabelRow(text) !== undefined, STRIP_WAIT_SECONDS);
	await settle(pane);
	const screen = everything(pane);
	const exchange = exchanges(pane);
	const seconds = (Date.now() - started) / 1000;
	cell.seconds = seconds;
	if (seconds > maxSeconds) failures.push({ gate: "maxSeconds", detail: `${seconds.toFixed(0)} s, over ${maxSeconds}` });
	// The width gate is against the pane as it is now: a window the player resized mid-run would otherwise fail every line.
	const measured = (JSON.parse(cli(["list", "--format", "json"]).out) as { pane_id: number; size: { cols: number } }[]).find((item) => item.pane_id === pane.id)?.size.cols ?? g.COLS;
	if (measured !== g.COLS) console.error(`${story.id}: the pane is ${measured} columns, not ${g.COLS}`);
	writeFileSync(join(out, `${story.id}.screen.txt`), `${screen}\n`);
	const coachLog = join(pane.home, "coach.log.ndjson");
	if (existsSync(coachLog)) copyFileSync(coachLog, join(out, `${story.id}.coach.log.ndjson`));
	writeFileSync(join(out, `${story.id}.exchange.json`), `${JSON.stringify(exchange, null, "\t")}\n`);
	// The shot, the raw viewport, and the pane sizes are read together: the icon gate crops the shot where the bytes placed icons.
	const rawViewport = rawText(pane);
	const paneList = JSON.parse(cli(["list", "--format", "json"]).out || "[]");
	// A window shot can come before WezTerm has repainted the pane (4 panes at once): a placed icon then crops as bare background.
	// Shoot again until every placed picture's crop has colour, or the wait runs out (the gate then reports the blank ones as unpainted).
	let icons: Awaited<ReturnType<typeof collectIcons>> | undefined;
	for (let attempt = 0; ; attempt++) {
		const shot = wez(["shot", "--pid", String(g.windowPid), join(out, `${story.id}.png`)]);
		if (!shot.ok) console.error(`${story.id}: no screenshot (${shot.out.trim().split("\n").pop()})`);
		icons = story.gates.icons ? await collectIcons(story, pane, screen, exchange, join(out, `${story.id}.png`), rawViewport, paneList) : undefined;
		if (!icons?.blank || attempt >= PAINT_ATTEMPTS) break;
		await sleep(PAINT_WAIT_MS);
	}
	if (icons) cell.icons = { status: icons.status, expected: icons.expected, placed: icons.placed, blank: icons.blank };
	failures.push(...judge(story, screen, exchange, measured, icons));
	await quitCoach(pane);
	return { story, failures, seconds, rubric: "n/a", grades: [], doctrine: [], note: "", screen, exchange, icons, stats: { ...storyStats(story.id, "PASS", seconds, exchange, screen), footerCostUsd: footer, ...(icons ? { icons: { status: icons.status, expected: icons.expected, placed: icons.placed, blank: icons.blank, unchecked: icons.unchecked } } : {}) } };
}

/** One step; returns what went wrong, or undefined. */
async function runStep(pane: Pane, step: Step, story: Story, replay: string | undefined, maxSeconds: number): Promise<string | undefined> {
	if ("send" in step) {
		rmSync(pane.idle, { force: true });
		type(pane, `${step.send}\r`);
	} else if ("type" in step) type(pane, step.type);
	else if ("key" in step) type(pane, KEY_BYTES[step.key]);
	else if ("wait" in step) {
		const timeout = step.timeout ?? STEP_WAIT_SECONDS;
		if (!(await waitScreen(pane, (text) => text.includes(step.wait) !== !!step.absent, timeout))) return `"${step.wait}" ${step.absent ? "never went away" : "never showed"} within ${timeout} s`;
	} else if ("idle" in step) {
		const timeout = step.timeout ?? maxSeconds;
		if (!(await waitIdle(pane, timeout))) return step.optional ? undefined : `the model turn did not settle within ${timeout} s`;
		rmSync(pane.idle, { force: true });
	} else {
		await quitCoach(pane);
		if (!(await startCoach(pane, { ...story, env: { ...story.env, PI_TUI_WRITE_LOG: join(pane.dir, "tui-log") } }, replay, `${BANNER}${story.id} \u00b7 restarted`))) return "the coach did not come back after the restart";
	}
	return undefined;
}

// --- rubric and note --------------------------------------------------------------------------------------------

function typesafeKey(): string | undefined {
	const set = process.env.TYPESAFE_API_KEY?.trim();
	if (set) return set;
	try {
		return readFileSync(join(realCoachHome(), ".env"), "utf8").split("\n").find((line) => line.startsWith("TYPESAFE_API_KEY="))?.slice("TYPESAFE_API_KEY=".length).trim() || undefined;
	} catch {
		return undefined; // no .env in the coach home: the rubric is reported as skipped, never as a pass
	}
}

/** Rubric verdict for a story: `{ text, failure? }`. Jev unreachable or no key is a skip, never a pass. */
async function rubric(story: Story, exchange: Run[]): Promise<{ text: string; failure?: Failure; jevInputTokens?: number; grades: (Grade | null)[] }> {
	const grades: (Grade | null)[] = exchange.map(() => null);
	if (!wantsRubric(story)) return { text: "n/a", grades };
	const answer = exchange.at(-1)?.answer?.trim();
	if (!answer) return { text: "skipped (no answer)", grades };
	const apiKey = typesafeKey();
	if (!apiKey) return { text: "skipped (no TYPESAFE_API_KEY)", grades };
	try {
		const client = new SystemOneClient({ apiKey });
		let jevInputTokens = 0;
		for (const [index, run] of exchange.entries()) {
			const text = run.answer?.trim();
			if (!text) continue;
			grades[index] = await gradeAnswer(client, text);
			jevInputTokens += grades[index]!.inputTokens;
		}
		const final = grades.at(-1);
		if (!final) return { text: "skipped (no answer)", grades, jevInputTokens };
		return { text: `${final.quality}/4`, failure: rubricFailure(final.quality, RUBRIC_PASS_QUALITY), jevInputTokens, grades };
	} catch (error) {
		return { text: `skipped (${error instanceof JudgeFailure ? error.reason : error instanceof Error ? error.message : "error"})`, grades };
	}
}

/** Jev's doctrine questions on each model run's answer: the ones the story's `applies` names, or all of them when it names none. Report-only like the rubric: Jev unreachable or no key is a skip that names its cause, never a pass or a fail. */
async function doctrineGrades(story: Story, exchange: Run[]): Promise<{ grades: (DoctrineGrade | null)[]; jevInputTokens: number; skipped?: string }> {
	const grades: (DoctrineGrade | null)[] = exchange.map(() => null);
	if (!wantsRubric(story)) return { grades, jevInputTokens: 0 };
	const apiKey = typesafeKey();
	if (!apiKey) return { grades, jevInputTokens: 0, skipped: "no TYPESAFE_API_KEY" };
	let jevInputTokens = 0;
	try {
		const client = new SystemOneClient({ apiKey });
		for (const [index, run] of exchange.entries()) {
			const text = run.answer?.trim();
			if (!text) continue;
			grades[index] = await gradeDoctrine(client, text, doctrineQuestionsFor(story));
			jevInputTokens += grades[index]!.inputTokens;
		}
		return { grades, jevInputTokens };
	} catch (error) {
		return { grades, jevInputTokens, skipped: error instanceof JudgeFailure ? error.reason : error instanceof Error ? error.message : "error" };
	}
}

/** The `answerNot` gate: Jev answers each named check on the final answer; a yes fails the story. A check that cannot run fails too, since a skipped gate is not a pass. */
async function answerChecks(story: Story, exchange: Run[]): Promise<{ failures: Failure[]; jevInputTokens: number }> {
	const names = story.gates.answerNot ?? [];
	if (!names.length) return { failures: [], jevInputTokens: 0 };
	const answer = exchange.at(-1)?.answer?.trim();
	const apiKey = typesafeKey();
	if (!answer || !apiKey) return { failures: [{ gate: "answerNot", detail: answer ? "no TYPESAFE_API_KEY to ask Jev" : "no final answer to check" }], jevInputTokens: 0 };
	try {
		const checked = await checkAnswer(new SystemOneClient({ apiKey }), answer, names);
		return { failures: answerNotFailures(names, checked.noul), jevInputTokens: checked.inputTokens };
	} catch (error) {
		return { failures: [{ gate: "answerNot", detail: `Jev could not check the answer (${error instanceof JudgeFailure ? error.reason : error instanceof Error ? error.message : "error"})` }], jevInputTokens: 0 };
	}
}

/** Advisory only: up to three lines of taste notes from sonnet, with what the call cost (`claude -p --output-format json`); never changes a verdict. */
async function tasteNote(story: Story, screen: string, exchange: Run[]): Promise<{ text: string; usd: number; input: number; output: number }> {
	const answer = exchange.at(-1)?.answer;
	const none = { text: "", usd: 0, input: 0, output: 0 };
	if (!answer) return none;
	const prompt = `You review one reply of a League of Legends coach for a solo-queue player.\nStory: ${story.title}\n\nFinal screen:\n${screen.slice(-6000)}\n\nThe answer text:\n${answer.slice(0, 4000)}\n\nIn at most 3 short lines of plain text, no markdown: does the advice address the player (not teammates), is it specific and actionable, is the layout clean.`;
	return new Promise((done) => {
		const child = spawn("claude", ["-p", "--model", "sonnet", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"], { cwd: g.scratch, stdio: ["pipe", "pipe", "ignore"] });
		let text = "";
		const timer = setTimeout(() => child.kill(), 120_000);
		child.stdout.on("data", (chunk) => (text += chunk));
		child.on("error", () => done({ ...none, text: "(note unavailable: claude not found)" }));
		child.on("close", () => {
			clearTimeout(timer);
			try {
				const reply = JSON.parse(text) as { result?: string; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number } };
				done({ text: (reply.result ?? "").trim().split("\n").filter(Boolean).slice(0, 3).join(" / ") || "(note unavailable)", usd: reply.total_cost_usd ?? 0, input: reply.usage?.input_tokens ?? 0, output: reply.usage?.output_tokens ?? 0 });
			} catch {
				done({ ...none, text: "(note unavailable: no JSON from claude)" }); // the note is advisory; a bad reply costs nothing and fails nothing
			}
		});
		child.stdin.end(prompt);
	});
}

// --- main -------------------------------------------------------------------------------------------------------

let cleaned = false;
function cleanup() {
	if (cleaned) return;
	cleaned = true;
	closeWindow();
	for (const pane of g.panes) {
		try {
			unlinkSync(join(pane.home, "pi-agent"));
		} catch {
			// Never linked (the story did not start) or already gone.
		}
	}
	rmSync(g.scratch, { recursive: true, force: true });
}
process.on("SIGINT", () => {
	cleanup();
	process.exit(130);
});
process.on("SIGTERM", () => {
	cleanup();
	process.exit(143);
});

/** A story needs a model slot when it waits on a model turn; the others (the /flow panel stories) never call one. */
const needsModel = (story: Story) => hasIdle(story);
/** Concurrent model stories: --max-model, lowered when a model or Jev call answers 429 (rate limit). */
let modelCap = maxModelFlag;
let modelRunning = 0;
const waiting: (() => void)[] = [];

/** The next queued story this pane may run: a model story only while a model slot is free, else a no-model one; waits when none fits. */
async function nextStory(queue: { story: Story; position: number }[]) {
	for (;;) {
		if (!queue.length) return undefined;
		const index = queue.findIndex((item) => !needsModel(item.story) || modelRunning < modelCap);
		if (index >= 0) return queue.splice(index, 1)[0];
		await new Promise<void>((done) => waiting.push(done));
	}
}
const rateLimited = (result: Result) => result.exchange.some((run) => run.turns?.some((turn) => /\b429\b|rate.?limit/i.test(turn.error ?? ""))) || /\b429\b|rate.?limit/i.test(result.screen);
function capModels(why: string) {
	if (modelCap <= 1) return;
	modelCap = Math.max(1, modelCap - 1);
	g.statusNote = `${why}: at most ${modelCap} model stories at once`;
	console.error(g.statusNote);
}

async function main() {
	const started = Date.now();
	g.statusRows = statusRows;
	g.drawStatus = drawStatus;
	openWindow(paneCount);
	console.error(`window pid ${g.windowPid}, ${g.panes.length} pane(s) of ${g.COLS}x${g.ROWS}, font ${g.font}, ${stories.length} stories, out ${out}`);
	const results: Result[] = [];
	const queue = stories.map((story, index) => ({ story, position: index + 1 }));
	for (const story of stories) cells.set(story.id, { id: story.id, state: "queued", liveCost: 0 });
	drawStatus();
	const redraw = setInterval(drawStatus, 500); // the spinner and the clocks; fire-and-forget, nothing awaits it
	redraw.unref();
	const finishing: Promise<void>[] = [];
	await Promise.all(
		g.panes.map(async (pane) => {
			for (let next = await nextStory(queue); next; next = await nextStory(queue)) {
				const { story, position } = next;
				const cell = cells.get(story.id)!;
				const model = needsModel(story);
				if (model) modelRunning++;
				const result = await runStory(story, pane, position);
				if (model) modelRunning--;
				for (const wake of waiting.splice(0)) wake();
				if (rateLimited(result)) capModels("rate limit (429) seen");
				results.push(result);
				const verdict = result.failures.length ? "FAIL" : "PASS";
				result.stats.verdict = verdict;
				cell.stats = result.stats;
				cell.gate = result.failures[0]?.gate;
				cell.grounding = groundingSummary(result.screen);
				if (cell.grounding) result.stats.contradicted = cell.grounding.contradicted;
				const footer = result.stats.footerCostUsd;
				if (footer !== undefined && Math.abs(footer - result.stats.costUsd) > 0.001) cell.warn = "cost?";
				title(pane, `${story.id} ${verdict} ${money(result.stats.totalUsd)} ${result.seconds.toFixed(0)}s`);
				resultBanner(pane, !result.failures.length, `${story.id} ${verdict} ${money(result.stats.totalUsd)} ${result.seconds.toFixed(0)}s`);
				console.error(`${result.failures.length ? "FAIL" : "ok  "} ${story.id} (${result.seconds.toFixed(0)} s, ${money(result.stats.totalUsd)})`);
				// Rubric and note run beside the next story: the pane is free already.
				finishing.push(
					(async () => {
						const graded = await rubric(story, result.exchange);
						result.rubric = graded.text;
						result.grades = graded.grades;
						cell.rubric = graded.text;
						if (graded.text.includes("rate_limited")) capModels("Jev rate limit (429)");
						if (graded.failure) result.failures.push(graded.failure);
						const checked = await answerChecks(story, result.exchange);
						result.failures.push(...checked.failures);
						const doctrine = await doctrineGrades(story, result.exchange);
						result.doctrine = doctrine.grades;
						result.doctrineSkipped = doctrine.skipped;
						if (doctrine.skipped === "rate_limited") capModels("Jev rate limit (429)");
						result.stats = withJudgeCosts(result.stats, { jevInputTokens: (graded.jevInputTokens ?? 0) + checked.jevInputTokens + doctrine.jevInputTokens });
						result.stats = { ...result.stats, answers: withDoctrine(result.stats.answers ?? [], doctrine.grades) };
						cell.stats = result.stats;
						if (notes) {
							const note = await tasteNote(story, result.screen, result.exchange);
							result.note = note.text;
							result.stats = withJudgeCosts(result.stats, { noteUsd: note.usd, noteInputTokens: note.input, noteOutputTokens: note.output });
							cell.stats = result.stats;
						}
						result.stats.verdict = result.failures.length ? "FAIL" : "PASS";
						if (result.failures.length) result.stats.failures = result.failures.map((failure) => `${failure.gate}: ${failure.detail}`);
						Object.assign(cell, { verdict: result.stats.verdict, gate: result.failures[0]?.gate, state: "done" });
						drawStatus();
					})(),
				);
			}
		}),
	);
	await Promise.all(finishing);
	drawStatus();
	console.error(`panes at the end: ${JSON.parse(cli(["list", "--format", "json"]).out).map((item: { size: { cols: number; rows: number } }) => `${item.size.cols}x${item.size.rows}`).join(" ")}`);
	await sleep(1200); // the strip redraws twice a second: let it show the final counts before the shot
	wez(["shot", "--pid", String(g.windowPid), join(out, "grid-end.png")]);
	results.sort((a, b) => a.story.id.localeCompare(b.story.id));
	const wall = (Date.now() - started) / 1000;
	const stats = results.map((r) => r.stats);
	const summary = runSummary(stats, wall);
	const cell = (text: string) => text.replace(/\|/g, "/").replace(/\n/g, " ");
	const tools = (entry: StoryStats) => (entry.slowestTool ? `${entry.slowestTool.name} ${entry.slowestTool.ms} ms` : "-");
	// Pi's footer and the exchange log both sum the session; they must agree at story end.
	const warnings = results.flatMap((r) => (r.stats.footerCostUsd !== undefined && Math.abs(r.stats.footerCostUsd - r.stats.costUsd) > 0.001 ? [`${r.story.id}: Pi's footer says ${money(r.stats.footerCostUsd)}, the exchange log sums to ${money(r.stats.costUsd)}`] : []));
	// Per story id (repeats folded together): per-turn aggregates. Strict pass is reported here and never read by a verdict.
	const storyIds = [...new Set(results.map((r) => r.story.id.replace(repeat === 1 ? /$^/ : /\.r\d+$/, "")))];
	const perStory: StoryTurns[] = storyIds.map((id) => {
		const mine = results.filter((r) => (repeat === 1 ? r.story.id === id : r.story.id.startsWith(`${id}.r`)));
		const turns = aggregateTurns(mine.map((r) => r.grades), strictQuality).map((t) => ({ ...t, answer: mine[0]?.exchange[t.turn - 1]?.answer?.trim() || undefined }));
		return { id, repeats: mine.map((r) => r.story.id), turns };
	}).filter((entry) => entry.turns.length);
	const baseline = compare ? (JSON.parse(readFileSync(compare, "utf8")) as { stories: StoryStats[]; turns?: StoryTurns[] }) : undefined;
	const delta = baseline ? compareStats(baseline.stories, stats) : undefined;
	const turnDelta = baseline ? compareTurns(baseline.turns ?? [], perStory).map(turnCompareLine) : [];
	const splitDelta = baseline ? (() => { const was = new Map(splitSummaries(baseline.stories, baseline.turns ?? []).map((x) => [x.split, x])); return splitSummaries(stats, perStory).map((x) => splitLine(was.get(x.split), x)); })() : [];
	const turnRows = perStory.flatMap((entry) => entry.turns.map((t) => `| ${entry.id} | ${t.turn} | ${t.medianQuality ?? "null"} | ${t.qualities.map((q) => q ?? "null").join(", ")} | ${t.flags.intro}/${t.flags.hedges}/${t.flags.unsourced} | ${t.strictPass ?? "null"} |`));
	const answerRows = results.flatMap((r) => (r.stats.answers ?? []).map((answer) => answerRow(r.story.id, answer)));
	const report = [
		`# Story report (${new Date().toISOString()})`,
		"",
		"| id | verdict | s | model s | slowest tool | Jev ms | model $ | Jev tokens ($) | note $ | total $ | tokens in/out | turns | model | gates failed | recovered tool calls | icons exp/placed/blank | rubric | note |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
		...results.map((r) => `| ${r.story.id} | ${r.stats.verdict} | ${r.stats.seconds} | ${r.stats.modelSeconds} | ${tools(r.stats)} | ${r.stats.jevMs} | ${money(r.stats.costUsd)} | ${r.stats.jevInputTokens} (${money(r.stats.jevUsd)}) | ${money(r.stats.noteUsd)} | ${money(r.stats.totalUsd)} | ${r.stats.inputTokens}/${r.stats.outputTokens} | ${r.stats.turns} | ${r.stats.model || "-"} | ${cell(r.failures.map((f) => `${f.gate}: ${f.detail}`).join("; ")) || "-"} | ${[...new Set(toolFailures(r.exchange).recovered)].map((name) => `${name} recovered`).join(", ") || "-"} | ${iconCell(r.stats)} | ${r.rubric} | ${cell(r.note) || "-"} |`),
		...(turnRows.length ? ["", `Per turn over ${repeat} repeat(s) (strict pass: every repeat quality >= ${strictQuality}, no flag; reported only, the gates decide pass and fail):`, "", "| story | turn | median quality | repeats | flags intro/hedges/unsourced | strict pass |", "|---|---|---|---|---|---|", ...turnRows] : []),
		...(answerRows.length ? ["", "Per answer (each model run): the claims as the coach's own check routed them, the coach model's tokens and dollars, and Jev's doctrine questions (`jev.doctrine` in coach.yaml) on the answer. Report-only, no pass mark: each answer is asked the questions its story's `applies` names, or every question when the story names none, and a rule the answer had no occasion for shows as not followed.", "", ...ANSWER_TABLE, ...answerRows, ...results.filter((r) => r.doctrineSkipped).map((r) => `Doctrine grading stopped on ${r.story.id}: ${r.doctrineSkipped}.`)] : []),
		"",
		`Totals: ${money(summary.costUsd)} spent: model ${money(summary.modelUsd)}, Jev ${money(summary.jevUsd)} (${summary.jevInputTokens} input tokens at $${(JEV_USD_PER_INPUT_TOKEN * 1e6).toFixed(3)} per million, the router call not counted), notes ${money(summary.noteUsd)}. Story seconds add up to ${summary.sumSeconds} s against ${summary.wallSeconds} s on the wall clock, a ${summary.speedup}x speed-up from the ${g.panes.length} panes. Median story ${summary.medianSeconds} s, p90 ${summary.p90Seconds} s.`,
		`Slowest tools: ${summary.slowestTools.map((tool) => `${tool.name} ${tool.ms} ms (${tool.story})`).join(", ") || "none"}.`,
		...(warnings.length ? ["", "Runner warnings:", ...warnings.map((line) => `- cost mismatch, ${line}`)] : []),
		...(delta ? ["", `Against ${compare}: ${delta.flagged.length ? `${delta.flagged.length} flagged (over 25% slower or costlier, and at least 2x the baseline repeats' MAD): ${delta.flagged.join(", ")}` : "nothing flagged (over 25% slower or costlier, and at least 2x the baseline repeats' MAD)"}${unverifiedNote(delta.unverified)}. Model cost compares on total tokens (cached plus uncached) when both logs record cache reads, else on costUsd, which swings with cache state.`, ...delta.lines.map((line) => `- ${line}`), "", turnCompareHeading(), ...turnDelta.map((line) => `- ${line}`), "", "Per split (story, repeats folded; guards are pass count, flags intro/hedges/unsourced, contradicted claims):", ...splitDelta.map((line) => `- ${line}`)] : []),
		"",
		`${results.filter((r) => !r.failures.length).length} of ${results.length} passed. Rubric: ${RUBRIC_PASS_QUALITY === undefined ? "report-only, no pass mark set" : `pass mark ${RUBRIC_PASS_QUALITY} of 4`}. Font ${g.font}, ${g.panes.length} panes of ${g.COLS}x${g.ROWS}, up to ${maxModelFlag} model stories at once${g.statusNote ? `; ${g.statusNote}` : ""}.`,
	].join("\n");
	writeFileSync(join(out, "report.md"), `${report}\n`);
	writeFileSync(join(out, "stats.json"), `${JSON.stringify({ at: new Date().toISOString(), summary, stories: stats, strictQuality, turns: perStory }, null, "\t")}\n`);
	console.log(report);
	console.error(`report: ${join(out, "report.md")}`);
	if (delta) for (const line of delta.lines) console.error(line);
	cleanup();
	process.exit(results.some((r) => r.failures.length) ? 1 : 0);
}

main().catch((error) => {
	console.error(error);
	cleanup();
	process.exit(1);
});
