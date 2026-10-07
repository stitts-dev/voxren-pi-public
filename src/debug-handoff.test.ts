import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEBUG_COMMAND, DEBUG_NOTHING_MESSAGE, DEBUG_NO_HOME_MESSAGE, buildDebugBundle, claudeEnvironment, mainCheckout, runCommand, startDebugSession, type RunCommand } from "./debug-handoff";
import { installVoxrenCoach } from "./index";
import { wezWindow } from "./window-shot";

const line = (row: Record<string, unknown>) => JSON.stringify(row);
const exchangesText = [
	line({ ts: "t1", sessionId: "mine", systemPrompt: "SYSTEM", answer: "first" }),
	line({ ts: "t2", sessionId: "other", systemPrompt: "SYSTEM", answer: "someone else's" }),
	line({ ts: "t3", sessionId: "mine", systemPrompt: "SYSTEM", answer: "second", tools: [{ name: "voxren_meta_research", result: { shards: ["Health Scaling"], echoed: "key RGAPI-0a1b2c3d-0a1b-0a1b-0a1b-0a1b2c3d4e5f seen" } }] }),
	'{"ts":"t4","sessionId":"mine","answer":"cut off mid-wri',
].join("\n");
const STAMP = "2026-01-02T03-04-05-678Z";
const now = new Date("2026-01-02T03:04:05.678Z");
const started = "Starting background service…\nbackgrounded · 5b9c0a21 · coach debug\n";
/** The coach's window as /report sees it in WezTerm: a picture beside the bundle and the pane's text. */
const look = async (dir: string) => ({ picture: `${dir}/window.png`, screen: "VOXREN COACH\n> /review 3\nShards: Health Scaling" });

/** The coach with no coach home: a /report that starts answers DEBUG_NO_HOME_MESSAGE and spawns nothing. */
function coachWithoutHome() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
	const pi = { registerTool() {}, setActiveTools() {}, sendUserMessage() {}, sendMessage() {}, registerMessageRenderer() {}, registerMarkdownTransformer() {}, getThinkingLevel: () => "medium", setModel: async () => true, setThinkingLevel() {}, registerCommand: (name: string, options: any) => commands.set(name, options), on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) };
	const custodian = { fetch: async () => ({ status: 200, body: "{}" }), status: async () => ({ state: { stored: false } }) } as any;
	installVoxrenCoach(pi as any, {}, custodian, async () => undefined, async () => undefined, undefined, async () => undefined);
	const notes: Array<[string, string]> = [];
	const state = { idle: false };
	const ctx = { hasUI: true, mode: "tui", isIdle: () => state.idle, sessionManager: { getSessionId: () => "mine" }, ui: { notify: (text: string, level: string) => notes.push([text, level]) } };
	const settle = async () => {
		for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return { debug: (args: string) => commands.get(DEBUG_COMMAND).handler(args, ctx), commands, notes, state, settle };
}

