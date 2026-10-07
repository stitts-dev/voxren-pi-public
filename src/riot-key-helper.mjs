#!/usr/bin/env node
// Secret key custodian for Voxren Coach (Riot Development key today; Perplexity, Typesafe, and
// Gemini share the same store, one field-set per secret in SECRETS below).
//
// This child process is the only code that ever holds a key. The extension spawns it with an
// action and a secret id, and receives one sanitized JSON line on stdout. The key travels in
// exactly two places: the masked input -> this process's stdin (store), and the macOS Keychain
// -> this process's memory -> one Riot request header (test). It never appears in argv,
// environment, stdout, stderr, state files, or thrown errors.
//
// Actions:
//   status  -> { ok, state }            sanitized persisted state, no network
//   store   -> { ok, state | reason }   key read from stdin, written via `security -i`
//   test    -> { ok, state | reason }   one explicit probe of a narrow Riot endpoint
//   remove  -> { ok, state }            delete the keychain item and reset state
//   fetch   -> { ok, httpStatus, body } one GET against an allowlisted Riot API
//                                      URL read as JSON {url} from stdin; the
//                                      key is attached here and only here
//   read    -> { ok, value | reason }   perplexity/typesafe/gemini only, never riot: the plaintext
//                                      value once, for bin/coach.mjs's env>dotenv>store
//                                      precedence. Sanitized of everything else.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const DPAPI_FILE_NAME = "riot-key.dpapi";

export const KEYCHAIN_ACCOUNT = "voxren-coach";
export const KEYCHAIN_SERVICE = "voxren.riot.dev-key";
export const KEYCHAIN_LABEL = "Voxren Coach Riot Development key";
export const STATE_FILE_NAME = "riot-key-state.json";
export const DEFAULT_PROBE_URL = "https://na1.api.riotgames.com/lol/status/v4/platform-data";
export const PROBE_TIMEOUT_MS = 10_000;
// A just-created key can be refused for a short while before the provider accepts it (seen with
// Riot dev keys: 401 one second after storing, 200 minutes later). Within FRESH_KEY_MS of a store, a
// 401/403 is retried every FRESH_RETRY_DELAY_MS until FRESH_RETRY_BUDGET_MS, all inside the 20 s
// HELPER_TIMEOUT_MS in src/riot-key.ts.
export const FRESH_KEY_MS = 120_000;
const FRESH_RETRY_DELAY_MS = 3_000;
const FRESH_RETRY_BUDGET_MS = 12_000;
const FRESH_RETRY_PROBE_TIMEOUT_MS = 5_000;
// Riot rejects Node's default user agent at the edge; identify the probe plainly.
const PROBE_USER_AGENT = "voxren-coach-riot-key-probe/1";
// Riot Development keys are `RGAPI-` plus a UUID. Anything else is refused
// before it can reach the keychain command line.
const KEY_FORMAT = /^RGAPI-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Perplexity documents this prefix; the shared generic pre-check below (empty/placeholder) covers the rest.
const PERPLEXITY_KEY_FORMAT = /^pplx-\S+$/;

/**
 * @typedef {object} SecretDescriptor
 * @property {string} id
 * @property {string} keychainService
 * @property {string} keychainLabel
 * @property {string} dpapiFileName
 * @property {string} stateFileName
 * @property {RegExp} [keyFormat]
 * @property {string} [probeUrl]
 */

