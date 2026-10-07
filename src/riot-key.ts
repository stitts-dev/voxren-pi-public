import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { logEvent } from "./coach-log";
import {
	Container,
	SettingsList,
	Text,
	decodeKittyPrintable,
	matchesKey,
	type Component,
	type SettingItem,
	type SettingsListTheme,
} from "@earendil-works/pi-tui";
import { wrapLines, type UiTheme } from "./ui";

/**
 * `/riot-key`: a Pi-settings-style panel for the Riot Development key.
 *
 * Boundary: the key exists inside this process only in the MaskedKeyInput
 * buffer, for the moment between Enter and the custodian child's stdin. It is
 * never rendered, logged, stored on extension state, returned from a tool, or
 * passed as an argument. Everything the extension keeps is RiotKeyState, which
 * the custodian child already sanitized (no key, derivative, or length).
 */

export type RiotKeyTestResult = "ok" | "rejected" | "rate_limited" | "upstream" | "transport";

export interface RiotKeyState {
	stored: boolean;
	updatedAt?: string;
	lastTest?: { result: RiotKeyTestResult; at: string; httpStatus?: number };
}

export type RiotKeyReason =
	| "invalid_format"
	| "keychain_write_failed"
	| "keychain_delete_failed"
	| "keychain_read_failed"
	| "not_stored"
	| "probe_url_refused"
	| "unknown_action"
	| "aborted"
	| "helper_error";

export interface RiotKeyOutcome {
	ok: boolean;
	reason?: RiotKeyReason;
	state: RiotKeyState;
}

export interface RiotFetchOutcome {
	ok: boolean;
	reason?: string;
	httpStatus?: number;
	retryAfterSeconds?: number;
	body?: string;
}

export interface RiotKeyCustodian {
	status(): Promise<RiotKeyOutcome>;
	/** The key goes straight to the child's stdin; callers must not retain it. */
	store(key: string): Promise<RiotKeyOutcome>;
	test(signal?: AbortSignal): Promise<RiotKeyOutcome>;
	remove(): Promise<RiotKeyOutcome>;
	/** One GET against an allowlisted Riot API URL; the child attaches the key. */
	fetch(url: string, signal?: AbortSignal): Promise<RiotFetchOutcome>;
}

/** The helper's SECRETS registry keys, mirrored here so a typo is a compile error, not a runtime `unknown_secret`. */
export type SecretId = "riot" | "perplexity" | "typesafe" | "gemini";

export const RIOT_KEY_COMMAND = "riot-key";
export const RIOT_KEY_COMMAND_DESCRIPTION = "Riot Development key: update (hidden input), live test, status, remove";
export const RIOT_KEY_NO_ARGS_MESSAGE = "/riot-key takes no arguments. Open it bare and enter the key in the hidden field.";
export const RIOT_KEY_UNAVAILABLE_MESSAGE = "Riot key store is unavailable in this launch (no key store configured).";
export const RIOT_KEY_TUI_ONLY_MESSAGE = "/riot-key needs the interactive TUI.";
export const RENEWAL_REQUIRED_NOTICE = "Riot Development key rejected (HTTP 401/403): renewal required. Run /riot-key and replace it.";
export const RATE_LIMITED_NOTICE = "Riot rate limited the probe (HTTP 429). That is not an expiry verdict; retry the live test later.";
export const TRANSPORT_NOTICE = "Riot was unreachable (transport failure). No key verdict; retry the live test later.";
export const UPSTREAM_NOTICE = "Riot returned an unexpected upstream status. No key verdict; retry the live test later.";
export const ACCEPTED_NOTICE = "Riot Development key accepted (HTTP 200).";
export const PROBE_TARGET = "lol/status/v4/platform-data (na1)";
export const HIDDEN_VALUE_MASK = "•••••••••••• hidden ••••••••••••";
export const EMPTY_VALUE_HINT = "type or paste the key; nothing is echoed";
const MAX_KEY_CHARS = 256;
const HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), "riot-key-helper.mjs");
const HELPER_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 25_000;
const RESULTS: readonly RiotKeyTestResult[] = ["ok", "rejected", "rate_limited", "upstream", "transport"];
const REASONS: readonly RiotKeyReason[] = [
	"invalid_format",
	"keychain_write_failed",
	"keychain_delete_failed",
	"keychain_read_failed",
	"not_stored",
	"probe_url_refused",
	"unknown_action",
	"aborted",
	"helper_error",
];

