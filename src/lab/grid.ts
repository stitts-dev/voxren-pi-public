/**
 * The WezTerm window and pane grid shared by the labs that drive many coaches at once (story-runner.ts) or draw many
 * views at once (ui-shoot.ts). No side effects on import: `initGrid` sets what the helpers need, `openWindow` opens the window.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JEV_KEY_ENV, labHome } from "./lab-home.ts";
import type { Story } from "./stories.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const FONT_FLOOR = 10;
export const PROMPT = "voxren$";
export const BANNER = "\u258c ";
export const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};
/** Inside the window code a failure throws, so the caller's `finally` closes the window and removes its folders; the top level prints it and exits non-zero. */
const stop = (message: string): never => {
	throw new Error(message);
};
export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export interface Pane {
	id: number;
	index: number;
	home: string;
	dir: string;
	idle: string;
	/** The pane's terminal device, for the last-resort kill of a coach that will not quit. */
	tty: string;
}

/** Mutable window state: one window per process. */
export const g = {
	gui: "",
	scratch: "",
	/** Pane size in cells and grid side, set by openGrid: 80x24 (3x3), 100x30 (2x2 and 1). */
	COLS: 100,
	ROWS: 30,
	GRID: 2,
	font: 11,
	windowPid: 0,
	panes: [] as Pane[],
	/** The strip along the bottom of the window: a tiny loop in its own pane re-reads this file, the runner rewrites it. */
	statusFile: "",
	statusPane: 0,
	statusNote: "",
	/** Rows the bottom strip needs (the caller's content decides) and its redraw; a lab with no strip keeps these. */
	statusRows: (_grid: number, _cols: number) => 1,
	drawStatus: () => {},
};
export function initGrid(gui: string, scratch: string) {
	g.gui = gui;
	g.scratch = scratch;
}

export const socket = () => join(homedir(), ".local", "share", "wezterm", `gui-sock-${g.windowPid}`);

