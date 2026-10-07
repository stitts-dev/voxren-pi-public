import { COACH_YAML, RESEARCH_CONTRACT_VERSION, VOXREN_TOOLS, type EvidenceReference, type GatewayResponse } from "./contracts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The audit's own cap: ten games, each with its row and every death, kill, and assist in context, measured on real games
 * at about 2.5 KB a game beside 6 KB of summary, habits, and reference. A longer history gives up its oldest games' moments.
 */
export const MAX_AUDIT_PAYLOAD_BYTES = 48 * 1024;
export const MAX_DISPLAY_TEXT_BYTES = 8 * 1024;
/** Separate hard ceiling on the `chart` payload alone: it is display-only and exempt from the two budgets above, but not unbounded. */
export const MAX_CHART_PAYLOAD_BYTES = 64 * 1024;
/** Ceiling on the assembled system prompt (contracts.ts coachSystemPrompt): doctrine plus every per-launch line. contracts.test.ts gates the worst case under it. Raised from 32 KB on 2026-10-04 by the owner once doctrine and the main card left 358 bytes; each extra KB costs about 250 input tokens on a cold turn. */
export const MAX_SYSTEM_PROMPT_BYTES = 40 * 1024;

export type SafeErrorCode =
	| "CONFIGURATION"
	| "AUTHENTICATION"
	| "VALIDATION"
	| "NOT_FOUND"
	| "UPSTREAM_UNAVAILABLE"
	| "RATE_LIMITED"
	| "MALFORMED_RESPONSE";

// Model-facing text lives in coach.yaml (AGENTS.md rule 1); this is just typed to the fixed code set.
const SAFE_ERROR_TEXT = COACH_YAML.errors as Record<SafeErrorCode, string>;

export class SafeToolError extends Error {
	constructor(
		readonly code: SafeErrorCode,
	) {
		super(SAFE_ERROR_TEXT[code]);
		this.name = "SafeToolError";
	}
}

export function safeErrorCode(error: unknown): SafeErrorCode {
	if (error instanceof SafeToolError) return error.code;
	return "UPSTREAM_UNAVAILABLE";
}

export function safeToolFailure(error: unknown) {
	const code = safeErrorCode(error);
	return {
		content: [{ type: "text" as const, text: `ERROR[${code}]: ${SAFE_ERROR_TEXT[code]}` }],
		details: { contractVersion: RESEARCH_CONTRACT_VERSION, error: { code } },
	};
}

export function assertRecord(value: unknown): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new SafeToolError("VALIDATION");
}

export function assertString(value: unknown, min: number, max: number): asserts value is string {
	if (typeof value !== "string" || value.length < min || value.length > max) throw new SafeToolError("VALIDATION");
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).some((key) => !keys.includes(key))) throw new SafeToolError("VALIDATION");
}

function assertArray(value: unknown, min: number, max: number): asserts value is unknown[] {
	if (!Array.isArray(value) || value.length < min || value.length > max) throw new SafeToolError("VALIDATION");
}

export function assertAbortNotRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw new SafeToolError("UPSTREAM_UNAVAILABLE");
}

// Terminal escape sequences an upstream string could smuggle onto the screen: CSI, OSC (clipboard, title), DCS/APC/PM/SOS, charset and two-byte ESC forms.
const TERMINAL_SEQUENCES = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_X][^\x1b]*(?:\x1b\\)?|\x1b[ -\/]+[0-~]|\x1b[@-Z\\-_]|\x1b/g;
// Residual C0 controls (except tab and newline; CR goes, it rewinds the cursor), DEL, C1 controls (U+0080-U+009F), which some terminals read as 7-bit sequence introducers, and bidi overrides/isolates (U+202A-202E, U+2066-2069), which reorder what the player reads.
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Untrusted upstream text (search titles, OP.GG tips, model-supplied arguments) goes to the terminal through this first.
 * Strips escape sequences and control characters so a poisoned result cannot set the clipboard (OSC 52), retitle the
 * window, or move the cursor; the card adds its own colours afterwards through the theme.
 */