// --- sanitized state --------------------------------------------------------

export function sanitizeRiotKeyState(raw: unknown): RiotKeyState {
	const state: RiotKeyState = { stored: false };
	if (!raw || typeof raw !== "object") return state;
	const record = raw as Record<string, any>;
	state.stored = record.stored === true;
	if (typeof record.updatedAt === "string" && record.updatedAt.length <= 40) state.updatedAt = record.updatedAt;
	const last = record.lastTest;
	if (last && typeof last === "object" && RESULTS.includes(last.result) && typeof last.at === "string" && last.at.length <= 40) {
		state.lastTest = { result: last.result, at: last.at };
		if (Number.isInteger(last.httpStatus)) state.lastTest.httpStatus = last.httpStatus;
	}
	return state;
}

export function sanitizeRiotKeyOutcome(raw: unknown, fallback: RiotKeyState): RiotKeyOutcome {
	const record = raw && typeof raw === "object" ? (raw as Record<string, any>) : {};
	const knownReason = REASONS.includes(record.reason) ? (record.reason as RiotKeyReason) : undefined;
	const ok = record.ok === true && record.reason === undefined;
	return { ok, reason: ok ? undefined : (knownReason ?? "helper_error"), state: record.state ? sanitizeRiotKeyState(record.state) : fallback };
}

// --- custodian child ---------------------------------------------------------

const CHILD_ENV_KEYS = ["PATH", "HOME", "VOXREN_RIOT_KEY_STATE_DIR", "VOXREN_RIOT_KEYCHAIN", "VOXREN_RIOT_SECURITY_BIN", "VOXREN_RIOT_PROBE_URL"] as const;

/** Spawn the helper for one action against one secret; only the sanitized JSON line comes back. */
export function createSecretCustodian(
	environment: Record<string, string | undefined>,
	secretId: SecretId,
	helperPath: string = HELPER_PATH,
): RiotKeyCustodian | undefined {
	if (!environment.VOXREN_RIOT_KEY_STATE_DIR) return undefined;
	const childEnv: Record<string, string> = {};
	for (const key of CHILD_ENV_KEYS) if (environment[key]) childEnv[key] = environment[key] as string;
	let known: RiotKeyState = { stored: false };

	const run = (action: string, stdinText?: string, signal?: AbortSignal): Promise<RiotKeyOutcome> =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [helperPath, action, secretId], { env: childEnv, stdio: ["pipe", "pipe", "ignore"], signal });
			const chunks: Buffer[] = [];
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (outcome: RiotKeyOutcome) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				known = outcome.state;
				resolve(outcome);
			};
			timer = setTimeout(() => {
				child.kill();
				finish({ ok: false, reason: "helper_error", state: known });
			}, HELPER_TIMEOUT_MS);
			child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
			child.on("error", () => finish({ ok: false, reason: signal?.aborted ? "aborted" : "helper_error", state: known }));
			child.on("close", (status) => {
				const text = Buffer.concat(chunks).toString("utf8");
				// Defense in depth: a helper that ever echoes a key-shaped value is treated as broken.
				if (status !== 0 || /RGAPI-/i.test(text)) return finish({ ok: false, reason: "helper_error", state: known });
				try {
					finish(sanitizeRiotKeyOutcome(JSON.parse(text), known));
				} catch (error) {
					// `text` itself never gets logged: it is the helper's raw stdout, and only the RGAPI- check above stands
					// between it and a real key. A trusted helper's own output failing to parse breaks this call
					// outright (not a best-effort fallback), so it is an error, not a warning.
					logEvent("error", "riot-key", "helper-parse-failed", { secretId, action, length: text.length }, error);
					finish({ ok: false, reason: "helper_error", state: known });
				}
			});
			if (stdinText !== undefined) child.stdin.write(`${stdinText}\n`);
			child.stdin.end();
		});

	const runFetch = (url: string, signal?: AbortSignal): Promise<RiotFetchOutcome> =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [helperPath, "fetch", secretId], { env: childEnv, stdio: ["pipe", "pipe", "ignore"], signal });
			const chunks: Buffer[] = [];
			let settled = false;
			const finish = (outcome: RiotFetchOutcome) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(outcome);
			};
			const timer = setTimeout(() => {
				child.kill();
				finish({ ok: false, reason: "helper_error" });
			}, FETCH_TIMEOUT_MS);
			child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
			child.on("error", () => finish({ ok: false, reason: signal?.aborted ? "aborted" : "helper_error" }));
			child.on("close", (status) => {
				const text = Buffer.concat(chunks).toString("utf8");
				if (status !== 0 || /RGAPI-/i.test(text)) return finish({ ok: false, reason: "helper_error" });
				try {
					const raw = JSON.parse(text);
					if (raw?.ok !== true) return finish({ ok: false, reason: typeof raw?.reason === "string" ? raw.reason : "helper_error" });
					finish({
						ok: true,
						httpStatus: Number.isInteger(raw.httpStatus) ? raw.httpStatus : 0,
						retryAfterSeconds: Number.isFinite(raw.retryAfterSeconds) ? raw.retryAfterSeconds : 0,
						body: typeof raw.body === "string" ? raw.body : "",
					});
				} catch (error) {
					// `text` itself never gets logged, same reason as createSecretCustodian's own helper-parse catch.
					// Same severity too: the helper's own output failing to parse breaks this fetch outright.
					logEvent("error", "riot-key", "helper-fetch-parse-failed", { secretId, length: text.length }, error);
					finish({ ok: false, reason: "helper_error" });
				}
			});
			child.stdin.write(`${JSON.stringify({ url })}\n`);
			child.stdin.end();
		});

	return {
		status: () => run("status"),
		store: (key: string) => run("store", key),
		test: (signal?: AbortSignal) => run("test", undefined, signal),
		remove: () => run("remove"),
		fetch: runFetch,
	};
}

