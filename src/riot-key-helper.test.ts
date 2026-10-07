import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// The fakes are bash scripts; the real Windows DPAPI backend was verified by hand on Windows.
const describeUnix = describe.skipIf(process.platform === "win32");
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyStatus, SECRETS, STATE_FILE_NAME, probeUrlAllowed, psLiteral, sanitizeState, systemPowershell, testProbeUrlAllowed } from "./riot-key-helper.mjs";

/**
 * Deterministic coverage for the key custodian child. A fake `security`
 * binary stands in for the macOS Keychain and a local HTTP server stands in
 * for Riot. SENTINEL is a synthetic, format-valid credential; the assertions
 * prove it never reaches argv, stdout, the state file, or this test's output.
 */
const SENTINEL = ["RGAPI", "0badc0de", "0000", "4000", "8000", "5e11f1e1d0a7"].join("-");
// Perplexity's own format (`pplx-` prefix, matching riot-key.test.ts's PPLX_SENTINEL), for the live-probe tests below.
const PERPLEXITY_SENTINEL = "pplx-0badc0de0000111122223333";
// A synthetic Gemini-shaped value (Google keys start AIza today, but the helper pins no prefix), for the live-probe tests below.
const GEMINI_SENTINEL = ["AIza", "SyBadC0de", "0000111122223333444455"].join("");
const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, "riot-key-helper.mjs");
// Items are stored one file per `-a` account, the way distinct Keychain items would be.
const FAKE_SECURITY = `#!/bin/bash
dir=$(dirname "$0")
printf '%s\\n' "$*" >> "$dir/argv.log"
account_from_args() {
  prev=""
  for a in "$@"; do
    if [ "$prev" = "-a" ]; then printf '%s' "$a"; return; fi
    prev="$a"
  done
}
case "$1" in
  -i)
    line=$(cat)
    printf '%s\\n' "$line" >> "$dir/stdin.log"
    account=$(printf '%s' "$line" | sed -n 's/.* -a "\\([^"]*\\)".*/\\1/p')
    value=$(printf '%s' "$line" | sed -n 's/.* -w "\\([^"]*\\)".*/\\1/p')
    [ -n "$value" ] && [ -n "$account" ] || exit 1
    printf '%s' "$value" > "$dir/item-$account"
    exit 0
    ;;
  find-generic-password)
    shift
    account=$(account_from_args "$@")
    item="$dir/item-$account"
    [ -f "$item" ] || exit 44
    for a in "$@"; do
      if [ "$a" = "-w" ]; then [ -f "$dir/locked" ] && exit 51; cat "$item"; echo; exit 0; fi
    done
    echo 'attributes only'
    exit 0
    ;;
  delete-generic-password)
    shift
    account=$(account_from_args "$@")
    item="$dir/item-$account"
    [ -f "$item" ] || exit 44
    rm -f "$item"
    exit 0
    ;;
esac
exit 2
`;

/**
 * Fake `powershell.exe` standing in for Windows DPAPI: "encrypts" by base64 (never the
 * real algorithm, but enough to prove the JS side only ever moves the key over stdin/a
 * file it wrote itself, and never through argv). Positional $4 is the -Command script text.
 */
const FAKE_POWERSHELL = `#!/bin/bash
dir=$(dirname "$0")
printf '%s\\n' "$*" >> "$dir/argv.log"
script="$4"
if [[ "$script" == *"In.ReadLine"* ]]; then
  read -r line
  printf '%s\\n' "$line" >> "$dir/stdin.log"
  path=$(printf '%s' "$script" | sed -n "s/.*-LiteralPath '\\([^']*\\)' -NoNewline.*/\\1/p")
  printf '%s' "$line" | base64 > "$path"
  exit 0
elif [[ "$script" == *"NetworkCredential"* ]]; then
  path=$(printf '%s' "$script" | sed -n "s/^\\$p='\\([^']*\\)'.*/\\1/p")
  [ -f "$path" ] || exit 44
  base64 -d < "$path"
  exit 0
fi
exit 2
`;

const ALLOWED_TOP = new Set(["ok", "reason", "state"]);
const ALLOWED_STATE = new Set(["stored", "updatedAt", "lastTest"]);
const ALLOWED_TEST = new Set(["result", "at", "httpStatus"]);

let base: string;
let fakeDir: string;
let stateDir: string;
let server: Server;
let port = 0;
let upstreamStatus = 200;
/** Statuses answered first, one per request, before falling back to upstreamStatus. */
const upstreamQueue: number[] = [];
/** Every fake keychain dir and state dir a test below used. afterAll scans them all: no stored key may reach an argv log or a state file. */
const keyDirs: Array<{ fake: string; state: string }> = [];
/** Every key value a test below stored through the helper and the helper accepted. */
const storedValues = new Set<string>();
const noteStored = (action: string, input: string | undefined, output: { ok?: boolean }) => {
	if (action === "store" && output.ok === true && input?.trim()) storedValues.add(input.trim());
};
const seen: Array<{ headerMatches: boolean; riotToken: string | undefined; userAgent: string; method: string; url: string; authorization: string | undefined; googleKey: string | undefined; body: string }> = [];
const outputs: string[] = [];

