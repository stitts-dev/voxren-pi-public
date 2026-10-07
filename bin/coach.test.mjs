import { spawn, spawnSync } from "node:child_process";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { COACH_DIR, EXTENSION, FORWARDED_ENV, imageProtocolOverride, ownTerminal, PI_CLI, THEMES_DIR, TOOLS, UsageError, checkoutInfo, coachHome, createPiInvocation, createRuntime, loadCoachEnv, parseArgs, parseEnvFile, piCommand, staleCoachProcesses, riotKeyEnvironment, signedIn, USAGE } from "./coach.mjs";

const ENV_FILE = "ANTHROPIC_API_KEY=file-anthropic\nPERPLEXITY_API_KEY=file-perplexity\nRAILWAY_TOKEN=unrelated\nDATABASE_URL=postgres://secret\n";
// A fake deps.spawn that always reports "nothing in the store," for tests that aren't about the
// third precedence tier itself -- never the real spawnSync, which would shell out to the real
// Keychain/DPAPI from a unit test.
/** @typedef {NonNullable<Parameters<typeof loadCoachEnv>[2]>} Deps */
/**
 * A partial spawnSync result: the launcher reads only `status`, `stdout` and `error`, so a mock carries just those.
 * @param {{ status: number | null, stdout: string, signal?: string, error?: Error }} partial
 * @returns {any} explicit any: the mock cannot supply the other SpawnSyncReturns fields
 */
const spawned = (partial) => partial;
/**
 * @param {(command: string, args: readonly string[], options?: Record<string, unknown>) => unknown} fn
 * @returns {NonNullable<Deps["spawn"]>}
 */
// as unknown as: spawnSync is overloaded, so no plain function type matches it; the mock honours the one overload the launcher calls.
const asSpawn = (fn) => /** @type {NonNullable<Deps["spawn"]>} */ (/** @type {unknown} */ (fn));
/** @type {Deps} */
const NO_STORE = { spawn: asSpawn(() => spawned({ status: 1, stdout: "" })), log: () => {} };

describe("launcher arguments", () => {
	test("passes only continue, resume, and print through", () => {
		expect(parseArgs([])).toEqual({ help: false, version: false, pass: [] });
		expect(parseArgs(["-c"]).pass).toEqual(["-c"]);
		expect(parseArgs(["--resume"]).pass).toEqual(["--resume"]);
		expect(parseArgs(["-p", "how", "do", "I", "beat", "Ahri"]).pass).toEqual(["--print", "how do I beat Ahri"]);
		expect(parseArgs(["-c", "-p", "/review 5"]).pass).toEqual(["-c", "--print", "/review 5"]);
		expect(parseArgs(["--help"]).help).toBe(true);
	});

	test("short-circuits on -v/--version like --help, never throwing UsageError", () => {
		expect(() => parseArgs(["--version"])).not.toThrow();
		expect(() => parseArgs(["-v"])).not.toThrow();
		expect(parseArgs(["--version"])).toEqual({ help: false, version: true, pass: [] });
		expect(parseArgs(["-v"])).toEqual({ help: false, version: true, pass: [] });
	});

	test("rejects anything that would widen the coach", () => {
		for (const argv of [["--tools", "bash"], ["--extension", "x.ts"], ["--model", "x"], ["-p"], ["hello"]]) expect(() => parseArgs(argv)).toThrow(UsageError);
	});
});

describe("launcher environment", () => {
	test("reads only the coach's names; process env wins; only the chosen provider's key is kept", () => {
		const values = loadCoachEnv({ PERPLEXITY_API_KEY: "env-perplexity", HOME: "/h", PATH: "/bin" }, () => ENV_FILE, NO_STORE);
		expect(values).toEqual({ PERPLEXITY_API_KEY: "env-perplexity", VOXREN_KEY_SOURCE_PERPLEXITY: "env" });
		const anthropic = loadCoachEnv({ VOXREN_COACH_PROVIDER: "anthropic" }, () => ENV_FILE, NO_STORE);
		expect(anthropic).toEqual({ ANTHROPIC_API_KEY: "file-anthropic", PERPLEXITY_API_KEY: "file-perplexity", VOXREN_COACH_PROVIDER: "anthropic", VOXREN_KEY_SOURCE_PERPLEXITY: "dotenv" });
		// VOXREN_KEY_SOURCE_* is loadCoachEnv's own signal, not something read from env/file: it never came from FORWARDED_ENV.
		expect(
			Object.keys(anthropic)
				.filter((name) => !name.startsWith("VOXREN_KEY_SOURCE_"))
				.every((name) => FORWARDED_ENV.includes(name)),
		).toBe(true);
	});

	test("forwards VOXREN_COACH_LANE", () => {
		expect(FORWARDED_ENV).toContain("VOXREN_COACH_LANE");
	});

	test("forwards VOXREN_COACH_TURN_TIMEOUT_MS", () => {
		expect(FORWARDED_ENV).toContain("VOXREN_COACH_TURN_TIMEOUT_MS");
	});

	test("forwards VOXREN_COACH_CARD_DETAIL, read from .env too, and the usage text names it", () => {
		expect(FORWARDED_ENV).toContain("VOXREN_COACH_CARD_DETAIL");
		expect(loadCoachEnv({}, () => "VOXREN_COACH_CARD_DETAIL=full\n", NO_STORE)).toEqual({ VOXREN_COACH_CARD_DETAIL: "full" });
		expect(USAGE).toContain("VOXREN_COACH_CARD_DETAIL");
	});

	test("reads GEMINI_API_KEY from the environment or .env, the environment first, and hands it to Pi's child as VOXREN_GEMINI_API_KEY by environment only, never under the name Pi's own Google provider reads", () => {
		expect(FORWARDED_ENV).toContain("GEMINI_API_KEY");
		expect(loadCoachEnv({ GEMINI_API_KEY: "env-gemini" }, () => "GEMINI_API_KEY=file-gemini\n", NO_STORE)).toEqual({ VOXREN_GEMINI_API_KEY: "env-gemini", VOXREN_KEY_SOURCE_GEMINI: "env" });
		const values = loadCoachEnv({}, () => "GEMINI_API_KEY=file-gemini\n", NO_STORE);
		expect(values).toEqual({ VOXREN_GEMINI_API_KEY: "file-gemini", VOXREN_KEY_SOURCE_GEMINI: "dotenv" });
		const runtime = createRuntime(mkdtempSync(join(tmpdir(), "coach-test-")), mkdtempSync(join(tmpdir(), "coach-cwd-")));
		const { args, childEnv } = createPiInvocation(runtime, values, [], { PATH: "/bin", GEMINI_API_KEY: "ambient-gemini", VOXREN_COACH_HOME: mkdtempSync(join(tmpdir(), "coach-isolated-home-")) }, "darwin");
		expect(childEnv.VOXREN_GEMINI_API_KEY).toBe("file-gemini");
		// Pi's Google provider switches on when GEMINI_API_KEY is set, whatever put it there.
		expect(childEnv.GEMINI_API_KEY).toBeUndefined();
		expect(args.join(" ")).not.toContain("file-gemini");
	});

	test("the usage text names GEMINI_API_KEY", () => {
		expect(USAGE).toContain("GEMINI_API_KEY");
	});

	test("an API-key provider without its key is a clear error; a missing file is fine", () => {
		expect(() => loadCoachEnv({ VOXREN_COACH_PROVIDER: "openrouter" }, () => ENV_FILE, NO_STORE)).toThrow("OPENROUTER_API_KEY");
		const missing = () => {
			throw Object.assign(new Error("nope"), { code: "ENOENT" });
		};
		expect(loadCoachEnv({}, missing, NO_STORE)).toEqual({});
	});
});