/** Spawn the helper for one action; only the sanitized JSON line comes back. */
export function createRiotKeyCustodian(
	environment: Record<string, string | undefined>,
	helperPath: string = HELPER_PATH,
): RiotKeyCustodian | undefined {
	return createSecretCustodian(environment, "riot", helperPath) as RiotKeyCustodian;
}

// --- sanitized presentation --------------------------------------------------

function shortStamp(iso: string | undefined): string {
	if (!iso) return "";
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
	return match ? `${match[1]} ${match[2]}Z` : iso.slice(0, 16);
}

export function keyValueText(state: RiotKeyState): string {
	if (!state.stored) return "not stored";
	return state.updatedAt ? `stored · updated ${shortStamp(state.updatedAt)}` : "stored";
}

export function testValueText(state: RiotKeyState): string {
	const last = state.lastTest;
	if (!state.stored) return "no key to test";
	if (!last) return "never run";
	const when = shortStamp(last.at);
	switch (last.result) {
		case "ok":
			return `ok (200) · ${when}`;
		case "rejected":
			return `REJECTED (${last.httpStatus ?? "401/403"}) · renewal required · ${when}`;
		case "rate_limited":
			return `rate limited (429) · not an expiry verdict · ${when}`;
		case "upstream":
			return `upstream ${last.httpStatus ?? "error"} · no verdict · ${when}`;
		case "transport":
			return `unreachable · no verdict · ${when}`;
	}
}

export function reasonText(reason: RiotKeyReason | undefined): string {
	switch (reason) {
		case "invalid_format":
			return "Key format not recognized (expected RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Nothing was stored.";
		case "keychain_write_failed":
			return "The system key store refused the write. Nothing was stored.";
		case "keychain_delete_failed":
			return "The system key store refused the delete.";
		case "keychain_read_failed":
			return "The system key store refused the read (locked or access denied). The stored key and last test result are unchanged.";
		case "not_stored":
			return "No Riot Development key is stored. Choose Development key first.";
		case "probe_url_refused":
			return "The probe target was refused; only Riot API hosts are allowed.";
		case "aborted":
			return "Live test aborted before a verdict.";
		default:
			return "The key custodian failed. Nothing about the key was shown or changed.";
	}
}

/** Development keys expire after a day; an ok older than this is a guess, not a verdict. */
const KEY_VERDICT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function riotKeyHeaderLine(state: RiotKeyState | undefined, available: boolean, now: number = Date.now()): string {
	if (!available) return "Riot key unavailable in this launch";
	if (!state) return "Riot key checking…";
	if (!state.stored) return "Riot key not stored · /riot-key";
	if (state.lastTest?.result === "rejected") return "Riot key REJECTED · /riot-key";
	if (!state.lastTest) return `Riot key ${keyValueText(state)} · untested · /riot-key`;
	const age = now - Date.parse(state.lastTest.at);
	if (state.lastTest.result === "ok" && age > KEY_VERDICT_MAX_AGE_MS) return `Riot key last ok ${Math.floor(age / 3_600_000)}h ago · dev keys expire daily · /riot-key`;
	return `Riot key ${testValueText(state)}`;
}