/** Async spawn so the fake upstream in this process can answer while the helper runs. */
async function run(action: string, input?: string, extraEnv: Record<string, string> = {}) {
	const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
		const child = spawn(process.execPath, [HELPER, action, "riot"], {
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				VOXREN_RIOT_KEY_STATE_DIR: stateDir,
				VOXREN_RIOT_KEYCHAIN: join(fakeDir, "login.keychain-db"),
				VOXREN_RIOT_SECURITY_BIN: join(fakeDir, "security"),
				VOXREN_RIOT_PROBE_URL: `http://127.0.0.1:${port}/lol/status/v4/platform-data`,
				VOXREN_RIOT_FRESH_KEY_MS: "0",
				...extraEnv,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (status) => resolve({ status, stdout, stderr }));
		if (input !== undefined) child.stdin.write(input);
		child.stdin.end();
	});
	outputs.push(result.stdout, result.stderr);
	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	const output = JSON.parse(result.stdout);
	noteStored(action, input, output);
	return output;
}

function expectSanitizedShape(output: any) {
	for (const key of Object.keys(output)) expect(ALLOWED_TOP.has(key)).toBe(true);
	if (output.state) {
		for (const key of Object.keys(output.state)) expect(ALLOWED_STATE.has(key)).toBe(true);
		if (output.state.lastTest) for (const key of Object.keys(output.state.lastTest)) expect(ALLOWED_TEST.has(key)).toBe(true);
	}
}

