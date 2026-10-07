/**
 * Drive the real coach in its own WezTerm window, pictures and all: the one rung where an agent sees the charts and
 * icons a player sees. WezTerm's own `wezterm cli` types and reads through the window's GUI socket; the capture grabs
 * the window even when other windows cover it, without touching the desktop.
 *
 *   node src/lab/wezterm.ts open [--real-home] [--cols 120] [--rows 36]          start the coach; prints "pid <n>"
 *   node src/lab/wezterm.ts open --font-size 11                                  a fixed font size, so cols and rows mean cells
 *   node src/lab/wezterm.ts open --env VOXREN_COACH_ENV_FILE=/dev/null            set a variable for it (repeatable)
 *   node src/lab/wezterm.ts open --wait BUILD -- bun run src/lab/strip-preview.ts   a lab script in its place, held open
 *   node src/lab/wezterm.ts send --pid <n> "/review 5"                          type a line and press Enter
 *   node src/lab/wezterm.ts key --pid <n> esc|enter|up|down|left|right|tab      press one key
 *   node src/lab/wezterm.ts read --pid <n> [--wait "CHECK"] [--timeout 120]     the screen as text, after the text shows
 *   node src/lab/wezterm.ts shot --pid <n> <file.png>                           capture the window, real pixels
 *   node src/lab/wezterm.ts record --pid <n> <run.gif> [--send <line>] [--seconds 20] [--fps 4]
 *   node src/lab/wezterm.ts close --pid <n>                                     close the window
 *
 * Every window is its own: `open` prints its pid and every other command must name it, so agents working in parallel
 * never type into, read, or close each other's window. Runs in a throwaway coach home (keys copied, sign-in shared)
 * unless --real-home. Windows and macOS: `shot` and `record` capture through PrintWindow on Windows and `screencapture` on
 * macOS, which needs Screen Recording allowed for the terminal (for sshd-keygen-wrapper when driven over SSH).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findWezterm } from "../../bin/coach.mjs";
import { labHome } from "./lab-home.ts";
import { captureWindow } from "../window-shot.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const KEYS: Record<string, string> = { esc: "\x1b", enter: "\r", tab: "\t", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D" };

const [command, ...argv] = process.argv.slice(2);
const flag = (name: string) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv.splice(index, 2)[1] : undefined;
};
/**
 * A typed line, however the shell delivered it: PowerShell (under `just`) splits a quoted line into words, and Git Bash
 * first rewrites a leading /word into "C:/Program Files/Git/word". `after` names the flag the line follows (its words
 * run to the next --flag); without it, the line is every word left.
 */
const line = (after?: string) => {
	const start = after ? argv.indexOf(after) : 0;
	if (start < 0) return undefined;
	const end = argv.findIndex((word, index) => index > start && word.startsWith("--"));
	const words = argv.splice(start, (end < 0 ? argv.length : end) - start).slice(after ? 1 : 0);
	// ponytail: Git Bash's path rewrite undone by its one known prefix; MSYS_NO_PATHCONV=1 avoids it at the source.
	return words.length ? words.join(" ").replace(/^[A-Za-z]:\/Program Files\/Git\//, "/") : undefined;
};
const has = (name: string) => {
	const index = argv.indexOf(name);
	return index >= 0 && argv.splice(index, 1).length > 0;
};
const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const gui = findWezterm() ?? fail("WezTerm is not installed (npm run setup installs it).");
/** The window this call works on: the one `open` started, else the --pid it printed. Never a guess. */
const scoped = ["send", "key", "read", "shot", "record", "close"].includes(command ?? "");
let window = scoped ? Number(flag("--pid") ?? fail(`${command} needs --pid <n>, the pid \`open\` printed.`)) : 0;
const socket = (pid: number) => join(homedir(), ".local", "share", "wezterm", `gui-sock-${pid}`);
const pid = () => window;

const mac = process.platform === "darwin";

/** One `wezterm cli` call against this window's GUI socket; --no-auto-start so a missing window never spawns a mux server. */
function cli(args: string[], window = pid()) {
	const result = spawnSync(join(dirname(gui), mac ? "wezterm" : "wezterm.exe"), ["cli", "--no-auto-start", ...args], {
		encoding: "utf8",
		timeout: 10_000,
		env: { ...process.env, WEZTERM_UNIX_SOCKET: socket(window) },
	});
	return { ok: result.status === 0, out: result.stdout ?? "" };
}

/** The window's pane, or undefined while WezTerm is still starting (its socket not up yet). */
const paneOf = () => JSON.parse(cli(["list", "--format", "json"]).out || "[]")[0]?.pane_id as number | undefined;
const pane = () => paneOf() ?? fail("The window has no pane.");
const screen = () => {
	const id = paneOf();
	return id === undefined ? "" : cli(["get-text", "--pane-id", String(id)]).out.split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
};
// Asked of WezTerm itself: the socket is an AF_UNIX file, which existsSync cannot see on Windows.
if (scoped && !cli(["list"]).ok) fail(`No coach window with pid ${window}: open one with \`open\`.`);
const type = (text: string) => cli(["send-text", "--no-paste", "--pane-id", String(pane()), text]).ok || fail("Could not type into the window.");

/** The window's pixels through the shared capture (src/window-shot.ts); a failure ends the lab call with its cause. */
const capture = (file: string, count: number, everyMs: number) => captureWindow(pid(), file, count, everyMs).catch((error) => fail(String(error?.message ?? error)));

async function waitFor(text: string, seconds: number) {
	for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(1000)) if (screen().includes(text)) return true;
	return false;
}