export function stripTerminalControl(text: string): string {
	return text.replace(TERMINAL_SEQUENCES, "").replace(CONTROL_CHARS, "");
}

/**
 * A saved takeaway is re-read into every later system prompt, so a web or OP.GG passage that talks the model
 * into calling voxren_remember must not be able to plant a multi-line or control-character instruction.
 * Strips terminal control first, then collapses every run of whitespace (including newlines) to one space
 * and trims: a takeaway is always one clean line. Used both to save the text and to render it on the tool card.
 */
export function normalizeTakeaway(text: string): string {
	return stripTerminalControl(text).replace(/\s+/g, " ").trim();
}

/**
 * Keys the model never reads. `chart` feeds the card's charts: per-minute series would crowd the model's budget and add
 * nothing it can quote. `playedAtMs` is the game's start time, which only the learnings fold uses, to order games.
 * `unread` marks a cited source whose text the check never saw, which only the card's sources row shows.
 */
const DISPLAY_ONLY_KEYS = new Set(["chart", "playedAtMs", "unread"]);

/** The response as the model reads it: display-only keys removed. The two size budgets measure this, not the chart payload. */
export function modelText(response: unknown): string {
	return JSON.stringify(response, (key, value) => (DISPLAY_ONLY_KEYS.has(key) ? undefined : value));
}

/** Total serialized size of every `chart` value in the response: display-only but still bounded, so an oversized one still rejects. */
function chartPayloadBytes(response: unknown): number {
	let total = 0;
	JSON.stringify(response, (key, value) => {
		if (key === "chart") total += Buffer.byteLength(JSON.stringify(value), "utf8");
		return value;
	});
	return total;
}

export function assertGatewayResponse(response: unknown, operation: string): asserts response is GatewayResponse {
	try {
		assertRecord(response);
		assertExactKeys(response, ["version", "operation", "data", "evidence"]);
		if (response.version !== RESEARCH_CONTRACT_VERSION || response.operation !== operation) {
			throw new SafeToolError("MALFORMED_RESPONSE");
		}
		assertRecord(response.data);
		assertEvidence(response.evidence);
		if (Buffer.byteLength(modelText(response), "utf8") > displayBudget(operation)) throw new SafeToolError("MALFORMED_RESPONSE");
		if (chartPayloadBytes(response) > MAX_CHART_PAYLOAD_BYTES) throw new SafeToolError("MALFORMED_RESPONSE");
	} catch (error) {
		if (error instanceof SafeToolError && error.code === "MALFORMED_RESPONSE") throw error;
		throw new SafeToolError("MALFORMED_RESPONSE");
	}
}

function assertEvidence(value: unknown): asserts value is EvidenceReference[] {
	assertArray(value, 0, 8);
	for (const entry of value) {
		assertRecord(entry);
		assertExactKeys(entry, ["id", "source", "title", "url", "retrievedAt"]);
		assertString(entry.id, 1, 64);
		if (!VOXREN_TOOLS.includes(entry.source as (typeof VOXREN_TOOLS)[number])) {
			throw new SafeToolError("MALFORMED_RESPONSE");
		}
		if (entry.source === "voxren_strategy_frame") throw new SafeToolError("MALFORMED_RESPONSE");
		assertString(entry.title, 1, 160);
		assertString(entry.url, 8, 512);
		assertString(entry.retrievedAt, 10, 40);
	}
}

/** The audit alone gets its own, larger cap: its depth (every game with its farm, lead, objectives, habits, deaths, and kills) is the point of it. */
export function displayBudget(operation: string): number {
	return operation === "player_audit" ? MAX_AUDIT_PAYLOAD_BYTES : MAX_DISPLAY_TEXT_BYTES;
}
