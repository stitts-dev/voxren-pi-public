import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveQuestionPrompt } from "../contracts";
import { freezeSession, sessionsIn, writeFrozen, type Logged } from "./freeze.ts";
import { loadStories } from "./stories.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SESSION = "01a1062f-aaaa-bbbb-cccc-000000000001";

/** A made-up log: another session's run in the middle, an auto run, a run from before the log kept the typed line, a question from before it too. */
const LOG: Logged[] = [
	{ ts: "2026-10-04T10:00:00.000Z", sessionId: SESSION, command: "matchup", input: "/matchup Syndra", prompt: "composed matchup prompt" },
	{ ts: "2026-10-04T10:01:00.000Z", sessionId: "other-session", input: "someone else's question", prompt: "someone else's question" },
	{ ts: "2026-10-04T10:02:00.000Z", sessionId: SESSION, command: "draft:auto", prompt: "composed draft prompt" },
	{ ts: "2026-10-04T10:03:00.000Z", sessionId: SESSION, input: "why not Ignite?", prompt: "why not Ignite?" },
	{ ts: "2026-10-04T10:04:00.000Z", sessionId: SESSION, command: "build", prompt: "composed build prompt" },
	{ ts: "2026-10-04T10:05:00.000Z", sessionId: SESSION, prompt: "when do I back?" },
];

const typed = (story: { steps: unknown[] }) => story.steps.filter((step) => "send" in (step as object)).map((step) => (step as { send: string }).send);
const inTemp = <T>(run: (dir: string) => T): T => {
	const dir = mkdtempSync(join(tmpdir(), "freeze-test-"));
	try {
		return run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

describe("freezeSession", () => {
	test("one send per typed turn of that session, in order, each followed by a wait for its run", () => {
		const { story } = freezeSession(LOG, { sessionId: SESSION, split: "holdout" });
		expect(typed(story)).toEqual(["/matchup Syndra", "why not Ignite?", "when do I back?"]);
		expect(story.steps).toEqual([{ send: "/matchup Syndra" }, { idle: true }, { send: "why not Ignite?" }, { idle: true }, { send: "when do I back?" }, { idle: true }]);
		expect(story.split).toBe("holdout");
		expect(story.id).toBe(`frozen-${SESSION}`);
		expect(story.gates.maxSeconds).toBe(3 * 180);
	});

	test("two sessions that share their first 8 characters (UUIDv7 ids started a minute apart do) get different ids and titles", () => {
		const other = "01a1062f-dddd-eeee-ffff-000000000002";
		const story = (sessionId: string) => freezeSession([{ ts: "t1", sessionId, input: "hi", prompt: "hi" }], { sessionId, split: "train" }).story;
		const first = story(SESSION);
		const second = story(other);
		expect(SESSION.slice(0, 8)).toBe(other.slice(0, 8));
		expect(second.id).not.toBe(first.id);
		expect(second.title).not.toBe(first.title);
	});

	test("an automatic run is left out, with a note", () => {
		const { skipped } = freezeSession(LOG, { sessionId: SESSION, split: "train" });
		expect(skipped.find((item) => item.kind === "auto")).toEqual({ ts: "2026-10-04T10:02:00.000Z", kind: "auto", note: "automatic draft run, not typed" });
	});

	test("a command run from before the log kept the typed line is reported, not guessed", () => {
		const { story, skipped } = freezeSession(LOG, { sessionId: SESSION, split: "train" });
		expect(skipped.find((item) => item.kind === "old-format")).toEqual({ ts: "2026-10-04T10:04:00.000Z", kind: "old-format", note: "build run logged before the typed line was kept: its arguments are unknown" });
		expect(JSON.stringify(story)).not.toContain("composed build prompt");
		expect(skipped).toHaveLength(2);
	});

	test("a Riot ID in a typed turn, a key, and a known account's bare name do not reach the file", () => {
		const log: Logged[] = [
			{ ts: "t1", sessionId: SESSION, input: "audit Hide on bush#KR1 please", prompt: "x" },
			{ ts: "t2", sessionId: SESSION, input: "key RGAPI-1111-2222-3333 is set", prompt: "x" },
			{ ts: "t3", sessionId: SESSION, input: "why did ZedMain lose lane", prompt: "x" },
		];
		const file = inTemp((dir) => readFileSync(writeFrozen(freezeSession(log, { sessionId: SESSION, split: "train", accounts: ["ZedMain#NA1"] }), dir), "utf8"));
		for (const leaked of ["Hide on bush", "KR1", "RGAPI", "1111-2222", "ZedMain"]) expect(file).not.toContain(leaked);
		expect(file).toContain("[riot-id]");
	});

	test("a question typed in a live game freezes as the question, not the game read above it", () => {
		const composed = liveQuestionPrompt("Game: Hide on bush#KR1 (you) Syndra vs Zed, 4:10", "should I back now?");
		const log: Logged[] = [{ ts: "t1", sessionId: SESSION, input: composed, prompt: composed }];
		const { story } = freezeSession(log, { sessionId: SESSION, split: "train" });
		expect(typed(story)).toEqual(["should I back now?"]);
	});

	test("the name flag becomes the story id", () => {
		expect(freezeSession(LOG, { sessionId: SESSION, split: "train", name: "frozen-lane-night" }).story.id).toBe("frozen-lane-night");
	});
});

describe("writeFrozen", () => {
	test("the file it writes passes the story loader and holds what was frozen", () => {
		const frozen = freezeSession(LOG, { sessionId: SESSION, split: "train" });
		inTemp((dir) => {
			const path = writeFrozen(frozen, dir);
			expect(path).toBe(join(dir, `${frozen.story.id}.json`));
			expect(loadStories(dir)).toEqual([frozen.story]);
		});
	});

	test("a story with no steps (a session with no typed turn) writes nothing", () => {
		const frozen = freezeSession([{ ts: "t1", sessionId: SESSION, command: "draft:auto", prompt: "p" }], { sessionId: SESSION, split: "train" });
		inTemp((dir) => {
			expect(() => writeFrozen(frozen, dir)).toThrow("steps must be a non-empty list");
			expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
		});
	});

	test("a second freeze to the same file is refused, names the file, and keeps the first", () => {
		inTemp((dir) => {
			const path = writeFrozen(freezeSession(LOG, { sessionId: SESSION, split: "train" }), dir);
			const first = readFileSync(path, "utf8");
			expect(() => writeFrozen(freezeSession(LOG, { sessionId: SESSION, split: "holdout" }), dir)).toThrow(path);
			expect(readFileSync(path, "utf8")).toBe(first);
		});
	});

	// The file holds the player's typed questions: owner only. Windows has no such mode bits.
	test.skipIf(process.platform === "win32")("the file is readable by its owner only, and so is the folder made for it", () => {
		inTemp((dir) => {
			const out = join(dir, "out");
			const path = writeFrozen(freezeSession(LOG, { sessionId: SESSION, split: "train" }), out);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(statSync(out).mode & 0o777).toBe(0o700);
		});
	});

	test("an id the loader would refuse writes nothing", () => {
		const frozen = freezeSession(LOG, { sessionId: SESSION, split: "train", name: "Not An Id" });
		inTemp((dir) => {
			expect(() => writeFrozen(frozen, dir)).toThrow("id must be lowercase letters, digits, dashes");
			expect(readdirSync(dir)).toEqual([]);
		});
	});

	// A copied mirror (`just devbox`) has no history, so git cannot answer there.
	const inGit = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: REPO }).status === 0;
	test.skipIf(!inGit)("a folder in the repository that git tracks is refused", () => {
		const frozen = freezeSession(LOG, { sessionId: SESSION, split: "train", name: "frozen-refused" });
		const file = join(REPO, "data", "lab", "stories", "frozen-refused.json");
		try {
			expect(() => writeFrozen(frozen, dirname(file))).toThrow("inside the repository and not git-ignored");
			expect(existsSync(file)).toBe(false);
		} finally {
			// A guard that failed would have written a real-looking story into the tree: never leave it for the next run.
			rmSync(file, { force: true });
		}
	});
});

