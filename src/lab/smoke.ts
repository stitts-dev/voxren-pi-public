/**
 * Smoke tests (tier T2): the QA stories replayed fully offline through Pi's faux model, in a WezTerm grid, each recorded
 * as a GIF, judged by the story's gates plus deterministic animation gates on the text timeline (timeline.ts), with an
 * advisory visual review by an agent. A fast, cheap check of the real TUI and its animation before a push.
 *
 *   just smoke [--only id1,id2] [--no-gif] [--no-notes] [--notes all] [--warm] [--panes 1|4|9] [--out <dir>] [--json <file>]
 *   just smoke record <story-id> [--force]    run the story live once and keep its model run as data/lab/cassettes/<id>.json
 *
 * A model story runs only when it has a cassette; the /flow stories (no model turn) always run. Output in --out (default a
 * tmp dir, never inside the repo): report.md, and per story <id>.screen.txt, <id>.timeline.json, and with a GIF
 * <id>.gif, <id>-frames/ (png and the pane text of each frame), <id>-sheet-N.png; notes.md is the visual review; tier.json the result as JSON (smoke-tier.ts), also at --json.
 * Exit code 1 when a story fails a gate. The window and every throwaway home are removed at exit.
 */
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { findWezterm } from "../../bin/coach.mjs";
import type { Exchange } from "../exchange-log";
import { dataDragon, draftFrames, type Draft } from "./drafts.ts";
import { buildCassette, readCassette, writeCassette } from "./cassette.ts";
import { BANNER, clean, cli, closeWindow, everything, fail, g, initGrid, openWindow, quitCoach, quote, resetHome, settle, sleep, socket, type, viewport, waitIdle, waitScreen, wez, type Pane } from "./grid.ts";
import { realCoachHome } from "./lab-home.ts";
import { hasIdle, judge, loadStories, type Failure, type Run, type Step, type Story } from "./stories.ts";
import { tierResult } from "./smoke-tier.ts";
import { timelineGates, timelineHash, runningRows, type Frame } from "./timeline.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const CASSETTES = join(REPO, "data", "lab", "cassettes");
const KEYS: Record<string, string> = { esc: "\x1b", enter: "\r", tab: "\t", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F" };
/** Seconds a smoke story should take, and the whole set (the targets this lab reports against). */
const STORY_TARGET = 10;
const SET_TARGET = 60;
const STEP_WAIT_SECONDS = 20;
const FPS = 4;
const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
const has = (name: string) => {
	const index = argv.indexOf(name);
	return index >= 0 && argv.splice(index, 1).length > 0;
};
const flag = (name: string) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv.splice(index, 2)[1] : undefined;
};
const cassetteFile = (id: string) => join(CASSETTES, `${id}.json`);

// --- record -----------------------------------------------------------------------------------------------------

if (argv[0] === "record") {
	argv.shift();
	const force = has("--force");
	const id = argv[0] ?? fail("record needs a story id: just smoke record <story-id>");
	if (existsSync(cassetteFile(id)) && !force) {
		console.log(`${cassetteFile(id)} exists; --force records it again.`);
		process.exit(0);
	}
	const work = mkdtempSync(join(tmpdir(), "voxren-smoke-record-"));
	// The live run is the story runner's own: the same story, the real coach, the real model; only its exchange log is kept.
	const live = spawnSync(process.execPath, [join(REPO, "src", "lab", "story-runner.ts"), "--only", id, "--panes", "1", "--no-notes", "--out", work], { stdio: "inherit", cwd: REPO });
	const log = join(work, `${id}.exchange.json`);
	if (!existsSync(log)) fail(`The live run left no exchange log (${log}).`);
	const runs = JSON.parse(readFileSync(log, "utf8")) as Exchange[];
	if (!runs.length) fail("The story made no model run; there is nothing to record.");
	// The champion list a replayed coach reads names from, kept once beside the cassettes (a replay has no Data Dragon).
	const champions = join(CASSETTES, "champions.json");
	if (!existsSync(champions)) {
		mkdirSync(CASSETTES, { recursive: true });
		const list = (await dataDragon<{ data: Record<string, { key: string; name: string }> }>("champion.json")).data;
		const byName = Object.values(list).map((champion) => [champion.name, Number(champion.key)] as const).sort(([x], [y]) => x.localeCompare(y));
		writeFileSync(champions, `${JSON.stringify(Object.fromEntries(byName), null, "\t")}\n`);
	}
	const cassette = buildCassette(id, runs, [homedir(), realCoachHome(), REPO, tmpdir()]);
	mkdirSync(CASSETTES, { recursive: true });
	writeCassette(cassetteFile(id), cassette);
	rmSync(work, { recursive: true, force: true });
	console.log(`${cassetteFile(id)}: ${cassette.turns.length} turns, ${cassette.tools.length} tool results${live.status ? " (the live story failed its gates: read it before committing)" : ""}`);
	process.exit(0);
}