export function statusLines(state: RiotKeyState): string[] {
	const lines = [`Development key: ${keyValueText(state)}`, `Last live test: ${testValueText(state)}`, `Probe target: ${PROBE_TARGET}`];
	lines.push("Storage: the local system key store only; never in the transcript, tool data, or logs.");
	lines.push("Live tests run only when you choose them here; nothing probes automatically.");
	return lines;
}

/** Lines for the persistent above-editor widget, or undefined when no notice is due. */
export function renewalWidgetLines(state: RiotKeyState | undefined): string[] | undefined {
	return state?.lastTest?.result === "rejected" ? [RENEWAL_REQUIRED_NOTICE] : undefined;
}

export interface RiotKeyNotice {
	level: "info" | "warning" | "error";
	text: string;
}

/**
 * Notice for a completed explicit live test. The renewal-required notice fires
 * once per transition into the rejected state; a repeated rejection is shown
 * only through the panel value and the persistent widget.
 */
export function noticeForTest(previous: RiotKeyState | undefined, next: RiotKeyState): RiotKeyNotice | undefined {
	const result = next.lastTest?.result;
	if (!result) return undefined;
	switch (result) {
		case "ok":
			return { level: "info", text: ACCEPTED_NOTICE };
		case "rejected":
			return previous?.lastTest?.result === "rejected" ? undefined : { level: "warning", text: RENEWAL_REQUIRED_NOTICE };
		case "rate_limited":
			return { level: "warning", text: RATE_LIMITED_NOTICE };
		case "upstream":
			return { level: "warning", text: UPSTREAM_NOTICE };
		case "transport":
			return { level: "warning", text: TRANSPORT_NOTICE };
	}
}

// --- masked input -------------------------------------------------------------

function hasControlChars(text: string): boolean {
	return [...text].some((ch) => {
		const code = ch.charCodeAt(0);
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
	});
}

/**
 * Purpose-built single-secret field. It keeps one buffer, echoes a fixed mask
 * (never the value or its length), and hands the value out exactly once on
 * Enter, clearing itself in the same step.
 */
export class MaskedKeyInput implements Component {
	private buffer = "";
	private pasteBuffer = "";
	private inPaste = false;
	onSubmit?: (key: string) => void;
	onCancel?: () => void;

	/** `heading` names the secret being entered; every other guarantee (no echo, no length leak) is fixed. */
	constructor(
		private readonly theme: UiTheme,
		private readonly heading: string = "Riot Development key",
	) {}

	handleInput(data: string): void {
		if (data.includes("\x1b[200~")) {
			this.inPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}
		if (this.inPaste) {
			this.pasteBuffer += data;
			const end = this.pasteBuffer.indexOf("\x1b[201~");
			if (end === -1) return;
			this.append(this.pasteBuffer.slice(0, end));
			const remaining = this.pasteBuffer.slice(end + 6);
			this.inPaste = false;
			this.pasteBuffer = "";
			if (remaining) this.handleInput(remaining);
			return;
		}
		if (matchesKey(data, "escape")) {
			this.buffer = "";
			this.onCancel?.();
			return;
		}
		if (matchesKey(data, "return") || data === "\n" || data === "\r") {
			if (this.buffer.length === 0) return;
			const key = this.buffer;
			this.buffer = "";
			this.onSubmit?.(key);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.buffer = this.buffer.slice(0, -1);
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			this.buffer = "";
			return;
		}
		const kitty = decodeKittyPrintable(data);
		if (kitty !== undefined) {
			this.append(kitty);
			return;
		}
		// Any other escape or control sequence is dropped whole, as pi's Input does.
		if (!hasControlChars(data)) this.append(data);
	}

	private append(text: string): void {
		const clean = [...text.replace(/\r\n|\r|\n|\t/g, "")].filter((ch) => !hasControlChars(ch)).join("");
		this.buffer = (this.buffer + clean).slice(0, MAX_KEY_CHARS);
	}