export function cli(args: string[]) {
	const result = spawnSync(join(dirname(g.gui), process.platform === "win32" ? "wezterm.exe" : "wezterm"), ["cli", "--no-auto-start", ...args], { encoding: "utf8", timeout: 10_000, env: { ...process.env, WEZTERM_UNIX_SOCKET: socket() } });
	return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

export const shell = ["env", `PS1=${PROMPT} `, "/bin/sh"];

export const wez = (args: string[]) => {
	const logFile = join(g.scratch, "wez.out");
	// stdout to a file: the detached WezTerm would hold a pipe open for good.
	const fd = openSync(logFile, "w");
	const result = spawnSync(process.execPath, [join(REPO, "src", "lab", "wezterm.ts"), ...args], { stdio: ["ignore", fd, fd], cwd: REPO, timeout: 60_000 });
	closeSync(fd);
	return { ok: result.status === 0, out: readFileSync(logFile, "utf8") };
};

export function closeWindow() {
	if (!g.windowPid) return;
	for (const item of JSON.parse(cli(["list", "--format", "json"]).out || "[]")) cli(["kill-pane", "--pane-id", String(item.pane_id)]);
	g.windowPid = 0;
}

/** macOS: the usable screen in points (the menu bar and Dock taken out), and a window's outer size by pid. Undefined elsewhere. */
function jxa(script: string): number[] | undefined {
	if (process.platform !== "darwin") return undefined;
	const result = spawnSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8", timeout: 10_000 });
	try {
		return JSON.parse(result.stdout) as number[];
	} catch {
		return undefined; // no usable answer from osascript: the sizing falls back to the cell counts WezTerm reports
	}
}
const visibleFrame = () => jxa(`ObjC.import("AppKit"); const f = $.NSScreen.mainScreen.visibleFrame; JSON.stringify([f.size.width, f.size.height])`);
const windowSize = (pid: number) =>
	jxa(`ObjC.import("CoreGraphics"); const w = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID))).filter((w) => w.kCGWindowOwnerPID === ${pid} && w.kCGWindowLayer === 0 && w.kCGWindowIsOnscreen).sort((a, b) => b.kCGWindowBounds.Width * b.kCGWindowBounds.Height - a.kCGWindowBounds.Width * a.kCGWindowBounds.Height)[0]; JSON.stringify(w ? [w.kCGWindowBounds.Width, w.kCGWindowBounds.Height] : [])`);

/**
 * Opens the window with a grid x grid block of cols x rows panes and the strip across the bottom. The window is sized
 * for the display: opened at a font, its real size in points is read and compared with the screen's usable frame, and the
 * font scaled by how much too big it was (cell metrics scale with the font), never below FONT_FLOOR. Returns false when
 * the grid does not fit at the floor.
 */
export function openGrid(grid: number, cols: number, rows: number): boolean {
	const wantCols = grid * cols + grid - 1;
	const wantRows = grid * rows + grid - 1 + g.statusRows(grid, cols) + 1;
	const frame = visibleFrame();
	let size = g.font;
	for (let attempt = 0; attempt < 4; attempt++) {
		const opened = wez(["open", "--real-home", "--font-size", String(size), "--cols", String(wantCols), "--rows", String(wantRows), "--wait", PROMPT, "--", ...shell]);
		g.windowPid = Number(/pid (\d+)/.exec(opened.out)?.[1] ?? 0);
		if (!opened.ok || !g.windowPid) stop(`Could not open the window:\n${opened.out}`);
		const first = JSON.parse(cli(["list", "--format", "json"]).out)[0];
		const outer = windowSize(g.windowPid);
		const fits = first.size.cols >= wantCols && first.size.rows >= wantRows && (!frame || !outer?.length || (outer[0] <= frame[0] && outer[1] <= frame[1]));
		if (fits) {
			g.font = size;
			g.COLS = cols;
			g.ROWS = rows;
			g.GRID = grid;
			buildPanes(first.pane_id as number, grid);
			return true;
		}
		const ratios = [first.size.cols / wantCols, first.size.rows / wantRows, ...(frame && outer?.length ? [frame[0] / outer[0], frame[1] / outer[1]] : [])];
		const next = Math.floor(size * Math.min(...ratios) * 0.99 * 2) / 2;
		closeWindow();
		if (next < FONT_FLOOR) return false;
		size = next === size ? size - 0.5 : next;
		if (size < FONT_FLOOR) return false;
	}
	return false;
}

export function buildPanes(first: number, grid: number) {
	g.statusFile = join(g.scratch, "status.txt");
	writeFileSync(g.statusFile, "");
	g.statusPane = Number(cli(["split-pane", "--top-level", "--bottom", "--cells", String(g.statusRows(grid, g.COLS)), "--", "sh", "-c", `while :; do printf '\\033[H'; cat ${quote(g.statusFile)}; sleep 0.5; done`]).out);
	// Each split gives the new pane exactly the cells still to share, so every pane lands on g.COLS x g.ROWS.
	const columns = [first];
	for (let i = 1, at = first; i < grid; i++) {
		at = Number(cli(["split-pane", "--pane-id", String(at), "--right", "--cells", String((grid - i) * g.COLS + (grid - i - 1)), "--", ...shell]).out);
		columns.push(at);
	}
	const cells = columns.map((column) => {
		const stack = [column];
		for (let i = 1, at = column; i < grid; i++) {
			at = Number(cli(["split-pane", "--pane-id", String(at), "--bottom", "--cells", String((grid - i) * g.ROWS + (grid - i - 1)), "--", ...shell]).out);
			stack.push(at);
		}
		return stack;
	});
	const sizes = JSON.parse(cli(["list", "--format", "json"]).out) as { pane_id: number; tty_name?: string; size: { cols: number; rows: number } }[];
	const bad = sizes.filter((item) => item.pane_id !== g.statusPane && (item.size.cols !== g.COLS || item.size.rows !== g.ROWS));
	console.error(`pane sizes: ${sizes.map((item) => `${item.size.cols}x${item.size.rows}`).join(" ")} (strip last)`);
	if (bad.length) {
		closeWindow();
		stop(`The panes are not all ${g.COLS}x${g.ROWS}: ${sizes.map((item) => `${item.size.cols}x${item.size.rows}`).join(" ")}. Not running in a window that clips or reflows its panes.`);
	}
	// Row-major, so pane numbers read left to right, top to bottom.
	for (let row = 0; row < grid; row++)
		for (let column = 0; column < grid; column++) {
			const index = row * grid + column;
			const id = cells[column][row];
			const dir = join(g.scratch, `pane-${index}`);
			mkdirSync(dir, { recursive: true });
			g.panes.push({ id, index, home: join(dir, "home"), dir, idle: join(dir, "idle"), tty: sizes.find((item) => item.pane_id === id)?.tty_name ?? "" });
		}
	g.drawStatus();
}

/** 3x3 of 80x24 when the screen holds it at the font floor, else 2x2 of 100x30 (said on the strip); --panes 4 and 1 ask for those directly. */
export function openWindow(paneCount: number) {
	if (paneCount === 9) {
		if (openGrid(3, 80, 24)) return;
		console.error(`the screen cannot hold 3x3 panes of 80x24 at font ${FONT_FLOOR}: falling back to 2x2 of 100x30`);
		g.statusNote = "3x3 did not fit at font 10: running 2x2";
	}
	if (paneCount === 1 ? openGrid(1, 100, 30) : openGrid(2, 100, 30)) return;
	stop(`No font size of ${FONT_FLOOR} or more gives a window the grid fits in on this screen.`);
}

export const type = (pane: Pane, text: string) => cli(["send-text", "--no-paste", "--pane-id", String(pane.id), text]).ok || stop("Could not type into a pane.");
// The cards draw some spaces as no-break spaces (U+00A0); a story's text is written with plain ones.
export const clean = (text: string) => text.replace(/\u00a0/g, " ").split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
export const viewport = (pane: Pane) => clean(cli(["get-text", "--pane-id", String(pane.id)]).out);
/** The viewport and the scrollback above it: an answer longer than the pane still counts. */
export const everything = (pane: Pane) => {
	const lines = clean(cli(["get-text", "--pane-id", String(pane.id), "--start-line", "-3000"]).out).split("\n");
	// The story banner is the runner's, not the coach's: the screen starts after the last one.
	const launched = lines.map((line) => line.startsWith(BANNER)).lastIndexOf(true);
	return lines.slice(launched + 1).join("\n").trim();
};

/** Polls the viewport until `test` holds or `seconds` pass. Screen text has no event to wait on; the idle file does (waitIdle). */
export async function waitScreen(pane: Pane, test: (text: string) => boolean, seconds: number): Promise<boolean> {
	for (const end = Date.now() + seconds * 1000; ; await sleep(250)) {
		if (test(viewport(pane))) return true;
		if (Date.now() >= end) return false;
	}
}
export const atPrompt = (text: string) => text.split("\n").pop()?.startsWith(PROMPT) ?? false;

/** Resolves once the coach touches the idle file (a model turn settled), false after `seconds`. fs.watch on the folder, never a sleep loop. */
export function waitIdle(pane: Pane, seconds: number): Promise<boolean> {
	return new Promise((done) => {
		let finished = false;
		const end = (value: boolean) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			watcher.close();
			done(value);
		};
		const watcher = watch(dirname(pane.idle), () => existsSync(pane.idle) && end(true));
		const timer = setTimeout(() => end(false), seconds * 1000);
		if (existsSync(pane.idle)) end(true);
	});
}

