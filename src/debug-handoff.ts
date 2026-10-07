import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvent, redactSecrets } from "./coach-log";
import { SECRET_ENV_NAMES } from "./launch-secrets.mjs";
import { COACH_YAML, fillTemplate } from "./contracts";
import { coachHomePath } from "./exchange-log";
import { stripTerminalControl } from "./policy";
import { captureWindow, paneText, wezWindow } from "./window-shot";

/**
 * `/report [note]`: hands this coach session to a Claude Code session that starts working at once. The session's runs
 * (`exchanges.ndjson`), log lines (`coach.log.ndjson`), a picture and the text of the coach's own WezTerm window, and the
 * checkout's team state (branch, worktrees, uncommitted files, open PRs) go into one folder in the coach home, and
 * `claude --bg` starts in this checkout on `prompts.debug` (coach.yaml). The prompt carries the note, the newest run, the
 * screen text, and the team state itself, so the session starts on them without opening a file; the bundle holds the rest.
 * A background session is an ordinary Claude Code session: `claude attach <id>` opens it, `claude agents` lists it,
 * and other sessions on the machine see it. Never a model turn of the coach's own.
 */
// Not "debug" or "bug": Pi answers `/debug` (it writes pi-debug.log) and `/bug [text]` (a report to the Pi developers)
// itself, before any extension command is looked up. src/e2e/coach.test.ts holds Pi's built-in names.
export const DEBUG_COMMAND = "report";
export const DEBUG_COMMAND_DESCRIPTION = "Hand this session (its runs, tool results, log lines, a picture of this window, and your note) to a Claude Code session that starts debugging at once";
export const DEBUG_NOTHING_MESSAGE = "Nothing to debug yet: this session has no finished run. Run a command first, or say what is wrong: /report <what looks wrong>";
export const DEBUG_NO_HOME_MESSAGE = "/report needs the coach home, which only the launcher sets. Start the coach with `coach`.";

/** The newest runs of the session a bundle carries; older ones stay in exchanges.ndjson, which the bundle names. */
const MAX_EXCHANGES = 10;
const MAX_LOG_LINES = 200;
/** How long `claude --bg` gets to print its id; it returns in a few seconds once its background service is up. */
const START_TIMEOUT_MS = 30_000;
/** After the launcher exits, how long its last output gets to arrive before the wait ends without "close". */
const EXIT_GRACE_MS = 500;
/** Bundle folders kept in the coach home's `debug` folder; older ones are deleted when a new one is written. */
const MAX_BUNDLES = 10;
/**
 * What the prompt carries inline, in characters. The prompt is one command-line argument, and Windows caps a whole
 * command line at 32,767 characters: these leave room for the template and for quotes escaped on the way.
 */
const PROMPT_NEWEST = 10_000;
const PROMPT_SCREEN = 5_000;
const PROMPT_TEAM = 2_500;

export const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));

export interface DebugBundle {
	note: string;
	createdAt: string;
	sessionId?: string;
	/** What the coach showed beside the transcript when the player asked: the League client state and the header's notices. */
	state: unknown;
	/** The coach window as the player saw it: its picture (a PNG beside the bundle) and its text, or why there is none. */
	window?: WindowLook;
	/** The checkout as every session shares it: branch, worktrees, uncommitted files, open PRs. */
	team?: string;
	/** Where the whole record lives, for what the bundle leaves out. */
	files: { exchanges?: string; log?: string };
	/** This session's runs, newest first; a system prompt equal to the newest run's is left out of the older ones. */
	exchanges: Array<Record<string, unknown>>;
	/** This session's log lines, oldest first. */
	log: unknown[];
}

/** The lines of an NDJSON file that belong to `sessionId`, parsed; a line that does not parse is skipped (a run cut off mid-write). */
function sessionLines(text: string, sessionId: string | undefined, max: number): Array<Record<string, unknown>> {
	if (!sessionId) return [];
	const rows: Array<Record<string, unknown>> = [];
	for (const line of text.split("\n")) {
		// A cheap test before the parse: the exchange log holds every session's runs, tool results included.
		if (!line.includes(sessionId)) continue;
		try {
			const row = JSON.parse(line);
			if (row?.sessionId === sessionId) rows.push(row);
		} catch {
			// A half-written last line is routine while another coach appends; the rest of the file still reads.
		}
	}
	return rows.slice(-max);
}