	/** True while something is typed; exposes no size. */
	hasValue(): boolean {
		return this.buffer.length > 0;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const field = this.hasValue() ? t.fg("accent", HIDDEN_VALUE_MASK) : t.fg("dim", EMPTY_VALUE_HINT);
		return wrapLines(
			[
				t.bold(t.fg("accent", this.heading)),
				t.fg("muted", "Paste or type it here. It goes to the system key store only and never into the chat."),
				`${t.fg("accent", "> ")}${field}`,
				t.fg("dim", "Enter store · Esc cancel · ctrl+u clear"),
			],
			width,
			"  ",
		);
	}
}

// --- panel --------------------------------------------------------------------

export interface RiotKeyPanelHooks {
	onState(state: RiotKeyState, previous: RiotKeyState | undefined): void;
	onNotice(notice: RiotKeyNotice): void;
	requestRender(): void;
	done(): void;
	/** Why this launch never reads the key (Perplexity and Gemini reach only the research service the coach starts); set, a stored or removed notice says so instead of "takes effect at the next launch". */
	unusedReason?: string;
}

export function settingsTheme(theme: UiTheme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("text", text)),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("muted", text),
		cursor: theme.fg("accent", "› "),
		hint: (text) => theme.fg("dim", text),
	};
}

/** A submenu that shows static lines and closes on Enter or Esc. */
class LinesView implements Component {
	constructor(
		private readonly theme: UiTheme,
		private readonly lines: string[],
		private readonly hint: string,
		private readonly close: () => void,
	) {}
	handleInput(data: string): void {
		if (matchesKey(data, "return") || matchesKey(data, "escape") || data === "\n" || data === "\r") this.close();
	}
	invalidate(): void {}
	render(width: number): string[] {
		return wrapLines([...this.lines, this.theme.fg("dim", this.hint)], width, "  ");
	}
}

/**
 * Confirm-on-Enter submenu for the remove action. Enter starts the action and closes in the same
 * keypress, so the input's own render shows the list again; an async action reports through its
 * own notice/render path. A busy state closed from a promise callback left a stale frame instead.
 */
export class ConfirmView implements Component {
	constructor(
		private readonly theme: UiTheme,
		private readonly question: string,
		private readonly confirm: () => Promise<void>,
		private readonly close: () => void,
	) {}
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) return this.close();
		if (matchesKey(data, "return") || data === "\n" || data === "\r") {
			void this.confirm();
			this.close();
		}
	}
	invalidate(): void {}
	render(width: number): string[] {
		const t = this.theme;
		return wrapLines([t.fg("warning", this.question), t.fg("dim", "Enter confirm · Esc keep")], width, "  ");
	}
}

/** Runs one explicit live test while open; Esc aborts the probe. */
class ProbeView implements Component {
	private readonly abort = new AbortController();
	private finished = false;
	constructor(
		private readonly theme: UiTheme,
		private readonly runningText: string,
		run: (signal: AbortSignal) => Promise<void>,
		private readonly close: () => void,
	) {
		void run(this.abort.signal).finally(() => {
			this.finished = true;
			this.close();
		});
	}
	handleInput(data: string): void {
		if (!this.finished && matchesKey(data, "escape")) this.abort.abort();
	}
	invalidate(): void {}
	render(width: number): string[] {
		const t = this.theme;
		return wrapLines([t.fg("accent", this.runningText), t.fg("dim", "One request, explicit only · Esc abort")], width, "  ");
	}
}

/**
 * Every string in the four-action submenu that names the secret, gathered in one
 * place. `riot`'s bundle is the byte-identical text this panel has always shown;
 * any other secret gets the same shape built from `label`, so no Riot-specific
 * wording (or the Riot-only live-test target) can leak into a generic secret's UI.
 */
interface SecretCopy {
	/** The key row's own label: Riot's is a Development key; every other secret's is an API key. */
	keyRowLabel: string;
	keyHeading: string;
	testDescription: string;
	statusLines(state: RiotKeyState): string[];
	notStoredWarning: string;
	removeConfirmQuestion: string;
	storedNotice: string;
	removedNotice: string;
	probeRunningText: string;
	reasonText(reason: RiotKeyReason | undefined): string;
	noticeForTest(previous: RiotKeyState | undefined, next: RiotKeyState): RiotKeyNotice | undefined;
}

