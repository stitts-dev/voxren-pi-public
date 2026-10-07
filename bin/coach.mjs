#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { stashSecrets } from "../src/launch-secrets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const COACH_DIR = resolve(HERE, "..");
export const EXTENSION = join(COACH_DIR, "src", "index.ts");
export const THEMES_DIR = join(COACH_DIR, "themes");
export const TERMINAL_DIR = join(COACH_DIR, "terminal");
export const DEFAULT_ENV_FILE = join(coachHome(), ".env");
// Defaults come from coach.yaml, the single home for prompts and agent config.
/** @type {import("../src/contracts.ts").CoachYaml} */
const COACH_YAML = parseYaml(readFileSync(join(COACH_DIR, "coach.yaml"), "utf8"));
export const DEFAULT_PROVIDER = COACH_YAML.agent.provider;
export const DEFAULT_MODEL_ID = COACH_YAML.agent.model;
export const DEFAULT_MODELS = COACH_YAML.agent.models;
export const DEFAULT_THEME = COACH_YAML.agent.theme;
// API-key env per provider. OAuth providers (openai-codex = ChatGPT/Codex plan) sign in once with /login inside the coach.
/** @type {Record<string, string>} */
export const PROVIDER_KEY_ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" };
export const TOOLS = COACH_YAML.agent.tools;
// The only values the coach reads; nothing else from the env file reaches Pi.
export const FORWARDED_ENV = [...Object.values(PROVIDER_KEY_ENV), "PERPLEXITY_API_KEY", "BRAVE_API_KEY", "TYPESAFE_API_KEY", "GEMINI_API_KEY", "VOXREN_RESEARCH_URL", "VOXREN_RESEARCH_TOKEN", "VOXREN_COACH_ACCOUNTS", "VOXREN_COACH_PROVIDER", "VOXREN_COACH_MODEL", "VOXREN_COACH_CHAMPION", "VOXREN_COACH_LANE", "VOXREN_COACH_THEME", "VOXREN_COACH_THINKING", "VOXREN_COACH_IDLE_FILE", "VOXREN_COACH_TURN_TIMEOUT_MS", "VOXREN_LCU_REPLAY", "VOXREN_LCU_REPLAY_STEP_MS", "VOXREN_LCU_RECORD", "VOXREN_COACH_AUTO_COMP", "VOXREN_COACH_CARD_DETAIL"];
// Only these three get a third precedence tier (env > .env > key store); Riot has no env/.env tier by
// design (AGENTS.md rule 4). Keyed by env var name -> the key-helper's SECRETS registry id.
export const STORE_BACKED_ENV = { PERPLEXITY_API_KEY: "perplexity", TYPESAFE_API_KEY: "typesafe", GEMINI_API_KEY: "gemini" };
const SECRET_HELPER_PATH = join(COACH_DIR, "src", "riot-key-helper.mjs");
// A locked macOS Keychain or a slow DPAPI call must not block a headless launch. The helper ends its own
// key-store child at 2.5 s (READ_DEADLINE_MS) and answers `timeout`; this kill is only for a helper that hung
// itself, so it sits well past that deadline and is SIGKILL: the helper's children are already gone by then.
const SECRET_HELPER_TIMEOUT_MS = 5000;
// Pi's stock startup chrome advertises shell and coding-agent help; the extension replaces it.
export const PI_SETTINGS = { quietStartup: true, hideThinkingBlock: false };
export const USAGE = `Usage: coach [-c | --continue] [-r | --resume] [-p | --print "<question>"]

  (no args)     open the coach
  -c            continue the last conversation
  -r            pick a past conversation
  -p "<text>"   ask once and print the answer (a /command works too)

The coach opens in its own terminal, WezTerm, when it is installed (npm run setup
installs it), so pictures draw the same everywhere. VOXREN_COACH_TERMINAL=here keeps it in this one.

Keys are read from ${DEFAULT_ENV_FILE} (override with VOXREN_COACH_ENV_FILE):
  VOXREN_COACH_THEME=tidal|hextech|void|signal   look (default tidal; /settings switches it for one session)
  BRAVE_API_KEY or PERPLEXITY_API_KEY (optional keyed web search), VOXREN_COACH_ACCOUNTS=Name#TAG (player audit),
  TYPESAFE_API_KEY (Jev screen), VOXREN_COACH_CHAMPION (default Fizz),
  GEMINI_API_KEY (Gemini reads YouTube videos instead of scraping captions),
  VOXREN_COACH_LANE=top|jungle|mid|bot|support (default: the client's role, else the champion's usual lane),
  VOXREN_COACH_PROVIDER / VOXREN_COACH_MODEL (default ${DEFAULT_PROVIDER} / ${DEFAULT_MODEL_ID}),
  VOXREN_COACH_THINKING=low|medium|high (Pi's default when unset),
  VOXREN_COACH_TURN_TIMEOUT_MS (default 180000; a turn past this aborts),
  VOXREN_COACH_AUTO_COMP=0|false|off (stop the automatic /pick and /draft calls in champ select; on by default),
  VOXREN_COACH_CARD_DETAIL=claims|full|brief (what Ctrl+O shows on a tool card; default claims).
The default provider signs in with your ChatGPT/Codex plan: run /login once inside the coach.`;