// --- run --------------------------------------------------------------------------------------------------------

const only = flag("--only")?.split(",").map((item) => item.trim()).filter(Boolean);
const gif = !has("--no-gif");
const notes = !has("--no-notes");
const jsonOut = flag("--json");
const warm = has("--warm");
const notesAll = flag("--notes") === "all";
/** The Data Dragon cache every replay reads (icons, item and rune lists): outside the repo, filled only by --warm, never by a replay. */
const DDRAGON = join(homedir(), ".cache", "voxren-smoke", "ddragon");
const paneCount = Number(flag("--panes") ?? 9);
const out = resolve(flag("--out") ?? mkdtempSync(join(tmpdir(), "voxren-smoke-out-")));
if (![1, 4, 9].includes(paneCount)) fail("--panes is 1, 4, or 9.");
if (out === REPO || out.startsWith(`${REPO}/`)) fail("--out must be outside the repo.");
const gui = findWezterm() ?? fail("WezTerm is not installed (npm run setup installs it).");
const everyStory = loadStories(join(REPO, "data", "lab", "stories")).filter((story) => !only || only.includes(story.id));
if (only) for (const id of only) if (!everyStory.some((story) => story.id === id)) fail(`No story "${id}".`);
const skipped = everyStory.filter((story) => hasIdle(story) && !existsSync(cassetteFile(story.id)));
const stories = everyStory.filter((story) => !skipped.includes(story)).sort((a, b) => Number(hasIdle(b)) - Number(hasIdle(a)));
if (!stories.length) fail(`Nothing to run${skipped.length ? `: no cassette for ${skipped.map((story) => story.id).join(", ")}. Record one with just smoke record <id>.` : "."}`);
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "voxren-smoke-"));
initGrid(gui, scratch);

const results: Result[] = [];
g.statusRows = () => 1;
g.drawStatus = () => writeFileSync(g.statusFile, `SMOKE ${results.length}/${stories.length} stories\x1b[K\x1b[J`);

interface Result {
	story: Story;
	failures: Failure[];
	seconds: number;
	startedAt: number;
	endedAt: number;
	pane: Pane;
	frames: Frame[];
	screen: string;
	exchange: Run[];
}

/** A hand-written draft expanded into a client replay file from the recorded champion list: no Data Dragon, so the run needs no network at all. */
function expandDraft(file: string, to: string): string {
	const names = JSON.parse(readFileSync(join(CASSETTES, "champions.json"), "utf8")) as Record<string, number>;
	const ids = new Map(Object.entries(names).map(([name, key]) => [name.toLowerCase(), key]));
	writeFileSync(to, draftFrames(JSON.parse(readFileSync(file, "utf8")) as Draft, ids).map((frame) => JSON.stringify(frame.frame)).join("\n") + "\n");
	return to;
}