function genericStatusLines(state: RiotKeyState): string[] {
	return [
		`API key: ${keyValueText(state)}`,
		`Last live test: ${testValueText(state)}`,
		"Storage: the local system key store only; never in the transcript, tool data, or logs.",
		"Live tests run only when you choose them here; nothing probes automatically.",
	];
}

function secretCopy(secretId: SecretId, label: string, unusedReason?: string): SecretCopy {
	if (secretId === "riot") {
		return {
			keyRowLabel: "Development key",
			keyHeading: "Riot Development key",
			testDescription: `Enter sends one request to ${PROBE_TARGET} with the stored key. 200 ok · 401/403 renewal required · 429 rate limited (not expiry) · other: no verdict.`,
			statusLines,
			notStoredWarning: reasonText("not_stored"),
			removeConfirmQuestion: "Remove the Riot Development key from the system key store?",
			storedNotice: "Riot Development key stored in the system key store.",
			removedNotice: "Riot Development key removed.",
			probeRunningText: `Testing the stored key against ${PROBE_TARGET}…`,
			reasonText,
			noticeForTest,
		};
	}
	// D-R2: a stored/removed Perplexity, Typesafe, or Gemini key only reaches the running coach at its next
	// launch (all are read once into process.env by bin/coach.mjs's loadCoachEnv), unlike Riot's key,
	// which the custodian re-reads from the key store on every fetch. Say so wherever the panel
	// reports the change. D-R3: Perplexity's and Typesafe's live tests are each one real, billed
	// upstream call, and Gemini's is a free model-list read; say so right on the row that triggers it.
	const nextLaunchNote = unusedReason ? `Not used by this launch: ${unusedReason}.` : "Takes effect at the next launch of coach.";
	return {
		keyRowLabel: "API key",
		keyHeading: `${label} key`,
		testDescription:
			secretId === "perplexity"
				? `Enter sends one small billed call to Perplexity with the stored key. ok · rejected (renewal required) · rate limited (not expiry) · other: no verdict.`
				: secretId === "typesafe"
					? `Enter sends one small billed Jev call to Typesafe with the stored key. ok · rejected (renewal required) · rate limited (not expiry) · other: no verdict.`
					: secretId === "gemini"
						? `Enter sends one free request to Google (lists one model) with the stored key. ok · rejected (renewal required) · rate limited (not expiry) · other: no verdict.`
						: `Enter runs a live test with the stored ${label} key. ok · rejected (renewal required) · rate limited (not expiry) · other: no verdict.`,
		statusLines: genericStatusLines,
		notStoredWarning: `No ${label} key is stored. Choose API key first.`,
		removeConfirmQuestion: `Remove the ${label} key from the system key store?`,
		storedNotice: `${label} key stored in the system key store. ${nextLaunchNote}`,
		removedNotice: `${label} key removed. ${nextLaunchNote}`,
		probeRunningText: `Testing the stored ${label} key…`,
		reasonText: (reason) => {
			if (reason === "not_stored") return `No ${label} key is stored. Choose API key first.`;
			if (reason === "invalid_format") return "Key format not recognized. Nothing was stored.";
			if (reason === "probe_url_refused") return `The ${label} probe target was refused.`;
			return reasonText(reason);
		},
		noticeForTest: (previous, next) => {
			const result = next.lastTest?.result;
			if (!result) return undefined;
			switch (result) {
				case "ok":
					return { level: "info", text: `${label} key accepted.` };
				case "rejected":
					return previous?.lastTest?.result === "rejected" ? undefined : { level: "warning", text: `${label} key rejected: renewal required.` };
				case "rate_limited":
					return { level: "warning", text: `${label} rate limited the probe. That is not an expiry verdict; retry the live test later.` };
				case "upstream":
					return { level: "warning", text: `${label} returned an unexpected upstream status. No key verdict; retry the live test later.` };
				case "transport":
					return { level: "warning", text: `${label} was unreachable (transport failure). No key verdict; retry the live test later.` };
			}
		},
	};
}

/**
 * The four-action submenu (Development key / Live test / Status / Remove key)
 * for one secret, built once and reused for every entry in the Keys registry.
 * `RiotKeyPanel` below is this builder called with `secretId: "riot"`.
 */
export class SecretKeyPanel extends Container {
	private readonly list: SettingsList;
	private state: RiotKeyState;
	private readonly copy: SecretCopy;