export class UsageError extends Error {}

/**
 * Allowlisted pass-through arguments only; the capability surface is fixed by the launcher.
 * @param {readonly string[]} argv
 */
export function parseArgs(argv) {
	/** @type {string[]} */
	const pass = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") return { help: true, version: false, pass: [] };
		if (arg === "-v" || arg === "--version") return { help: false, version: true, pass: [] };
		if (arg === "-c" || arg === "--continue" || arg === "-r" || arg === "--resume") pass.push(arg);
		else if (arg === "-p" || arg === "--print") {
			const text = argv.slice(index + 1).join(" ").trim();
			if (!text) throw new UsageError(`${arg} needs a question.`);
			pass.push("--print", text);
			break;
		} else throw new UsageError(`Unknown argument: ${arg}`);
	}
	return { help: false, version: false, pass };
}

/**
 * Minimal dotenv reader. Unlike node:util parseEnv, an unquoted `#` starts a comment only after
 * whitespace, so a Riot ID such as Name#TAG survives unquoted.
 * @param {string} text
 */
export function parseEnvFile(text) {
	/** @type {Record<string, string>} */
	const values = {};
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (!match) continue;
		const quoted = /^(['"])(.*?)\1(?:\s+#.*)?$/.exec(match[2]);
		values[match[1]] = quoted ? quoted[2] : match[2].replace(/\s+#.*$/, "");
	}
	return values;
}

/**
 * One `read` or `status` call to the key-store helper child, for `loadCoachEnv`'s third precedence
 * tier. `deps.spawn` mirrors `piCommand`'s injectable-dependency pattern (`spawnSync` in production, a
 * fake in tests) so this never shells out to a real Keychain/DPAPI from a unit test. A timeout or a
 * non-ok result reads as "absent" here, never a hang or a thrown error: a locked macOS Keychain must
 * not block a headless launch.
 */
/**
 * @typedef {object} SecretHelperResult
 * @property {true} ok
 * @property {{ stored?: boolean }} [state]
 * @property {string} [value]
 */
/**
 * @param {"read" | "status"} action
 * @param {string} secretId
 * @param {NodeJS.ProcessEnv} environment
 * @param {{ spawn?: typeof spawnSync, log?: (event: string, details: Record<string, string>) => void }} deps
 * @returns {SecretHelperResult | undefined}
 */
function askSecretHelper(action, secretId, environment, deps) {
	const spawn = deps.spawn ?? spawnSync;
	const log = deps.log ?? ((event, details) => appendLauncherLog(environment, event, details));
	/** @param {string} reason */
	const absent = (reason) => {
		// Only the reason code: the helper's stdout may be a key, so none of it is logged.
		if (reason !== "not_stored") log("secret_read_fallback", { secret: secretId, action, reason });
		return undefined;
	};
	let result;
	try {
		result = spawn(process.execPath, [SECRET_HELPER_PATH, action, secretId], { env: { ...riotKeyEnvironment(environment), VOXREN_SECRET_DEADLINE: "1" }, encoding: "utf8", timeout: SECRET_HELPER_TIMEOUT_MS, killSignal: "SIGKILL" });
	} catch {
		return absent("spawn_failed");
	}
	if (result?.error) return absent(/** @type {NodeJS.ErrnoException} */ (result.error).code === "ETIMEDOUT" ? "launcher_timeout" : "spawn_error");
	if (!result || !result.stdout) return absent("helper_failed");
	try {
		const parsed = JSON.parse(result.stdout);
		if (parsed?.ok === true) return parsed;
		return absent(typeof parsed?.reason === "string" && /^[a-z_]{1,40}$/.test(parsed.reason) ? parsed.reason : "unknown");
	} catch {
		return absent("bad_output");
	}
}

/**
 * One NDJSON line in the coach home's `coach.log.ndjson`, the file src/coach-log.ts writes. The launcher is plain
 * node and cannot load that TypeScript, so it appends a line of the same shape. Best effort: a launch never fails
 * because its log could not be written (the one catch here has nowhere left to log to).
 * ponytail: no rotation here; one short line per failed read per launch.
 * @param {NodeJS.ProcessEnv} environment
 * @param {string} event
 * @param {Record<string, string>} details
 */
function appendLauncherLog(environment, event, details) {
	try {
		const home = coachHome(environment);
		mkdirSync(home, { recursive: true, mode: 0o700 });
		appendFileSync(join(home, "coach.log.ndjson"), `${JSON.stringify({ ts: new Date().toISOString(), level: "warn", component: "launcher", event, details })}\n`);
	} catch {
		// the log is the last place to report to
	}
}

/**
 * Process env wins; the env file fills gaps; PERPLEXITY_API_KEY/TYPESAFE_API_KEY/GEMINI_API_KEY fall through once more to the key
 * store. Only FORWARDED_ENV names are read from env/file, and only the chosen provider's key is kept.
 * @param {NodeJS.ProcessEnv} [environment]
 * @param {(path: string) => string} [readFile]
 * @param {{ spawn?: typeof spawnSync, log?: (event: string, details: Record<string, string>) => void }} [deps]
 */
export function loadCoachEnv(environment = process.env, readFile = (path) => readFileSync(path, "utf8"), deps = {}) {
	const path = environment.VOXREN_COACH_ENV_FILE?.trim() || DEFAULT_ENV_FILE;
	/** @type {Record<string, string>} */
	let fromFile = {};
	try {
		fromFile = parseEnvFile(readFile(path));
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") throw new Error(`Could not read ${path}.`);
	}
	/** @type {Record<string, string>} */
	const values = {};
	for (const name of FORWARDED_ENV) {
		const value = environment[name]?.trim() || fromFile[name]?.trim();
		if (value) values[name] = value;
	}
	// Third tier, Perplexity/Typesafe/Gemini only (Riot has no env/.env tier to fall through from). Env or file
	// winning still asks the store, purely to detect shadowing; env and file both empty reads the store's
	// value. Either way the (source, shadow) pair is forwarded as VOXREN_KEY_SOURCE_<NAME>, decoded by
	// src/key-source.ts's resolveKeySource for src/index.ts's header note.
	for (const [name, secretId] of Object.entries(STORE_BACKED_ENV)) {
		const envTag = environment[name]?.trim() ? "env" : fromFile[name]?.trim() ? "dotenv" : undefined;
		const sourceVar = `VOXREN_KEY_SOURCE_${secretId.toUpperCase()}`;
		if (envTag) {
			const status = askSecretHelper("status", secretId, environment, deps);
			values[sourceVar] = status?.state?.stored ? `${envTag}+store` : envTag;
			continue;
		}
		const read = askSecretHelper("read", secretId, environment, deps);
		if (typeof read?.value === "string" && read.value) {
			values[name] = read.value;
			values[sourceVar] = "store";
		}
	}
	// Pi's own Google provider reads GEMINI_API_KEY and switches on when it is set, so Pi gets the key under the coach's own name.
	if (values.GEMINI_API_KEY) {
		values.VOXREN_GEMINI_API_KEY = values.GEMINI_API_KEY;
		delete values.GEMINI_API_KEY;
	}
	const provider = values.VOXREN_COACH_PROVIDER || DEFAULT_PROVIDER;
	for (const [name, keyEnv] of Object.entries(PROVIDER_KEY_ENV)) if (name !== provider) delete values[keyEnv];
	const keyEnv = PROVIDER_KEY_ENV[provider];
	if (keyEnv && !values[keyEnv]) throw new Error(`Voxren Coach on ${provider} needs ${keyEnv} in the environment or ${path}.`);
	return values;
}

export function coachHome(environment = process.env, platform = process.platform) {
	if (environment.VOXREN_COACH_HOME?.trim()) return environment.VOXREN_COACH_HOME.trim();
	// path.win32/posix (not the bare, host-dependent `join`/`dirname`) so a win32/linux branch
	// computes a real Windows/Linux path even under tests running on a macOS host.
	if (platform === "win32") return win32.join(environment.LOCALAPPDATA?.trim() || win32.join(homedir(), "AppData", "Local"), "voxren-coach");
	if (platform === "linux") return join(environment.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "voxren-coach");
	return join(homedir(), "Library", "Application Support", "voxren-coach");
}

/**
 * Stable per-user runtime: sessions persist; Pi runs under an isolated HOME so no personal Pi config leaks in.
 * The cwd sits in the per-user temp dir, outside the home tree, so ancestor `.pi` or `.agents` folders never
 * count as project resources (Pi would show a project-trust warning for them).
 * @typedef {ReturnType<typeof createRuntime>} Runtime
 */
export function createRuntime(base = coachHome(), cwdBase = tmpdir()) {
	const cwd = join(cwdBase, "voxren-coach-cwd");
	const agentDir = join(base, "pi-agent");
	const sessionDir = join(base, "sessions");
	for (const path of [cwd, agentDir, sessionDir, join(agentDir, "home")]) mkdirSync(path, { recursive: true, mode: 0o700 });
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(PI_SETTINGS, null, "\t")}\n`, { mode: 0o600 });
	// Pre-trust the cwd: on Windows the temp dir sits inside the profile, so the user's own ~/.agents/skills reads as a
	// project resource and Pi shows a trust notice every launch. Nothing loads from it anyway (--no-skills, --no-extensions).
	writeFileSync(join(agentDir, "trust.json"), `${JSON.stringify({ [realpathSync(cwd)]: true }, null, 2)}\n`, { mode: 0o600 });
	return { cwd, agentDir, sessionDir };
}

// The Riot key custodian needs a stable sanitized-state directory and, on macOS, the real login
// keychain; on Windows the key store is DPAPI-encrypted inside the coach home, no keychain env needed.
/**
 * @param {NodeJS.ProcessEnv} [environment]
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, string>}
 */
export function riotKeyEnvironment(environment = process.env, platform = process.platform) {
	// The sanitized state file lives in the coach home on every OS, so VOXREN_COACH_HOME moves it too.
	const stateDir = { VOXREN_RIOT_KEY_STATE_DIR: coachHome(environment, platform) };
	if (platform === "win32") return stateDir;
	const home = environment.HOME?.trim();
	if (!home) return {};
	return { VOXREN_RIOT_KEYCHAIN: posix.join(home, "Library", "Keychains", "login.keychain-db"), ...stateDir };
}

// Terminal identity only (no secrets): what pi-tui's capability detection reads, plus its explicit overrides, and the
// WezTerm window's socket and folder, which /report reads to picture the coach's own window (src/window-shot.ts).
export const TERMINAL_ENV = ["TERM_PROGRAM", "WARP_SESSION_ID", "WARP_TERMINAL_SESSION_UUID", "KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "WEZTERM_PANE", "WEZTERM_UNIX_SOCKET", "WEZTERM_EXECUTABLE_DIR", "ITERM_SESSION_ID", "WT_SESSION", "TERMINAL_EMULATOR", "TMUX", "PI_IMAGE_PROTOCOL", "PI_FORCE_IMAGE_PROTOCOL", "PI_TRUE_COLOR", "PI_HYPERLINKS", "PI_TUI_WRITE_LOG"];

/**
 * Pi-tui turns Kitty images on for Warp everywhere, but Warp draws inline images only on macOS and Linux
 * (docs.warp.dev, Files, Links & Scripts). On Windows the card would reserve blank rows, so ask for the text charts.
 * An explicit PI_IMAGE_PROTOCOL still wins.
 */
export function imageProtocolOverride(environment = process.env, platform = process.platform) {
	if (environment.PI_IMAGE_PROTOCOL) return {};
	const warp = environment.TERM_PROGRAM === "WarpTerminal" || environment.WARP_SESSION_ID || environment.WARP_TERMINAL_SESSION_UUID;
	if (platform === "win32" && warp) return { PI_IMAGE_PROTOCOL: "none" };
	// Pi-tui picks Kitty for WezTerm, but on Windows ConPTY drops Kitty's APC sequences. The iTerm2 way gets through,
	// and WezTerm takes it on every platform, so macOS and Windows draw pictures the same way.
	return environment.WEZTERM_PANE ? { PI_IMAGE_PROTOCOL: "iterm2" } : {};
}

/**
 * WezTerm's GUI binary: on Windows the installer's folder, else the first PATH entry that has it; on macOS the app
 * Homebrew's cask installs. Undefined when it is not installed.
 */
export function findWezterm(environment = process.env, exists = existsSync, platform = process.platform) {
	if (platform === "darwin") return ["/Applications/WezTerm.app/Contents/MacOS/wezterm-gui"].find((file) => exists(file));
	if (platform !== "win32") return undefined;
	const dirs = [win32.join(environment.ProgramFiles ?? "C:\\Program Files", "WezTerm"), ...(environment.Path ?? environment.PATH ?? "").split(";").filter(Boolean)];
	return dirs.map((dir) => win32.join(dir, "wezterm-gui.exe")).find((file) => exists(file));
}

/**
 * The coach's own terminal, so every machine draws it the same way: WezTerm with `terminal/wezterm.lua` on Windows and
 * macOS. Returns the command that reopens this launch there, or undefined to run in place: already in WezTerm, not a
 * terminal, `-p`, tmux, `VOXREN_COACH_TERMINAL=here` (tests and labs), or WezTerm is not installed.
 * @param {readonly string[]} argv
 * @param {{ environment?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, exists?: typeof existsSync, tty?: boolean }} [deps]
 * @returns {{ command: string, args: string[] } | undefined}
 */
export function ownTerminal(argv, deps = {}) {
	const { environment = process.env, platform = process.platform, exists = existsSync, tty = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = deps;
	if (!tty || argv.includes("-p") || argv.includes("--print") || environment.VOXREN_COACH_TERMINAL === "here" || environment.TMUX || environment.WEZTERM_PANE) return undefined;
	const wezterm = findWezterm(environment, exists, platform);
	return wezterm ? { command: wezterm, args: ["--config-file", join(TERMINAL_DIR, "wezterm.lua"), "start", "--always-new-process", "--cwd", COACH_DIR, "--", process.execPath, fileURLToPath(import.meta.url), ...argv] } : undefined;
}

// ponytail: duplicated in src/config.ts's sanitizeProfile, kept in sync by hand — no cross TS/JS import path here
// (bin/coach.mjs runs under plain Node; src/config.ts is TypeScript with no type-stripping guaranteed pre-23.6).
const THEME_NAMES = ["tidal", "hextech", "void", "signal"];

/** `<coach home>/profile.json`'s theme, if it's one of the four valid names; undefined otherwise or on any read/parse error. */
export function profileTheme(environment = process.env, platform = process.platform) {
	try {
		const theme = JSON.parse(readFileSync(join(coachHome(environment, platform), "profile.json"), "utf8")).theme;
		return THEME_NAMES.includes(theme) ? theme : undefined;
	} catch {
		return undefined;
	}
}

/**
 * @param {Runtime} runtime
 * @param {Record<string, string>} values
 * @param {readonly string[]} [pass]
 * @param {NodeJS.ProcessEnv} [environment]
 * @param {NodeJS.Platform} [platform]
 */
export function createPiInvocation(runtime, values, pass = [], environment = process.env, platform = process.platform) {
	const provider = values.VOXREN_COACH_PROVIDER || DEFAULT_PROVIDER;
	const model = values.VOXREN_COACH_MODEL || DEFAULT_MODEL_ID;
	// Pinned (src/index.ts's pinnedAtLaunch) on either override, not just VOXREN_COACH_MODEL: a
	// provider-only override still narrows to one model, so the gate and the launcher agree on
	// what Pi may offer -- otherwise Pi could cycle to a DEFAULT_MODELS id under the new provider
	// that the gate then aborts on.
	const models = values.VOXREN_COACH_MODEL || values.VOXREN_COACH_PROVIDER ? [model] : DEFAULT_MODELS;
	/** @type {Record<string, string | undefined>} */
	const childEnv = {
		PATH: environment.PATH ?? "",
		TERM: environment.TERM ?? "xterm-256color",
		COLORTERM: environment.COLORTERM ?? "",
		LANG: environment.LANG ?? "en_US.UTF-8",
		// Pi-tui picks image/hyperlink support from these; without them Warp/Kitty/WezTerm read as a plain console and images stay off.
		...Object.fromEntries(TERMINAL_ENV.filter((name) => environment[name]).map((name) => [name, environment[name]])),
		...imageProtocolOverride(environment, platform),
		HOME: join(runtime.agentDir, "home"),
		PI_CODING_AGENT_DIR: runtime.agentDir,
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		...riotKeyEnvironment(environment, platform),
		...values,
	};
	const args = [
		"--no-extensions",
		"--extension", EXTENSION,
		"--no-builtin-tools",
		"--tools", TOOLS.join(","),
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--theme", THEMES_DIR,
		"--use-theme", values.VOXREN_COACH_THEME || profileTheme(environment, platform) || DEFAULT_THEME,
		// No --no-approve: Pi reads it as "force untrusted" ahead of trust.json, which is what showed the trust notice every launch.
		"--session-dir", runtime.sessionDir,
		"--provider", provider,
		"--model", model,
		"--models", models.map((id) => `${provider}/${id}`).join(","),
		// Pi's thinking level for the run (off, minimal, low, medium, high, xhigh, max); Pi's own default when unset.
		...(values.VOXREN_COACH_THINKING ? ["--thinking", values.VOXREN_COACH_THINKING] : []),
		...pass,
	];
	return { args, childEnv };
}

/** Pi's entry script inside a global npm prefix; run with this Node so no shell ever sees the arguments. */
export const PI_CLI = win32.join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

/**
 * Pi installed next to this Node runtime, else (on Windows) the global npm prefix's copy, else the
 * copy beside any `pi.cmd` on PATH (a standalone Node install such as pi-node), all run through this
 * Node with no shell; bare `pi.cmd` is the last resort only, since cmd.exe re-splits the arguments
 * and a `-p` question arrives as one message per word. `deps` lets tests inject the filesystem
 * probe and npm-prefix lookup so all three platforms are covered from one machine.
 * @param {NodeJS.Platform} [platform]
 * @param {{ existsSync?: typeof existsSync, execPath?: string, npmPrefix?: () => string | undefined, env?: NodeJS.ProcessEnv }} [deps]
 */
export function piCommand(platform = process.platform, deps = {}) {
	const exists = deps.existsSync ?? existsSync;
	const execPath = deps.execPath ?? process.execPath;
	if (platform === "win32") {
		const npmPrefix = deps.npmPrefix ?? (() => spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", shell: true }).stdout?.trim());
		const env = deps.env ?? process.env;
		const pathDirs = (env.Path ?? env.PATH ?? "").split(";").filter(Boolean);
		const prefixes = [win32.dirname(execPath), npmPrefix() || win32.join(env.APPDATA ?? "", "npm"), ...pathDirs];
		for (const prefix of prefixes) {
			const cli = win32.join(prefix, PI_CLI);
			if (exists(cli)) return { command: execPath, prefix: [cli], shell: false };
		}
		return { command: "pi.cmd", prefix: [], shell: true };
	}
	const sibling = join(dirname(execPath), "pi");
	return exists(sibling) ? { command: execPath, prefix: [sibling], shell: false } : { command: "pi", prefix: [], shell: false };
}

/**
 * OAuth providers keep their sign-in in the coach's own agent dir, separate from any other Pi setup.
 * @param {Runtime} runtime
 * @param {string} provider
 */
export function signedIn(runtime, provider) {
	if (PROVIDER_KEY_ENV[provider]) return true;
	try {
		return provider in JSON.parse(readFileSync(join(runtime.agentDir, "auth.json"), "utf8"));
	} catch {
		return false;
	}
}

/**
 * `{ dir, branch }` for the checkout at `cwd`: `branch` is `<branch>@<short sha>`, "detached@<sha>"
 * when HEAD isn't on a branch, or undefined when this isn't a git checkout at all (a global npm
 * install has no `.git`) or the git binary isn't on PATH. `git describe --always --dirty` is the one
 * "short SHA" call: `--always` falls back to the abbreviated commit when there is no tag, and
 * `--dirty` appends a `-dirty` suffix on an uncommitted change, with no extra git call needed.
 * `deps.git(args)` mirrors piCommand's injectable-dependency pattern: a fake in tests, spawnSync in prod.
 * @param {string} cwd
 * @param {{ git?: (args: readonly string[]) => string | undefined }} [deps]
 */
export function checkoutInfo(cwd, deps = {}) {
	const git = deps.git ?? ((args) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout?.trim() || undefined);
	let branch;
	try {
		const ref = git(["rev-parse", "--abbrev-ref", "HEAD"]);
		const sha = git(["describe", "--always", "--dirty"]);
		if (ref && sha) branch = `${ref === "HEAD" ? "detached" : ref}@${sha}`;
	} catch {
		// non-git install: dir still prints below, branch stays undefined
	}
	return { dir: cwd, branch };
}

/** `coach --version`/`-v`: package version, checkout branch@sha, and the running checkout's path — no .env or sign-in needed. */
export function versionLine(deps = {}) {
	const version = JSON.parse(readFileSync(join(COACH_DIR, "package.json"), "utf8")).version;
	const { dir, branch } = checkoutInfo(COACH_DIR, deps);
	return `${version} · ${branch ?? "not a git checkout"} · ${dir}`;
}

/**
 * @param {string[]} [argv]
 * @param {{ pi?: { command: string, prefix: string[], shell: boolean } }} [deps]
 */
export function main(argv = process.argv.slice(2), deps = {}) {
	const { help, version, pass } = parseArgs(argv);
	if (help) return console.log(USAGE);
	if (version) return console.log(versionLine());
	const terminal = ownTerminal(argv);
	if (terminal) return spawn(terminal.command, terminal.args, { detached: true, stdio: "ignore" }).unref();
	const values = loadCoachEnv();
	const runtime = createRuntime();
	const provider = values.VOXREN_COACH_PROVIDER || DEFAULT_PROVIDER;
	if (!signedIn(runtime, provider)) {
		// Pi cannot show a sign-in flow in print mode and would wait with no model.
		if (pass.includes("--print")) throw new Error(`Not signed in to ${provider} yet. Run \`coach\`, type /login, pick "Sign in with an account", then restart the coach.`);
		console.error(`Not signed in to ${provider} yet: type /login in the coach, pick "Sign in with an account", then restart it.`);
	}
	const { args, childEnv } = createPiInvocation(runtime, values, pass);
	const pi = deps.pi ?? piCommand();
	// Keys travel in a 0600 file the extension reads and deletes, never in Pi's environment (issue #209).
	const stash = stashSecrets(childEnv, runtime.agentDir);
	return runPi(pi, args, { cwd: runtime.cwd, env: stash.env }).finally(stash.cleanup);
}