/** The pane's text without blocking the event loop: nine panes sampled four times a second would otherwise starve each other. */
async function paneText(pane: Pane): Promise<string> {
	const wezterm = join(dirname(gui), process.platform === "win32" ? "wezterm.exe" : "wezterm");
	try {
		const { stdout } = await execFileAsync(wezterm, ["cli", "--no-auto-start", "get-text", "--pane-id", String(pane.id)], { env: { ...process.env, WEZTERM_UNIX_SOCKET: socket() }, timeout: 5000 });
		return clean(stdout);
	} catch (error) {
		console.error(`get-text failed for pane ${pane.id}: ${error instanceof Error ? error.message : error}`);
		return "";
	}
}

/** The coach in the pane through the smoke launcher (smoke-coach.mjs): replaying the story's cassette, offline. */
async function startCoach(pane: Pane, story: Story, replay: string | undefined, banner: string, onCleared?: () => void) {
	const env = [
		"VOXREN_COACH_TERMINAL=here",
		`VOXREN_COACH_HOME=${pane.home}`,
		`VOXREN_COACH_IDLE_FILE=${pane.idle}`,
		`VOXREN_SMOKE_NET_LOG=${join(pane.dir, "net.log")}`,
		`VOXREN_SMOKE_ICON_MISS=${join(pane.dir, "icon-miss.log")}`,
		...(existsSync(DDRAGON) || warm ? [`VOXREN_SMOKE_DDRAGON=${DDRAGON}`] : []),
		...(warm ? ["VOXREN_SMOKE_WARM=1"] : []),
		...(existsSync(cassetteFile(story.id)) ? [`VOXREN_SMOKE_CASSETTE=${cassetteFile(story.id)}`] : []),
		...(replay ? [`VOXREN_LCU_REPLAY=${replay}`] : []),
		...(story.replayStepMs ? [`VOXREN_LCU_REPLAY_STEP_MS=${story.replayStepMs}`] : []),
		...Object.entries(story.env ?? {}).map(([name, value]) => `${name}=${value}`),
	];
	const script = join(pane.dir, "launch.sh");
	writeFileSync(script, `printf '\\033]2;%s\\007' ${quote(`${story.id} smoke`)}\nprintf '\\033[1;36m%s\\033[0m\\n' ${quote(banner.slice(0, g.COLS - 2))}\nexec env ${env.map(quote).join(" ")} node src/lab/smoke-coach.mjs\n`);
	type(pane, `clear; sh ${quote(script)}\r`);
	// The pane is cleared and the new story's banner is up: nothing of the last story is left, and the recording starts here.
	if (onCleared && (await waitScreen(pane, (text) => text.includes(story.id), 10))) onCleared();
	return waitScreen(pane, (text) => text.includes("VOXREN COACH"), 30);
}

// ponytail: the story runner's step loop, copied (story-runner.ts runs on import, so it cannot be imported); lift it into grid.ts if a third lab needs it.
async function runStep(pane: Pane, step: Step, story: Story, replay: string | undefined, seconds: number): Promise<string | undefined> {
	if ("send" in step) {
		rmSync(pane.idle, { force: true });
		type(pane, `${step.send}\r`);
	} else if ("type" in step) type(pane, step.type);
	else if ("key" in step) type(pane, KEYS[step.key]);
	else if ("wait" in step) {
		const timeout = step.timeout ?? STEP_WAIT_SECONDS;
		if (!(await waitScreen(pane, (text) => text.includes(step.wait) !== !!step.absent, timeout))) return `"${step.wait}" ${step.absent ? "never went away" : "never showed"} within ${timeout} s`;
	} else if ("idle" in step) {
		const timeout = step.timeout ?? seconds;
		if (!(await waitIdle(pane, timeout))) return step.optional ? undefined : `the model turn did not settle within ${timeout} s`;
		rmSync(pane.idle, { force: true });
	} else {
		await quitCoach(pane);
		if (!(await startCoach(pane, story, replay, `${BANNER}${story.id} · restarted`))) return "the coach did not come back after the restart";
	}
	return undefined;
}