/** Two reads 600 ms apart that agree, up to 6 s: the last rows of an answer land just after "settled". */
export async function settle(pane: Pane) {
	let last = "";
	for (let tries = 0; tries < 10; tries++) {
		const now = everything(pane);
		if (now === last) return;
		last = now;
		await sleep(600);
	}
}

export function resetHome(pane: Pane, story?: Story) {
	try {
		unlinkSync(join(pane.home, "pi-agent"));
	} catch {
		// Nothing to unlink on a first run; the link must go before the folder so rm never reaches the real sign-in.
	}
	rmSync(pane.home, { recursive: true, force: true });
	// Saved /flow settings (a bare /patch champion, /comp question) are the player's state, not the story's: every story starts from the defaults, with auto still off.
	labHome(pane.home, true, story?.noJevKey === true);
	rmSync(pane.idle, { force: true });
}

/** Gets the shell prompt back: Esc and Ctrl+U (abort, empty the editor), then Ctrl+D; a coach still up after that is killed by its terminal device. */
export async function quitCoach(pane: Pane) {
	for (let attempt = 0; attempt < 3; attempt++) {
		// Never Ctrl+D at the shell prompt: that ends the shell and closes the pane, and the grid reflows.
		if (atPrompt(viewport(pane))) return;
		type(pane, "\x1b");
		await sleep(300);
		type(pane, "\x15");
		await sleep(300);
		type(pane, "\x04");
		if (await waitScreen(pane, atPrompt, 10)) return;
	}
	if (pane.tty) spawnSync("pkill", ["-KILL", "-t", pane.tty.replace("/dev/", ""), "-f", "coach.mjs"]);
	await waitScreen(pane, atPrompt, 6);
}

/** The `env` arguments of a coach launch; a noJevKey story unsets the Jev key first, which a story `env` cannot do. */
export function coachEnvArgs(pane: Pane, story: Story, replay: string | undefined): string[] {
	return [...(story.noJevKey ? ["-u", JEV_KEY_ENV] : []), "VOXREN_COACH_TERMINAL=here", `VOXREN_COACH_HOME=${pane.home}`, `VOXREN_COACH_IDLE_FILE=${pane.idle}`, ...(replay ? [`VOXREN_LCU_REPLAY=${replay}`] : []), ...(story.replayStepMs ? [`VOXREN_LCU_REPLAY_STEP_MS=${story.replayStepMs}`] : []), ...Object.entries(story.env ?? {}).map(([name, value]) => `${name}=${value}`)];
}

/**
 * The coach in the pane, started through a small script so no long command shows: the pane is cleared, the story's banner
 * and the pane's title printed, then the coach runs. The typed line is gone the moment `clear` runs.
 */
export async function startCoach(pane: Pane, story: Story, replay: string | undefined, banner: string) {
	const script = join(pane.dir, "launch.sh");
	writeFileSync(script, `printf '\\033]2;%s\\007' ${quote(`${story.id} running`)}\nprintf '\\033[1;36m%s\\033[0m\\n' ${quote(banner.slice(0, g.COLS - 2))}\nexec env ${coachEnvArgs(pane, story, replay).map(quote).join(" ")} node bin/coach.mjs\n`);
	type(pane, `clear; sh ${quote(script)}\r`);
	return waitScreen(pane, (text) => text.includes("VOXREN COACH"), 60);
}