if (command === "open") {
	// After `--`, a lab script runs in the coach's window instead of the coach; the window holds once it exits.
	const dashes = argv.indexOf("--");
	const run = dashes >= 0 ? argv.splice(dashes).slice(1) : undefined;
	const ready = flag("--wait") ?? "VOXREN COACH";
	const home = has("--real-home") ? undefined : labHome(join(mkdtempSync(join(tmpdir(), "voxren-wezterm-")), "home"));
	const extra: string[] = [];
	for (let set = flag("--env"); set; set = flag("--env")) extra.push(set);
	const env = [...(home ? [`VOXREN_COACH_HOME=${home}`] : []), ...extra];
	const fontSize = flag("--font-size");
	const size = [`initial_cols=${flag("--cols") ?? 120}`, `initial_rows=${flag("--rows") ?? 36}`, ...(fontSize ? [`font_size=${fontSize}`] : []), ...(run ? ['exit_behavior="Hold"'] : [])].flatMap((value) => ["--config", value]);
	const program = run?.length ? run : [process.execPath, join(REPO, "bin", "coach.mjs")];
	const args = (prefix: string[]) => ["--config-file", join(REPO, "terminal", "wezterm.lua"), ...size, "start", "--always-new-process", "--cwd", REPO, "--", ...prefix, ...program];
	if (mac) {
		// LaunchServices starts it in the logged-in GUI session (spawned straight from an SSH session it never reaches the
		// window server) with launchd's environment, not this one: PATH and the coach home go through `env`.
		const wezPids = () => spawnSync("pgrep", ["-x", "wezterm-gui"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
		const before = new Set(wezPids());
		spawnSync("open", ["-n", "-a", gui.replace(/\/Contents\/MacOS\/.*$/, ""), "--args", ...args(["env", `PATH=${process.env.PATH ?? ""}`, ...env])]);
		for (let tries = 0; !window && tries < 20; tries++, await sleep(500)) window = wezPids().find((id) => !before.has(id)) ?? 0;
		if (!window) fail("WezTerm did not start.");
	} else {
		const child = spawn(gui, args([]), { detached: true, stdio: "ignore", env: { ...process.env, ...Object.fromEntries(env.map((set) => [set.slice(0, set.indexOf("=")), set.slice(set.indexOf("=") + 1)])) } });
		child.unref();
		window = child.pid ?? fail("WezTerm did not start.");
	}
	if (!(await waitFor(ready, 30))) fail(`"${ready}" did not show within 30 s.`);
	console.log(`pid ${window}\n  ${home ? `home ${home}` : "real home"}; pass --pid ${window} to every other command`);
} else if (command === "send") {
	type(`${line() ?? fail("send needs a line.")}\r`);
} else if (command === "key") {
	type(KEYS[argv[0] ?? ""] ?? fail(`key is one of ${Object.keys(KEYS).join(", ")}.`));
} else if (command === "read") {
	const wait = flag("--wait");
	if (wait && !(await waitFor(wait, Number(flag("--timeout") ?? 120)))) console.error(`"${wait}" did not show; the screen as it is:`);
	console.log(screen());
} else if (command === "shot") {
	const out = argv[0] ?? fail("shot needs a file.");
	console.log(`shot: ${out} (${await capture(out, 1, 0)})`);
} else if (command === "record") {
	// Frames on a timer while the coach works, then a GIF: catches what only shows mid-run (spinners, a doubled row).
	const out = argv[0] ?? fail("record needs a .gif file.");
	const seconds = Number(flag("--seconds") ?? 20);
	const fps = Number(flag("--fps") ?? 4);
	const send = line("--send");
	const frames = out.replace(/\.gif$/i, "-frames");
	rmSync(frames, { recursive: true, force: true });
	const recording = capture(join(frames, "frame-%04d.png"), Math.round(seconds * fps), 1000 / fps);
	if (send) {
		await sleep(1500); // PowerShell's start-up: a few frames of the screen as it was before the line goes in
		type(`${send}\r`);
	}
	const size = await recording;
	const gif = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(frames, "frame-%04d.png"), "-vf", "scale=iw/2:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", out], { encoding: "utf8" });
	if (gif.status !== 0) fail(`ffmpeg: ${gif.stderr || gif.error?.message}`);
	// The contact sheet: every 4th frame, 36 to a page, so one look covers the run; read single frames where it looks off.
	const sheet = out.replace(/\.gif$/i, "-sheet-%d.png");
	spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(frames, "frame-%04d.png"), "-vf", "select='not(mod(n\\,4))',scale=420:-1,tile=6x6", sheet], { encoding: "utf8" });
	console.log(`record: ${out} (${size}, ${Math.round(seconds * fps)} frames at ${fps} fps)\n  frames: ${frames}\n  sheets: ${sheet.replace("%d", "1")}…`);
} else if (command === "close") {
	cli(["kill-pane", "--pane-id", String(pane())]);
} else fail("Usage: node src/lab/wezterm.ts open | send --pid <n> <line> | key --pid <n> <name> | read --pid <n> [--wait <text>] | shot --pid <n> <file.png> | record --pid <n> <run.gif> | close --pid <n>");