describe("debug handoff", () => {
	test("no coach command takes a name Pi answers itself, which would never reach the coach", () => {
		// Pi 0.87.1's interactive mode checks these before any extension command (its submit handler and slash-command list).
		const piBuiltIns = ["arminsayshi", "bash", "bug", "changelog", "clone", "compact", "copy", "debug", "dementedelves", "edit", "export", "fork", "glob", "grep", "hotkeys", "import", "login", "logout", "model", "name", "new", "quit", "read", "reload", "resume", "scoped-models", "session", "settings", "share", "thinking", "tree", "trust", "write"];
		const names = [...coachWithoutHome().commands.keys()];
		expect(names).toContain(DEBUG_COMMAND);
		expect(names.filter((name) => piBuiltIns.includes(name))).toEqual([]);
	});

	test("the bundle holds this session's runs only, newest first, with the system prompt once", () => {
		const bundle = buildDebugBundle({ note: "wrong shard", sessionId: "mine", exchangesText, logText: `${line({ sessionId: "mine", event: "icon-failed" })}\n${line({ sessionId: "other", event: "x" })}`, now });
		expect(bundle.exchanges.map((exchange) => exchange.answer)).toEqual(["second", "first"]);
		expect(bundle.exchanges.map((exchange) => exchange.systemPrompt)).toEqual(["SYSTEM", "(same as the newest run's)"]);
		expect(bundle.log).toEqual([{ sessionId: "mine", event: "icon-failed" }]);
		expect(bundle.createdAt).toBe("2026-01-02T03:04:05.678Z");
	});

	test("Claude Code gets the player's own home and none of the coach's keys", () => {
		const coachEnv = { PATH: "/bin", HOME: "/coach/pi-agent/home", OPENAI_API_KEY: "sk-coach", ANTHROPIC_API_KEY: "sk-ant", PI_CODING_AGENT_DIR: "/coach/pi-agent" };
		expect(claudeEnvironment(coachEnv, "darwin", "/Users/player")).toEqual({ PATH: "/bin", HOME: "/Users/player" });
		expect(claudeEnvironment({ PATH: "C:\\bin", SYSTEMROOT: "C:\\Windows", HOME: "C:\\coach\\home" }, "win32", "C:\\Users\\player")).toEqual({
			PATH: "C:\\bin",
			SYSTEMROOT: "C:\\Windows",
			PATHEXT: ".COM;.EXE;.BAT;.CMD",
			HOME: "C:\\Users\\player",
			USERPROFILE: "C:\\Users\\player",
			APPDATA: "C:\\Users\\player\\AppData\\Roaming",
			LOCALAPPDATA: "C:\\Users\\player\\AppData\\Local",
		});
	});

	test("/report writes the bundle to its own folder, then starts claude in the background on a prompt naming it and the note", async () => {
		const written: Array<[string, string]> = [];
		const calls: Array<Parameters<RunCommand>> = [];
		const run: RunCommand = async (...call) => (calls.push(call), { code: 0, output: started });
		const result = await startDebugSession(
			{ PI_CODING_AGENT_DIR: "/coach/pi-agent", PATH: "/bin", OPENAI_API_KEY: "sk-coach" },
			{ note: "wrong shard", sessionId: "mine", state: { lcu: { kind: "closed" } } },
			{ run, readText: (path) => (path.endsWith("exchanges.ndjson") ? exchangesText : ""), writeText: (path, text) => void written.push([path, text]), look, team: () => "Branch: main", now, platform: "darwin", home: "/Users/player", repo: "/repo" },
		);
		expect(result).toEqual({ ok: true, id: "5b9c0a21", bundlePath: `/coach/debug/${STAMP}/bundle.json` });
		expect(written.map(([path]) => path)).toEqual([`/coach/debug/${STAMP}/bundle.json`]);
		const tool = JSON.parse(written[0][1]).exchanges[0].tools[0];
		expect(tool.result.shards).toEqual(["Health Scaling"]);
		// A bundle leaves the machine: a Riot key that a tool result ever echoed is cut from it.
		expect(tool.result.echoed).toBe("key [redacted] seen");
		const [command, args, options] = calls[0];
		expect(command).toBe("claude");
		// The session is given this run's folder only, and the prompt sits behind "--": --add-dir takes any number of folders and would swallow it.
		expect(args.slice(0, 6)).toEqual(["--bg", "--name", "coach debug: wrong shard", "--add-dir", `/coach/debug/${STAMP}`, "--"]);
		expect(args).toHaveLength(7);
		expect(args[6]).toContain("What the player says is wrong: wrong shard");
		expect(args[6]).toContain(`/coach/debug/${STAMP}/bundle.json`);
		expect(options).toEqual({ cwd: "/repo", env: { PATH: "/bin", HOME: "/Users/player" } });
	});

	test("every key the coach holds is cut from the bundle, a bare one a 401 echoed included (#373)", async () => {
		let written = "";
		const logLine = JSON.stringify({ sessionId: "s1", msg: "401 invalid x-api-key sk-ant-FAKE-0000 and openrouter sk-or-FAKE-1111, brave BSA-FAKE-2222" });
		const result = await startDebugSession(
			{ PI_CODING_AGENT_DIR: "/h/pi-agent", ANTHROPIC_API_KEY: "sk-ant-FAKE-0000", OPENROUTER_API_KEY: "sk-or-FAKE-1111", BRAVE_API_KEY: "BSA-FAKE-2222" },
			{ note: "n", sessionId: "s1" },
			{ readText: (file) => (file.endsWith("coach.log.ndjson") ? logLine : ""), writeText: (_path, text) => void (written = text), run: async () => ({ code: 0, output: "backgrounded · abcdef12 · n" }), now, platform: "darwin", home: "/Users/player", repo: "/repo" },
		);
		expect(result.ok).toBe(true);
		expect(written).toContain("401 invalid x-api-key");
		for (const key of ["sk-ant-FAKE-0000", "sk-or-FAKE-1111", "BSA-FAKE-2222"]) expect(written).not.toContain(key);
	});

	test("a note with newlines or escape sequences reaches the session name and the prompt as one clean line", async () => {
		const calls: Array<Parameters<RunCommand>> = [];
		const run: RunCommand = async (...call) => (calls.push(call), { code: 0, output: started });
		await startDebugSession({ PI_CODING_AGENT_DIR: "/coach/pi-agent" }, { note: "wrong\nshard \x1b]0;title\x07here" }, { run, readText: () => "", writeText: () => {}, now, platform: "darwin", home: "/Users/player", repo: "/repo" });
		expect(calls[0][1][2]).toBe("coach debug: wrong shard here");
		expect(calls[0][1][6]).toContain("What the player says is wrong: wrong shard here\n");
	});

	test("only the newest ten bundles stay in the coach home", async () => {
		const home = mkdtempSync(join(tmpdir(), "voxren-debug-"));
		try {
			const debugDir = join(home, "debug");
			for (let day = 10; day <= 21; day++) mkdirSync(join(debugDir, `2025-12-${day}T00-00-00-000Z`), { recursive: true });
			writeFileSync(join(debugDir, "2025-12-01T00-00-00-000Z.json"), "{}");
			const result = await startDebugSession({ PI_CODING_AGENT_DIR: join(home, "pi-agent") }, { note: "x" }, { run: async () => ({ code: 0, output: started }), now, platform: "darwin", home: "/Users/player", repo: "/repo" });
			expect(result.ok).toBe(true);
			const kept = readdirSync(debugDir).sort();
			expect(kept).toHaveLength(10);
			expect(kept[0]).toBe("2025-12-13T00-00-00-000Z");
			expect(kept.at(-1)).toBe(STAMP);
			expect(readdirSync(join(debugDir, STAMP))).toEqual(["bundle.json"]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("the launcher's exit ends the wait even when a process it started still holds its output, and a silent one is given up on", async () => {
		// What `claude --bg` does: print the id, leave a background process behind that inherited the pipes, and exit.
		const launcher = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: "inherit", detached: true }).unref(); console.log("backgrounded · abc12345 · x");`;
		const options = { cwd: process.cwd(), env: process.env as Record<string, string> };
		const t0 = Date.now();
		const result = await runCommand(process.execPath, ["-e", launcher], options);
		expect(result.code).toBe(0);
		expect(result.output).toContain("backgrounded · abc12345 · x");
		expect(Date.now() - t0).toBeLessThan(3000);
		await expect(runCommand(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], options, 300)).rejects.toThrow("gave no answer");
	}, 10_000);

	test("/report typed while a run is going waits for the run to end, so the bundle holds it; a second one is told the first is waiting", async () => {
		const coach = coachWithoutHome();
		await coach.debug("wrong shard");
		await coach.debug("and the build");
		expect(coach.notes).toEqual([
			["The debug session starts when this run ends, with the run in it.", "info"],
			["A debug session is already waiting for this run to end.", "info"],
		]);
		await coach.settle();
		// One start for the run, not two.
		expect(coach.notes.slice(2)).toEqual([[DEBUG_NO_HOME_MESSAGE, "error"]]);
		// The wait is spent: the next run's end starts nothing more, and an idle coach starts at once.
		await coach.settle();
		coach.state.idle = true;
		await coach.debug("");
		expect(coach.notes.slice(3)).toEqual([[DEBUG_NO_HOME_MESSAGE, "error"]]);
	});

	test("a failed start says why and where the context was kept; nothing to send says what to do", async () => {
		const environment = { PI_CODING_AGENT_DIR: "/coach/pi-agent" };
		const deps = { readText: () => "", writeText: () => {}, platform: "darwin" as const, home: "/Users/player", repo: "/repo", now };
		const saved = `The context is saved at /coach/debug/${STAMP}/bundle.json.`;
		const enoent = async () => Promise.reject(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
		expect(await startDebugSession({}, { note: "x" }, deps)).toEqual({ ok: false, message: DEBUG_NO_HOME_MESSAGE });
		expect(await startDebugSession(environment, { note: "", sessionId: "mine" }, deps)).toEqual({ ok: false, message: DEBUG_NOTHING_MESSAGE });
		expect(await startDebugSession(environment, { note: "x" }, { ...deps, run: enoent })).toEqual({ ok: false, message: `/report needs Claude Code on PATH (the \`claude\` command): install it, then run /report again. ${saved}` });
		// Claude Code's own last line is text from outside: escape sequences are stripped before it reaches the terminal.
		const refused = await startDebugSession(environment, { note: "x" }, { ...deps, run: async () => ({ code: 1, output: "\x1b[31mNot logged in\x1b[0m\n" }) });
		expect(refused).toEqual({ ok: false, message: `Claude Code did not start a debug session (exit 1): Not logged in. ${saved}` });
		const hung = await startDebugSession(environment, { note: "x" }, { ...deps, run: async () => Promise.reject(new Error("`claude --bg` gave no answer in 30 seconds")) });
		expect(hung).toEqual({ ok: false, message: "/report failed: `claude --bg` gave no answer in 30 seconds" });
	});

	test("on Windows, Claude Code installed through npm is named as the cause, with the fix", async () => {
		const result = await startDebugSession(
			{ PI_CODING_AGENT_DIR: "C:\\coach\\pi-agent", PATH: "C:\\Windows;C:\\npm" },
			{ note: "x" },
			{ readText: () => "", writeText: () => {}, now, platform: "win32", home: "C:\\Users\\player", repo: "C:\\repo", exists: (path) => path === "C:\\npm\\claude.cmd", run: async () => Promise.reject(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })) },
		);
		expect(result).toEqual({ ok: false, message: `Claude Code here is the npm install (claude.cmd), which /report cannot start. Install the native build with \`claude install\`, then run /report again. The context is saved at C:\\coach\\debug\\${STAMP}\\bundle.json.` });
	});

	test("the prompt carries the picture, the screen, the newest run, and the team state, so the session starts without opening a file", async () => {
		let bundleText = "";
		const calls: Array<Parameters<RunCommand>> = [];
		const run: RunCommand = async (...call) => (calls.push(call), { code: 0, output: started });
		const team = (repo: string, env: Record<string, string>) => `Branch: main in ${repo} for ${env.HOME}\nOpen PRs:\n445 coach sweep`;
		await startDebugSession(
			{ PI_CODING_AGENT_DIR: "/coach/pi-agent", PATH: "/bin" },
			{ note: "wrong shard", sessionId: "mine" },
			{ run, readText: (path) => (path.endsWith("exchanges.ndjson") ? exchangesText : ""), writeText: (_path, text) => void (bundleText = text), look, team, now, platform: "darwin", home: "/Users/player", repo: "/repo" },
		);
		const prompt = calls[0][1][6];
		expect(prompt).toContain(`A picture of the coach window when the player typed /report: /coach/debug/${STAMP}/window.png. Look at it first.`);
		expect(prompt).toContain("<screen>\nVOXREN COACH\n> /review 3\nShards: Health Scaling\n</screen>");
		// The newest run inline, its tool results included; the system prompt stays in the bundle.
		expect(prompt).toContain('"answer":"second"');
		expect(prompt).toContain('"shards":["Health Scaling"]');
		expect(prompt).not.toContain("SYSTEM");
		// Team state is gathered in the player's environment, where gh is signed in.
		expect(prompt).toContain("<team>\nBranch: main in /repo for /Users/player\nOpen PRs:\n445 coach sweep\n</team>");
		expect(prompt).toContain("ListAgents");
		const bundle = JSON.parse(bundleText);
		expect(bundle.window.picture).toBe(`/coach/debug/${STAMP}/window.png`);
		expect(bundle.team).toContain("445 coach sweep");
	});

	test("outside WezTerm the session still starts, the prompt says there is no picture, and the player is told why", async () => {
		const calls: Array<Parameters<RunCommand>> = [];
		const run: RunCommand = async (...call) => (calls.push(call), { code: 0, output: started });
		const result = await startDebugSession({ PI_CODING_AGENT_DIR: "/coach/pi-agent" }, { note: "x" }, { run, readText: () => "", writeText: () => {}, team: () => "", now, platform: "darwin", home: "/Users/player", repo: "/repo" });
		const reason = "the coach is not running in its WezTerm window (`just coach` opens it there)";
		expect(result).toEqual({ ok: true, id: "5b9c0a21", bundlePath: `/coach/debug/${STAMP}/bundle.json`, noPicture: reason });
		expect(calls[0][1][6]).toContain(`No picture of the coach window: ${reason}.`);
		expect(calls[0][1][6]).toContain("(no finished run)");
	});

	test("a huge run is cut in the prompt, which stays under the Windows command-line limit, and says where the rest is", async () => {
		const calls: Array<Parameters<RunCommand>> = [];
		const run: RunCommand = async (...call) => (calls.push(call), { code: 0, output: started });
		const huge = line({ sessionId: "mine", answer: "a".repeat(50_000), tools: [{ name: "t", result: '"'.repeat(20_000) }] });
		const bigLook = async () => ({ screen: "s".repeat(20_000), missing: "x" });
		await startDebugSession({ PI_CODING_AGENT_DIR: "/coach/pi-agent" }, { note: "x", sessionId: "mine" }, { run, readText: (path) => (path.endsWith("exchanges.ndjson") ? huge : ""), writeText: () => {}, look: bigLook, team: () => "t".repeat(20_000), now, platform: "darwin", home: "/Users/player", repo: "/repo" });
		const prompt = calls[0][1][6];
		expect(prompt).toContain("(cut here; the rest is exchanges[0] in the bundle)");
		expect(prompt).toContain("(cut here; the rest is window.screen in the bundle)");
		expect(prompt).toContain("(cut here; the rest is team in the bundle)");
		// Every quote escaped on the way doubles: the worst case still fits in 32,767.
		expect(prompt.length + (prompt.match(/"/g)?.length ?? 0)).toBeLessThan(30_000);
	});

	test("the WezTerm window is read from the variables WezTerm gives its panes", () => {
		const windows = { WEZTERM_UNIX_SOCKET: "C:\\Users\\p\\.local/share/wezterm\\gui-sock-45504", WEZTERM_PANE: "0", WEZTERM_EXECUTABLE_DIR: "C:\\Program Files\\WezTerm" };
		expect(wezWindow(windows, "win32")).toEqual({ pid: 45504, pane: "0", socket: windows.WEZTERM_UNIX_SOCKET, cli: "C:\\Program Files\\WezTerm\\wezterm.exe" });
		expect(wezWindow({ WEZTERM_PANE: "0" })).toBeUndefined();
		expect(wezWindow({ ...windows, WEZTERM_UNIX_SOCKET: "/tmp/mux-sock" })).toBeUndefined();
	});

	test("the debug session starts in the main checkout, never in the worktree the coach runs from", async () => {
		const root = realpathSync.native(mkdtempSync(join(tmpdir(), "voxren-main-")));
		try {
			const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
			git("init", "-q");
			git("commit", "-q", "--allow-empty", "-m", "x");
			git("worktree", "add", "-q", join(root, ".claude", "worktrees", "dev"));
			const norm = (path: string) => path.replace(/\\/g, "/").toLowerCase();
			expect(norm(mainCheckout(join(root, ".claude", "worktrees", "dev")))).toBe(norm(root));
			expect(norm(mainCheckout(root))).toBe(norm(root));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
		// Not a repository: the coach's own folder, as before.
		expect(mainCheckout("/no/such/repo")).toBe("/no/such/repo");
		const calls: Array<Parameters<RunCommand>> = [];
		await startDebugSession({ PI_CODING_AGENT_DIR: "/coach/pi-agent" }, { note: "x" }, { run: async (...call) => (calls.push(call), { code: 0, output: started }), readText: () => "", writeText: () => {}, look, team: () => "", startIn: (repo) => `${repo}-main`, now, platform: "darwin", home: "/Users/player", repo: "/repo/.claude/worktrees/dev" });
		expect(calls[0][2].cwd).toBe("/repo/.claude/worktrees/dev-main");
	});
});