	constructor(
		private readonly theme: UiTheme,
		secretId: SecretId,
		label: string,
		private readonly custodian: RiotKeyCustodian,
		initialState: RiotKeyState,
		private readonly hooks: RiotKeyPanelHooks,
	) {
		super();
		this.state = initialState;
		this.copy = secretCopy(secretId, label, hooks.unusedReason);
		const items: SettingItem[] = [
			{
				id: "key",
				label: this.copy.keyRowLabel,
				description: "Enter opens a hidden field. The key is stored in the system key store only; it never enters the transcript.",
				currentValue: keyValueText(initialState),
				submenu: (_current, done) => this.keySubmenu(done),
			},
			{
				id: "test",
				label: "Live test",
				description: this.copy.testDescription,
				currentValue: testValueText(initialState),
				submenu: (_current, done) => this.testSubmenu(done),
			},
			{
				id: "status",
				label: "Status",
				description: "Sanitized stored state only; no probe runs.",
				currentValue: initialState.stored ? "stored" : "not stored",
				submenu: (_current, done) => new LinesView(theme, this.copy.statusLines(this.state), "Enter/Esc back", () => done()),
			},
			{
				id: "remove",
				label: "Remove key",
				description: "Delete the key from the system key store and forget the last test result.",
				currentValue: "",
				submenu: (_current, done) => this.removeSubmenu(done),
			},
		];
		this.list = new SettingsList(items, items.length, settingsTheme(theme), () => {}, () => hooks.done());
		const accent = (text: string) => theme.fg("accent", text);
		this.addChild(new DynamicBorder(accent));
		this.addChild(new Text(`${theme.bold(accent(this.copy.keyHeading))} ${theme.fg("muted", "· settings")}`, 1, 0));
		this.addChild(this.list);
		this.addChild(new DynamicBorder(accent));
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	private apply(outcome: RiotKeyOutcome, notice?: RiotKeyNotice): void {
		const previous = this.state;
		this.state = outcome.state;
		this.list.updateValue("key", keyValueText(this.state));
		this.list.updateValue("test", testValueText(this.state));
		this.list.updateValue("status", this.state.stored ? "stored" : "not stored");
		this.hooks.onState(this.state, previous);
		if (!outcome.ok) this.hooks.onNotice({ level: "error", text: this.copy.reasonText(outcome.reason) });
		else if (notice) this.hooks.onNotice(notice);
		this.hooks.requestRender();
	}

	private keySubmenu(done: () => void): Component {
		const input = new MaskedKeyInput(this.theme, this.copy.keyHeading);
		let busy = false;
		input.onCancel = () => {
			if (!busy) done();
		};
		input.onSubmit = (key) => {
			if (busy) return;
			busy = true;
			this.list.updateValue("key", "storing…");
			this.hooks.requestRender();
			void this.custodian
				.store(key)
				.then((outcome) => this.apply(outcome, outcome.ok ? { level: "info", text: this.copy.storedNotice } : undefined))
				.finally(() => done());
		};
		return input;
	}

	private testSubmenu(done: () => void): Component {
		if (!this.state.stored) {
			return new LinesView(this.theme, [this.theme.fg("warning", this.copy.notStoredWarning)], "Enter/Esc back", () => done());
		}
		return new ProbeView(
			this.theme,
			this.copy.probeRunningText,
			async (signal) => {
				const previous = this.state;
				const outcome = await this.custodian.test(signal);
				this.apply(outcome, outcome.ok ? this.copy.noticeForTest(previous, outcome.state) : undefined);
			},
			() => done(),
		);
	}

	private removeSubmenu(done: () => void): Component {
		if (!this.state.stored) return new LinesView(this.theme, [this.theme.fg("muted", "No key is stored.")], "Enter/Esc back", () => done());
		return new ConfirmView(
			this.theme,
			this.copy.removeConfirmQuestion,
			async () => this.apply(await this.custodian.remove(), { level: "info", text: this.copy.removedNotice }),
			() => done(),
		);
	}
}

/** `/riot-key`'s panel: `SecretKeyPanel` called for the one secret it has always managed. */
export class RiotKeyPanel extends SecretKeyPanel {
	constructor(theme: UiTheme, custodian: RiotKeyCustodian, initialState: RiotKeyState, hooks: RiotKeyPanelHooks) {
		super(theme, "riot", "Riot Development key", custodian, initialState, hooks);
	}
}
