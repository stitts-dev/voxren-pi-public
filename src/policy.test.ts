import { describe, expect, test } from "bun:test";
import { COACH_YAML, RESEARCH_CONTRACT_VERSION } from "./contracts";
import { MAX_AUDIT_PAYLOAD_BYTES, MAX_CHART_PAYLOAD_BYTES, MAX_DISPLAY_TEXT_BYTES, SafeToolError, type SafeErrorCode, assertGatewayResponse, modelText, safeToolFailure, stripTerminalControl } from "./policy";

const SAFE_ERROR_CODES: SafeErrorCode[] = ["CONFIGURATION", "AUTHENTICATION", "VALIDATION", "UPSTREAM_UNAVAILABLE", "RATE_LIMITED", "MALFORMED_RESPONSE"];

/** A player_audit-shaped response whose one game's chart carries `fillerBytes` of padding. */
function auditResponse(fillerBytes: number): any {
	return {
		version: RESEARCH_CONTRACT_VERSION,
		operation: "player_audit",
		data: {
			games: [{ id: "NA1_1", dAfterAlly: 0, dUntraded: 1, chart: { gd: [0, 100, 200], deaths: [], kills: [], items: [], filler: "x".repeat(fillerBytes) } }],
		},
		evidence: [],
	};
}

describe("chart payload cap", () => {
	test("a chart payload within the 64 KiB ceiling passes, and stays out of the model's text", () => {
		const normal = auditResponse(1000);
		expect(() => assertGatewayResponse(normal, "player_audit")).not.toThrow();
		expect(modelText(normal)).not.toContain('"chart"');
		expect(modelText(normal)).toContain('"dUntraded":1');
	});

	test("an over-cap chart payload (>64 KiB) is rejected as MALFORMED_RESPONSE, even though chart is exempt from the model-text budgets", () => {
		const oversized = auditResponse(MAX_CHART_PAYLOAD_BYTES + 1);
		try {
			assertGatewayResponse(oversized, "player_audit");
			throw new Error("expected assertGatewayResponse to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SafeToolError);
			expect((error as SafeToolError).code).toBe("MALFORMED_RESPONSE");
		}
	});
});

describe("display budget", () => {
	test("the audit has its own, larger cap; every other result keeps the display budget", () => {
		const padded = (operation: string, bytes = MAX_DISPLAY_TEXT_BYTES + 1024) => ({ version: RESEARCH_CONTRACT_VERSION, operation, data: { note: "x".repeat(bytes) }, evidence: [] }) as any;
		// One cap, one place: a response past the display budget fails the assert, so nothing that passes it can fail later.
		expect(() => assertGatewayResponse(padded("web_search"), "web_search")).toThrow(SafeToolError);
		expect(() => assertGatewayResponse(padded("web_search", 10 * 1024), "web_search")).toThrow(SafeToolError);
		expect(() => assertGatewayResponse(padded("web_search", 4 * 1024), "web_search")).not.toThrow();
		// Past every other tool's payload cap and still an audit the model may read; past its own cap it is refused like any other.
		const audit = padded("player_audit", MAX_DISPLAY_TEXT_BYTES + 1024);
		expect(Buffer.byteLength(modelText(audit), "utf8")).toBeLessThanOrEqual(MAX_AUDIT_PAYLOAD_BYTES);
		expect(() => assertGatewayResponse(audit, "player_audit")).not.toThrow();
		expect(() => assertGatewayResponse({ ...audit, operation: "web_search" }, "web_search")).toThrow(SafeToolError);
		expect(() => assertGatewayResponse(padded("player_audit", MAX_AUDIT_PAYLOAD_BYTES), "player_audit")).toThrow(SafeToolError);
	});
});

describe("safeToolFailure text comes from coach.yaml", () => {
	test("every SafeErrorCode's failure text ends with the coach.yaml text for that code", () => {
		for (const code of SAFE_ERROR_CODES) {
			const { text } = safeToolFailure(new SafeToolError(code)).content[0];
			expect(text.endsWith(COACH_YAML.errors[code])).toBe(true);
		}
	});
});

describe("stripTerminalControl", () => {
	test("removes OSC, CSI, DCS/APC and bare ESC sequences but keeps the words around them", () => {
		expect(stripTerminalControl("\x1b]52;c;Zm9v\x07hi")).toBe("hi");
		expect(stripTerminalControl("\x1b]0;owned\x1b\\title")).toBe("title");
		expect(stripTerminalControl("a\x1b[31mred\x1b[0m b \x1b[2J\x1b[H")).toBe("ared b ");
		expect(stripTerminalControl("\x1bPq#0;2;0;0;0\x1b\\x \x1b_Gf=100\x1b\\y \x1b(B z\x1b")).toBe("x y  z");
	});

	test("removes carriage return and bidi controls, so a card value cannot overwrite earlier text or reorder a URL", () => {
		expect(stripTerminalControl("safe text\rEVIL")).toBe("safe textEVIL");
		expect(stripTerminalControl("a\u202Eb\u2066c\u2069d\u202ae")).toBe("abcde");
		expect(stripTerminalControl("l1\r\nl2")).toBe("l1\nl2");
	});

	test("removes C0, DEL and C1 controls, keeps tab, newline and every printable script", () => {
		expect(stripTerminalControl("a\x00b\x08c\x7fd\u009be\u0085f")).toBe("abcdef");
		expect(stripTerminalControl("tab\there\nnext")).toBe("tab\there\nnext");
		expect(stripTerminalControl("가나다#팀명 · Fizz · ¡Olé! · 中文")).toBe("가나다#팀명 · Fizz · ¡Olé! · 中文");
	});
});