// One entry per secret id. keyFormat and probeUrl are optional: a secret without keyFormat still gets
// the shared generic pre-check on store; one without probeUrl reports "no probe configured".
/** @type {Record<string, SecretDescriptor>} */
export const SECRETS = {
	riot: {
		id: "riot",
		keychainService: KEYCHAIN_SERVICE,
		keychainLabel: KEYCHAIN_LABEL,
		dpapiFileName: DPAPI_FILE_NAME,
		stateFileName: STATE_FILE_NAME,
		keyFormat: KEY_FORMAT,
		probeUrl: DEFAULT_PROBE_URL,
	},
	perplexity: {
		id: "perplexity",
		keychainService: "voxren.perplexity.api-key",
		keychainLabel: "Voxren Coach Perplexity API key",
		dpapiFileName: "perplexity-key.dpapi",
		stateFileName: "perplexity-key-state.json",
		keyFormat: PERPLEXITY_KEY_FORMAT,
		// The real billed POST call, wired for the /config Keys panel stage (#36 stage 4).
		probeUrl: "https://api.perplexity.ai/chat/completions",
	},
	typesafe: {
		id: "typesafe",
		keychainService: "voxren.typesafe.api-key",
		keychainLabel: "Voxren Coach Typesafe API key",
		dpapiFileName: "typesafe-key.dpapi",
		stateFileName: "typesafe-key-state.json",
		// ponytail: no known Typesafe key-format prefix; add one once TypeSafe publishes it.
		// The same endpoint src/passage-judge.ts calls; the probe sends one tiny billed question.
		probeUrl: "https://api.typesafe.ai/v1/systemone",
	},
	gemini: {
		id: "gemini",
		keychainService: "voxren.gemini.api-key",
		keychainLabel: "Voxren Coach Gemini API key",
		dpapiFileName: "gemini-key.dpapi",
		stateFileName: "gemini-key-state.json",
		// ponytail: no Google-documented key prefix to pin; add one if Google ever publishes it.
		// Listing one model is free, so unlike the other two this probe costs nothing. The key goes in a header, never this URL.
		probeUrl: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
	},
};

/** Same rejection for every secret, ahead of any per-secret format: an empty value or an obvious
 * placeholder (a docs-style `<your key>`) never reaches a keychain or DPAPI write. This is the
 * literal issue #36 bug: `echo 'PERPLEXITY_API_KEY=<your key>' >> .env` stored the placeholder verbatim. */
/** @param {string} key */
export function looksLikePlaceholder(key) {
	const trimmed = key.trim();
	if (!trimmed) return true;
	if (trimmed.includes("<") || trimmed.includes(">")) return true;
	return /your key/i.test(trimmed);
}

/** A secret's own shape on top of the generic check (Riot's UUID pattern, Perplexity's `pplx-` prefix);
 * a secret with no keyFormat (Typesafe today) accepts anything the generic check already passed. */
/**
 * @param {SecretDescriptor} descriptor
 * @param {string} key
 */
function matchesKeyFormat(descriptor, key) {
	return descriptor.keyFormat ? descriptor.keyFormat.test(key) : true;
}

/**
 * @param {SecretDescriptor} descriptor
 * @param {string} key
 */
