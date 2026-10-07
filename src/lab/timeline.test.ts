import { describe, expect, test } from "bun:test";
import { runningRows, timelineGates, timelineHash, type Frame } from "./timeline.ts";

const row = (clock: string, mark = "⠋") => ` ▌  META  ${mark} ${clock}  Katarina vs Ahri`;
const frames = (...texts: string[]): Frame[] => texts.map((text, index) => ({ t: index * 250, text }));
const good = frames("hello", `ask\n${row("0.2s")}`, `ask\n${row("0.5s", "⠙")}`, "ask\n ▌  META  ✓ 0.6s  Katarina vs Ahri\nanswer");
const final = "ask\n ▌  META  ✓ 0.6s  Katarina vs Ahri\nanswer";
const gates = (list: Frame[], screen = final, running = true) => timelineGates(list, screen, 100, running).map((failure) => failure.gate);

describe("timelineGates", () => {
	test("a clean timeline passes", () => expect(gates(good)).toEqual([]));
	test("reads the clock in seconds", () => expect(runningRows(row("1m05s"))[0].seconds).toBe(65));

	test("running: fails when no frame ever shows a running row, and when one is left at the end", () => {
		expect(gates(frames("a", "b", final))).toContain("running");
		const stuck = frames("a", row("0.2s"), row("0.5s", "⠙"));
		expect(gates(stuck, stuck.at(-1)!.text)).toContain("running");
		expect(gates(frames("a", "b"), "b", false)).toEqual([]);
	});
	test("duplicate-row: fails when one frame draws a row twice", () => {
		const twice = frames("x", `${row("0.2s")}\nthe plan: hold the wave`, `${row("0.4s")}\nthe plan: hold the wave\nthe plan: hold the wave`, final);
		expect(gates(twice)).toContain("duplicate-row");
		// a card's sub-row repeats from card to card (each card nothing screened says so); a card's first row drawn twice still fails
		const cards = " │ META     ✓ 0.3s  Katarina vs Ahri\n │   not screened · no key\n │ SEARCH   ✓ 1.5s  three results\n │   not screened · no key";
		expect(gates(frames("x", row("0.2s"), cards, final))).not.toContain("duplicate-row");
		expect(gates(frames("x", row("0.2s"), `${cards}\n │ META     ✓ 0.3s  Katarina vs Ahri`, final))).toContain("duplicate-row");
	});
	test("clock-backwards: fails when one row's time drops", () => {
		expect(gates(frames(row("0.2s"), row("0.9s"), row("0.4s"), final))).toContain("clock-backwards");
		// two different rows may each start at 0
		expect(gates(frames(row("0.9s"), `${row("0.9s")}\n ▌  GAME  ⠋ 0.1s  Syndra`, final))).not.toContain("clock-backwards");
	});
	test("raw markup: a ** that holds still, an entity, or escape text fails; a half-written bold that grows does not", () => {
		const growing = frames(row("0.2s"), `${row("0.4s")}\n- Level 6: **All-in`, `${row("0.5s")}\n- Level 6: **All-in when Charm is down.**`, final);
		expect(timelineGates(growing, final, 100, true)).toEqual([]);
		for (const bad of ["**Lane:** push", "a &gt; b", "\\x1b[31m red", "bell\u0007"]) {
			const list = frames(row("0.2s"), `${bad}\n${row("0.5s")}`, `${bad}\n${row("0.6s")}`, final);
			expect(timelineGates(list, final, 100, true).some((failure) => ["raw-markup", "entity", "escape"].includes(failure.gate))).toBe(true);
		}
	});
	test("last-frame: fails when the final screen is not the last frame", () => expect(gates(good, `${final}\nlate row`)).toContain("last-frame"));
	test("first-frame: fails when frame 1 is not this story's banner", () => {
		const own = frames("\u258c cmd-x \u00b7 smoke", ...good.map((frame) => frame.text));
		expect(timelineGates(own, final, 100, true, "cmd-x")).toEqual([]);
		expect(timelineGates(frames("old story result", ...good.map((frame) => frame.text)), final, 100, true, "cmd-x").map((failure) => failure.gate)).toEqual(["first-frame"]);
	});
	test("no frames is a failure, not a pass", () => expect(gates([], "")).toEqual(["timeline"]));
});

describe("timelineHash", () => {
	test("the same look hashes the same whatever the timing; a changed screen or a new running row changes it", () => {
		const a = frames(row("0.2s"), row("0.5s", "\u2819"), final);
		const b = frames(row("0.3s", "\u2839"), final);
		expect(timelineHash(a, final)).toBe(timelineHash(b, final));
		expect(timelineHash(a, `${final}\nnew row`)).not.toBe(timelineHash(a, final));
		expect(timelineHash(frames(`${row("0.2s")}\n \u258c  GAME  \u280b 0.1s  Syndra`), final)).not.toBe(timelineHash(a, final));
	});
});
