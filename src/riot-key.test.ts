import { afterAll, describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TREE_COMMAND } from "./command-tree";
import { CONFIG_COMMAND } from "./config";
import { installVoxrenCoach } from "./index";
import {
	ACCEPTED_NOTICE,
	EMPTY_VALUE_HINT,
	HIDDEN_VALUE_MASK,
	MaskedKeyInput,
	RATE_LIMITED_NOTICE,
	RENEWAL_REQUIRED_NOTICE,
	RIOT_KEY_COMMAND,
	RIOT_KEY_NO_ARGS_MESSAGE,
	RIOT_KEY_UNAVAILABLE_MESSAGE,
	RiotKeyPanel,
	SecretKeyPanel,
	noticeForTest,
	renewalWidgetLines,
	riotKeyHeaderLine,
	sanitizeRiotKeyOutcome,
	statusLines,
	testValueText,
	type RiotKeyCustodian,
	type RiotKeyNotice,
	type RiotKeyOutcome,
	type RiotKeyReason,
	type RiotKeyState,
	type RiotKeyTestResult,
	type SecretId,
} from "./riot-key";
import { createHeader } from "./ui";

/** Synthetic, format-valid credential. It must never surface anywhere the human or model can see. */
const SENTINEL = ["RGAPI", "0badc0de", "0000", "4000", "8000", "5e11f1e1d0a7"].join("-");
const WIDTHS = [24, 44, 80, 120];
const RETURN = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";
const CTRL_U = "\x15";
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
const visible: string[] = [];
const notices: RiotKeyNotice[] = [];

function record(lines: string[]): string[] {
	visible.push(...lines);
	return lines;
}

