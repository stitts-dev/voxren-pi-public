import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setTimeout as delay } from "node:timers/promises";
import { JEV_FRAMES, createJevBadge, foldJudgment, jevBadgeText, type JevBadgeState } from "./jev-badge";
import { coachLabels, headerLines } from "./ui";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const tagged = { fg: (color: string, text: string) => `[${color}:${text}]`, bg: (_color: string, text: string) => text, bold: (text: string) => `[b:${text}]` } as any;

const result = (data: Record<string, unknown>) => ({ details: { response: { data } } });
const fresh = (): JevBadgeState => ({ busy: 0, frame: 0, tally: { screened: 0, cut: 0, checked: 0, flagged: 0 } });
// Polls on a plain ref'd timer (AGENTS.md rule 8) until done() holds or ms has passed; the bound stays under Bun's 5 s test timeout.
async function until(done: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (!done() && Date.now() < end) await delay(2);
	return done();
}

describe("jev badge", () => {
	test("tally folds passages, withheld answers, and frame claims; failures replace it until the next judged result", () => {
		const state = fresh();
		foldJudgment(state, result({ judgment: { judge: "jev", status: "judged", kept: 3, removed: [{ domain: "a.net", route: "withheld" }], answer: "evidence" } }));
		expect(state.tally).toEqual({ screened: 5, cut: 1, checked: 0, flagged: 0 });
		// An OP.GG summary: one passage, blanked.
		foldJudgment(state, result({ judgment: { judge: "jev", status: "judged", kept: 0, removed: [], answer: "withheld" } }));
		expect(state.tally).toEqual({ screened: 6, cut: 2, checked: 0, flagged: 0 });
		foldJudgment(state, result({ judgment: { judge: "jev", status: "judged", checked: 3 }, claims: [{ route: "grounded" }, { route: "unsupported" }, { route: "contradicted" }] }));
		expect(state.tally).toEqual({ screened: 6, cut: 2, checked: 3, flagged: 2 });
		expect(jevBadgeText(theme, state)).toBe("◆ Jev · 6 screened · 2 cut · 3 checked · 2 flagged");
		foldJudgment(state, result({ judgment: { judge: "jev", status: "unavailable", reason: "timeout" } }));
		expect(jevBadgeText(tagged, state)).toBe("[warning:◇] [b:Jev] [warning:unavailable (timeout)]");
		foldJudgment(state, result({ judgment: { judge: "jev", status: "judged", kept: 1, removed: [] } }));
		expect(state.unavailable).toBeUndefined();
		// Results without a judgment (game facts, audits, errors) change nothing.
		foldJudgment(state, result({ games: [] }));
		foldJudgment(state, undefined);
		expect(state.tally.screened).toBe(7);
		expect(jevBadgeText(tagged, fresh())).toBe("[accent:◆] [b:Jev]");
	});

	test("an off_topic or kept search answer counts like the judgment that produced it", () => {
		const base = { judge: "jev", status: "judged", kept: 2, removed: [] };
		const tallyOf = (answer: string) => {
			const state = fresh();
			foldJudgment(state, result({ judgment: { ...base, answer } }));
			return state.tally;
		};
		expect(tallyOf("withheld")).toMatchObject({ screened: 3, cut: 1 });
		expect(tallyOf("off_topic")).toMatchObject({ screened: 3, cut: 1 });
		expect(tallyOf("evidence")).toMatchObject({ screened: 3, cut: 0 });
	});

	test("a failed frame check stays until the frame is judged, whatever other tools judge", () => {
		const state = fresh();
		foldJudgment(state, result({ judgment: { judge: "jev", status: "unavailable", reason: "timeout" } }), "voxren_strategy_frame");
		foldJudgment(state, result({ judgment: { judge: "jev", status: "judged", kept: 1, removed: [] } }), "web_search");
		expect(state.unavailable).toBe("timeout");
		foldJudgment(state, result({ judgment: { judge: "jev", status: "judged", checked: 1 }, claims: [] }), "voxren_strategy_frame");
		expect(state.unavailable).toBeUndefined();
	});

	test("pulses only while a screened tool call is in flight, and repaints on every frame", async () => {
		const seen: number[] = [];
		const badge = createJevBadge({ onChange: () => seen.push(badge.read().frame), frameMs: 5 });
		badge.start({ toolCallId: "facts", toolName: "voxren_game_facts" });
		expect(badge.read().busy).toBe(0);
		badge.start({ toolCallId: "search", toolName: "web_search" });
		badge.start({ toolCallId: "meta", toolName: "voxren_meta_research" });
		expect(badge.read().busy).toBe(2);
		// Wait for the first frame tick, however late the timer is; the frame wraps, so the frame at this instant can be 0 again, the frames repainted cannot.
		expect(await until(() => seen.some((frame) => frame > 0), 2000)).toBe(true);
		const frames = new Set<string>();
		for (let i = 0; i < JEV_FRAMES.length; i++) frames.add(jevBadgeText(theme, { ...badge.read(), frame: i }));
		expect(frames.size).toBe(3); // hollow, half, full: the half frame repeats
		expect(seen.length).toBeGreaterThan(2); // two starts repaint, so a third repaint is a tick
		badge.end({ toolCallId: "search", result: result({ judgment: { judge: "jev", status: "judged", kept: 2, removed: [] } }) });
		badge.end({ toolCallId: "facts" });
		expect(badge.read().busy).toBe(1);
		badge.end({ toolCallId: "meta", result: result({ judgment: { judge: "jev", status: "judged", kept: 1, removed: [] } }) });
		expect(badge.read().busy).toBe(0);
		const settled = badge.read().frame;
		const after = seen.length;
		await delay(30);
		expect(badge.read().frame).toBe(settled);
		expect(seen.length).toBe(after);
		expect(jevBadgeText(theme, badge.read())).toBe("◆ Jev · 3 screened");
		badge.stop();
	});

	test("header: the badge is glued to the right end of the title rule and degrades tally, badge, rule in that order", () => {
		const labels = coachLabels("openai-codex/gpt-6-sol", ["Player01#NA1"]);
		const state = fresh();
		state.tally.screened = 12;
		state.tally.cut = 3;
		const wide = headerLines(theme, undefined, labels, 100, undefined, state)[1];
		expect(wide).toStartWith("VOXREN COACH  Player01#NA1 ━━━");
		expect(wide).toEndWith("━ ◆ Jev · 12 screened · 3 cut");
		expect(visibleWidth(wide)).toBe(100);
		const narrow = headerLines(theme, undefined, labels, 50, undefined, state)[1];
		expect(narrow).toEndWith("━ ◆ Jev");
		expect(visibleWidth(narrow)).toBe(50);
		expect(headerLines(theme, undefined, labels, 34, undefined, state)[1]).toBe(`VOXREN COACH  Player01#NA1 ${"━".repeat(7)}`);
		expect(headerLines(theme, undefined, labels, 100)[1]).not.toContain("Jev");
		for (const width of [44, 60, 80, 120]) expect(visibleWidth(headerLines(theme, undefined, labels, width, undefined, state)[1])).toBeLessThanOrEqual(width);
	});
});