export function buildDebugBundle(input: { note: string; sessionId?: string; state?: unknown; exchangesText?: string; logText?: string; files?: DebugBundle["files"]; now?: Date }): DebugBundle {
	const exchanges = sessionLines(input.exchangesText ?? "", input.sessionId, MAX_EXCHANGES).reverse();
	const systemPrompt = exchanges[0]?.systemPrompt;
	return {
		note: input.note,
		createdAt: (input.now ?? new Date()).toISOString(),
		sessionId: input.sessionId,
		state: input.state,
		files: input.files ?? {},
		exchanges: exchanges.map((exchange, index) => (index > 0 && exchange.systemPrompt === systemPrompt ? { ...exchange, systemPrompt: "(same as the newest run's)" } : exchange)),
		log: sessionLines(input.logText ?? "", input.sessionId, MAX_LOG_LINES),
	};
}

/**
 * The environment Claude Code starts in: the player's own, not the coach's. The launcher gives Pi an isolated HOME and
 * the coach's keys, so this is an allowlist built around the real home folder; no key the coach holds crosses over.
 */
export function claudeEnvironment(environment: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform, home: string = userInfo().homedir): Record<string, string> {
	const pass = ["PATH", "TERM", "COLORTERM", "LANG", ...(platform === "win32" ? ["SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP", "USERNAME", "USERDOMAIN", "COMSPEC", "PATHEXT"] : ["USER", "LOGNAME", "SHELL", "TMPDIR"])];
	const kept = Object.fromEntries(pass.filter((name) => environment[name]).map((name) => [name, environment[name] as string]));
	if (platform !== "win32") return { ...kept, HOME: home };
	// Without PATHEXT, `gh` cannot find git.exe (a /report session hit this when the coach's own environment lacked it).
	kept.PATHEXT ||= ".COM;.EXE;.BAT;.CMD";
	// The launcher passes neither folder; both sit at their standard place under the profile.
	return { ...kept, HOME: home, USERPROFILE: home, APPDATA: win32.join(home, "AppData", "Roaming"), LOCALAPPDATA: win32.join(home, "AppData", "Local") };
}

/** Runs one command to its end and gives back what it printed. Tests pass their own. */
export type RunCommand = (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => Promise<{ code: number | null; output: string }>;

/**
 * The launcher (`claude --bg`) starts a background service that can keep these pipes open after the launcher itself is
 * gone, so "close" may never come: the launcher's exit ends the wait, with a moment for its last output to arrive, and
 * the deadline rejects instead of hanging.
 */
export const runCommand = (command: string, args: string[], options: { cwd: string; env: Record<string, string> }, timeoutMs = START_TIMEOUT_MS): Promise<{ code: number | null; output: string }> =>
	new Promise((resolve, reject) => {
		const child = nodeSpawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let output = "";
		let grace: ReturnType<typeof setTimeout> | undefined;
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		const finish = (settle: () => void) => {
			clearTimeout(deadline);
			clearTimeout(grace);
			child.stdout.destroy();
			child.stderr.destroy();
			settle();
		};
		const deadline = setTimeout(() => {
			child.kill();
			finish(() => reject(new Error(`\`claude --bg\` gave no answer in ${Math.round(timeoutMs / 1000)} seconds`)));
		}, timeoutMs);
		child.on("error", (error) => finish(() => reject(error)));
		child.on("exit", (code) => (grace = setTimeout(() => finish(() => resolve({ code, output })), EXIT_GRACE_MS)));
		child.on("close", (code) => finish(() => resolve({ code, output })));
	});

export type DebugStart = { ok: true; id: string; bundlePath: string; noPicture?: string } | { ok: false; message: string };

export interface WindowLook {
	/** The PNG of the window, beside the bundle. */
	picture?: string;
	/** The pane's text as WezTerm holds it. */
	screen?: string;
	/** Why there is no picture, in words for the player. */
	missing?: string;
}

/** The coach's own window, pictured into `dir`: only when the coach runs in its WezTerm window, whose variables name it. */
export async function lookAtWindow(environment: Record<string, string | undefined>, dir: string, join: (...parts: string[]) => string): Promise<WindowLook> {
	const window = wezWindow(environment);
	if (!window) return { missing: "the coach is not running in its WezTerm window (`just coach` opens it there)" };
	const screen = paneText(window) || undefined;
	const picture = join(dir, "window.png");
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		await captureWindow(window.pid, picture);
		return { picture, screen };
	} catch (error) {
		logEvent("warn", "debug-handoff", "picture-failed", { pid: window.pid }, error);
		return { screen, missing: `the capture failed: ${oneLine(String((error as Error)?.message ?? error)).slice(0, 160)}` };
	}
}