describe("sessionsIn", () => {
	test("each session once, with its first run's time and its run count", () => {
		expect(sessionsIn(LOG)).toEqual([
			{ sessionId: SESSION, first: "2026-10-04T10:00:00.000Z", runs: 5 },
			{ sessionId: "other-session", first: "2026-10-04T10:01:00.000Z", runs: 1 },
		]);
	});
});

describe("the command", () => {
	const runWith = (env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, ["run", join(REPO, "src", "lab", "freeze.ts"), ...args], { encoding: "utf8", env: { ...process.env, VOXREN_COACH_ACCOUNTS: "", ...env } });
	const run = (...args: string[]) => runWith({}, ...args);
	const writeLog = (dir: string, entries: Logged[]) => {
		const log = join(dir, "exchanges.ndjson");
		writeFileSync(log, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		return log;
	};

	test("reads a log, writes the story to --out, and names what it left out", () => {
		inTemp((dir) => {
			const log = join(dir, "exchanges.ndjson");
			writeFileSync(log, `${LOG.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			const out = join(dir, "out");
			const result = run(SESSION, "--split", "train", "--from", log, "--out", out);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("3 typed turns");
			expect(result.stdout).toContain("automatic draft run, not typed");
			expect(result.stdout).toContain("build run logged before the typed line was kept");
			expect(typed(loadStories(out)[0])).toEqual(["/matchup Syndra", "why not Ignite?", "when do I back?"]);
		});
	});

	test("an unknown session exits 1 and lists the sessions the log holds", () => {
		inTemp((dir) => {
			const log = join(dir, "exchanges.ndjson");
			writeFileSync(log, `${LOG.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			const result = run("nope", "--split", "train", "--from", log, "--out", join(dir, "out"));
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(SESSION);
		});
	});

	test("a session with no typed turn exits 1, names the session and each run it left out, and writes nothing", () => {
		inTemp((dir) => {
			const log = writeLog(dir, [
				{ ts: "2026-10-04T10:04:00.000Z", sessionId: SESSION, command: "build", prompt: "composed build prompt" },
				{ ts: "2026-10-04T10:05:00.000Z", sessionId: SESSION, command: "draft:auto", prompt: "composed draft prompt" },
			]);
			const out = join(dir, "out");
			const result = run(SESSION, "--split", "train", "--from", log, "--out", out);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`session ${SESSION} has no typed turn`);
			expect(result.stderr).toContain("2026-10-04T10:04:00.000Z: build run logged before the typed line was kept");
			expect(result.stderr).toContain("2026-10-04T10:05:00.000Z: automatic draft run, not typed");
			expect(existsSync(out)).toBe(false);
		});
	});

	test("the player's known accounts come from the profile beside the log, so their bare name is scrubbed", () => {
		inTemp((dir) => {
			const log = writeLog(dir, [{ ts: "t1", sessionId: SESSION, input: "why did ZedMain lose lane", prompt: "x" }]);
			writeFileSync(join(dir, "profile.json"), JSON.stringify({ riotIds: { primary: "ZedMain#NA1", known: ["ZedMain#NA1"] } }));
			const out = join(dir, "out");
			expect(run(SESSION, "--split", "train", "--from", log, "--out", out).status).toBe(0);
			const file = readFileSync(join(out, readdirSync(out)[0]), "utf8");
			expect(file).not.toContain("ZedMain");
			expect(file).toContain("[riot-id]");
		});
	});

	test("--split and --name reach the story, and the accounts in VOXREN_COACH_ACCOUNTS are scrubbed with no profile", () => {
		inTemp((dir) => {
			const log = writeLog(dir, [{ ts: "t1", sessionId: SESSION, input: "why did ZedMain lose lane", prompt: "x" }]);
			const out = join(dir, "out");
			const result = runWith({ VOXREN_COACH_ACCOUNTS: "ZedMain#NA1" }, SESSION, "--split", "holdout", "--name", "frozen-lane-night", "--from", log, "--out", out);
			expect(result.status).toBe(0);
			expect(readdirSync(out)).toEqual(["frozen-lane-night.json"]);
			const file = readFileSync(join(out, "frozen-lane-night.json"), "utf8");
			expect(loadStories(out)[0].split).toBe("holdout");
			expect(file).not.toContain("ZedMain");
			expect(file).toContain("[riot-id]");
		});
	});

	// Each message is matched on text only the running command can print (the joined splits, the quoted value): Bun's
	// error frame shows the source line, so a bare "--split" would match whatever threw.
	test("--split is required: without it the usage is printed and nothing is written", () => {
		inTemp((dir) => {
			const out = join(dir, "out");
			const result = run(SESSION, "--from", writeLog(dir, LOG), "--out", out);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("--split must be train or holdout\nusage: freeze.ts <sessionId> --split train|holdout");
			expect(existsSync(out)).toBe(false);
		});
	});

	test("without a session id the usage is printed and nothing is written", () => {
		inTemp((dir) => {
			const out = join(dir, "out");
			const result = run("--split", "train", "--from", writeLog(dir, LOG), "--out", out);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("usage: freeze.ts <sessionId> --split train|holdout");
			expect(existsSync(out)).toBe(false);
		});
	});

	test("a --split that is not train or holdout is refused by name, and nothing is written", () => {
		inTemp((dir) => {
			const out = join(dir, "out");
			const result = run(SESSION, "--split", "trian", "--from", writeLog(dir, LOG), "--out", out);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('--split must be train or holdout, not "trian"');
			expect(existsSync(out)).toBe(false);
		});
	});

	test("with no --from and no --out it reads the coach home's log and writes to frozen-stories inside it", () => {
		inTemp((home) => {
			writeLog(home, LOG);
			const result = runWith({ VOXREN_COACH_HOME: home }, SESSION, "--split", "train");
			expect(result.status).toBe(0);
			const out = join(home, "frozen-stories");
			expect(readdirSync(out)).toHaveLength(1);
			expect(typed(loadStories(out)[0])).toEqual(["/matchup Syndra", "why not Ignite?", "when do I back?"]);
		});
	});
});