beforeAll(async () => {
	base = mkdtempSync(join(tmpdir(), "voxren-riot-key-helper-"));
	fakeDir = join(base, "fake");
	stateDir = join(base, "state");
	mkdirSync(fakeDir, { recursive: true });
	writeFileSync(join(fakeDir, "security"), FAKE_SECURITY);
	chmodSync(join(fakeDir, "security"), 0o700);
	keyDirs.push({ fake: fakeDir, state: stateDir });
	server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			seen.push({
				headerMatches: request.headers["x-riot-token"] === SENTINEL,
				riotToken: request.headers["x-riot-token"] as string | undefined,
				userAgent: String(request.headers["user-agent"] ?? ""),
				method: request.method ?? "",
				url: request.url ?? "",
				authorization: request.headers.authorization,
				googleKey: request.headers["x-goog-api-key"] as string | undefined,
				body: Buffer.concat(chunks).toString("utf8"),
			});
			const status = upstreamQueue.shift() ?? upstreamStatus;
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify({ status: { status_code: status } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as { port: number }).port;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	const argvLog = (() => {
		try {
			return readFileSync(join(fakeDir, "argv.log"), "utf8");
		} catch {
			return "";
		}
	})();
	const stateFile = (() => {
		try {
			return readFileSync(join(stateDir, "riot-key-state.json"), "utf8");
		} catch {
			return "";
		}
	})();
	// The sentinel may appear only on the fake keychain's stdin and inside its item file. Scrubbed for
	// every secret this file exercises, not only Riot's RGAPI- shape (#36 stage 4).
	expect(argvLog).not.toContain(SENTINEL);
	expect(argvLog).not.toContain("RGAPI");
	expect(stateFile).not.toContain("RGAPI");
	expect(stateFile).not.toContain(String(SENTINEL.length));
	for (const sentinel of [SENTINEL, PERPLEXITY_SENTINEL, GEMINI_SENTINEL]) {
		expect(argvLog).not.toContain(sentinel);
		expect(stateFile).not.toContain(sentinel);
		for (const output of outputs) expect(output).not.toContain(sentinel);
	}
	// Every fixture's own dirs, not only the top-level Riot one: each secret has its own fake keychain, argv log, and state file.
	for (const { fake, state } of keyDirs) {
		const files = [join(fake, "argv.log"), ...(existsSync(state) ? readdirSync(state).map((name) => join(state, name)) : [])];
		for (const file of files) {
			const text = existsSync(file) ? readFileSync(file, "utf8") : "";
			for (const value of storedValues) expect(text).not.toContain(value);
		}
	}
	for (const output of outputs) expect(output).not.toContain("RGAPI");
});

describeUnix("riot key custodian child", () => {
	test("pure helpers classify and sanitize", () => {
		expect(classifyStatus(200)).toBe("ok");
		expect(classifyStatus(401)).toBe("rejected");
		expect(classifyStatus(403)).toBe("rejected");
		expect(classifyStatus(429)).toBe("rate_limited");
		expect(classifyStatus(503)).toBe("upstream");
		expect(probeUrlAllowed("https://na1.api.riotgames.com/lol/status/v4/platform-data")).toBe(true);
		expect(probeUrlAllowed("http://127.0.0.1:1/x")).toBe(true);
		expect(probeUrlAllowed("https://example.invalid/?key=1")).toBe(false);
		expect(probeUrlAllowed("http://na1.api.riotgames.com/plain")).toBe(false);
		// testProbeUrlAllowed adds exactly one more URL on top of probeUrlAllowed: this secret's own
		// hardcoded probeUrl (#36 stage 4) -- not the whole api.perplexity.ai host.
		const perplexityDescriptor = { probeUrl: "https://api.perplexity.ai/chat/completions" };
		expect(testProbeUrlAllowed("https://api.perplexity.ai/chat/completions", perplexityDescriptor)).toBe(true);
		expect(testProbeUrlAllowed("https://api.perplexity.ai/other-path", perplexityDescriptor)).toBe(false);
		expect(testProbeUrlAllowed("https://na1.api.riotgames.com/lol/status/v4/platform-data", perplexityDescriptor)).toBe(true);
		expect(testProbeUrlAllowed("https://evil.invalid/steal", { probeUrl: undefined })).toBe(false);
		expect(sanitizeState({ stored: true, key: "x", keyLength: 41, lastTest: { result: "ok", at: "2026-09-23T00:00:00Z", raw: "body" } })).toEqual({
			stored: true,
			lastTest: { result: "ok", at: "2026-09-23T00:00:00Z" },
		});
	});

	test("status before any store is sanitized and not stored", async () => {
		const output = await run("status");
		expectSanitizedShape(output);
		expect(output).toEqual({ ok: true, state: { stored: false } });
	});

	test("store refuses a non-Riot-shaped value before touching the keychain", async () => {
		const output = await run("store", "not-a-key\n");
		expectSanitizedShape(output);
		expect(output.ok).toBe(false);
		expect(output.reason).toBe("invalid_format");
		expect(output.state.stored).toBe(false);
		expect((await run("test")).reason).toBe("not_stored");
	});

	test("store hands the key over stdin and reports sanitized state only", async () => {
		const output = await run("store", `${SENTINEL}\n`);
		expectSanitizedShape(output);
		expect(output.ok).toBe(true);
		expect(output.state.stored).toBe(true);
		expect(typeof output.state.updatedAt).toBe("string");
		expect(output.state.lastTest).toBeUndefined();
		const stdinLog = readFileSync(join(fakeDir, "stdin.log"), "utf8");
		expect(stdinLog.includes(SENTINEL)).toBe(true);
		expect(stdinLog).toContain("add-generic-password -U");
		expect((await run("status")).state.stored).toBe(true);
	});

	test("explicit live test classifies each upstream outcome separately", async () => {
		const cases: Array<[number, string]> = [
			[200, "ok"],
			[401, "rejected"],
			[403, "rejected"],
			[429, "rate_limited"],
			[503, "upstream"],
		];
		for (const [status, result] of cases) {
			upstreamStatus = status;
			const output = await run("test");
			expectSanitizedShape(output);
			expect(output.ok).toBe(true);
			expect(output.state.lastTest.result).toBe(result);
			expect(output.state.lastTest.httpStatus).toBe(status);
			expect(output.state.stored).toBe(true);
		}
		expect(seen.length).toBe(cases.length);
		for (const request of seen) {
			expect(request.headerMatches).toBe(true);
			expect(request.userAgent).toContain("voxren-coach");
			expect(request.userAgent).not.toMatch(/^(node|undici)/i);
		}
	});

	test("a key stored moments ago that gets 401 is retried, and the later 200 is the verdict", async () => {
		upstreamStatus = 200;
		upstreamQueue.push(401);
		const before = seen.length;
		const output = await run("test", undefined, { VOXREN_RIOT_FRESH_KEY_MS: "120000" });
		expect(output.state.lastTest).toMatchObject({ result: "ok", httpStatus: 200 });
		expect(seen.length).toBe(before + 2);
	}, 10_000);

	test("transport failure and refused probe targets never become a key verdict", async () => {
		const closed = createServer();
		const closedPort = (() => {
			closed.listen(0, "127.0.0.1");
			const address = closed.address() as { port: number };
			closed.close();
			return address.port;
		})();
		const transport = await run("test", undefined, { VOXREN_RIOT_PROBE_URL: `http://127.0.0.1:${closedPort}/x` });
		expect(transport.ok).toBe(true);
		expect(transport.state.lastTest.result).toBe("transport");
		expect(transport.state.lastTest.httpStatus).toBeUndefined();
		const refused = await run("test", undefined, { VOXREN_RIOT_PROBE_URL: "https://evil.invalid/steal" });
		expect(refused.ok).toBe(false);
		expect(refused.reason).toBe("probe_url_refused");
	});

	test("a keychain read failure keeps the stored state and last verdict", async () => {
		upstreamStatus = 401;
		const rejected = await run("test");
		expect(rejected.state.lastTest.result).toBe("rejected");
		const probes = seen.length;
		writeFileSync(join(fakeDir, "locked"), "");
		try {
			const output = await run("test");
			expectSanitizedShape(output);
			expect(output.ok).toBe(false);
			expect(output.reason).toBe("keychain_read_failed");
			expect(output.state).toEqual(rejected.state);
			expect((await run("status")).state).toEqual(rejected.state);
			expect(seen.length).toBe(probes);
		} finally {
			rmSync(join(fakeDir, "locked"));
		}
	});

	test("remove deletes the item and resets the sanitized state", async () => {
		const output = await run("remove");
		expectSanitizedShape(output);
		expect(output).toEqual({ ok: true, state: { stored: false } });
		expect((await run("status")).state).toEqual({ stored: false });
		expect((await run("test")).reason).toBe("not_stored");
	});

	test("unknown or extra actions are refused", async () => {
		expect((await run("export")).reason).toBe("unknown_action");
	});

	test("status riot matches the pre-refactor output for a fresh install, byte for byte", () => {
		const base = mkdtempSync(join(tmpdir(), "voxren-riot-key-helper-fixture-"));
		const fixtureFakeDir = join(base, "fake");
		const fixtureStateDir = join(base, "state");
		mkdirSync(fixtureFakeDir, { recursive: true });
		writeFileSync(join(fixtureFakeDir, "security"), FAKE_SECURITY);
		chmodSync(join(fixtureFakeDir, "security"), 0o700);
		const result = spawnSync(process.execPath, [HELPER, "status", "riot"], {
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				VOXREN_RIOT_KEY_STATE_DIR: fixtureStateDir,
				VOXREN_RIOT_KEYCHAIN: join(fixtureFakeDir, "login.keychain-db"),
				VOXREN_RIOT_SECURITY_BIN: join(fixtureFakeDir, "security"),
			},
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		outputs.push(result.stdout, result.stderr);
		// This is exactly what `main(["status"])` printed before secretId existed, for a fresh
		// install with nothing stored: the generalized argv contract must not change one byte of it.
		expect(result.stdout).toBe('{"ok":true,"state":{"stored":false}}\n');
	});

	test("an unknown secret id is refused before any filesystem, Keychain, or DPAPI call", () => {
		const base = mkdtempSync(join(tmpdir(), "voxren-riot-key-helper-unknown-"));
		const unknownFakeDir = join(base, "fake");
		const unknownStateDir = join(base, "state");
		mkdirSync(unknownFakeDir, { recursive: true });
		writeFileSync(join(unknownFakeDir, "security"), FAKE_SECURITY);
		chmodSync(join(unknownFakeDir, "security"), 0o700);
		const result = spawnSync(process.execPath, [HELPER, "status", "nope"], {
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				VOXREN_RIOT_KEY_STATE_DIR: unknownStateDir,
				VOXREN_RIOT_KEYCHAIN: join(unknownFakeDir, "login.keychain-db"),
				VOXREN_RIOT_SECURITY_BIN: join(unknownFakeDir, "security"),
			},
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		outputs.push(result.stdout, result.stderr);
		expect(JSON.parse(result.stdout)).toEqual({ ok: false, reason: "unknown_secret" });
		// The fake `security` logs every invocation to argv.log; it never ran, and the state dir
		// was never created either, so unknown_secret short-circuited before any OS primitive.
		expect(existsSync(join(unknownFakeDir, "argv.log"))).toBe(false);
		expect(existsSync(unknownStateDir)).toBe(false);
	});
});

describeUnix("riot key custodian fetch action", () => {
	test("fetch attaches the key only inside the child and returns status plus body", async () => {
		upstreamStatus = 200;
		await run("store", SENTINEL);
		const before = seen.length;
		const out = await run("fetch", JSON.stringify({ url: `http://127.0.0.1:${port}/lol/match/v5/matches/NA1_1/timeline` }));
		expect(out.ok).toBe(true);
		expect(out.httpStatus).toBe(200);
		expect(JSON.parse(out.body)).toEqual({ status: { status_code: 200 } });
		expect(seen.length).toBe(before + 1);
		expect(seen[seen.length - 1].headerMatches).toBe(true);
		expect(out.body).not.toContain("RGAPI");
	});

	test("fetch records a 403 as a rejected key and a 200 as ok, so the header follows real calls", async () => {
		await run("store", SENTINEL);
		upstreamStatus = 403;
		expect((await run("fetch", JSON.stringify({ url: `http://127.0.0.1:${port}/lol/match/v5/matches/NA1_1/timeline` }))).httpStatus).toBe(403);
		expect((await run("status")).state.lastTest).toMatchObject({ result: "rejected", httpStatus: 403 });
		upstreamStatus = 200;
		await run("fetch", JSON.stringify({ url: `http://127.0.0.1:${port}/lol/match/v5/matches/NA1_1/timeline` }));
		expect((await run("status")).state.lastTest).toMatchObject({ result: "ok", httpStatus: 200 });
	});

	test("fetch refuses non-Riot hosts and malformed requests before reading the key", async () => {
		const before = seen.length;
		expect(await run("fetch", JSON.stringify({ url: "https://example.com/x" }))).toEqual({ ok: false, reason: "probe_url_refused" });
		expect(await run("fetch", "not json")).toEqual({ ok: false, reason: "invalid_format" });
		expect(seen.length).toBe(before);
	});

	test("fetch without a stored key reports not_stored", async () => {
		await run("remove");
		expect(await run("fetch", JSON.stringify({ url: `http://127.0.0.1:${port}/riot/account/v1/x` }))).toEqual({ ok: false, reason: "not_stored" });
	});
});

describeUnix("riot key custodian child (Windows DPAPI backend)", () => {
	// A separate fake dir/state dir from the macOS suite above: same helper process, same local
	// upstream server, but VOXREN_RIOT_PLATFORM forces the Windows branch so this runs on any host.
	let winFakeDir: string;
	let winStateDir: string;

	beforeAll(() => {
		const winBase = mkdtempSync(join(tmpdir(), "voxren-riot-key-helper-win-"));
		winFakeDir = join(winBase, "fake");
		winStateDir = join(winBase, "state");
		mkdirSync(winFakeDir, { recursive: true });
		mkdirSync(winStateDir, { recursive: true });
		writeFileSync(join(winFakeDir, "powershell"), FAKE_POWERSHELL);
		chmodSync(join(winFakeDir, "powershell"), 0o700);
	});

	async function runWin(action: string, input?: string) {
		const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
			const child = spawn(process.execPath, [HELPER, action, "riot"], {
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					VOXREN_RIOT_KEY_STATE_DIR: winStateDir,
					VOXREN_RIOT_PLATFORM: "win32",
					VOXREN_RIOT_POWERSHELL_BIN: join(winFakeDir, "powershell"),
					VOXREN_RIOT_PROBE_URL: `http://127.0.0.1:${port}/lol/status/v4/platform-data`,
					VOXREN_RIOT_FRESH_KEY_MS: "0",
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.on("data", (chunk) => (stderr += chunk));
			child.on("close", (status) => resolve({ status, stdout, stderr }));
			if (input !== undefined) child.stdin.write(input);
			child.stdin.end();
		});
		outputs.push(result.stdout, result.stderr);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		return JSON.parse(result.stdout);
	}

	test("status before any store is sanitized and not stored", async () => {
		expect(await runWin("status")).toEqual({ ok: true, state: { stored: false } });
	});

	test("store refuses a non-Riot-shaped value before touching the key store", async () => {
		const output = await runWin("store", "not-a-key\n");
		expectSanitizedShape(output);
		expect(output.ok).toBe(false);
		expect(output.reason).toBe("invalid_format");
		expect((await runWin("test")).reason).toBe("not_stored");
	});

	test("store hands the key over stdin only; the DPAPI file never contains it in the clear", async () => {
		const output = await runWin("store", `${SENTINEL}\n`);
		expectSanitizedShape(output);
		expect(output.ok).toBe(true);
		expect(output.state.stored).toBe(true);
		expect(typeof output.state.updatedAt).toBe("string");
		expect((await runWin("status")).state.stored).toBe(true);
		const encrypted = readFileSync(join(winStateDir, "riot-key.dpapi"), "utf8");
		expect(encrypted).not.toContain(SENTINEL);
	});

	test("live test decrypts through the fake DPAPI backend and classifies each upstream outcome", async () => {
		upstreamStatus = 200;
		expect((await runWin("test")).state.lastTest).toMatchObject({ result: "ok", httpStatus: 200 });
		upstreamStatus = 403;
		expect((await runWin("test")).state.lastTest).toMatchObject({ result: "rejected", httpStatus: 403 });
	});

	test("remove deletes the DPAPI file and resets the sanitized state", async () => {
		expect(await runWin("remove")).toEqual({ ok: true, state: { stored: false } });
		expect((await runWin("status")).state).toEqual({ stored: false });
		expect((await runWin("test")).reason).toBe("not_stored");
	});

	test("the sentinel reaches only stdin, never argv, across the whole Windows run", () => {
		const argvLog = readFileSync(join(winFakeDir, "argv.log"), "utf8");
		const stdinLog = readFileSync(join(winFakeDir, "stdin.log"), "utf8");
		expect(argvLog).not.toContain(SENTINEL);
		expect(argvLog).not.toContain("RGAPI");
		expect(stdinLog).toContain(SENTINEL);
	});
});

describeUnix("perplexity/typesafe/gemini descriptors: generic pre-check, per-secret format, and read (#36)", () => {
	/** A fresh fake keychain + state dir per secret under test, so cases never share stored state. */
	function fixture(secretId: string) {
		const base = mkdtempSync(join(tmpdir(), `voxren-riot-key-helper-${secretId}-`));
		const fake = join(base, "fake");
		const state = join(base, "state");
		mkdirSync(fake, { recursive: true });
		writeFileSync(join(fake, "security"), FAKE_SECURITY);
		chmodSync(join(fake, "security"), 0o700);
		keyDirs.push({ fake, state });
		const call = (action: string, input?: string) => {
			const result = spawnSync(process.execPath, [HELPER, action, secretId], {
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					VOXREN_RIOT_KEY_STATE_DIR: state,
					VOXREN_RIOT_KEYCHAIN: join(fake, "login.keychain-db"),
					VOXREN_RIOT_SECURITY_BIN: join(fake, "security"),
				},
				input,
				encoding: "utf8" as const,
			});
			outputs.push(result.stdout ?? "", result.stderr ?? "");
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			const output = JSON.parse(result.stdout);
			noteStored(action, input, output);
			return output;
		};
		return { call, fake, state };
	}

	test("the shared generic pre-check refuses empty, whitespace, angle brackets, and 'your key' (case-insensitive) before any per-secret format check -- the literal issue #36 bug", () => {
		for (const placeholder of ["", "   ", "\n", "pplx-<paste key here>", "pplx-your key", "Your Key: pplx-test", "<pplx-test>"]) {
			const output = fixture("perplexity").call("store", `${placeholder}\n`);
			expect(output.ok).toBe(false);
			expect(output.reason).toBe("invalid_format");
			expect(output.state.stored).toBe(false);
		}
	});

	test("perplexity requires the documented pplx- prefix on top of the generic check", () => {
		const wrongPrefix = fixture("perplexity").call("store", "sk-not-perplexity-shaped\n");
		expect(wrongPrefix.ok).toBe(false);
		expect(wrongPrefix.reason).toBe("invalid_format");

		const wellFormed = fixture("perplexity");
		const stored = wellFormed.call("store", "pplx-abcdefghijklmnop\n");
		expect(stored.ok).toBe(true);
		expect(stored.state.stored).toBe(true);
	});

	test("typesafe has no invented prefix: the generic check is the only gate", () => {
		const typesafe = fixture("typesafe");
		const placeholder = typesafe.call("store", "<your key>\n");
		expect(placeholder.ok).toBe(false);
		expect(placeholder.reason).toBe("invalid_format");

		const stored = typesafe.call("store", "an-arbitrary-typesafe-value\n");
		expect(stored.ok).toBe(true);
		expect(stored.state.stored).toBe(true);
	});

	test("read hands back the plaintext value once, sanitized to exactly {ok, value}", () => {
		const perplexity = fixture("perplexity");
		expect(perplexity.call("read")).toEqual({ ok: false, reason: "not_stored" });
		perplexity.call("store", "pplx-readback-value\n");
		expect(perplexity.call("read")).toEqual({ ok: true, value: "pplx-readback-value" });
	});

	test("read is never wired for riot, refused the same way an unknown action is", () => {
		expect(fixture("riot").call("read")).toEqual({ ok: false, reason: "unknown_action" });
	});

	test("gemini is a third secret with its own names, and its probe URL carries no key", () => {
		const gemini = SECRETS.gemini;
		expect(gemini).toMatchObject({ id: "gemini", keychainService: "voxren.gemini.api-key", keychainLabel: "Voxren Coach Gemini API key", dpapiFileName: "gemini-key.dpapi", stateFileName: "gemini-key-state.json" });
		// No two secrets share a keychain item, a label, or a file, so storing one can never overwrite another.
		for (const field of ["keychainService", "keychainLabel", "dpapiFileName", "stateFileName"] as const) {
			expect(new Set(Object.values(SECRETS).map((secret) => secret[field])).size).toBe(Object.keys(SECRETS).length);
		}
		const url = new URL(gemini.probeUrl as string);
		expect([url.protocol, url.host, url.pathname, url.search]).toEqual(["https:", "generativelanguage.googleapis.com", "/v1beta/models", "?pageSize=1"]);
		// The test action may reach exactly this URL; the same host with a key in the query is refused.
		expect(testProbeUrlAllowed(gemini.probeUrl as string, gemini)).toBe(true);
		expect(testProbeUrlAllowed(`${gemini.probeUrl}&key=x`, gemini)).toBe(false);
	});

	test("gemini has no invented prefix, keeps its own keychain item and state file, and reads back", () => {
		const gemini = fixture("gemini");
		expect(gemini.call("store", "<your key>\n")).toMatchObject({ ok: false, reason: "invalid_format" });
		expect(gemini.call("read")).toEqual({ ok: false, reason: "not_stored" });
		expect(gemini.call("store", "AIzaReadbackValue0000\n").ok).toBe(true);
		expect(gemini.call("read")).toEqual({ ok: true, value: "AIzaReadbackValue0000" });
		expect(readFileSync(join(gemini.fake, "stdin.log"), "utf8")).toContain('-s "voxren.gemini.api-key" -j "Voxren Coach Gemini API key"');
		expect(existsSync(join(gemini.state, "gemini-key-state.json"))).toBe(true);
		// The key went over stdin only: never argv, never the state file.
		expect(readFileSync(join(gemini.fake, "argv.log"), "utf8")).not.toContain("AIzaReadbackValue0000");
		expect(readFileSync(join(gemini.state, "gemini-key-state.json"), "utf8")).not.toContain("AIzaReadbackValue0000");
		expect(existsSync(join(gemini.state, STATE_FILE_NAME))).toBe(false);
	});

});

// Wrapped in describeUnix like every other block in this file, so windows-latest CI gives zero
// coverage of probeRequest/testProbeUrlAllowed -- no run of this suite, on either the real DPAPI
// backend or a bash-faked stand-in. A manual Windows launch check of /config > Keys > Perplexity
// (store, live test, remove) is outstanding for the owner, tracked against #24, per the spec's
// binding decision that any stage touching src/riot-key* states this plainly rather than implying
// CI coverage that doesn't exist.
describeUnix("perplexity live test: the real request shape (#36 stage 4)", () => {
	/** Own fake dir/state dir, and its own async spawn (spawnSync would block this process's event
	 * loop and the shared local server above could never answer) -- same shape as the top-of-file run(). */
	let liveFakeDir: string;
	let liveStateDir: string;

	beforeAll(() => {
		const base = mkdtempSync(join(tmpdir(), "voxren-riot-key-helper-pplx-live-"));
		liveFakeDir = join(base, "fake");
		liveStateDir = join(base, "state");
		mkdirSync(liveFakeDir, { recursive: true });
		writeFileSync(join(liveFakeDir, "security"), FAKE_SECURITY);
		chmodSync(join(liveFakeDir, "security"), 0o700);
		keyDirs.push({ fake: liveFakeDir, state: liveStateDir });
	});

	async function callLive(action: string, input?: string, secretId = "perplexity", probePath = "/chat/completions") {
		const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
			const child = spawn(process.execPath, [HELPER, action, secretId], {
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					VOXREN_RIOT_KEY_STATE_DIR: liveStateDir,
					VOXREN_RIOT_KEYCHAIN: join(liveFakeDir, "login.keychain-db"),
					VOXREN_RIOT_SECURITY_BIN: join(liveFakeDir, "security"),
					// Points the fixed test upstream at Perplexity's own action, standing in for the real
					// api.perplexity.ai host the same way the Riot suite above stands in for Riot's.
					VOXREN_RIOT_PROBE_URL: `http://127.0.0.1:${port}${probePath}`,
					VOXREN_RIOT_FRESH_KEY_MS: "0",
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.on("data", (chunk) => (stderr += chunk));
			child.on("close", (status) => resolve({ status, stdout, stderr }));
			if (input !== undefined) child.stdin.write(input);
			child.stdin.end();
		});
		outputs.push(result.stdout, result.stderr);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		const output = JSON.parse(result.stdout);
		noteStored(action, input, output);
		return output;
	}

	test("sends one POST with Authorization: Bearer <key>, the smallest model, and max_tokens 1 -- never the Riot X-Riot-Token shape -- and classifies the response by status like Riot's", async () => {
		const stored = await callLive("store", `${PERPLEXITY_SENTINEL}\n`);
		expect(stored.ok).toBe(true);

		upstreamStatus = 200;
		const before = seen.length;
		const ok = await callLive("test");
		expect(ok.ok).toBe(true);
		expect(ok.state.lastTest).toMatchObject({ result: "ok", httpStatus: 200 });
		expect(seen.length).toBe(before + 1);
		const request = seen[seen.length - 1];
		expect(request.method).toBe("POST");
		expect(request.authorization).toBe(`Bearer ${PERPLEXITY_SENTINEL}`);
		expect(request.riotToken).toBeUndefined(); // no X-Riot-Token header at all, whatever its value
		const body = JSON.parse(request.body);
		expect(body).toEqual({ model: "sonar", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });

		upstreamStatus = 401;
		expect((await callLive("test")).state.lastTest).toMatchObject({ result: "rejected", httpStatus: 401 });
		upstreamStatus = 429;
		expect((await callLive("test")).state.lastTest).toMatchObject({ result: "rate_limited", httpStatus: 429 });
	});

	test("typesafe's live test sends one Bearer POST with a single Jev question and classifies by status", async () => {
		expect((await callLive("store", "ts-live-value\n", "typesafe")).ok).toBe(true);
		upstreamStatus = 200;
		const before = seen.length;
		expect((await callLive("test", undefined, "typesafe")).state.lastTest).toMatchObject({ result: "ok", httpStatus: 200 });
		expect(seen.length).toBe(before + 1);
		const request = seen[seen.length - 1];
		expect(request.method).toBe("POST");
		expect(request.authorization).toBe("Bearer ts-live-value");
		expect(request.riotToken).toBeUndefined();
		const body = JSON.parse(request.body);
		expect(body.model).toBe("jev-latest");
		expect(Object.keys(body.questions)).toHaveLength(1);
		upstreamStatus = 401;
		expect((await callLive("test", undefined, "typesafe")).state.lastTest).toMatchObject({ result: "rejected", httpStatus: 401 });
	});

	test("gemini's live test is a free GET with the key only in x-goog-api-key, and Google's 400 for a bad key is a rejection", async () => {
		const path = "/v1beta/models?pageSize=1";
		expect((await callLive("store", `${GEMINI_SENTINEL}\n`, "gemini", path)).ok).toBe(true);
		upstreamStatus = 200;
		const before = seen.length;
		expect((await callLive("test", undefined, "gemini", path)).state.lastTest).toMatchObject({ result: "ok", httpStatus: 200 });
		expect(seen.length).toBe(before + 1);
		const request = seen[seen.length - 1];
		expect(request.method).toBe("GET");
		expect(request.body).toBe("");
		expect(request.url).toBe(path);
		expect(request.googleKey).toBe(GEMINI_SENTINEL);
		expect(request.authorization).toBeUndefined();
		expect(request.riotToken).toBeUndefined(); // no X-Riot-Token header at all, whatever its value
		for (const [status, result] of [[400, "rejected"], [403, "rejected"], [429, "rate_limited"], [503, "upstream"]] as const) {
			upstreamStatus = status;
			expect((await callLive("test", undefined, "gemini", path)).state.lastTest).toMatchObject({ result, httpStatus: status });
		}
		// 400 is a verdict on Gemini's key only: for Perplexity it stays "no verdict".
		expect((await callLive("store", `${PERPLEXITY_SENTINEL}\n`)).ok).toBe(true);
		upstreamStatus = 400;
		expect((await callLive("test")).state.lastTest).toMatchObject({ result: "upstream", httpStatus: 400 });
	});
});

describe("systemPowershell (#325)", () => {
	test("is an absolute path under SystemRoot, never a bare name", () => {
		expect(systemPowershell({ SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		expect(systemPowershell({})).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	});
});

describeUnix("Windows backend does not resolve powershell by name (#325)", () => {
	test("a powershell.exe on PATH is not run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-ps-plant-"));
		const marker = join(dir, "ran");
		writeFileSync(join(dir, "powershell.exe"), `#!/bin/bash\ntouch '${marker}'\nexit 0\n`);
		chmodSync(join(dir, "powershell.exe"), 0o700);
		const out = await new Promise<string>((resolve) => {
			const child = spawn(process.execPath, [HELPER, "read", "gemini"], {
				cwd: dir,
				env: { PATH: `${dir}:${process.env.PATH ?? ""}`, VOXREN_RIOT_KEY_STATE_DIR: join(dir, "state"), VOXREN_RIOT_PLATFORM: "win32", SystemRoot: join(dir, "nowhere") },
				stdio: ["ignore", "pipe", "ignore"],
			});
			let text = "";
			child.stdout.on("data", (chunk) => (text += chunk));
			child.on("close", () => resolve(text));
		});
		expect(existsSync(marker)).toBe(false);
		expect(JSON.parse(out).ok).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});
});

describeUnix("store refuses values that could rewrite the security -i line (#326)", () => {
	for (const secret of Object.keys(SECRETS)) {
		for (const bad of ['abc" -T "/bin/sh', "abc\\def", "abc def", ` ${secret}-lead`, "abc\u0007def"]) {
			test(`${secret} refuses ${JSON.stringify(bad)}`, async () => {
				const dir = mkdtempSync(join(tmpdir(), "voxren-store-bad-"));
				writeFileSync(join(dir, "security"), FAKE_SECURITY);
				chmodSync(join(dir, "security"), 0o700);
				const out = await new Promise<string>((resolve) => {
					const child = spawn(process.execPath, [HELPER, "store", secret], {
						env: { PATH: process.env.PATH ?? "/usr/bin:/bin", VOXREN_RIOT_KEY_STATE_DIR: join(dir, "state"), VOXREN_RIOT_SECURITY_BIN: join(dir, "security"), VOXREN_RIOT_KEYCHAIN: join(dir, "kc") },
						stdio: ["pipe", "pipe", "ignore"],
					});
					let text = "";
					child.stdout.on("data", (chunk) => (text += chunk));
					child.on("close", () => resolve(text));
					child.stdin.end(`${bad}\n`);
				});
				expect(JSON.parse(out)).toMatchObject({ ok: false, reason: "invalid_format" });
				expect(existsSync(join(dir, "argv.log"))).toBe(false);
				rmSync(dir, { recursive: true, force: true });
			});
		}
	}
});

describe("psLiteral (#327)", () => {
	/** PowerShell's own reading of a '...' literal: any of the four typographic quotes or ' ends it unless doubled. */
	function parseLiteral(text: string): { value: string; end: number } {
		const quotes = "'\u2018\u2019\u201A\u201B";
		let value = "";
		let i = 1;
		for (; i < text.length; i++) {
			if (quotes.includes(text[i])) {
				if (i + 1 >= text.length || !quotes.includes(text[i + 1])) break;
				i++;
			}
			value += text[i];
		}
		return { value, end: i };
	}
	for (const path of ["C:\\Users\\O'Brien", "C:\\Users\\O\u2019Brien", "C:\\Users\\a\u2018b\u201Ac\u201Bd", "x'; Remove-Item -r C:\\ #\u2019"]) {
		test(`one balanced literal for ${JSON.stringify(path)}`, () => {
			const literal = psLiteral(path);
			expect(parseLiteral(literal)).toEqual({ value: path, end: literal.length - 1 });
		});
	}
});

describeUnix("read ends its key-store child on its own deadline (#328)", () => {
	test("a hung security is killed before the launcher's kill, and the reason says timeout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-read-hang-"));
		const pidFile = join(dir, "pid");
		writeFileSync(join(dir, "security"), `#!/bin/bash\necho $$ > '${pidFile}'\nexec sleep 30\n`);
		chmodSync(join(dir, "security"), 0o700);
		const started = Date.now();
		const out = await new Promise<string>((resolve) => {
			const child = spawn(process.execPath, [HELPER, "read", "gemini"], {
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", VOXREN_RIOT_KEY_STATE_DIR: join(dir, "state"), VOXREN_RIOT_SECURITY_BIN: join(dir, "security") },
				stdio: ["ignore", "pipe", "ignore"],
			});
			let text = "";
			child.stdout.on("data", (chunk) => (text += chunk));
			child.on("close", () => resolve(text));
		});
		expect(Date.now() - started).toBeLessThan(4000);
		expect(JSON.parse(out)).toEqual({ ok: false, reason: "timeout" });
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
		rmSync(dir, { recursive: true, force: true });
	});

	test("status asked for the deadline (the launcher does) ends its child on it, answers timeout, and leaves the saved state alone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-status-hang-"));
		const state = join(dir, "state");
		mkdirSync(state, { recursive: true });
		const stateFile = join(state, "gemini-key-state.json");
		const saved = JSON.stringify({ stored: true, updatedAt: "2026-01-01T00:00:00.000Z" });
		writeFileSync(stateFile, saved);
		const pidFile = join(dir, "pid");
		writeFileSync(join(dir, "security"), `#!/bin/bash\necho $$ > '${pidFile}'\nexec sleep 30\n`);
		chmodSync(join(dir, "security"), 0o700);
		const started = Date.now();
		const out = await new Promise<string>((resolve) => {
			const child = spawn(process.execPath, [HELPER, "status", "gemini"], {
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", VOXREN_RIOT_KEY_STATE_DIR: state, VOXREN_RIOT_SECURITY_BIN: join(dir, "security"), VOXREN_SECRET_DEADLINE: "1" },
				stdio: ["ignore", "pipe", "ignore"],
			});
			let text = "";
			child.stdout.on("data", (chunk) => (text += chunk));
			child.on("close", () => resolve(text));
		});
		expect(Date.now() - started).toBeLessThan(4000);
		expect(JSON.parse(out)).toEqual({ ok: false, reason: "timeout" });
		expect(readFileSync(stateFile, "utf8")).toBe(saved);
		expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
		rmSync(dir, { recursive: true, force: true });
	});
});