/**
 * Runs Pi with inherited stdio and forwards termination signals to it, so killing the launcher never orphans Pi
 * and its uv/uvicorn children. Resolves with Pi's exit code (1 when it ends by a signal) and re-raises that signal
 * on this process once Pi is gone. On Windows `kill` is a hard terminate and a console Ctrl+C already reaches the
 * whole process group, so SIGINT is only absorbed there (the launcher stays up until Pi exits), never forwarded.
 * @param {{ command: string, prefix: string[], shell: boolean }} pi
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 * @returns {Promise<void>}
 */
export function runPi(pi, args, options) {
	return new Promise((done, fail) => {
		// Windows, stdin not a terminal (ssh, a service, a pipe): an async child inheriting it makes Pi wait for an EOF that
		// never comes, where spawnSync's child did not. Print mode needs no stdin, so give it none there.
		const stdin = process.platform === "win32" && !process.stdin.isTTY ? "ignore" : "inherit";
		const child = spawn(pi.command, [...pi.prefix, ...args], { ...options, stdio: [stdin, "inherit", "inherit"], shell: pi.shell });
		/** @type {Record<string, () => void>} */
		const handlers = {};
		for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
			handlers[signal] = () => {
				if (!(signal === "SIGINT" && process.platform === "win32")) child.kill(signal);
			};
			process.on(signal, handlers[signal]);
		}
		const detach = () => {
			for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
		};
		child.on("error", (error) => {
			detach();
			fail(error);
		});
		child.on("close", (code, signal) => {
			detach();
			process.exitCode = code ?? 1;
			done();
			if (signal) process.kill(process.pid, signal);
		});
	});
}