async function runStory(story: Story, pane: Pane): Promise<Result> {
	const failures: Failure[] = [];
	const started = Date.now();
	const limit = Math.min(story.gates.maxSeconds ?? 120, 30);
	resetHome(pane);
	rmSync(join(pane.dir, "net.log"), { force: true });
	const replay = story.replay ? (story.replay.endsWith(".json") ? expandDraft(join(REPO, story.replay), join(pane.dir, "draft.ndjson")) : join(REPO, story.replay)) : undefined;
	// The text timeline: the pane sampled until the story ends, one at a time so a slow read never queues up.
	const frames: Frame[] = [];
	let sampling = true;
	let t0 = started;
	let sampler: Promise<void> | undefined;
	// Sampling (and the recording's cut) begins once the pane shows this story's banner, so frame 1 is the banner and never the last story.
	const begin = () => {
		t0 = Date.now();
		sampler = (async () => {
			while (sampling) {
				const begun = Date.now();
				frames.push({ t: begun - t0, text: await paneText(pane) });
				await sleep(Math.max(0, 1000 / FPS - (Date.now() - begun)));
			}
		})();
	};
	if (!(await startCoach(pane, story, replay, `${BANNER}${story.id} · ${story.title} · smoke`, begin))) failures.push({ gate: "step", detail: "the coach header did not draw within 30 s" });
	else
		for (const [index, step] of story.steps.entries()) {
			const problem = await runStep(pane, step, story, replay, limit);
			if (problem) {
				failures.push({ gate: "step", detail: `step ${index + 1} ${JSON.stringify(step)}: ${problem}` });
				break;
			}
		}
	await settle(pane);
	const screen = everything(pane);
	const finalViewport = viewport(pane);
	sampling = false;
	await sampler;
	frames.push({ t: Date.now() - t0, text: await paneText(pane) });
	const endedAt = Date.now();
	const exchangeFile = join(pane.home, "exchanges.ndjson");
	const exchange = existsSync(exchangeFile) ? readFileSync(exchangeFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Run) : [];
	const seconds = (endedAt - started) / 1000;
	failures.push(...judge(story, screen, exchange, g.COLS));
	failures.push(...timelineGates(frames, finalViewport, g.COLS, exchange.some((run) => run.tools.length > 0), story.id));
	const refused = existsSync(join(pane.dir, "net.log")) ? readFileSync(join(pane.dir, "net.log"), "utf8").trim() : "";
	if (refused) failures.push({ gate: "offline", detail: `the replay tried the network: ${refused.split("\n")[0]}` });
	const missFile = join(pane.dir, "icon-miss.log");
	if (existsSync(missFile) && !warm) {
		const missed = [...new Set(readFileSync(missFile, "utf8").trim().split("\n"))];
		failures.push({ gate: "icons", detail: `icons: missing-cache, ${missed.length} Data Dragon files not cached (${missed[0]}): run just smoke --warm` });
	}
	writeFileSync(join(out, `${story.id}.screen.txt`), `${screen}\n`);
	writeFileSync(join(out, `${story.id}.timeline.json`), `${JSON.stringify(frames)}\n`);
	await quitCoach(pane);
	return { story, failures, seconds, startedAt: t0, endedAt, pane, frames, screen, exchange };
}

// --- the recording ------------------------------------------------------------------------------------------------

/** `wezterm.ts record` as a subprocess over the whole grid window for the whole run; stopped when the stories end. */
function startRecording(): ChildProcess | undefined {
	if (!gif) return undefined;
	const child = spawn(process.execPath, [join(REPO, "src", "lab", "wezterm.ts"), "record", "--pid", String(g.windowPid), join(out, "grid.gif"), "--seconds", "180", "--fps", String(FPS)], { cwd: REPO, stdio: "ignore" });
	return child;
}