describe("key-store precedence tier (Perplexity/Typesafe/Gemini: env > .env > store)", () => {
	/** A fake deps.spawn keyed by "<action>:<secretId>"; anything not listed reports absent, same as a real miss. */
	/** @param {Record<string, { status: number, stdout: string }>} responses */
	function fakeSpawn(responses) {
		/** @param {string} _command @param {readonly string[]} args */
		const spawn = (_command, args) => spawned(responses[`${args[1]}:${args[2]}`] ?? { status: 1, stdout: "" });
		return asSpawn(spawn);
	}
	/** @param {boolean} stored */
	const okStatus = (stored) => ({ status: 0, stdout: JSON.stringify({ ok: true, state: { stored } }) });
	/** @param {string} value */
	const okRead = (value) => ({ status: 0, stdout: JSON.stringify({ ok: true, value }) });
	const ABSENT = { status: 1, stdout: "" };

	test("env-only: the env value is used as-is; a status check confirms it isn't shadowing anything", () => {
		const values = loadCoachEnv({ PERPLEXITY_API_KEY: "pplx-env-value", HOME: "/h", PATH: "/bin" }, () => "", {
			log: () => {},
			spawn: fakeSpawn({ "status:perplexity": okStatus(false), "read:typesafe": ABSENT }),
		});
		expect(values.PERPLEXITY_API_KEY).toBe("pplx-env-value");
		expect(values.VOXREN_KEY_SOURCE_PERPLEXITY).toBe("env");
		expect(values.TYPESAFE_API_KEY).toBeUndefined();
		expect(values.VOXREN_KEY_SOURCE_TYPESAFE).toBeUndefined();
	});

	test("dotenv-only: the .env value wins with no process env set", () => {
		const values = loadCoachEnv({ HOME: "/h", PATH: "/bin" }, () => "PERPLEXITY_API_KEY=pplx-file-value\n", {
			log: () => {},
			spawn: fakeSpawn({ "status:perplexity": okStatus(false), "read:typesafe": ABSENT }),
		});
		expect(values.PERPLEXITY_API_KEY).toBe("pplx-file-value");
		expect(values.VOXREN_KEY_SOURCE_PERPLEXITY).toBe("dotenv");
	});

	test("store-only: neither env nor .env has a value, so the helper's read supplies one", () => {
		const values = loadCoachEnv({ HOME: "/h", PATH: "/bin" }, () => "", {
			log: () => {},
			spawn: fakeSpawn({ "read:perplexity": okRead("pplx-from-store"), "read:typesafe": ABSENT }),
		});
		expect(values.PERPLEXITY_API_KEY).toBe("pplx-from-store");
		expect(values.VOXREN_KEY_SOURCE_PERPLEXITY).toBe("store");
	});

	test("env+store: an active env value while the store also holds one is reported as shadowing it", () => {
		const values = loadCoachEnv({ TYPESAFE_API_KEY: "typesafe-env-value", HOME: "/h", PATH: "/bin" }, () => "", {
			log: () => {},
			spawn: fakeSpawn({ "read:perplexity": ABSENT, "status:typesafe": okStatus(true) }),
		});
		expect(values.TYPESAFE_API_KEY).toBe("typesafe-env-value");
		expect(values.VOXREN_KEY_SOURCE_TYPESAFE).toBe("env+store");
	});

	test("gemini follows the same three tiers: the store supplies a value when nothing else does, and an env or .env value over a stored one is reported as shadowing it", () => {
		const fromStore = loadCoachEnv({ HOME: "/h", PATH: "/bin" }, () => "", { spawn: fakeSpawn({ "read:gemini": okRead("AIza-from-store") }) });
		expect(fromStore.VOXREN_GEMINI_API_KEY).toBe("AIza-from-store");
		expect(fromStore.GEMINI_API_KEY).toBeUndefined();
		expect(fromStore.VOXREN_KEY_SOURCE_GEMINI).toBe("store");
		const envShadow = loadCoachEnv({ GEMINI_API_KEY: "AIza-env", HOME: "/h", PATH: "/bin" }, () => "", { spawn: fakeSpawn({ "status:gemini": okStatus(true) }) });
		expect(envShadow.VOXREN_GEMINI_API_KEY).toBe("AIza-env");
		expect(envShadow.VOXREN_KEY_SOURCE_GEMINI).toBe("env+store");
		const fileOnly = loadCoachEnv({ HOME: "/h", PATH: "/bin" }, () => "GEMINI_API_KEY=AIza-file\n", { spawn: fakeSpawn({ "status:gemini": okStatus(false) }) });
		expect(fileOnly.VOXREN_GEMINI_API_KEY).toBe("AIza-file");
		expect(fileOnly.VOXREN_KEY_SOURCE_GEMINI).toBe("dotenv");
		const nothing = loadCoachEnv({ HOME: "/h", PATH: "/bin" }, () => "", { spawn: fakeSpawn({}) });
		expect(nothing.VOXREN_GEMINI_API_KEY).toBeUndefined();
		expect(nothing.VOXREN_KEY_SOURCE_GEMINI).toBeUndefined();
	});

	test("absent: nothing in env, .env, or the store sets no value and no source", () => {
		const values = loadCoachEnv({ HOME: "/h", PATH: "/bin" }, () => "", {
			log: () => {},
			spawn: fakeSpawn({ "read:perplexity": ABSENT, "read:typesafe": ABSENT }),
		});
		expect(values.PERPLEXITY_API_KEY).toBeUndefined();
		expect(values.VOXREN_KEY_SOURCE_PERPLEXITY).toBeUndefined();
		expect(values.TYPESAFE_API_KEY).toBeUndefined();
		expect(values.VOXREN_KEY_SOURCE_TYPESAFE).toBeUndefined();
	});

	test("a spawn exceeding the timeout resolves as absent, never a hang or a thrown error", () => {
		// What node:child_process.spawnSync actually returns when its `timeout` option fires.
		const timedOut = () => spawned({ status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }), stdout: "" });
		/** @type {ReturnType<typeof loadCoachEnv> | undefined} */
		let values;
		expect(() => {
			values = loadCoachEnv({ HOME: "/h", PATH: "/bin" }, () => "", { log: () => {}, spawn: asSpawn(timedOut) });
		}).not.toThrow();
		expect(values?.PERPLEXITY_API_KEY).toBeUndefined();
		expect(values?.VOXREN_KEY_SOURCE_PERPLEXITY).toBeUndefined();
		expect(values?.TYPESAFE_API_KEY).toBeUndefined();
		expect(values?.VOXREN_KEY_SOURCE_TYPESAFE).toBeUndefined();
	});
});