/**
 * Coach processes a closed WezTerm window left behind: this checkout's launcher or Pi whose parent is gone (WezTerm
 * ends the launcher hard, so the launcher never forwards a signal and Pi is orphaned). A process whose parent is alive
 * is a window still in use and stays, as does anything that is not this checkout's coach. Only a node process counts:
 * the WezTerm window a launcher opens carries the coach's command line in its own and outlives that launcher, so
 * matching on the command line alone would end the new window, and the launcher inside it, at every launch.
 * @param {readonly { pid: number, ppid: number, cmd: string }[]} processes
 * @param {{ coachDir?: string, self?: number }} [options]
 */
export function staleCoachProcesses(processes, { coachDir = COACH_DIR, self = process.pid } = {}) {
	const norm = (/** @type {string} */ text) => text.replaceAll("/", "\\").toLowerCase();
	const dir = norm(coachDir);
	const alive = new Set(processes.map((entry) => entry.pid));
	const executable = (/** @type {string} */ cmd) => /^\s*(?:"([^"]*)"|(\S+))/.exec(cmd)?.slice(1).find(Boolean) ?? "";
	return processes.filter((entry) => entry.pid !== self && !alive.has(entry.ppid) && /(?:^|[\\/])node(?:\.exe)?$/i.test(executable(entry.cmd)) && norm(entry.cmd).includes(dir) && /coach\.mjs|pi-coding-agent|src[\\/]index\.ts/i.test(entry.cmd));
}