function keyFormatOk(descriptor, key) {
	// `security -i` takes its whole command from one line, so a quote, backslash, space or control character
	// would split or rewrite it. None occurs in a real key; refuse them for every secret.
	if (/[\s"\\\p{Cc}]/u.test(key)) return false;
	return !looksLikePlaceholder(key) && matchesKeyFormat(descriptor, key);
}

// `read` and the launcher's `status` run at every launch behind bin/coach.mjs's 5 s kill of this process, which would leave a hung
// `security` or PowerShell behind: its children end sooner, on this deadline.
const READ_DEADLINE_MS = 2_500;
const MAX_STDIN_BYTES = 256;
const MAX_FETCH_STDIN_BYTES = 1024;
const MAX_FETCH_BODY_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_USER_AGENT = "voxren-coach-riot-fetch/1";
const RESULTS = new Set(["ok", "rejected", "rate_limited", "upstream", "transport"]);

/**
 * @typedef {object} SecretConfig
 * @property {string} stateDir
 * @property {string} platform
 * @property {string} [keychain]
 * @property {string} securityBin
 * @property {string} powershellBin
 * @property {string} [probeUrl]
 * @property {number} freshKeyMs
 * @property {number} [deadlineMs] epoch ms after which no key-store child is started and a running one is killed
 */

/**
 * Windows PowerShell by absolute path from SystemRoot, so neither the cwd nor PATH can supply the binary
 * (libuv looks in the cwd first for a bare name on Windows).
 * @param {NodeJS.ProcessEnv} env
 */
export function systemPowershell(env) {
	return win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** @returns {SecretConfig} */
function config(env = process.env) {
	const stateDir = env.VOXREN_RIOT_KEY_STATE_DIR;
	if (!stateDir) throw new Error("state dir missing");
	return {
		stateDir,
		// VOXREN_RIOT_PLATFORM lets tests force the Windows (DPAPI) backend from any host; real
		// launches never set it, so this always falls through to the actual OS.
		platform: env.VOXREN_RIOT_PLATFORM || process.platform,
		keychain: env.VOXREN_RIOT_KEYCHAIN || undefined,
		securityBin: env.VOXREN_RIOT_SECURITY_BIN || "/usr/bin/security",
		powershellBin: env.VOXREN_RIOT_POWERSHELL_BIN || systemPowershell(env),
		// A test-only override, for whichever secret's probe is being exercised; production never sets it,
		// so the per-secret descriptor.probeUrl below decides (undefined for a secret with no live test yet).
		probeUrl: env.VOXREN_RIOT_PROBE_URL || undefined,
		// Test-only, like probeUrl: "0" turns the fresh-key retry off so a 401 is one request.
		freshKeyMs: env.VOXREN_RIOT_FRESH_KEY_MS ? Number(env.VOXREN_RIOT_FRESH_KEY_MS) : FRESH_KEY_MS,
	};
}

/**
 * Only Riot's API hosts, or loopback for the deterministic test upstream.
 * @param {string} url
 */
export function probeUrlAllowed(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol === "https:" && parsed.hostname.endsWith(".api.riotgames.com")) return true;
	return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
}

/**
 * The `test` action's own allowlist: Riot's hosts and loopback (above), plus an exact match against
 * this secret's own hardcoded `probeUrl` -- never an attacker-influenced value, since it comes from
 * the SECRETS literal above, not from any input. Narrower than "any api.perplexity.ai path": only the
 * one URL this descriptor already names. `fetchRiot` below keeps its own narrower Riot-only boundary
 * and never calls this.
 * @param {string} url
 * @param {{ probeUrl?: string }} [descriptor]
 */
export function testProbeUrlAllowed(url, descriptor) {
	return probeUrlAllowed(url) || (typeof descriptor?.probeUrl === "string" && url === descriptor.probeUrl);
}

/**
 * @typedef {object} LastTestState
 * @property {string} result
 * @property {string} at
 * @property {number} [httpStatus]
 */
/**
 * @typedef {object} KeyState
 * @property {boolean} stored
 * @property {string} [updatedAt]
 * @property {LastTestState} [lastTest]
 */

/**
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {KeyState}
 */
export function sanitizeState(raw) {
	/** @type {KeyState} */
	const state = { stored: false };
	if (!raw || typeof raw !== "object") return state;
	state.stored = raw.stored === true;
	if (typeof raw.updatedAt === "string" && raw.updatedAt.length <= 40) state.updatedAt = raw.updatedAt;
	const last = /** @type {Record<string, unknown> | undefined} */ (raw.lastTest);
	if (last && typeof last === "object" && RESULTS.has(/** @type {string} */ (last.result)) && typeof last.at === "string" && last.at.length <= 40) {
		state.lastTest = { result: /** @type {string} */ (last.result), at: last.at };
		if (Number.isInteger(last.httpStatus)) state.lastTest.httpStatus = /** @type {number} */ (last.httpStatus);
	}
	return state;
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @returns {KeyState}
 */
function readState(cfg, descriptor) {
	try {
		return sanitizeState(JSON.parse(readFileSync(join(cfg.stateDir, descriptor.stateFileName), "utf8")));
	} catch {
		return { stored: false };
	}
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @param {Record<string, unknown> | null | undefined} state
 * @returns {KeyState}
 */
function writeState(cfg, descriptor, state) {
	const clean = sanitizeState(state);
	mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(cfg.stateDir, descriptor.stateFileName), `${JSON.stringify(clean)}\n`, { mode: 0o600 });
	return clean;
}

/**
 * Time left for a child, from the action's own deadline: Infinity when it has none, 0 or less when spent.
 * @param {SecretConfig} cfg
 */
function remainingMs(cfg) {
	return cfg.deadlineMs === undefined ? Infinity : cfg.deadlineMs - Date.now();
}

/**
 * Run `security`; stderr is discarded so no diagnostic can echo input.
 * @param {SecretConfig} cfg
 * @param {readonly string[]} args
 * @param {string} [stdinText]
 * @returns {Promise<{ status: number, stdout: string }>}
 */
function security(cfg, args, stdinText) {
	return new Promise((resolve) => {
		const timeout = remainingMs(cfg);
		if (timeout <= 0) return resolve({ status: 124, stdout: "" });
		const child = spawn(cfg.securityBin, args, { stdio: ["pipe", "pipe", "ignore"], timeout: Number.isFinite(timeout) ? Math.ceil(timeout) : 0, killSignal: "SIGKILL" });
		/** @type {Buffer[]} */
		const chunks = [];
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.on("error", () => resolve({ status: 127, stdout: "" }));
		child.on("close", (status) => resolve({ status: status ?? 1, stdout: Buffer.concat(chunks).toString("utf8") }));
		if (stdinText !== undefined) child.stdin.write(stdinText);
		child.stdin.end();
	});
}

/**
 * @param {SecretConfig} cfg
 * @returns {string[]}
 */
function keychainArgs(cfg) {
	return cfg.keychain ? [cfg.keychain] : [];
}

/**
 * Run `powershell.exe -Command <script>`; the key (when present) travels only over stdin.
 * @param {SecretConfig} cfg
 * @param {string} script
 * @param {string} [stdinText]
 * @returns {Promise<{ status: number, stdout: string }>}
 */
function powershell(cfg, script, stdinText) {
	return new Promise((resolve) => {
		const timeout = remainingMs(cfg);
		if (timeout <= 0) return resolve({ status: 124, stdout: "" });
		const child = spawn(cfg.powershellBin, ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["pipe", "pipe", "ignore"], timeout: Number.isFinite(timeout) ? Math.ceil(timeout) : 0, killSignal: "SIGKILL" });
		/** @type {Buffer[]} */
		const chunks = [];
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.on("error", () => resolve({ status: 127, stdout: "" }));
		child.on("close", (status) => resolve({ status: status ?? 1, stdout: Buffer.concat(chunks).toString("utf8") }));
		if (stdinText !== undefined) child.stdin.write(stdinText);
		child.stdin.end();
	});
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @returns {string}
 */
function dpapiPath(cfg, descriptor) {
	return join(cfg.stateDir, descriptor.dpapiFileName);
}

/**
 * PowerShell reads ' and the typographic U+2018, U+2019, U+201A, U+201B as the same quote, and a doubled
 * pair of any of them is one literal quote, so each is doubled inside a '...' literal.
 * @param {string} value
 */
export function psLiteral(value) {
	return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 */
async function dpapiStored(cfg, descriptor) {
	try {
		return statSync(dpapiPath(cfg, descriptor)).isFile();
	} catch {
		return false;
	}
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 */
async function dpapiRead(cfg, descriptor) {
	const script = `$p=${psLiteral(dpapiPath(cfg, descriptor))}; if (-not (Test-Path -LiteralPath $p)) { exit 44 }; $enc = Get-Content -LiteralPath $p -Raw; $secure = ConvertTo-SecureString -String $enc; [System.Net.NetworkCredential]::new('', $secure).Password`;
	const result = await powershell(cfg, script);
	if (result.status !== 0) return undefined;
	const key = result.stdout.replace(/\r?\n$/, "");
	return matchesKeyFormat(descriptor, key) ? key : undefined;
}

/**
 * DPAPI-encrypt (current Windows user) and write; the key is read back from this process's stdin, never argv.
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @param {string} key
 */
async function dpapiWrite(cfg, descriptor, key) {
	mkdirSync(cfg.stateDir, { recursive: true });
	const script = `$key=[Console]::In.ReadLine(); $secure = ConvertTo-SecureString -String $key -AsPlainText -Force; ConvertFrom-SecureString $secure | Set-Content -LiteralPath ${psLiteral(dpapiPath(cfg, descriptor))} -NoNewline`;
	const result = await powershell(cfg, script, `${key}\n`);
	return result.status === 0;
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 */
function dpapiDelete(cfg, descriptor) {
	try {
		rmSync(dpapiPath(cfg, descriptor), { force: true });
	} catch {
		// fall through: keyStored() below is the source of truth
	}
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @param {string} account
 */
async function keychainHasItem(cfg, descriptor, account) {
	// Without -w this lists attributes only; the secret is never printed.
	const result = await security(cfg, ["find-generic-password", "-a", account, "-s", descriptor.keychainService, ...keychainArgs(cfg)]);
	return result.status === 0;
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @param {string} account
 */
async function keychainReadItem(cfg, descriptor, account) {
	const result = await security(cfg, ["find-generic-password", "-a", account, "-s", descriptor.keychainService, "-w", ...keychainArgs(cfg)]);
	if (result.status !== 0) return undefined;
	const key = result.stdout.replace(/\r?\n$/, "");
	return matchesKeyFormat(descriptor, key) ? key : undefined;
}

/**
 * Writes through the same stdin `-i` path as `store`; the key never becomes an argv entry.
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @param {string} account
 * @param {string} key
 */
async function writeKeychainItem(cfg, descriptor, account, key) {
	const keychain = cfg.keychain ? ` "${cfg.keychain}"` : "";
	const command = `add-generic-password -U -a "${account}" -s "${descriptor.keychainService}" -j "${descriptor.keychainLabel}" -w "${key}"${keychain}\n`;
	const result = await security(cfg, ["-i"], command);
	return result.status === 0;
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 */
async function keyStored(cfg, descriptor) {
	if (cfg.platform === "win32") return dpapiStored(cfg, descriptor);
	return keychainHasItem(cfg, descriptor, KEYCHAIN_ACCOUNT);
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 */
async function readKey(cfg, descriptor) {
	if (cfg.platform === "win32") return dpapiRead(cfg, descriptor);
	return keychainReadItem(cfg, descriptor, KEYCHAIN_ACCOUNT);
}

function readStdin(limit = MAX_STDIN_BYTES) {
	return new Promise((resolve) => {
		/** @type {Buffer[]} */
		const chunks = [];
		let size = 0;
		process.stdin.on("data", (chunk) => {
			size += chunk.length;
			if (size <= limit) chunks.push(/** @type {Buffer} */ (chunk));
		});
		process.stdin.on("end", () => resolve(size > limit ? "" : Buffer.concat(chunks).toString("utf8")));
		process.stdin.on("error", () => resolve(""));
	});
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @returns {Promise<StatusOk | StatusFail>}
 */
async function status(cfg, descriptor) {
	const state = readState(cfg, descriptor);
	const stored = await keyStored(cfg, descriptor);
	// A check cut off by the deadline says nothing about the key; never write that as "not stored".
	if (remainingMs(cfg) <= 0) return { ok: false, reason: "timeout" };
	if (stored !== state.stored) return { ok: true, state: writeState(cfg, descriptor, { ...state, stored, lastTest: stored ? state.lastTest : undefined }) };
	return { ok: true, state };
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @returns {Promise<StatusOk | StatusFail>}
 */
async function store(cfg, descriptor) {
	const key = (await readStdin()).replace(/\r?\n$/, "");
	if (!keyFormatOk(descriptor, key)) return { ok: false, reason: "invalid_format", state: readState(cfg, descriptor) };
	if (cfg.platform === "win32") {
		const wrote = await dpapiWrite(cfg, descriptor, key);
		if (!wrote || !(await keyStored(cfg, descriptor))) return { ok: false, reason: "keychain_write_failed", state: readState(cfg, descriptor) };
		return { ok: true, state: writeState(cfg, descriptor, { stored: true, updatedAt: new Date().toISOString() }) };
	}
	// Interactive mode reads the whole command from stdin, so the key is never
	// an argv entry visible to `ps` or a shell history.
	const wrote = await writeKeychainItem(cfg, descriptor, KEYCHAIN_ACCOUNT, key);
	if (!wrote || !(await keychainHasItem(cfg, descriptor, KEYCHAIN_ACCOUNT))) return { ok: false, reason: "keychain_write_failed", state: readState(cfg, descriptor) };
	return { ok: true, state: writeState(cfg, descriptor, { stored: true, updatedAt: new Date().toISOString() }) };
}

/** @param {number} httpStatus */
export function classifyStatus(httpStatus) {
	if (httpStatus === 200) return "ok";
	if (httpStatus === 401 || httpStatus === 403) return "rejected";
	if (httpStatus === 429) return "rate_limited";
	return "upstream";
}

/**
 * The one request each secret's live test sends. Riot: a free GET with its token header, unchanged.
 * Perplexity: one minimal billed chat completion (smallest model, `max_tokens: 1`), classified by
 * HTTP status exactly like Riot's -- never a guessed shape, this is the same body/endpoint
 * `live-gateway.ts`'s real web_search call already uses (`model: "sonar"`), just with the shortest
 * possible completion. Typesafe: one Jev question in the same shape src/passage-judge.ts sends.
 * Gemini: a free GET that lists one model, with the key in the `x-goog-api-key` header only.
 */
/**
 * @param {SecretDescriptor} descriptor
 * @param {string} key
 * @returns {{ method: string, headers: Record<string, string>, body?: string }}
 */
function probeRequest(descriptor, key) {
	if (descriptor.id === "typesafe") {
		return {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": PROBE_USER_AGENT, Accept: "application/json" },
			body: JSON.stringify({ model: "jev-latest", state: { text: "hi" }, questions: { probe: { type: "noul", instructions: "Is the text a greeting?", criteria: { true: "yes", false: "no" } } } }),
		};
	}
	if (descriptor.id === "perplexity") {
		return {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": PROBE_USER_AGENT, Accept: "application/json" },
			body: JSON.stringify({ model: "sonar", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
		};
	}
	if (descriptor.id === "gemini") {
		return { method: "GET", headers: { "x-goog-api-key": key, "User-Agent": PROBE_USER_AGENT, Accept: "application/json" } };
	}
	return { method: "GET", headers: { "X-Riot-Token": key, "User-Agent": PROBE_USER_AGENT, Accept: "application/json" } };
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @param {string} key
 * @param {string} probeUrl
 * @param {number} [timeoutMs]
 */
async function probe(cfg, descriptor, key, probeUrl, timeoutMs = PROBE_TIMEOUT_MS) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const { method, headers, body } = probeRequest(descriptor, key);
		const response = await fetch(probeUrl, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "error", signal: controller.signal });
		// The body is never read: the verdict is the status code alone.
		await response.body?.cancel?.();
		// Google answers a bad key with 400 (API_KEY_INVALID), not 401/403. The model list takes nothing else that can be malformed, so 400 is the key.
		const result = descriptor.id === "gemini" && response.status === 400 ? "rejected" : classifyStatus(response.status);
		return { result, httpStatus: response.status };
	} catch {
		return { result: "transport" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @returns {Promise<StatusOk | StatusFail>}
 */
async function test(cfg, descriptor) {
	// The env override (tests only) wins; otherwise each secret's own descriptor decides, so a
	// secret with no live test wired reports that plainly instead of a refused URL.
	const probeUrl = cfg.probeUrl || descriptor.probeUrl;
	if (!probeUrl) return { ok: false, reason: "no_probe_configured", state: readState(cfg, descriptor) };
	if (!testProbeUrlAllowed(probeUrl, descriptor)) return { ok: false, reason: "probe_url_refused", state: readState(cfg, descriptor) };
	const key = await readKey(cfg, descriptor);
	if (!key) {
		if (await keyStored(cfg, descriptor)) return { ok: false, reason: "keychain_read_failed", state: readState(cfg, descriptor) };
		return { ok: false, reason: "not_stored", state: writeState(cfg, descriptor, { ...readState(cfg, descriptor), stored: false, lastTest: undefined }) };
	}
	const previous = readState(cfg, descriptor);
	const started = Date.now();
	const fresh = started - Date.parse(previous.updatedAt ?? "") < cfg.freshKeyMs;
	let outcome = await probe(cfg, descriptor, key, probeUrl);
	while (fresh && outcome.result === "rejected" && Date.now() + FRESH_RETRY_DELAY_MS < started + FRESH_RETRY_BUDGET_MS) {
		await new Promise((resolve) => setTimeout(resolve, FRESH_RETRY_DELAY_MS));
		outcome = await probe(cfg, descriptor, key, probeUrl, FRESH_RETRY_PROBE_TIMEOUT_MS);
	}
	const state = writeState(cfg, descriptor, { ...previous, stored: true, lastTest: { ...outcome, at: new Date().toISOString() } });
	return { ok: true, state };
}

/**
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @returns {Promise<StatusOk | StatusFail>}
 */
async function remove(cfg, descriptor) {
	if (cfg.platform === "win32") {
		dpapiDelete(cfg, descriptor);
	} else {
		await security(cfg, ["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", descriptor.keychainService, ...keychainArgs(cfg)]);
	}
	if (await keyStored(cfg, descriptor)) return { ok: false, reason: "keychain_delete_failed", state: readState(cfg, descriptor) };
	return { ok: true, state: writeState(cfg, descriptor, { stored: false }) };
}

/**
 * One authenticated GET for the live research gateway. The URL must be an
 * allowlisted Riot API host (or loopback for tests); the response body is
 * returned as text, capped, with no key material anywhere in the output.
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @returns {Promise<FetchOk | StatusFail>}
 */
async function fetchRiot(cfg, descriptor) {
	let url;
	try {
		const request = JSON.parse((await readStdin(MAX_FETCH_STDIN_BYTES)) || "{}");
		url = typeof request.url === "string" ? request.url : "";
	} catch {
		return { ok: false, reason: "invalid_format" };
	}
	if (!probeUrlAllowed(url)) return { ok: false, reason: "probe_url_refused" };
	const key = await readKey(cfg, descriptor);
	if (!key) return { ok: false, reason: (await keyStored(cfg, descriptor)) ? "keychain_read_failed" : "not_stored" };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: { "X-Riot-Token": key, "User-Agent": FETCH_USER_AGENT, Accept: "application/json" },
			redirect: "error",
			signal: controller.signal,
		});
		const length = Number(response.headers.get("content-length") ?? 0);
		if (length > MAX_FETCH_BODY_BYTES) {
			await response.body?.cancel?.();
			return { ok: false, reason: "oversized" };
		}
		const body = await response.text();
		if (Buffer.byteLength(body, "utf8") > MAX_FETCH_BODY_BYTES) return { ok: false, reason: "oversized" };
		const retryAfter = Number(response.headers.get("retry-after") ?? 0);
		// A real call is as good a verdict as the probe: record ok or rejected so the coach chrome follows the key, not a stale test.
		const verdict = classifyStatus(response.status);
		if (verdict === "ok" || verdict === "rejected")
			writeState(cfg, descriptor, { ...readState(cfg, descriptor), stored: true, lastTest: { result: verdict, httpStatus: response.status, at: new Date().toISOString() } });
		return { ok: true, httpStatus: response.status, retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 0, body };
	} catch {
		return { ok: false, reason: "transport" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The plaintext value once, for bin/coach.mjs's env>dotenv>store precedence check. Sanitized to
 * exactly {ok, value} on success: no `state`, so this never grows a field some other caller expects
 * sanitized. Never wired for riot (see `main` below) -- Riot keeps its narrower fetch-only boundary.
 * @param {SecretConfig} cfg
 * @param {SecretDescriptor} descriptor
 * @returns {Promise<ReadOk | StatusFail>}
 */
async function read(cfg, descriptor) {
	const key = await readKey(cfg, descriptor);
	if (!key) {
		if (remainingMs(cfg) <= 0) return { ok: false, reason: "timeout" };
		return { ok: false, reason: (await keyStored(cfg, descriptor)) ? "keychain_read_failed" : "not_stored" };
	}
	return { ok: true, value: key };
}

/**
 * @typedef {{ ok: true, state: KeyState }} StatusOk
 * @typedef {{ ok: false, reason: string, state?: KeyState }} StatusFail
 * @typedef {{ ok: true, httpStatus: number, retryAfterSeconds: number, body: string }} FetchOk
 * @typedef {{ ok: true, value: string }} ReadOk
 * @typedef {StatusOk | StatusFail | FetchOk | ReadOk} HelperResult
 */

/** @type {Record<string, (cfg: SecretConfig, descriptor: SecretDescriptor) => Promise<HelperResult>>} */
const ACTIONS = { status, store, test, remove, fetch: fetchRiot, read };

export async function main(argv = process.argv.slice(2), env = process.env) {
	const [actionName, secretId] = argv;
	const descriptor = SECRETS[secretId];
	if (!descriptor) return { ok: false, reason: "unknown_secret" };
	// read hands a plaintext value back to the caller; riot keeps its narrower fetch-only boundary.
	if (actionName === "read" && secretId === "riot") return { ok: false, reason: "unknown_action" };
	const action = ACTIONS[actionName];
	if (argv.length !== 2 || !action) return { ok: false, reason: "unknown_action" };
	try {
		const cfg = config(env);
		// The launcher asks for the deadline on its `status` calls too; the extension's own calls have none.
		if (actionName === "read" || (actionName === "status" && env.VOXREN_SECRET_DEADLINE)) cfg.deadlineMs = Date.now() + READ_DEADLINE_MS;
		return await action(cfg, descriptor);
	} catch {
		// Never surface an error message: it could carry a path, a command, or input.
		return { ok: false, reason: "helper_error" };
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((output) => {
		process.stdout.write(`${JSON.stringify(output)}\n`);
	});
}