describe("a key read that falls back is logged (#328)", () => {
	const run = (/** @type {unknown} */ response) => {
		/** @type {Array<{ event: string, details: Record<string, string> }>} */
		const lines = [];
		/** @type {Array<Record<string, unknown>>} */
		const options = [];
		const spawn = asSpawn((_c, _a, o = {}) => (options.push(o), response));
		const values = loadCoachEnv({ HOME: "/h", PATH: "/bin" }, () => "", { spawn, log: (event, details) => lines.push({ event, details }) });
		return { values, lines, options };
	};
	const SECRET_LINE = "pplx-do-not-log-me";

	test("the helper's timeout reason is logged once per secret, and no value reaches the log", () => {
		const { lines } = run(spawned({ status: 0, stdout: JSON.stringify({ ok: false, reason: "timeout", value: SECRET_LINE }) }));
		expect(lines.map((l) => l.details)).toEqual([
			{ secret: "perplexity", action: "read", reason: "timeout" },
			{ secret: "typesafe", action: "read", reason: "timeout" },
			{ secret: "gemini", action: "read", reason: "timeout" },
		]);
		expect(JSON.stringify(lines)).not.toContain(SECRET_LINE);
	});

	test("the launcher's own kill, a spawn error, and garbage output each get a reason", () => {
		const killed = Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
		expect(run(spawned({ status: null, stdout: "", error: killed })).lines[0].details.reason).toBe("launcher_timeout");
		expect(run(spawned({ status: null, stdout: "", error: new Error("boom") })).lines[0].details.reason).toBe("spawn_error");
		expect(run(spawned({ status: 0, stdout: `not json ${SECRET_LINE}` })).lines[0].details.reason).toBe("bad_output");
	});

	test("a key that is simply not stored is not a fallback and logs nothing", () => {
		expect(run(spawned({ status: 0, stdout: JSON.stringify({ ok: false, reason: "not_stored" }) })).lines).toEqual([]);
	});

	test("the launcher's kill comes after the helper's own 2.5 s deadline and cannot be survived", () => {
		const { options } = run(spawned({ status: 0, stdout: JSON.stringify({ ok: false, reason: "not_stored" }) }));
		expect(options[0].timeout).toBeGreaterThan(2500);
		expect(options[0].killSignal).toBe("SIGKILL");
	});

	test("with no injected log, the line lands in the coach home's coach.log.ndjson", () => {
		const home = mkdtempSync(join(tmpdir(), "voxren-launcher-log-"));
		const spawn = asSpawn(() => spawned({ status: 0, stdout: JSON.stringify({ ok: false, reason: "timeout" }) }));
		loadCoachEnv({ VOXREN_COACH_HOME: home }, () => "", { spawn });
		const lines = readFileSync(join(home, "coach.log.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatchObject({ level: "warn", component: "launcher", event: "secret_read_fallback", details: { secret: "perplexity", action: "read", reason: "timeout" } });
		rmSync(home, { recursive: true, force: true });
	});
});

describe("env file", () => {
	test("keeps an unquoted Riot ID; strips quotes, export, and whitespace comments", () => {
		expect(
			parseEnvFile('VOXREN_COACH_ACCOUNTS=Player01#NA1\nexport A="x y" # note\nB=\'q#1\'\nC=plain # comment\n# D=skip\nnot a line\n'),
		).toEqual({ VOXREN_COACH_ACCOUNTS: "Player01#NA1", A: "x y", B: "q#1", C: "plain" });
	});

	test("OAuth providers need a saved sign-in; API-key providers do not", () => {
		const runtime = createRuntime(mkdtempSync(join(tmpdir(), "coach-auth-")), mkdtempSync(join(tmpdir(), "coach-cwd-")));
		expect(signedIn(runtime, "anthropic")).toBe(true);
		expect(signedIn(runtime, "openai-codex")).toBe(false);
		writeFileSync(join(runtime.agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth" } }));
		expect(signedIn(runtime, "openai-codex")).toBe(true);
	});
});

describe("launcher invocation", () => {
	// profileTheme() (added for the config-driven default) reads coachHome()'s profile.json whenever
	// VOXREN_COACH_HOME isn't set, and coachHome() falls back to the real os.homedir() on darwin/linux.
	// Every createPiInvocation call below must pass an isolated VOXREN_COACH_HOME so these tests never
	// read the developer's actual coach home.
	/** @type {string} */
	let coachHomeDir;
	beforeEach(() => {
		coachHomeDir = mkdtempSync(join(tmpdir(), "coach-isolated-home-"));
	});

	test("isolated Pi: coach extension only, no builtin tools, persistent sessions, keys only in env", () => {
		const runtime = createRuntime(mkdtempSync(join(tmpdir(), "coach-test-")), mkdtempSync(join(tmpdir(), "coach-cwd-")));
		expect(JSON.parse(readFileSync(join(runtime.agentDir, "trust.json"), "utf8"))).toEqual({ [realpathSync(runtime.cwd)]: true });
		if (process.platform !== "win32") expect(statSync(runtime.sessionDir).mode & 0o777).toBe(0o700); // Windows reports 0o666
		expect(JSON.parse(readFileSync(join(runtime.agentDir, "settings.json"), "utf8"))).toEqual({ quietStartup: true, hideThinkingBlock: false });
		const values = { ANTHROPIC_API_KEY: "secret-a", VOXREN_COACH_PROVIDER: "anthropic", VOXREN_COACH_MODEL: "claude-opus-5-5" };
		const environment = { HOME: "/Users/me", PATH: "/bin", SECRET_OTHER: "leak", TERM_PROGRAM: "WarpTerminal", WARP_TERMINAL_SESSION_UUID: "abc", VOXREN_COACH_HOME: coachHomeDir };
		const { args, childEnv } = createPiInvocation(runtime, values, ["-c"], environment, "darwin");
		expect(args).toContain("--no-builtin-tools");
		expect(args).toContain("--no-extensions");
		expect(args[args.indexOf("--extension") + 1]).toBe(EXTENSION);
		expect(args[args.indexOf("--tools") + 1]).toBe(TOOLS.join(","));
		expect(args[args.indexOf("--session-dir") + 1]).toBe(runtime.sessionDir);
		expect(args).not.toContain("--no-session");
		expect(args[args.indexOf("--models") + 1]).toBe("anthropic/claude-opus-5-5");
		expect(args.at(-1)).toBe("-c");
		expect(args.join(" ")).not.toContain("secret-a");
		expect(childEnv.ANTHROPIC_API_KEY).toBe("secret-a");
		expect(childEnv.SECRET_OTHER).toBeUndefined();
		expect(childEnv.TERM_PROGRAM).toBe("WarpTerminal"); // pi-tui needs it to turn Kitty images on
		expect(childEnv.WARP_TERMINAL_SESSION_UUID).toBe("abc");
		expect("KITTY_WINDOW_ID" in childEnv).toBe(false);
		expect(childEnv.PI_IMAGE_PROTOCOL).toBeUndefined(); // Warp on macOS draws images
		const winEnv = (/** @type {NodeJS.ProcessEnv} */ extra) => createPiInvocation(runtime, values, [], { PATH: "/bin", TERM_PROGRAM: "WarpTerminal", VOXREN_COACH_HOME: coachHomeDir, ...extra }, "win32").childEnv;
		expect(winEnv({}).PI_IMAGE_PROTOCOL).toBe("none"); // Warp on Windows drops them: text charts instead of blank rows
		expect(winEnv({ PI_IMAGE_PROTOCOL: "kitty" }).PI_IMAGE_PROTOCOL).toBe("kitty");
		expect(createPiInvocation(runtime, values, [], { PATH: "/bin", WEZTERM_PANE: "1", VOXREN_COACH_HOME: coachHomeDir }, "win32").childEnv.PI_IMAGE_PROTOCOL).toBe("iterm2"); // ConPTY drops Kitty APC on Windows
		expect(childEnv.HOME).toBe(join(runtime.agentDir, "home"));
		expect(childEnv.VOXREN_RIOT_KEY_STATE_DIR).toBe(coachHome(environment, "darwin"));
		const fallback = createPiInvocation(runtime, {}, [], { PATH: "/bin", VOXREN_COACH_HOME: coachHomeDir }).args;
		expect(fallback[fallback.indexOf("--models") + 1]).toBe("openai-codex/gpt-6-luna,openai-codex/gpt-6-sol");
		const pinned = createPiInvocation(runtime, { VOXREN_COACH_MODEL: "gpt-6-luna" }, [], { PATH: "/bin", VOXREN_COACH_HOME: coachHomeDir }).args;
		expect(pinned[pinned.indexOf("--model") + 1]).toBe("gpt-6-luna");
		expect(pinned[pinned.indexOf("--models") + 1]).toBe("openai-codex/gpt-6-luna");
		// A provider-only override pins the same way (matches src/index.ts's pinnedAtLaunch): --models
		// must not advertise DEFAULT_MODELS ids under the new provider that the gate would then abort on.
		const providerOnly = createPiInvocation(runtime, { VOXREN_COACH_PROVIDER: "anthropic" }, [], { PATH: "/bin", VOXREN_COACH_HOME: coachHomeDir }).args;
		expect(providerOnly[providerOnly.indexOf("--models") + 1]).toBe("anthropic/gpt-6-sol");
	});

	test("ships the coach themes and starts on tidal unless VOXREN_COACH_THEME says otherwise", () => {
		const runtime = createRuntime(mkdtempSync(join(tmpdir(), "coach-test-")), mkdtempSync(join(tmpdir(), "coach-cwd-")));
		const args = createPiInvocation(runtime, {}, [], { PATH: "/bin", VOXREN_COACH_HOME: coachHomeDir }).args;
		expect(args[args.indexOf("--theme") + 1]).toBe(THEMES_DIR);
		expect(args[args.indexOf("--use-theme") + 1]).toBe("tidal");
		for (const name of ["tidal", "hextech", "void", "signal"]) expect(JSON.parse(readFileSync(join(THEMES_DIR, `${name}.json`), "utf8")).name).toBe(name);
		const chosen = createPiInvocation(runtime, { VOXREN_COACH_THEME: "void" }, [], { PATH: "/bin", VOXREN_COACH_HOME: coachHomeDir }).args;
		expect(chosen[chosen.indexOf("--use-theme") + 1]).toBe("void");
		expect(loadCoachEnv({ VOXREN_COACH_THEME: "signal" }, () => "", NO_STORE)).toEqual({ VOXREN_COACH_THEME: "signal" });

		// No VOXREN_COACH_THEME: falls back to profile.json's theme.
		const home = mkdtempSync(join(tmpdir(), "coach-home-"));
		writeFileSync(join(home, "profile.json"), JSON.stringify({ theme: "hextech" }));
		const fromProfile = createPiInvocation(runtime, {}, [], { PATH: "/bin", VOXREN_COACH_HOME: home }).args;
		expect(fromProfile[fromProfile.indexOf("--use-theme") + 1]).toBe("hextech");

		// Both set: env still wins over the profile.
		const envWins = createPiInvocation(runtime, { VOXREN_COACH_THEME: "signal" }, [], { PATH: "/bin", VOXREN_COACH_HOME: home }).args;
		expect(envWins[envWins.indexOf("--use-theme") + 1]).toBe("signal");
	});
});

describe("platform-specific home and env paths", () => {
	test("coachHome picks the per-platform data dir; VOXREN_COACH_HOME always wins", () => {
		expect(coachHome({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32")).toBe("C:\\Users\\me\\AppData\\Local\\voxren-coach");
		expect(coachHome({}, "win32")).toBe(win32.join(homedir(), "AppData", "Local", "voxren-coach"));
		expect(coachHome({ XDG_DATA_HOME: "/home/me/.data" }, "linux")).toBe(join("/home/me/.data", "voxren-coach"));
		expect(coachHome({}, "linux")).toBe(join(homedir(), ".local", "share", "voxren-coach"));
		expect(coachHome({}, "darwin")).toBe(join(homedir(), "Library", "Application Support", "voxren-coach"));
		expect(coachHome({ VOXREN_COACH_HOME: "/custom" }, "win32")).toBe("/custom");
	});

	test("riotKeyEnvironment routes to DPAPI state dir on win32, keychain env on macOS", () => {
		const win = riotKeyEnvironment({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32");
		expect(win).toEqual({ VOXREN_RIOT_KEY_STATE_DIR: "C:\\Users\\me\\AppData\\Local\\voxren-coach" });
		expect(win.VOXREN_RIOT_KEYCHAIN).toBeUndefined();
		const mac = riotKeyEnvironment({ HOME: "/Users/me" }, "darwin");
		expect(mac.VOXREN_RIOT_KEYCHAIN).toBe("/Users/me/Library/Keychains/login.keychain-db");
		// The state dir is the coach home on every OS now, so VOXREN_COACH_HOME moves it with the sessions.
		expect(mac.VOXREN_RIOT_KEY_STATE_DIR).toBe(coachHome({ HOME: "/Users/me" }, "darwin"));
		expect(riotKeyEnvironment({ HOME: "/Users/me", VOXREN_COACH_HOME: "/custom" }, "darwin").VOXREN_RIOT_KEY_STATE_DIR).toBe("/custom");
		// No HOME: no keychain path to hand the custodian; the key store degrades to unavailable downstream.
		expect(riotKeyEnvironment({}, "darwin")).toEqual({});
	});
});

describe("checkout info", () => {
	test("normal checkout: branch and short sha from the injected git dep", () => {
		/** @type {(args: readonly string[]) => string} */
		const git = (args) => (args[0] === "rev-parse" ? "36/04-worktree-parity" : "a1b2c3d");
		expect(checkoutInfo("/repo", { git })).toEqual({ dir: "/repo", branch: "36/04-worktree-parity@a1b2c3d" });
	});

	test("a linked worktree reports its own branch, not the primary checkout's", () => {
		/** @type {(args: readonly string[]) => string} */
		const git = (args) => (args[0] === "rev-parse" ? "36/01-helper-generalize" : "9f8e7d6");
		expect(checkoutInfo("/wt", { git }).branch).toBe("36/01-helper-generalize@9f8e7d6");
	});

	test("detached HEAD reads as 'detached' instead of git's literal HEAD", () => {
		/** @type {(args: readonly string[]) => string} */
		const git = (args) => (args[0] === "rev-parse" ? "HEAD" : "a1b2c3d");
		expect(checkoutInfo("/repo", { git }).branch).toBe("detached@a1b2c3d");
	});

	test("a failing git dep leaves branch undefined instead of throwing", () => {
		const git = () => undefined;
		expect(() => checkoutInfo("/repo", { git })).not.toThrow();
		expect(checkoutInfo("/repo", { git })).toEqual({ dir: "/repo", branch: undefined });
	});

	test("a throwing git dep (no git on PATH) is caught, not propagated", () => {
		const git = () => {
			throw new Error("ENOENT");
		};
		expect(() => checkoutInfo("/repo", { git })).not.toThrow();
		expect(checkoutInfo("/repo", { git })).toEqual({ dir: "/repo", branch: undefined });
	});
});

describe("pi resolution", () => {
	test("darwin/linux: sibling pi beside node, else pi on PATH", () => {
		const sibling = piCommand("darwin", { existsSync: (path) => path === join(dirname("/opt/node/bin/node"), "pi"), execPath: "/opt/node/bin/node" });
		expect(sibling).toEqual({ command: "/opt/node/bin/node", prefix: [join("/opt/node/bin", "pi")], shell: false });
		const onPath = piCommand("linux", { existsSync: () => false, execPath: "/opt/node/bin/node" });
		expect(onPath).toEqual({ command: "pi", prefix: [], shell: false });
	});

	test("win32: Pi's cli.js beside node runs through this node with no shell", () => {
		const execPath = "C:\\nvm\\node.exe";
		const cli = `C:\\nvm\\${PI_CLI}`;
		const result = piCommand("win32", { existsSync: (path) => path === cli, execPath });
		expect(result).toEqual({ command: execPath, prefix: [cli], shell: false });
	});

	test("win32: falls back to the global npm prefix's cli.js when no sibling exists, still no shell", () => {
		const npmBin = "C:\\Users\\me\\AppData\\Roaming\\npm";
		const cli = `${npmBin}\\${PI_CLI}`;
		const result = piCommand("win32", {
			existsSync: (path) => path === cli,
			execPath: "C:\\nvm\\node.exe",
			npmPrefix: () => npmBin,
		});
		expect(result).toEqual({ command: "C:\\nvm\\node.exe", prefix: [cli], shell: false });
	});

	test("win32: finds the cli.js beside pi.cmd in a PATH directory, still no shell", () => {
		// A standalone Node install (pi-node) outside this Node's folder and the npm prefix: before, only
		// bare pi.cmd was left, cmd.exe re-split the arguments, and `-p "a b"` arrived as two messages.
		const piNode = "C:\\Users\\me\\AppData\\Local\\pi-node\\current";
		const cli = `${piNode}\\${PI_CLI}`;
		const result = piCommand("win32", {
			existsSync: (path) => path === cli,
			execPath: "C:\\nvm\\node.exe",
			npmPrefix: () => undefined,
			env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming", Path: `C:\\Windows;;${piNode}` },
		});
		expect(result).toEqual({ command: "C:\\nvm\\node.exe", prefix: [cli], shell: false });
	});

	test("win32: falls back to %APPDATA%\\npm, then bare pi.cmd on PATH as the last resort", () => {
		const cli = `C:\\Users\\me\\AppData\\Roaming\\npm\\${PI_CLI}`;
		const withAppData = piCommand("win32", {
			existsSync: (path) => path === cli,
			execPath: "C:\\nvm\\node.exe",
			npmPrefix: () => undefined,
			env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
		});
		expect(withAppData).toEqual({ command: "C:\\nvm\\node.exe", prefix: [cli], shell: false });
		const bare = piCommand("win32", { existsSync: () => false, execPath: "C:\\nvm\\node.exe", npmPrefix: () => undefined, env: {} });
		expect(bare).toEqual({ command: "pi.cmd", prefix: [], shell: true });
	});
});

describe("the coach's own terminal", () => {
	const wezterm = win32.join("C:\\Program Files", "WezTerm", "wezterm-gui.exe");
	/** @type {NonNullable<Parameters<typeof ownTerminal>[1]> & { platform: NodeJS.Platform }} */
	const windows = { platform: "win32", tty: true, exists: (file) => file === wezterm, environment: { ProgramFiles: "C:\\Program Files" } };

	test("on Windows, outside WezTerm, it reopens this launch in WezTerm with the repo's config and the same arguments", () => {
		const opened = ownTerminal(["-c"], windows);
		expect(opened?.command).toBe(wezterm);
		expect(opened?.args.slice(0, 3)).toEqual(["--config-file", join(COACH_DIR, "terminal", "wezterm.lua"), "start"]);
		expect(opened?.args.slice(-2)).toEqual([join(COACH_DIR, "bin", "coach.mjs"), "-c"]);
	});

	test("it runs in place when already there, asked to, printing, not a terminal, under tmux, or with nothing installed", () => {
		expect(ownTerminal([], { ...windows, environment: { WEZTERM_PANE: "0" } })).toBeUndefined();
		expect(ownTerminal([], { ...windows, environment: { VOXREN_COACH_TERMINAL: "here" } })).toBeUndefined();
		expect(ownTerminal(["-p", "/review 3"], windows)).toBeUndefined();
		expect(ownTerminal([], { ...windows, tty: false })).toBeUndefined();
		expect(ownTerminal([], { ...windows, environment: { TMUX: "/tmp/tmux" } })).toBeUndefined();
		expect(ownTerminal([], { ...windows, exists: () => false })).toBeUndefined();
		expect(ownTerminal([], { platform: "linux", tty: true, exists: () => true, environment: {} })).toBeUndefined();
	});

	test("on macOS it reopens in the same WezTerm with the same config, from the app Homebrew installs", () => {
		const app = "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui";
		const opened = ownTerminal(["-c"], { platform: "darwin", tty: true, exists: (file) => file === app, environment: {} });
		expect(opened?.command).toBe(app);
		expect(opened?.args.slice(0, 3)).toEqual(["--config-file", join(COACH_DIR, "terminal", "wezterm.lua"), "start"]);
		expect(ownTerminal([], { platform: "darwin", tty: true, exists: () => false, environment: {} })).toBeUndefined();
	});

	test("WezTerm gets pictures the iTerm2 way on every platform; an explicit PI_IMAGE_PROTOCOL still wins", () => {
		expect(imageProtocolOverride({ WEZTERM_PANE: "0" }, "win32")).toEqual({ PI_IMAGE_PROTOCOL: "iterm2" });
		expect(imageProtocolOverride({ WEZTERM_PANE: "0" }, "darwin")).toEqual({ PI_IMAGE_PROTOCOL: "iterm2" });
		expect(imageProtocolOverride({ WEZTERM_PANE: "0", PI_IMAGE_PROTOCOL: "kitty" }, "win32")).toEqual({});
		expect(imageProtocolOverride({ TERM_PROGRAM: "iTerm.app" }, "darwin")).toEqual({});
	});
});

describe("launcher signals", () => {
	// The stub Pi writes its pid, then waits; on SIGTERM it writes "term" and exits 7. The driver runs the real
	// main() against it. Killing the launcher with SIGTERM must reach the stub (no orphan) and end with the stub's code.
	// Windows has no SIGTERM: kill() is a hard terminate, so the stub's handler cannot run there.
	test.skipIf(process.platform === "win32")("SIGTERM to the launcher reaches Pi and the launcher exits with Pi's code", async () => {
		const dir = mkdtempSync(join(tmpdir(), "coach-signal-"));
		const pidFile = join(dir, "pid");
		const termFile = join(dir, "term");
		const stub = join(dir, "stub-pi.mjs");
		writeFileSync(stub, `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(termFile)}, "term"); process.exit(7); });
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
		const driver = join(dir, "driver.mjs");
		writeFileSync(driver, `import { main } from ${JSON.stringify(new URL("./coach.mjs", import.meta.url).href)};
main(["--print", "x"], { pi: { command: process.execPath, prefix: [${JSON.stringify(stub)}], shell: false } });
`);
		const home = join(dir, "home");
		const launcher = spawn(process.execPath, [driver], { env: { ...process.env, VOXREN_COACH_HOME: home, VOXREN_COACH_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "x" }, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		launcher.stderr.on("data", (chunk) => (stderr += chunk));
		const exited = new Promise((done) => launcher.on("exit", (code, signal) => done({ code, signal })));
		for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
		expect(existsSync(pidFile) ? "started" : `stub never started: ${stderr}`).toBe("started");
		const stubPid = Number(readFileSync(pidFile, "utf8"));
		launcher.kill("SIGTERM");
		const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r("hung"), 5000))]);
		let alive = true;
		for (let i = 0; i < 40 && alive; i++) {
			try { process.kill(stubPid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
		}
		if (alive) process.kill(stubPid, "SIGKILL"); // never leave the stub behind, pass or fail
		expect(readFileSync(termFile, "utf8")).toBe("term");
		expect(alive).toBe(false);
		expect(result).toEqual({ code: 7, signal: null });
	}, 60000);

	/**
	 * Runs main() against a stub Pi script; stdin is an open pipe that never ends.
	 * @param {string} stubSource
	 * @param {(stub: string) => { command: string, prefix: string[], shell: boolean }} [pi]
	 */
	function launch(stubSource, pi = (stub) => ({ command: process.execPath, prefix: [stub], shell: false })) {
		const dir = mkdtempSync(join(tmpdir(), "coach-launch-"));
		const stub = join(dir, "stub-pi.mjs");
		writeFileSync(stub, stubSource);
		const driver = join(dir, "driver.mjs");
		writeFileSync(driver, `import { main } from ${JSON.stringify(new URL("./coach.mjs", import.meta.url).href)};
const pi = ${JSON.stringify(pi(stub))};
await main(["--print", "x"], { pi });
`);
		const launcher = spawn(process.execPath, [driver], { env: { ...process.env, VOXREN_COACH_HOME: join(dir, "home"), VOXREN_COACH_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "x" }, stdio: ["pipe", "ignore", "ignore"] });
		// The launcher asks the key store up to three times at 3 s each before Pi starts; Windows CI is slow there.
		return new Promise((done) => {
			const timer = setTimeout(() => { launcher.kill("SIGKILL"); done("hung"); }, 40000);
			launcher.on("exit", (code) => { clearTimeout(timer); done(code); });
		});
	}

	test("a Pi that cannot start ends the launcher non-zero, never a hang", async () => {
		const code = await launch("", () => ({ command: join(tmpdir(), "no-such-pi-binary"), prefix: [], shell: false }));
		expect(code).not.toBe("hung");
		expect(code).not.toBe(0);
	}, 60000);

	// Windows only: Pi reading an open non-terminal stdin to EOF hung under async spawn (found over ssh on 2026-10-04).
	test.skipIf(process.platform !== "win32")("a Pi that reads stdin to EOF finishes when the launcher's stdin is an open pipe", async () => {
		const code = await launch(`process.stdin.on("end", () => process.exit(0)); process.stdin.resume();`);
		expect(code).toBe(0);
	}, 60000);
});

// Issue #209: Pi sets its process title, and on macOS `ps` (with the environment flag, and for some builds without it)
// then shows the process's environment. No key may be in the environment of the Pi the real launcher starts.
// Runs where `ps` and `script` (a pty, Pi's TUI needs a terminal) exist; Windows has neither and is skipped.
describe("keys in the process list", () => {
	const HAS_TOOLS = process.platform !== "win32" && (process.platform !== "darwin" || spawnSync("python3", ["-V"]).status === 0) && spawnSync("script", ["-q", "/dev/null", "true"]).status === 0 && spawnSync("ps", ["-p", String(process.pid)]).status === 0;
	const FAKE = { PERPLEXITY_API_KEY: "fake-perplexity-0000", GEMINI_API_KEY: "fake-gemini-0000", TYPESAFE_API_KEY: "fake-typesafe-0000", BRAVE_API_KEY: "fake-brave-0000" };
	const ps = (/** @type {string[]} */ args) => spawnSync("ps", args, { encoding: "utf8" }).stdout ?? "";
	const FAKE_KEY = /fake-[a-z]+-0000/g;
	// macOS: KERN_PROCARGS2 (the call ps itself uses), through python3, which ships with the command line tools. Linux: /proc.
	const MACOS_PROCARGS = "import ctypes,sys\nb=ctypes.create_string_buffer(1<<20);n=ctypes.c_size_t(len(b))\nctypes.CDLL('libc.dylib').sysctl((ctypes.c_int*3)(1,49,int(sys.argv[1])),3,b,ctypes.byref(n),None,0)\nsys.stdout.write(b.raw[:n.value].decode('latin-1'))";
	const rawProcessBlock = (/** @type {number} */ pid) => process.platform === "darwin" ? (spawnSync("python3", ["-c", MACOS_PROCARGS, String(pid)], { encoding: "latin1" }).stdout ?? "") : readFileSync(`/proc/${pid}/environ`, "latin1");
	const descendants = (/** @type {number} */ root) => {
		const rows = ps(["-A", "-o", "pid=,ppid=,comm="]).split("\n").map((line) => line.trim().split(/\s+/)).filter((cols) => cols.length >= 3);
		const found = new Set([root]);
		for (let grew = true; grew;) {
			grew = false;
			for (const [pid, ppid] of rows) if (found.has(Number(ppid)) && !found.has(Number(pid))) { found.add(Number(pid)); grew = true; }
		}
		return rows.filter(([pid]) => found.has(Number(pid))).map(([pid, , comm]) => ({ pid: Number(pid), comm: comm ?? "" }));
	};

	test.skipIf(!HAS_TOOLS)("the Pi the launcher starts shows none of the keys, even in the process list with environments", async () => {
		const dir = mkdtempSync(join(tmpdir(), "coach-ps-gate-"));
		const home = join(dir, "home");
		mkdirSync(home);
		const envFile = join(home, ".env");
		writeFileSync(envFile, `${Object.entries(FAKE).map(([name, value]) => `${name}=${value}`).join("\n")}\nOPENROUTER_API_KEY=fake-openrouter-0000\n`);
		/** @type {Record<string, string | undefined>} */
		const env = { ...process.env, VOXREN_COACH_HOME: home, VOXREN_COACH_ENV_FILE: envFile, VOXREN_COACH_PROVIDER: "openrouter", VOXREN_COACH_TERMINAL: "here" };
		for (const name of [...Object.keys(FAKE), "OPENROUTER_API_KEY", "VOXREN_GEMINI_API_KEY", "VOXREN_RESEARCH_TOKEN"]) delete env[name];
		const cli = join(COACH_DIR, "bin", "coach.mjs");
		// script wants a real stdin (a pipe from sleep), not the socket Node gives a "pipe" stdio.
		const script = process.platform === "darwin" ? `script -q /dev/null node "${cli}"` : `script -qec 'node "${cli}"' /dev/null`;
		const launcher = spawn("sh", ["-c", `sleep 50 | ${script}`], { env, stdio: "ignore" });
		try {
			/** @type {number[]} */
			let pi = [];
			for (let waited = 0; pi.length === 0 && waited < 30000; waited += 250) {
				await new Promise((done) => setTimeout(done, 250));
				pi = descendants(launcher.pid ?? 0).filter((proc) => /(^|\/)pi$/.test(proc.comm)).map((proc) => proc.pid);
			}
			expect(pi.length).toBeGreaterThan(0);
			await new Promise((done) => setTimeout(done, 4000)); // the extension has loaded and read its keys by now
			for (const pid of pi) {
				const listing = ps(["-ww", "-o", "command=", "-p", String(pid)]);
				expect(listing.length).toBeGreaterThan(0);
				expect(listing.match(FAKE_KEY)?.length ?? 0).toBe(0);
				// What ps -E and any same-user tool can read: the arguments and environment the process was started with.
				const block = rawProcessBlock(pid);
				expect(block.length).toBeGreaterThan(0);
				expect(block.match(FAKE_KEY)?.length ?? 0).toBe(0);
			}
		} finally {
			for (const proc of descendants(launcher.pid ?? 0)) spawnSync("kill", ["-9", String(proc.pid)]);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60000);

	// The provider key stays in the stash too: Pi reads it when the request is made, after the extension has put it back.
	// A Pi that decided at startup (before extensions load) that the provider had no key would say so here, offline or not.
	test.skipIf(process.platform === "win32")("a player who has only an API key for the provider (no login) still gets that provider's model and key", () => {
		const home = mkdtempSync(join(tmpdir(), "coach-apikey-only-"));
		/** @type {Record<string, string | undefined>} */
		const env = { ...process.env, VOXREN_COACH_HOME: home, VOXREN_COACH_PROVIDER: "anthropic", VOXREN_COACH_MODEL: "claude-sonnet-4-5", VOXREN_COACH_TERMINAL: "here", VOXREN_COACH_ENV_FILE: join(home, ".env") };
		for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY", "TYPESAFE_API_KEY"]) delete env[name];
		writeFileSync(join(home, ".env"), "ANTHROPIC_API_KEY=fake-anthropic-0000\n");
		const run = spawnSync(process.execPath, [join(COACH_DIR, "bin", "coach.mjs"), "-p", "hello"], { env, encoding: "utf8", timeout: 50000 });
		rmSync(home, { recursive: true, force: true });
		expect(`${run.stdout}${run.stderr}`).not.toMatch(/no api key|no models match|no model/i);
	}, 60000);
});

describe("old coach processes", () => {
	// Real Windows command lines, as Win32_Process reports them: String.raw keeps every backslash.
	const dir = String.raw`C:\work\voxren-pi`;
	const node = String.raw`"C:\Program Files\nodejs\node.exe"`;
	const pi = String.raw`C:\tools\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`;
	/** @param {number} pid @param {number} ppid @param {string} cmd */
	const row = (pid, ppid, cmd) => ({ pid, ppid, cmd });
	test("a launcher or Pi whose parent is gone is stale; one whose parent is alive is a window in use", () => {
		const processes = [
			row(11, 10, String.raw`${node} ${dir}\bin\coach.mjs`), // live window: WezTerm (10) is running
			row(10, 1, `cmd /c wezterm-host`), // stands in for the live terminal
			row(12, 11, String.raw`${node} ${pi} -e ${dir}\src\index.ts`), // live
			row(20, 99, String.raw`${node} C:\Work\Voxren-Pi\bin\coach.mjs`), // orphaned launcher; Windows paths ignore case
			row(21, 98, `node ${pi} -e C:/work/voxren-pi/src/index.ts`), // orphaned Pi, forward slashes
		];
		expect(staleCoachProcesses(processes, { coachDir: dir, self: 500 }).map((entry) => entry.pid)).toEqual([20, 21]);
	});

	test("the WezTerm window a launcher opened is never stale, though its command line names the coach and its launcher is gone", () => {
		const wezterm = String.raw`"C:\Program Files\WezTerm\wezterm-gui.exe" --config-file ${dir}\terminal\wezterm.lua start --always-new-process --cwd ${dir} -- ${node} ${dir}\bin\coach.mjs`;
		const processes = [row(40, 99, wezterm), row(41, 40, String.raw`${node} ${dir}\bin\coach.mjs`)];
		expect(staleCoachProcesses(processes, { coachDir: dir, self: 41 })).toEqual([]);
	});

	test("another checkout's coach, another node tool in this checkout, the League client and this process are never stale", () => {
		const processes = [
			row(30, 99, String.raw`${node} C:\other\voxren-pi\bin\coach.mjs`),
			row(33, 99, String.raw`${node} ${dir}\node_modules\typescript\bin\tsc --watch`),
			row(31, 99, String.raw`"C:\Riot Games\League of Legends\LeagueClientUx.exe" --app-port=1`),
			row(32, 99, String.raw`${node} ${dir}\bin\coach.mjs`),
		];
		expect(staleCoachProcesses(processes, { coachDir: dir, self: 32 })).toEqual([]);
	});
});