/** Ends this checkout's orphaned coach processes (Windows) before a launch. Never fatal and never touches the League client. */
export function sweepStaleCoach(platform = process.platform, environment = process.env) {
	if (platform !== "win32") return;
	const listing = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 });
	if (listing.status !== 0) return void console.error(`Could not look for old coach processes: ${listing.error?.message ?? `powershell exited ${listing.status}`}`);
	// a process whose command line carries a control character gives a listing JSON.parse refuses; the sweep is best effort, the launch is not
	let rows;
	try {
		rows = [JSON.parse(listing.stdout || "[]")].flat();
	} catch (error) {
		return void console.error(`Could not read the process list for old coach processes: ${error instanceof Error ? error.message : String(error)}`);
	}
	const stale = staleCoachProcesses(rows.map((row) => ({ pid: row.ProcessId, ppid: row.ParentProcessId, cmd: row.CommandLine ?? "" })));
	const taskkill = win32.join(environment.SystemRoot || environment.windir || "C:\\Windows", "System32", "taskkill.exe");
	for (const { pid } of stale) spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], { env: {}, stdio: "ignore", windowsHide: true });
}

// realpath: `npm link` puts a symlink on PATH and Node resolves the main module through it.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
	try {
		if (!process.argv.includes("-p") && !process.argv.includes("--print")) sweepStaleCoach();
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		if (error instanceof UsageError) console.error(`\n${USAGE}`);
		process.exitCode = error instanceof UsageError ? 2 : 1;
	}
}