/**
 * The checkout as other sessions see it, run in the player's environment (`gh` signs in from the real home). A command
 * that fails says so in its place: the debug session learns what it could not see, not nothing.
 */
export function teamState(repo: string, env: Record<string, string>): string {
	const run = (command: string, args: string[]) => {
		const result = spawnSync(command, args, { cwd: repo, env, encoding: "utf8", timeout: 10_000, windowsHide: true });
		return result.status === 0 ? (result.stdout ?? "").trimEnd() || "(none)" : `(${command} ${args[0]} failed: ${oneLine(result.stderr || String(result.error?.message ?? "")).slice(0, 120)})`;
	};
	return [
		`Branch: ${run("git", ["branch", "--show-current"])} at ${run("git", ["log", "-1", "--format=%h %s"])}`,
		`Worktrees:\n${run("git", ["worktree", "list"])}`,
		`Uncommitted here:\n${run("git", ["status", "--short"])}`,
		`Open PRs:\n${run("gh", ["pr", "list", "--limit", "10"])}`,
	].join("\n");
}

/** Text cut to `max` characters, saying where the rest is. */
const cut = (text: string, max: number, rest: string) => (text.length > max ? `${text.slice(0, max)}\n… (cut here; the rest is ${rest})` : text);

/** `claude --bg` prints "backgrounded · <id> · <name>". */
const BACKGROUND_ID = /backgrounded\s+\S\s+([0-9a-f]{6,})/;

/** Text from outside (the player's note, Claude Code's own output) as one clean line: no escape sequence, control character, or newline. */
const oneLine = (text: string) => stripTerminalControl(text).replace(/\s+/g, " ").trim();

/** The bundle folders past the newest `MAX_BUNDLES`, deleted: each holds a session's runs, and none is needed once its debug session has read it. */
function pruneBundles(debugDir: string, join: (...parts: string[]) => string): void {
	try {
		// Names are ISO timestamps, so name order is age order.
		for (const name of readdirSync(debugDir).sort().slice(0, -MAX_BUNDLES)) rmSync(join(debugDir, name), { recursive: true, force: true });
	} catch (error) {
		logEvent("warn", "debug-handoff", "prune-failed", { debugDir }, error);
	}
}

/**
 * Where the debug session starts: the repository's main working tree, never a linked worktree such as `dev`. A Claude
 * Code session started inside `.claude/worktrees/<name>` can take that worktree for its own and remove it when it ends
 * (seen 2026-10-06: the `dev` worktree the coach ran from was gone 27 s after its debug session finished).
 */
export function mainCheckout(repo: string): string {
	const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8", timeout: 10_000, windowsHide: true });
	const common = result.status === 0 ? (result.stdout ?? "").trim() : "";
	const path = common.includes("\\") || /^[A-Za-z]:/.test(common) ? win32 : posix;
	return common ? path.dirname(common) : repo;
}