/**
 * The pane's rectangle in a window capture, in the capture's pixels. Measured on a macOS capture (2920 px wide at font 11):
 * a title bar of 1.9% of the width above the grid, 0.15% padding either side, and cells 2.22 times as tall as wide. The grid
 * is `GRID` panes a side, each `COLS` cells wide with a gap cell between.
 */
function paneRect(pane: Pane, width: number): { w: number; h: number; x: number; y: number } {
	const totalCols = g.GRID * g.COLS + g.GRID - 1;
	const padX = 0.0015 * width;
	const cellW = (width - 2 * padX) / totalCols;
	const cellH = 2.223 * cellW;
	const top = 0.0192 * width;
	const column = pane.index % g.GRID;
	const row = Math.floor(pane.index / g.GRID);
	const even = (value: number) => 2 * Math.floor(value / 2);
	return { w: even(g.COLS * cellW), h: even((g.ROWS + 0.8) * cellH), x: Math.round(padX + column * (g.COLS + 1) * cellW), y: Math.round(top + row * (g.ROWS + 1) * cellH) };
}

const ffmpeg = (args: string[]) => spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { encoding: "utf8" });

/** Per story: its frames cropped to its pane, the GIF, the contact sheets, and each frame's pane text beside it. Returns the first-running and last frame paths for the review. */
function cutStory(result: Result, frameDir: string): { gif?: string; sheets: string[]; firstRunning?: string; last?: string } {
	// From the coach's first paint: before it the pane still shows the last story's result banner and the shell.
	const from = result.startedAt - 100;
	const names = readdirSync(frameDir).filter((name) => /^frame-\d+\.png$/.test(name)).sort();
	const inWindow = names.filter((name) => {
		const at = statSync(join(frameDir, name)).mtimeMs;
		return at >= from && at <= result.endedAt + 250;
	});
	if (!inWindow.length) return { sheets: [] };
	const dir = join(out, `${result.story.id}-frames`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", join(frameDir, inWindow[0])], { encoding: "utf8" }).stdout.trim().split(",").map(Number);
	const rect = paneRect(result.pane, probe[0]);
	let firstRunning: string | undefined;
	inWindow.forEach((name, index) => {
		const file = `frame-${String(index + 1).padStart(4, "0")}`;
		const at = statSync(join(frameDir, name)).mtimeMs - result.startedAt;
		// the sample taken at or just before the capture
		const sample = [...result.frames].reverse().find((frame) => frame.t <= at) ?? result.frames[0];
		writeFileSync(join(dir, `${file}.txt`), `${sample.text}\n`);
		const crop = ffmpeg(["-i", join(frameDir, name), "-vf", `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`, join(dir, `${file}.png`)]);
		if (crop.status !== 0) console.error(`${result.story.id}: crop failed: ${crop.stderr.trim()}`);
		if (!firstRunning && runningRows(sample.text).length) firstRunning = join(dir, `${file}.png`);
	});
	const count = inWindow.length;
	const gifFile = join(out, `${result.story.id}.gif`);
	ffmpeg(["-framerate", String(FPS), "-i", join(dir, "frame-%04d.png"), "-vf", "scale=iw/2:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", gifFile]);
	ffmpeg(["-framerate", String(FPS), "-i", join(dir, "frame-%04d.png"), "-vf", "select='not(mod(n\\,2))',scale=400:-1,tile=4x4", join(out, `${result.story.id}-sheet-%d.png`)]);
	const sheets = readdirSync(out).filter((name) => name.startsWith(`${result.story.id}-sheet-`)).sort().map((name) => join(out, name));
	return { gif: gifFile, sheets, firstRunning: firstRunning ?? join(dir, "frame-0001.png"), last: join(dir, `frame-${String(count).padStart(4, "0")}.png`) };
}

// --- the visual review --------------------------------------------------------------------------------------------

const HASHES = join(homedir(), ".cache", "voxren-smoke", "hashes.json");
const readHashes = (): Record<string, string> => {
	try {
		return JSON.parse(readFileSync(HASHES, "utf8")) as Record<string, string>;
	} catch {
		return {}; // no earlier run: every story counts as changed
	}
};

/**
 * One `claude -p` call for the whole run, on the stories whose look changed since the last run (`--notes all`: every story): per
 * story one small contact sheet and the last frame, as images in one message, no tools. Advisory; it never fails the run.
 */
function visualReview(cuts: Map<string, ReturnType<typeof cutStory>>, changed: string[]): { text: string; usd: number; input: number; output: number } {
	const none = { text: "", usd: 0, input: 0, output: 0 };
	if (!changed.length) return { ...none, text: "Review skipped: no story's look changed since the last run (--notes all forces it)." };
	const content: unknown[] = [];
	for (const id of changed) {
		const cut = cuts.get(id);
		const dir = join(out, `${id}-frames`);
		if (!cut?.last || !existsSync(dir)) continue;
		const shrink = (args: string[], file: string) => (ffmpeg(args).status === 0 ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: readFileSync(file).toString("base64") } }] : []);
		const sheet = join(dir, "review-sheet.jpg");
		const last = join(dir, "review-last.jpg");
		const every = Math.max(1, Math.ceil(readdirSync(dir).filter((name) => name.endsWith(".png")).length / 9));
		content.push({ type: "text", text: `Story ${id}: contact sheet (every ${every}th frame), then the last frame.` }, ...shrink(["-framerate", String(FPS), "-i", join(dir, "frame-%04d.png"), "-vf", `select='not(mod(n\\,${every}))',scale=260:-1,tile=3x3`, "-frames:v", "1", sheet], sheet), ...shrink(["-i", cut.last, "-vf", "scale=420:-1", last], last));
	}
	if (!content.length) return { ...none, text: "(no notes: no recordings)" };
	content.unshift({ type: "text", text: "These are recordings of a terminal League of Legends coach replayed offline. For each story below write one line starting with its id: flicker between sheet frames, a layout jump (a block moving while it should stay), icon or picture placement, rows cut off or drawn twice, the spinner and clock on a running card. Say \"fine\" when there is nothing. At most 12 lines, plain text, notes only." });
	const message = `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
	const run = spawnSync("claude", ["-p", "--model", "sonnet", "--system-prompt", "You review terminal UI recordings.", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"], { cwd: out, input: message, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
	try {
		const reply = JSON.parse(run.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "") as { result?: string; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
		const usage = reply.usage ?? {};
		return { text: (reply.result ?? "").trim() || "(no notes returned)", usd: reply.total_cost_usd ?? 0, input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), output: usage.output_tokens ?? 0 };
	} catch (error) {
		console.error(`visual review unavailable: ${error instanceof Error ? error.message : error}`);
		return { ...none, text: `(notes unavailable: ${(run.stderr || run.error?.message || "no JSON from claude").toString().trim().slice(0, 120)})` };
	}
}

// --- main -------------------------------------------------------------------------------------------------------

let cleaned = false;
let recorder: ChildProcess | undefined;
function cleanup() {
	if (cleaned) return;
	cleaned = true;
	recorder?.kill("SIGKILL");
	closeWindow();
	// The sign-in link goes before the folder so rm never reaches the real one; a pane whose story never started has no home.
	for (const pane of g.panes) if (existsSync(pane.home)) unlinkSync(join(pane.home, "pi-agent"));
	rmSync(scratch, { recursive: true, force: true });
}
// Whatever ends the process (a normal exit, a throw, Ctrl+C, kill) closes the window, stops the recorder, and removes the throwaway homes.
process.on("exit", cleanup);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const)
	process.on(signal, () => {
		cleanup();
		process.exit(code);
	});

async function main() {
	const began = Date.now();
	openWindow(paneCount);
	console.error(`window pid ${g.windowPid}, ${g.panes.length} pane(s) of ${g.COLS}x${g.ROWS}, ${stories.length} stories${skipped.length ? `, ${skipped.length} without a cassette` : ""}, out ${out}`);
	const recording = (recorder = startRecording());
	const queue = [...stories];
	await Promise.all(
		g.panes.map(async (pane) => {
			for (let story = queue.shift(); story; story = queue.shift()) {
				const result = await runStory(story, pane);
				results.push(result);
				g.drawStatus();
				console.error(`${result.failures.length ? "FAIL" : "ok  "} ${story.id} (${result.seconds.toFixed(1)} s)`);
			}
		}),
	);
	const wall = (Date.now() - began) / 1000;
	// Stop the recording where the stories end; its frames stay on disk.
	recording?.kill("SIGTERM");
	await sleep(500);
	const cuts = new Map<string, ReturnType<typeof cutStory>>();
	const frameDir = join(out, "grid-frames");
	if (gif && existsSync(frameDir)) for (const result of results) cuts.set(result.story.id, cutStory(result, frameDir));
	else if (gif) console.error("the recording left no frames (Screen Recording allowed for this terminal?)");
	const hashes = readHashes();
	const looks = Object.fromEntries(results.map((result) => [result.story.id, timelineHash(result.frames, result.screen)]));
	const changed = Object.keys(looks).filter((id) => notesAll || looks[id] !== hashes[id]);
	const review = notes && gif ? visualReview(cuts, changed) : undefined;
	if (review && !review.text.startsWith("(notes unavailable")) {
		mkdirSync(dirname(HASHES), { recursive: true });
		writeFileSync(HASHES, `${JSON.stringify({ ...hashes, ...looks }, null, "\t")}\n`);
	}
	if (review) writeFileSync(join(out, "notes.md"), `${review.text}\n`);
	results.sort((a, b) => a.story.id.localeCompare(b.story.id));
	const slow = results.filter((result) => result.seconds > STORY_TARGET);
	const report = [
		`# Smoke report (${new Date().toISOString()})`,
		"",
		"| story | verdict | s | gates failed |",
		"|---|---|---|---|",
		...results.map((result) => `| ${result.story.id} | ${result.failures.length ? "FAIL" : "PASS"} | ${result.seconds.toFixed(1)} | ${result.failures.map((failure) => `${failure.gate}: ${failure.detail}`).join("; ").replace(/\|/g, "/") || "-"} |`),
		"",
		`${results.filter((result) => !result.failures.length).length} of ${results.length} passed in ${wall.toFixed(1)} s on the wall clock (target ${SET_TARGET} s, ${wall <= SET_TARGET ? "met" : "MISSED"}); ${slow.length ? `over ${STORY_TARGET} s: ${slow.map((result) => `${result.story.id} ${result.seconds.toFixed(1)}`).join(", ")}` : `every story under ${STORY_TARGET} s`}. ${g.panes.length} panes of ${g.COLS}x${g.ROWS}.`,
		...(skipped.length ? [`No cassette, not run: ${skipped.map((story) => story.id).join(", ")}.`] : []),
		...(review ? ["", `Visual review (advisory, ${changed.length} of ${results.length} stories changed, cost $${review.usd.toFixed(3)}, ${review.input} tokens in, ${review.output} out):`, review.text] : []),
	].join("\n");
	writeFileSync(join(out, "report.md"), `${report}\n`);
	const tier = `${JSON.stringify(tierResult(results.map((result) => ({ id: result.story.id, failures: result.failures })), skipped.length, wall, review?.usd ?? 0), null, "\t")}\n`;
	writeFileSync(join(out, "tier.json"), tier);
	if (jsonOut) writeFileSync(resolve(jsonOut), tier);
	console.log(report);
	console.error(`report: ${join(out, "report.md")}`);
	cleanup();
	process.exit(results.some((result) => result.failures.length) ? 1 : 0);
}

main().catch((error) => {
	console.error(error);
	cleanup();
	process.exit(1);
});