function expectFits(lines: string[], width: number) {
	expect(lines.length).toBeGreaterThan(0);
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** In-memory custodian: it records only whether it received the sentinel, never the value. */
function fakeCustodian(script: RiotKeyTestResult[] = [], format: { sentinel: string; prefix: string } = { sentinel: SENTINEL, prefix: "RGAPI-" }) {
	let state: RiotKeyState = { stored: false };
	const calls: string[] = [];
	let receivedSentinel = false;
	const results = [...script];
	const custodian: RiotKeyCustodian = {
		async status() {
			calls.push("status");
			return { ok: true, state };
		},
		async store(key) {
			calls.push("store");
			receivedSentinel = key === format.sentinel;
			if (!key.startsWith(format.prefix)) return { ok: false, reason: "invalid_format", state };
			state = { stored: true, updatedAt: "2026-09-23T10:00:00.000Z" };
			return { ok: true, state };
		},
		async test() {
			calls.push("test");
			if (!state.stored) return { ok: false, reason: "not_stored", state };
			const result = results.shift() ?? "ok";
			const httpStatus = { ok: 200, rejected: 403, rate_limited: 429, upstream: 503, transport: undefined }[result];
			state = { ...state, lastTest: { result, at: "2026-09-23T10:05:00.000Z", ...(httpStatus ? { httpStatus } : {}) } };
			return { ok: true, state };
		},
		async remove() {
			calls.push("remove");
			state = { stored: false };
			return { ok: true, state };
		},
		async fetch() {
			calls.push("fetch");
			return { ok: false, reason: "not_stored" };
		},
	};
	return { custodian, calls, get receivedSentinel() { return receivedSentinel; }, get state() { return state; } };
}

function panelHarness(custodian: RiotKeyCustodian, initial: RiotKeyState) {
	const states: RiotKeyState[] = [];
	let renders = 0;
	let closed = false;
	const panel = new RiotKeyPanel(theme, custodian, initial, {
		onState: (state) => states.push(state),
		onNotice: (notice) => notices.push(notice),
		requestRender: () => renders++,
		done: () => (closed = true),
	});
	const render = (width = 80) => record(panel.render(width));
	return { panel, states, render, get renders() { return renders; }, get closed() { return closed; } };
}

afterAll(() => {
	// Every line any surface rendered and every notice text: no sentinel, no key prefix, no key length.
	for (const line of [...visible, ...notices.map((notice) => notice.text)]) {
		expect(line).not.toContain(SENTINEL);
		expect(line).not.toContain("RGAPI-0");
		expect(line).not.toMatch(new RegExp(`\\b${SENTINEL.length}\\b`));
	}
});

describe("MaskedKeyInput", () => {
	test("never echoes the value or its length at any width", () => {
		const input = new MaskedKeyInput(theme);
		for (const width of WIDTHS) {
			const lines = record(input.render(width));
			expectFits(lines, width);
			expect(lines.join("\n")).toContain(EMPTY_VALUE_HINT.slice(0, 12));
		}
		input.handleInput("R");
		const afterOne = WIDTHS.map((width) => record(input.render(width)));
		for (const ch of SENTINEL.slice(1)) input.handleInput(ch);
		const afterAll = WIDTHS.map((width) => record(input.render(width)));
		expect(afterAll).toEqual(afterOne);
		expect(afterAll[2].join("\n")).toContain(HIDDEN_VALUE_MASK);
		expect(input.hasValue()).toBe(true);
	});

	test("hands the value out once on Enter and clears itself", () => {
		const input = new MaskedKeyInput(theme);
		let matched = false;
		let submissions = 0;
		input.onSubmit = (key) => {
			submissions++;
			matched = key === SENTINEL;
		};
		input.handleInput(RETURN);
		expect(submissions).toBe(0);
		input.handleInput(`\x1b[200~${SENTINEL}\n\x1b[201~`);
		input.handleInput(RETURN);
		expect(submissions).toBe(1);
		expect(matched).toBe(true);
		expect(input.hasValue()).toBe(false);
		record(input.render(80));
	});

	test("supports backspace, clear, cancel, and drops control sequences", () => {
		const input = new MaskedKeyInput(theme);
		let cancelled = 0;
		let submitted: string | undefined;
		input.onCancel = () => cancelled++;
		input.onSubmit = (key) => (submitted = key);
		input.handleInput("abc");
		input.handleInput("\x1b[A");
		input.handleInput("\x1b[1;5C");
		input.handleInput(BACKSPACE);
		input.handleInput("\x1b[97u");
		input.handleInput(RETURN);
		expect(submitted).toBe("aba");
		input.handleInput("xyz");
		input.handleInput(CTRL_U);
		expect(input.hasValue()).toBe(false);
		input.handleInput("q");
		input.handleInput(ESCAPE);
		expect(cancelled).toBe(1);
		expect(input.hasValue()).toBe(false);
	});
});

describe("sanitized presentation and notices", () => {
	test("test value text separates every outcome and never calls 429 expiry", () => {
		const at = "2026-09-23T10:05:00.000Z";
		const stored = { stored: true, updatedAt: at };
		expect(testValueText({ stored: false })).toBe("no key to test");
		expect(testValueText(stored)).toBe("never run");
		expect(testValueText({ ...stored, lastTest: { result: "ok", at, httpStatus: 200 } })).toContain("ok (200)");
		expect(testValueText({ ...stored, lastTest: { result: "rejected", at, httpStatus: 403 } })).toContain("renewal required");
		const limited = testValueText({ ...stored, lastTest: { result: "rate_limited", at, httpStatus: 429 } });
		expect(limited).toContain("429");
		expect(limited).not.toMatch(/expired|renew/i);
		expect(testValueText({ ...stored, lastTest: { result: "transport", at } })).toContain("no verdict");
		expect(testValueText({ ...stored, lastTest: { result: "upstream", at, httpStatus: 503 } })).toContain("503");
		expect(RATE_LIMITED_NOTICE).not.toMatch(/expired|renewal/i);
	});

	test("renewal-required notice fires once per transition into rejected", () => {
		const at = "2026-09-23T10:05:00.000Z";
		const ok: RiotKeyState = { stored: true, lastTest: { result: "ok", at, httpStatus: 200 } };
		const rejected: RiotKeyState = { stored: true, lastTest: { result: "rejected", at, httpStatus: 403 } };
		const limited: RiotKeyState = { stored: true, lastTest: { result: "rate_limited", at, httpStatus: 429 } };
		expect(noticeForTest(undefined, rejected)).toEqual({ level: "warning", text: RENEWAL_REQUIRED_NOTICE });
		expect(noticeForTest(ok, rejected)).toEqual({ level: "warning", text: RENEWAL_REQUIRED_NOTICE });
		expect(noticeForTest(rejected, rejected)).toBeUndefined();
		expect(noticeForTest(rejected, ok)).toEqual({ level: "info", text: ACCEPTED_NOTICE });
		expect(noticeForTest(rejected, limited)).toEqual({ level: "warning", text: RATE_LIMITED_NOTICE });
		expect(renewalWidgetLines(rejected)).toEqual([RENEWAL_REQUIRED_NOTICE]);
		expect(renewalWidgetLines(ok)).toBeUndefined();
		expect(renewalWidgetLines(undefined)).toBeUndefined();
	});

	test("header line and status lines expose sanitized state only", () => {
		const at = "2026-09-23T10:05:00.000Z";
		expect(riotKeyHeaderLine(undefined, false)).toContain("unavailable");
		expect(riotKeyHeaderLine({ stored: false }, true)).toContain("not stored");
		expect(riotKeyHeaderLine({ stored: true, lastTest: { result: "rejected", at } }, true)).toContain("REJECTED");
		const fresh = Date.parse(at) + 23 * 3_600_000;
		expect(riotKeyHeaderLine({ stored: true, lastTest: { result: "ok", at, httpStatus: 200 }, updatedAt: at }, true, fresh)).toBe("Riot key ok (200) · 2026-09-23 10:05Z");
		expect(riotKeyHeaderLine({ stored: true, lastTest: { result: "ok", at, httpStatus: 200 }, updatedAt: at }, true, fresh + 2 * 3_600_000)).toBe("Riot key last ok 25h ago · dev keys expire daily · /riot-key");
		const header = createHeader(theme, () => riotKeyHeaderLine({ stored: true, updatedAt: at }, true));
		for (const width of WIDTHS) {
			const lines = record(header.render(width));
			expectFits(lines, width);
			// Narrow widths may wrap inside the phrase; join continuation rows before checking.
			expect(lines.join("\n").replace(/\n {3}/g, " ")).toContain("Riot key stored");
		}
		record(statusLines({ stored: true, updatedAt: at, lastTest: { result: "ok", at, httpStatus: 200 } }));
	});

	test("helper output is rebuilt from known fields only", () => {
		const fallback: RiotKeyState = { stored: true };
		const outcome = sanitizeRiotKeyOutcome(
			{ ok: true, state: { stored: true, secret: SENTINEL, lastTest: { result: "ok", at: "2026-09-23T10:05:00.000Z", body: "x" } }, extra: 1 },
			fallback,
		);
		expect(outcome).toEqual({ ok: true, reason: undefined, state: { stored: true, lastTest: { result: "ok", at: "2026-09-23T10:05:00.000Z" } } });
		expect(JSON.stringify(outcome)).not.toContain("RGAPI");
		expect(sanitizeRiotKeyOutcome({ ok: true, reason: "surprise" }, fallback)).toEqual({ ok: false, reason: "helper_error", state: fallback });
		expect(sanitizeRiotKeyOutcome("garbage", fallback)).toEqual({ ok: false, reason: "helper_error", state: fallback });
	});
});

describe("RiotKeyPanel", () => {
	test("renders a settings-style list that fits narrow and wide panes", () => {
		const { custodian } = fakeCustodian();
		const { render } = panelHarness(custodian, { stored: false });
		for (const width of WIDTHS) {
			const lines = render(width);
			expectFits(lines, width);
			const text = lines.join("\n");
			expect(text).toContain("Development key");
			expect(text).toContain("Live test");
			expect(text).toContain("Remove key");
		}
		expect(render(80).join("\n")).toContain("not stored");
	});

	test("update flow: hidden field, key straight to the custodian, sanitized value afterwards", async () => {
		const fake = fakeCustodian();
		const harness = panelHarness(fake.custodian, { stored: false });
		harness.panel.handleInput(RETURN);
		const field = harness.render(80).join("\n");
		expect(field).toContain("Riot Development key");
		expect(field).toContain(EMPTY_VALUE_HINT);
		for (const ch of SENTINEL) harness.panel.handleInput(ch);
		expect(harness.render(44).join("\n")).toContain("hidden");
		harness.panel.handleInput(RETURN);
		await flush();
		expect(fake.calls).toEqual(["store"]);
		expect(fake.receivedSentinel).toBe(true);
		const after = harness.render(80).join("\n");
		expect(after).toContain("stored · updated 2026-09-23 10:00Z");
		expect(after).toContain("never run");
		expect(harness.states.at(-1)).toEqual({ stored: true, updatedAt: "2026-09-23T10:00:00.000Z" });
		expect(notices.at(-1)?.text).toContain("stored in the system key store");
		expect(harness.renders).toBeGreaterThan(0);
	});

	test("an in-flight store ignores Esc and a second Enter, then closes the field once", async () => {
		const fake = fakeCustodian();
		let release = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const slow: RiotKeyCustodian = { ...fake.custodian, store: async (key) => (await gate, fake.custodian.store(key)) };
		const harness = panelHarness(slow, { stored: false });
		harness.panel.handleInput(RETURN);
		for (const ch of SENTINEL) harness.panel.handleInput(ch);
		harness.panel.handleInput(RETURN);
		harness.panel.handleInput(ESCAPE);
		for (const ch of SENTINEL) harness.panel.handleInput(ch);
		harness.panel.handleInput(RETURN);
		expect(harness.render(80).join("\n")).toContain(EMPTY_VALUE_HINT);
		release();
		await flush();
		expect(fake.calls).toEqual(["store"]);
		harness.panel.handleInput(DOWN);
		harness.panel.handleInput(RETURN);
		expect(harness.render(44).join("\n")).toContain("Testing the stored key");
		await flush();
		await flush();
		expect(harness.render(80).join("\n")).toContain("ok (200)");
		expect(harness.closed).toBe(false);
	});

	test("invalid input is refused with a sanitized reason", async () => {
		const fake = fakeCustodian();
		const harness = panelHarness(fake.custodian, { stored: false });
		harness.panel.handleInput(RETURN);
		harness.panel.handleInput("nope");
		harness.panel.handleInput(RETURN);
		await flush();
		expect(fake.state.stored).toBe(false);
		expect(notices.at(-1)).toEqual({ level: "error", text: expect.stringContaining("format not recognized") });
		expect(harness.render(80).join("\n")).toContain("not stored");
	});

	test("explicit live test only: rejected notice once, 429 not expiry, persistent widget", async () => {
		const fake = fakeCustodian(["rejected", "rejected", "rate_limited", "ok"]);
		const harness = panelHarness(fake.custodian, { stored: false });
		harness.panel.handleInput(DOWN);
		harness.panel.handleInput(RETURN);
		expect(harness.render(80).join("\n")).toContain("No Riot Development key is stored");
		harness.panel.handleInput(ESCAPE);
		expect(fake.calls).toEqual([]);
		harness.panel.handleInput("\x1b[A");
		harness.panel.handleInput(RETURN);
		for (const ch of SENTINEL) harness.panel.handleInput(ch);
		harness.panel.handleInput(RETURN);
		await flush();
		harness.panel.handleInput(DOWN);
		const before = notices.length;
		const runTest = async () => {
			harness.panel.handleInput(RETURN);
			expect(harness.render(44).join("\n")).toContain("Testing the stored key");
			await flush();
			await flush();
		};
		await runTest();
		expect(fake.calls.filter((call) => call === "test")).toHaveLength(1);
		expect(harness.render(80).join("\n")).toContain("REJECTED (403)");
		expect(notices.slice(before).map((notice) => notice.text)).toEqual([RENEWAL_REQUIRED_NOTICE]);
		expect(renewalWidgetLines(harness.states.at(-1))).toEqual([RENEWAL_REQUIRED_NOTICE]);
		await runTest();
		expect(notices.slice(before).map((notice) => notice.text)).toEqual([RENEWAL_REQUIRED_NOTICE]);
		await runTest();
		expect(harness.render(80).join("\n")).toContain("rate limited (429)");
		expect(notices.at(-1)?.text).toBe(RATE_LIMITED_NOTICE);
		expect(renewalWidgetLines(harness.states.at(-1))).toBeUndefined();
		await runTest();
		expect(harness.render(80).join("\n")).toContain("ok (200)");
		expect(notices.at(-1)?.text).toBe(ACCEPTED_NOTICE);
	});

	test("status shows sanitized lines, remove confirms, escape closes the panel", async () => {
		const fake = fakeCustodian();
		await fake.custodian.store(SENTINEL);
		const harness = panelHarness(fake.custodian, fake.state);
		harness.panel.handleInput(DOWN);
		harness.panel.handleInput(DOWN);
		harness.panel.handleInput(RETURN);
		const status = harness.render(44).join("\n");
		expect(status).toContain("Development key: stored");
		expect(status).toContain("nothing probes automatically");
		harness.panel.handleInput(RETURN);
		harness.panel.handleInput(DOWN);
		harness.panel.handleInput(RETURN);
		expect(harness.render(80).join("\n")).toContain("Remove the Riot Development key");
		harness.panel.handleInput(ESCAPE);
		expect(fake.state.stored).toBe(true);
		harness.panel.handleInput(RETURN);
		harness.panel.handleInput(RETURN);
		await flush();
		expect(fake.state.stored).toBe(false);
		expect(harness.render(80).join("\n")).toContain("not stored");
		expect(harness.closed).toBe(false);
		harness.panel.handleInput(ESCAPE);
		expect(harness.closed).toBe(true);
	});
});

describe("SecretKeyPanel generalized for a non-Riot secret", () => {
	// Perplexity's own format (`pplx-` prefix, per issue #36's proposal item 3), never RGAPI-shaped.
	const PPLX_SENTINEL = ["pplx", "0badc0de0000111122223333"].join("-");
	const PPLX_FORMAT = { sentinel: PPLX_SENTINEL, prefix: "pplx-" };
	const NO_RIOT_LEAK = /riot/i;

	function pplxHarness(custodian: RiotKeyCustodian, initial: RiotKeyState, secretId: SecretId = "perplexity", label = "Perplexity") {
		const states: RiotKeyState[] = [];
		let renders = 0;
		let closed = false;
		const panel = new SecretKeyPanel(theme, secretId, label, custodian, initial, {
			onState: (state) => states.push(state),
			onNotice: (notice) => notices.push(notice),
			requestRender: () => renders++,
			done: () => (closed = true),
		});
		const render = (width = 80) => record(panel.render(width));
		return { panel, states, render, get renders() { return renders; }, get closed() { return closed; } };
	}

	test("same four-action layout as RiotKeyPanel, at every width, with no Riot-specific label", () => {
		const { custodian } = fakeCustodian([], PPLX_FORMAT);
		const { render } = pplxHarness(custodian, { stored: false });
		for (const width of WIDTHS) {
			const lines = render(width);
			expectFits(lines, width);
			const text = lines.join("\n");
			// A Perplexity key is an API key, not a Riot Development key: the row label follows the secret.
			expect(text).toContain("API key");
			expect(text).not.toContain("Development key");
			expect(text).toContain("Live test");
			expect(text).toContain("Status");
			expect(text).toContain("Remove key");
			expect(text).not.toMatch(NO_RIOT_LEAK);
		}
		expect(render(80).join("\n")).toContain("not stored");
	});

	test("update, invalid format, live test, status, and remove work identically to the Riot panel", async () => {
		const fake = fakeCustodian(["rejected", "rejected", "rate_limited", "ok"], PPLX_FORMAT);
		const harness = pplxHarness(fake.custodian, { stored: false });

		// Development key: same hidden field, headed by this secret's own label instead of Riot's.
		harness.panel.handleInput(RETURN);
		const field = harness.render(80).join("\n");
		expect(field).toContain("Perplexity key");
		expect(field).toContain(EMPTY_VALUE_HINT);
		expect(field).not.toMatch(NO_RIOT_LEAK);

		// Invalid format is refused before anything is stored, same as Riot's RGAPI check.
		harness.panel.handleInput("nope");
		harness.panel.handleInput(RETURN);
		await flush();
		expect(fake.state.stored).toBe(false);
		expect(notices.at(-1)).toEqual({ level: "error", text: expect.stringContaining("format not recognized") });
		expect(notices.at(-1)!.text).not.toMatch(NO_RIOT_LEAK);

		// Store the sentinel.
		harness.panel.handleInput(RETURN);
		for (const ch of PPLX_SENTINEL) harness.panel.handleInput(ch);
		harness.panel.handleInput(RETURN);
		await flush();
		expect(fake.receivedSentinel).toBe(true);
		expect(harness.render(80).join("\n")).toContain("stored · updated 2026-09-23 10:00Z");
		expect(notices.at(-1)?.text).toContain("Perplexity key stored");
		expect(notices.at(-1)!.text).not.toMatch(NO_RIOT_LEAK);

		// Live test: same rejected/rejected/rate_limited/ok script, same once-per-transition renewal notice.
		harness.panel.handleInput(DOWN);
		const before = notices.length;
		const runTest = async () => {
			harness.panel.handleInput(RETURN);
			const running = harness.render(44).join("\n");
			expect(running).toContain("Testing the stored Perplexity key");
			expect(running).not.toMatch(NO_RIOT_LEAK);
			await flush();
			await flush();
		};
		await runTest();
		expect(harness.render(80).join("\n")).toContain("REJECTED (403)");
		expect(notices.slice(before).map((n) => n.text)).toEqual([expect.stringContaining("renewal required")]);
		await runTest();
		expect(notices.slice(before).map((n) => n.text)).toEqual([expect.stringContaining("renewal required")]); // still once
		await runTest();
		expect(harness.render(80).join("\n")).toContain("rate limited (429)");
		expect(notices.at(-1)?.text).toContain("rate limited");
		await runTest();
		expect(harness.render(80).join("\n")).toContain("ok (200)");
		expect(notices.at(-1)?.text).toContain("accepted");
		for (const notice of notices.slice(before)) expect(notice.text).not.toMatch(NO_RIOT_LEAK);

		// Status: sanitized, generic lines -- no Riot text and no Riot-only probe target.
		harness.panel.handleInput(DOWN);
		harness.panel.handleInput(RETURN);
		const status = harness.render(44).join("\n");
		expect(status).toContain("API key: stored");
		expect(status).toContain("nothing probes automatically");
		expect(status).not.toMatch(NO_RIOT_LEAK);
		harness.panel.handleInput(RETURN);

		// Remove: confirms, deletes, closes the panel on Esc -- identical mechanics to Riot's.
		harness.panel.handleInput(DOWN);
		harness.panel.handleInput(RETURN);
		expect(harness.render(80).join("\n")).toContain("Remove the Perplexity key");
		harness.panel.handleInput(ESCAPE);
		expect(fake.state.stored).toBe(true);
		harness.panel.handleInput(RETURN);
		harness.panel.handleInput(RETURN);
		await flush();
		expect(fake.state.stored).toBe(false);
		expect(notices.at(-1)?.text).toContain("Perplexity key removed");
		expect(notices.at(-1)!.text).not.toMatch(NO_RIOT_LEAK);
		expect(harness.closed).toBe(false);
		harness.panel.handleInput(ESCAPE);
		expect(harness.closed).toBe(true);
	});

	test("Perplexity's and Typesafe's Live test rows both disclose the call is billed (D-R3)", () => {
		const { custodian: pplxCustodian } = fakeCustodian([], PPLX_FORMAT);
		const pplx = pplxHarness(pplxCustodian, { stored: true });
		pplx.panel.handleInput(DOWN); // cursor to "Live test"
		expect(pplx.render(80).join("\n")).toContain("one small billed call");

		const { custodian: tsCustodian } = fakeCustodian([], { sentinel: "an-arbitrary-typesafe-value", prefix: "" });
		const typesafe = pplxHarness(tsCustodian, { stored: true }, "typesafe", "Typesafe");
		typesafe.panel.handleInput(DOWN); // cursor to "Live test"
		expect(typesafe.render(80).join("\n")).toContain("billed Jev call");
	});

	test("Gemini's Live test row says the call is free, and no Riot wording leaks into its panel", () => {
		const { custodian } = fakeCustodian([], { sentinel: "AIzaSyBadC0de00001111", prefix: "" });
		const gemini = pplxHarness(custodian, { stored: true }, "gemini", "Gemini");
		gemini.panel.handleInput(DOWN); // cursor to "Live test"
		const text = gemini.render(80).join("\n");
		expect(text).toContain("one free request to Google");
		expect(text).not.toContain("billed");
		expect(text).not.toMatch(NO_RIOT_LEAK);
	});

	test("storing or removing a Perplexity, Typesafe, or Gemini key notes the change takes effect at the next launch (D-R2)", async () => {
		for (const [secretId, label, sentinel] of [
			["perplexity", "Perplexity", PPLX_SENTINEL],
			["typesafe", "Typesafe", "an-arbitrary-typesafe-value"],
			["gemini", "Gemini", "AIzaSyBadC0de00001111"],
		] as const) {
			const fake = fakeCustodian([], { sentinel, prefix: secretId === "perplexity" ? "pplx-" : "" });
			const harness = pplxHarness(fake.custodian, { stored: false }, secretId, label);

			harness.panel.handleInput(RETURN); // "Development key" row: hidden input
			for (const ch of sentinel) harness.panel.handleInput(ch);
			harness.panel.handleInput(RETURN); // submit
			await flush();
			expect(notices.at(-1)?.text).toContain(`${label} key stored`);
			expect(notices.at(-1)?.text).toContain("Takes effect at the next launch");

			harness.panel.handleInput(DOWN); // "Live test"
			harness.panel.handleInput(DOWN); // "Status"
			harness.panel.handleInput(DOWN); // "Remove key"
			harness.panel.handleInput(RETURN); // ConfirmView
			harness.panel.handleInput(RETURN); // confirm
			await flush();
			expect(notices.at(-1)?.text).toContain(`${label} key removed`);
			expect(notices.at(-1)?.text).toContain("Takes effect at the next launch");
		}
	});

	test("a key the launch never reads is stored with a notice that says so, never that it takes effect at the next launch", async () => {
		const fake = fakeCustodian([], { sentinel: "AIzaSyBadC0de00001111", prefix: "" });
		const panel = new SecretKeyPanel(theme, "gemini", "Gemini", fake.custodian, { stored: false }, {
			onState: () => {},
			onNotice: (notice) => notices.push(notice),
			requestRender: () => {},
			done: () => {},
			unusedReason: "a service you run holds its own keys",
		});
		panel.handleInput(RETURN);
		for (const ch of "AIzaSyBadC0de00001111") panel.handleInput(ch);
		panel.handleInput(RETURN);
		await flush();
		expect(notices.at(-1)?.text).toContain("Gemini key stored");
		expect(notices.at(-1)?.text).toContain("Not used by this launch: a service you run holds its own keys.");
		expect(notices.at(-1)?.text).not.toContain("Takes effect");
	});

	test("every RiotKeyReason renders a notice with no Riot-specific wording", async () => {
		const ALL_REASONS: RiotKeyReason[] = [
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
		for (const reason of ALL_REASONS) {
			const state: RiotKeyState = { stored: true };
			const custodian: RiotKeyCustodian = {
				async status() { return { ok: true, state }; },
				async store() { return { ok: true, state }; },
				async test() { return { ok: false, reason, state }; },
				async remove() { return { ok: true, state }; },
				async fetch() { return { ok: false, reason: "not_stored" }; },
			};
			const harness = pplxHarness(custodian, state);
			harness.panel.handleInput(DOWN); // move cursor to "Live test"
			const before = notices.length;
			harness.panel.handleInput(RETURN); // opens ProbeView, which calls custodian.test()
			await flush();
			const added = notices.slice(before);
			expect(added.length).toBe(1);
			expect(added[0]!.level).toBe("error");
			expect(added[0]!.text).not.toMatch(NO_RIOT_LEAK);
		}
	});
});

describe("/riot-key command wiring", () => {
	function fakePi() {
		const commands = new Map<string, any>();
		const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
		return {
			commands,
			handlers,
			pi: {
				registerTool: () => {},
				setActiveTools: () => {},
				registerProvider: () => {},
				sendUserMessage: () => {},
				sendMessage: () => {},
				registerMessageRenderer: () => {},
				registerCommand: (name: string, options: any) => commands.set(name, options),
				on: (event: string, handler: (payload: any, ctx?: any) => any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			},
		};
	}

	function fakeCtx(mode = "tui") {
		const calls: Record<string, unknown[][]> = {};
		const log = (name: string) => (...args: unknown[]) => {
			(calls[name] ??= []).push(args);
		};
		let customFactory: any;
		return {
			calls,
			get customFactory() {
				return customFactory;
			},
			ctx: {
				hasUI: true,
				mode,
				sessionManager: { getBranch: () => [], getEntries: () => [] },
				ui: {
					notify: log("notify"),
					setWidget: log("setWidget"),
					setTitle: log("setTitle"),
					setHeader: log("setHeader"),
					setFooter: log("setFooter"),
					setWorkingMessage: log("setWorkingMessage"),
					custom: async (factory: any) => {
						customFactory = factory;
						log("custom")();
						return undefined;
					},
				},
			},
		};
	}

	test("registers a zero-argument command that never creates an LLM turn", async () => {
		const fake = fakePi();
		const custodian = fakeCustodian();
		installVoxrenCoach(fake.pi as any, {}, custodian.custodian);
		expect([...fake.commands.keys()]).toEqual([RIOT_KEY_COMMAND, CONFIG_COMMAND, "review", "matchup", "build", "patch", "otp", "comp", "draft", "pick", TREE_COMMAND, "update", "report", "feedback"]);
		const command = fake.commands.get(RIOT_KEY_COMMAND);
		expect(command.getArgumentCompletions).toBeUndefined();
		const withArgs = fakeCtx();
		await command.handler(SENTINEL, withArgs.ctx);
		expect(withArgs.calls.notify).toEqual([[RIOT_KEY_NO_ARGS_MESSAGE, "error"]]);
		expect(withArgs.calls.custom).toBeUndefined();
		expect(custodian.calls).toEqual([]);
		const printMode = fakeCtx("print");
		let code = 0;
		const savedWrite = process.stderr.write;
		process.stderr.write = (() => true) as any;
		try {
			await command.handler("", { ...printMode.ctx, setExitCode: (c: number) => void (code = c) });
		} finally {
			process.stderr.write = savedWrite;
		}
		expect(code).toBe(1);
		expect(printMode.calls.custom).toBeUndefined();
		const tui = fakeCtx();
		await command.handler("  ", tui.ctx);
		expect(tui.calls.custom).toHaveLength(1);
		expect(custodian.calls).toEqual(["status"]);
		let closed = false;
		const panel = tui.customFactory({ requestRender: () => {} }, theme, {}, () => (closed = true));
		record(panel.render(80));
		panel.handleInput(ESCAPE);
		expect(closed).toBe(true);
		expect(custodian.calls.filter((call) => call === "test")).toEqual([]);
	});

	test("launch shows persisted sanitized state and never probes", async () => {
		const fake = fakePi();
		const custodian = fakeCustodian(["rejected"]);
		await custodian.custodian.store(SENTINEL);
		await custodian.custodian.test();
		installVoxrenCoach(fake.pi as any, {}, custodian.custodian);
		const session = fakeCtx();
		await fake.handlers.get("session_start")![0]({}, session.ctx);
		expect(custodian.calls.filter((call) => call === "test")).toHaveLength(1);
		expect(custodian.calls.at(-1)).toBe("status");
		expect(session.calls.setWidget).toEqual([[RIOT_KEY_COMMAND, [RENEWAL_REQUIRED_NOTICE]]]);
		const headerFactory = session.calls.setHeader![0][0] as (tui: unknown, theme: any) => { render(width: number): string[] };
		const header = record(headerFactory(undefined, theme).render(80)).join("\n");
		expect(header).toContain("REJECTED");
		expect(session.calls.notify).toBeUndefined();
	});

	test("without a configured key store the command reports unavailable", async () => {
		const fake = fakePi();
		installVoxrenCoach(fake.pi as any, {}, undefined);
		const ctx = fakeCtx();
		await fake.commands.get(RIOT_KEY_COMMAND).handler("", ctx.ctx);
		expect(ctx.calls.notify).toEqual([[RIOT_KEY_UNAVAILABLE_MESSAGE, "error"]]);
		const session = fakeCtx();
		await fake.handlers.get("session_start")![0]({}, session.ctx);
		const headerFactory = session.calls.setHeader![0][0] as (tui: unknown, theme: any) => { render(width: number): string[] };
		expect(record(headerFactory(undefined, theme).render(80)).join("\n")).toContain("unavailable in this launch");
	});
});