export async function startDebugSession(
	environment: Record<string, string | undefined>,
	input: { note: string; sessionId?: string; state?: unknown },
	deps: {
		run?: RunCommand;
		readText?: (path: string) => string;
		writeText?: (path: string, text: string) => void;
		exists?: (path: string) => boolean;
		look?: (dir: string) => Promise<WindowLook>;
		team?: (repo: string, env: Record<string, string>) => string;
		/** The folder Claude Code starts in, from the coach's checkout. */
		startIn?: (repo: string) => string;
		now?: Date;
		platform?: NodeJS.Platform;
		home?: string;
		repo?: string;
	} = {},
): Promise<DebugStart> {
	const debugDir = coachHomePath(environment, "debug");
	if (!debugDir) return { ok: false, message: DEBUG_NO_HOME_MESSAGE };
	const path = debugDir.includes("\\") ? win32 : posix;
	const readText =
		deps.readText ??
		((file: string) => {
			if (!existsSync(file)) return "";
			try {
				return readFileSync(file, "utf8");
			} catch (error) {
				logEvent("warn", "debug-handoff", "read-failed", { file }, error);
				return "";
			}
		});
	const files = { exchanges: coachHomePath(environment, "exchanges.ndjson"), log: coachHomePath(environment, "coach.log.ndjson") };
	const bundle = buildDebugBundle({ ...input, files, now: deps.now, exchangesText: readText(files.exchanges as string), logText: readText(files.log as string) });
	if (!bundle.exchanges.length && !input.note) return { ok: false, message: DEBUG_NOTHING_MESSAGE };
	// A folder per run: the debug session is given this one bundle, never an earlier session's.
	const runDir = path.join(debugDir, bundle.createdAt.replace(/[:.]/g, "-"));
	const bundlePath = path.join(runDir, "bundle.json");
	const repo = deps.repo ?? REPO_DIR;
	const platform = deps.platform ?? process.platform;
	const env = claudeEnvironment(environment, platform, deps.home);
	const note = oneLine(input.note);
	try {
		// The window first: it is pictured as the player left it, before anything else is written or started.
		bundle.window = await (deps.look ?? ((dir) => lookAtWindow(environment, dir, path.join)))(runDir);
		bundle.team = (deps.team ?? teamState)(repo, env);
		const { systemPrompt: _systemPrompt, ...newest } = bundle.exchanges[0] ?? {};
		const prompt = fillTemplate(COACH_YAML.prompts.debug, {
			note: note || "(none given)",
			bundle: bundlePath,
			repo,
			runs: String(bundle.exchanges.length),
			picture: bundle.window.picture ? `A picture of the coach window when the player typed /report: ${bundle.window.picture}. Look at it first.` : `No picture of the coach window: ${bundle.window.missing}.`,
			screen: cut(bundle.window.screen ?? "(not available)", PROMPT_SCREEN, "window.screen in the bundle"),
			newest: bundle.exchanges.length ? cut(JSON.stringify(newest), PROMPT_NEWEST, "exchanges[0] in the bundle") : "(no finished run)",
			team: cut(bundle.team, PROMPT_TEAM, "team in the bundle"),
		});
		// The shared redaction for key-shaped text, then every key this process holds by value: a provider key echoed bare (a 401 naming the header) has no shape to match.
		let text = redactSecrets(JSON.stringify(bundle, null, "\t"));
		for (const name of SECRET_ENV_NAMES) {
			const value = environment[name];
			if (value && value.length >= 8) text = text.split(JSON.stringify(value).slice(1, -1)).join("[redacted]");
		}
		text += "\n";
		if (deps.writeText) deps.writeText(bundlePath, text);
		else {
			mkdirSync(runDir, { recursive: true, mode: 0o700 });
			writeFileSync(bundlePath, text, { mode: 0o600 });
			pruneBundles(debugDir, path.join);
		}
		const name = `coach debug${note ? `: ${note.slice(0, 40)}` : ""}`;
		// --add-dir: the bundle sits outside the checkout, and only its own folder is opened, never the coach home with its key stores.
		// The "--" matters: --add-dir takes any number of folders, and without it the prompt is read as one more and the session starts with none.
		const result = await (deps.run ?? runCommand)("claude", ["--bg", "--name", name, "--add-dir", runDir, "--", prompt], { cwd: (deps.startIn ?? mainCheckout)(repo), env });
		const id = BACKGROUND_ID.exec(result.output)?.[1];
		if (result.code === 0 && id) return { ok: true, id, bundlePath, ...(bundle.window.missing ? { noPicture: bundle.window.missing } : {}) };
		logEvent("error", "debug-handoff", "start-failed", { code: result.code, output: result.output });
		// Claude Code's own last line, to the player's terminal: cleaned and cut like any text from outside.
		const said = oneLine(result.output.trim().split("\n").at(-1) ?? "").slice(0, 200) || "no output";
		return { ok: false, message: `Claude Code did not start a debug session (exit ${result.code}): ${said}. The context is saved at ${bundlePath}.` };
	} catch (error) {
		logEvent("error", "debug-handoff", "start-failed", { bundlePath }, error);
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return { ok: false, message: `/report failed: ${oneLine(String((error as Error)?.message ?? error)).slice(0, 200)}` };
		// npm's Claude Code on Windows is claude.cmd, which starts only through a shell; the note and the prompt are arguments, so no shell is used.
		const npmInstall = platform === "win32" && (environment.PATH ?? "").split(";").some((dir) => dir && (deps.exists ?? existsSync)(win32.join(dir, "claude.cmd")));
		const fix = npmInstall ? "Claude Code here is the npm install (claude.cmd), which /report cannot start. Install the native build with `claude install`" : "/report needs Claude Code on PATH (the `claude` command): install it";
		return { ok: false, message: `${fix}, then run /report again. The context is saved at ${bundlePath}.` };
	}
}
