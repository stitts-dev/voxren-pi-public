import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadProfile, profilePath, saveProfile } from "./config";
import { COACH_COMMANDS, COACH_TIERS, COACH_YAML, type CommandSettings } from "./contracts";
import { EMPTY_STATS, TREE_COMMAND, TREE_COMMAND_DESCRIPTION, TREE_NO_ARGS_MESSAGE, TREE_TUI_ONLY_MESSAGE, TreePanel, commandMarks, commandTree, createTreeStats, lensLine, panelLines, promptSteps, treeLines } from "./command-tree";
import { installVoxrenCoach } from "./index";
import { createCardMotion, headerLines, wrapLines } from "./ui";

const plain = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as any;
/** Tags every span with its role so colour rules are testable: `[role:text]`, `[b:text]`. */
const tagged = { fg: (role: string, text: string) => `[${role}:${text}]`, bold: (text: string) => `[b:${text}]` } as any;

const KEY = { right: "\x1b[C", left: "\x1b[D", up: "\x1b[A", down: "\x1b[B", home: "\x1b[H", end: "\x1b[F", escape: "\x1b", enter: "\r", space: " ", backspace: "\x7f", delete: "\x1b[3~", a: "a" };

describe("promptSteps", () => {
	test("tools in order of first mention, each once", () => {
		expect(promptSteps("Use voxren_meta_research and voxren_game_facts, then voxren_meta_research again.", [])).toEqual(["voxren_meta_research", "voxren_game_facts"]);
	});

	test("a mention right after 'no' is a prohibition, not a step", () => {
		expect(promptSteps("Make one voxren_meta_research call; no web_search here, the clock is running.", [])).toEqual(["voxren_meta_research"]);
	});

	test("a template that names no tool falls back to the tools the command needs", () => {
		expect(promptSteps("Review my last {{count}} ranked solo games.", ["voxren_player_audit"])).toEqual(["voxren_player_audit"]);
		expect(promptSteps("", [])).toEqual([]);
	});
});

describe("commandTree", () => {
	const tree = commandTree();
	const node = (name: string) => tree.find((entry) => entry.name === name)!;

	test("one node per coach.yaml command, in its order, carrying the command's own tier and that tier's model and thinking", () => {
		expect(tree.map((entry) => entry.name)).toEqual(COACH_COMMANDS.map((command) => command.name));
		expect(tree.map((entry) => entry.tier)).toEqual(COACH_COMMANDS.map((command) => command.tier));
		for (const command of COACH_COMMANDS) {
			expect(node(command.name).model).toBe(COACH_TIERS[command.tier].model);
			expect(node(command.name).thinking).toBe(COACH_TIERS[command.tier].thinking);
		}
		expect(node("review").tier).toBe("deep");
		expect(node("draft").tier).toBe("quick");
	});

	test("a step whose tool is off in this launch is marked, and only that one", () => {
		const off = commandTree(COACH_COMMANDS, COACH_YAML.commands, ["voxren_player_audit", "web_search"]);
		const by = (name: string) => off.find((entry) => entry.name === name)!;
		expect(by("review").off).toEqual(["voxren_player_audit"]);
		expect(by("patch").off).toEqual(["web_search"]);
		expect(by("matchup").off).toEqual([]);
		expect(by("draft").off).toEqual([]);
		expect(tree.every((entry) => entry.off.length === 0)).toBe(true);
		const lines = treeLines(tagged, by("patch"), EMPTY_STATS, 120);
		expect(lines[5]).toContain("[b:search  ] Searching the web[dim: · ][error:off this launch]");
		expect(lines[6]).toContain("[b:facts   ] Reading Data Dragon[dim: · ][dim:not called yet]");
	});

	test("the steps follow each prompt: /matchup and /draft meta alone (the search pair lives in the system prompt), /review its audit", () => {
		expect(node("matchup").steps).toEqual(["voxren_meta_research"]);
		expect(node("draft").steps).toEqual(["voxren_meta_research"]);
		expect(node("pick").steps).toEqual(["voxren_meta_research"]);
		expect(node("build").steps).toEqual(["voxren_meta_research", "voxren_game_facts"]);
		expect(node("review").steps).toEqual(["voxren_player_audit"]);
		expect(node("patch").steps).toEqual(["web_search", "voxren_game_facts"]);
		expect(node("otp").steps).toEqual(["voxren_otp_build"]);
		expect(node("comp").steps).toEqual(["voxren_meta_research", "voxren_game_facts", "web_search", "voxren_video_research", "voxren_strategy_frame"]);
	});

	test("what each command reads follows the command contract", () => {
		expect(node("comp").readsClient).toBe(true);
		expect(node("matchup").fillsLane).toBe(true);
		expect(node("review").readsClient).toBe(false);
		expect(node("review").fillsLane).toBe(false);
	});
});

describe("createTreeStats", () => {
	test("folds tool calls into per-tool tallies with the clock it is given, and ignores a name that is not a coach tool", () => {
		let clock = 1000;
		const stats = createTreeStats({ now: () => clock });
		stats.toolStart({ toolCallId: "a", toolName: "web_search" });
		stats.toolStart({ toolCallId: "x", toolName: "bash" });
		clock += 1500;
		stats.toolEnd({ toolCallId: "a", isError: false });
		stats.toolEnd({ toolCallId: "x", isError: false });
		stats.toolStart({ toolCallId: "b", toolName: "web_search" });
		clock += 500;
		stats.toolEnd({ toolCallId: "b", isError: true });
		expect(stats.read().commands.get("")?.tools.get("web_search")).toEqual({ calls: 2, failed: 1, totalMs: 2000 });
		expect(stats.read().commands.get("")?.tools.has("bash" as any)).toBe(false);
		expect(stats.read().commands.get("")?.runs).toBe(0);
		expect(stats.read().running.size).toBe(0);
	});

	test("a run tags its command and strips the auto suffix; the turn stays open until it settles, since Pi can continue it after agent_end", () => {
		let changes = 0;
		const stats = createTreeStats({ onChange: () => changes++, now: () => 0 });
		stats.turnStart("draft");
		expect(stats.read().current).toBe("draft");
		expect(stats.read().currentStarted).toBe(0);
		stats.toolStart({ toolCallId: "a", toolName: "voxren_meta_research" });
		expect(stats.read().running.get("a")).toEqual({ name: "voxren_meta_research", command: "draft", started: 0 });
		stats.run({ command: "draft:auto", ms: 8000, tools: [{ name: "voxren_meta_research", args: {}, ms: 1200, ok: true, result: undefined }], aborted: undefined });
		expect(stats.read().commands.get("draft")).toEqual({ runs: 1, lastMs: 8000, lastTools: ["voxren_meta_research"], lastAborted: false, previousMs: undefined, tools: new Map() });
		// A retried attempt's call, after agent_end and before agent_settled, still files under the command.
		expect(stats.read().current).toBe("draft");
		expect(stats.read().running.size).toBe(1);
		stats.toolStart({ toolCallId: "b", toolName: "web_search" });
		stats.toolEnd({ toolCallId: "b", isError: false });
		expect(stats.read().commands.get("draft")?.tools.get("web_search")).toEqual({ calls: 1, failed: 0, totalMs: 0 });
		stats.turnEnd();
		expect(stats.read().current).toBeUndefined();
		expect(stats.read().currentStarted).toBeUndefined();
		expect(stats.read().running.size).toBe(0);
		stats.run({ command: "draft", ms: 5000, tools: [], aborted: undefined });
		expect(stats.read().commands.get("draft")).toMatchObject({ runs: 2, lastMs: 5000, previousMs: 8000 });
		stats.turnStart(undefined);
		expect(stats.read().current).toBe("");
		expect(changes).toBe(8);
		stats.reset();
		expect(stats.read().commands.size).toBe(0);
		expect(stats.read().current).toBeUndefined();
		expect(changes).toBe(9);
	});
});

describe("commandMarks", () => {
	test("the header's command bar carries a run count and ● per command, and nothing on a fresh launch", () => {
		expect(commandMarks(EMPTY_STATS).size).toBe(0);
		const stats = createTreeStats({ now: () => 0 });
		stats.run({ command: "matchup", ms: 1, tools: [], aborted: undefined });
		stats.run({ command: "matchup", ms: 1, tools: [], aborted: undefined });
		stats.turnStart("draft");
		stats.toolStart({ toolCallId: "a", toolName: "voxren_meta_research" });
		const marks = commandMarks(stats.read());
		expect([...marks]).toEqual([["matchup", " ×2  "], ["draft", " ●"]]);
		const bar = headerLines(plain, undefined, undefined, 120, undefined, undefined, marks)[2];
		expect(bar).toContain("/matchup <enemy> ×2");
		expect(bar).toContain("/draft ●");
		expect(bar).toContain("/review [games]");
		expect(headerLines(plain, undefined, undefined, 120)[2]).not.toContain("×");
		for (const width of [24, 40, 80]) for (const line of wrapLines(headerLines(plain, undefined, undefined, width, undefined, undefined, marks), width, "   ")) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});

describe("lensLine", () => {
	const tree = commandTree();

	test("wide: every command on the line, the selected one bold and bracketed, no arrows", () => {
		const line = lensLine(tagged, tree, 1, 120);
		expect(line).toContain("[b:[accent:[/matchup]]]");
		for (const node of tree) expect(line).toContain(`/${node.name}`);
		expect(line).not.toContain("◂");
		expect(line).not.toContain("▸");
	});

	test("narrow: a window around the selection with an arrow on each cut side, never wider than the pane", () => {
		for (const width of [20, 28, 36, 48, 60]) {
			for (let selected = 0; selected < tree.length; selected++) {
				const line = lensLine(plain, tree, selected, width);
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line).toContain(`[/${tree[selected].name}]`);
			}
		}
		expect(lensLine(plain, tree, 0, 36)).toMatch(/^\[\/review\].*▸$/);
		expect(lensLine(plain, tree, tree.length - 1, 36)).toMatch(/^◂ .*\[\/pick\]$/);
		const middle = lensLine(plain, tree, 4, 36);
		expect(middle).toBe("◂ /patch  [/otp]  /comp  /draft ▸");
	});

	test("a call opening or closing under a command moves no other command, in the header bar or the lens strip", () => {
		const col = (line: string, word: string) => line.indexOf(word);
		const stats = createTreeStats({ now: () => 0 });
		for (const command of ["pick", "draft", "comp"]) stats.run({ command, ms: 1, tools: [], aborted: undefined });
		const bar = (marks: Map<string, string>) => headerLines(plain, undefined, undefined, 120, undefined, undefined, marks)[2];
		const lens = () => lensLine(plain, tree, 0, 140, stats.read());
		const before = bar(commandMarks(stats.read()));
		const lensBefore = lens();
		stats.turnStart("pick");
		stats.toolStart({ toolCallId: "a", toolName: "voxren_meta_research" });
		const during = bar(commandMarks(stats.read()));
		expect(before).not.toBe(during);
		for (const word of ["/draft", "/comp", "/otp", "/report"]) expect(col(during, word)).toBe(col(before, word));
		for (const word of ["/draft", "/comp", "/otp"]) expect(col(lens(), word)).toBe(col(lensBefore, word));
	});

	test("live: a command that ran carries its run count, one with a call open right now carries ●, auto runs count for /draft", () => {
		const stats = createTreeStats({ now: () => 0 });
		stats.run({ command: "matchup", ms: 1, tools: [], aborted: undefined });
		stats.run({ command: "matchup", ms: 1, tools: [], aborted: undefined });
		stats.run({ command: "draft:auto", ms: 1, tools: [], aborted: undefined });
		stats.turnStart("draft");
		stats.toolStart({ toolCallId: "a", toolName: "voxren_meta_research" });
		const line = lensLine(tagged, tree, 1, 120, stats.read());
		expect(line).toContain("[b:[accent:[/matchup ×2]]]");
		expect(line).toContain("[dim:/draft ×1] [accent:●]");
		expect(line).toContain("[dim:/review]");
		expect(lensLine(plain, tree, 6, 120, stats.read())).toContain("[/draft ×1 ●]");
		expect(visibleWidth(lensLine(plain, tree, 1, 80, stats.read()))).toBeLessThanOrEqual(80);
	});
});

describe("treeLines", () => {
	const tree = commandTree();
	const matchup = tree.find((node) => node.name === "matchup")!;

	test("before any run: the tier, what it reads, its steps, and that nothing has run", () => {
		const lines = treeLines(plain, matchup, EMPTY_STATS, 100);
		expect(lines[0]).toStartWith("/matchup <enemy> ───");
		expect(lines[1]).toBe("  Lane plan for a matchup (<enemy>, or <mine> vs <enemy>)");
		expect(lines[2]).toBe("  ├─ tier   standard · default gpt-6-sol · thinking medium");
		expect(lines[3]).toBe("  ├─ reads  League client, your lane");
		expect(lines[4]).toBe("  ├─ steps");
		expect(lines[5]).toBe("  │  └─ 1 meta     Reading OP.GG meta · not called yet");
		expect(lines[6]).toBe("  └─ runs   not run this session");
		expect(lines).toHaveLength(7);
		const comp = treeLines(plain, tree.find((node) => node.name === "comp")!, EMPTY_STATS, 100);
		expect(comp.slice(5, 9)).toEqual([
			"  │  ├─ 1 meta     Reading OP.GG meta · not called yet",
			"  │  ├─ 2 facts    Reading Data Dragon · not called yet",
			"  │  ├─ 3 search   Searching the web · not called yet",
			"  │  ├─ 4 videos   Reading video transcripts · not called yet",
		]);
		const review = treeLines(plain, tree.find((node) => node.name === "review")!, EMPTY_STATS, 100);
		expect(review.find((line) => line.includes("├─ reads"))).toBe("  ├─ reads  no client read");
	});

	test("a long description wraps whole at 80 columns, never cut with an ellipsis", () => {
		const long = tree.filter((node) => visibleWidth(`  ${node.description}`) > 80);
		expect(long.length).toBeGreaterThan(0);
		for (const node of long) {
			const lines = treeLines(plain, node, EMPTY_STATS, 80);
			expect(lines.join("\n")).not.toMatch(/\.\.\.|…/);
			const head = lines.slice(1, lines.findIndex((line) => line.includes("├─ tier"))).map((line) => line.trim());
			expect(head.join(" ")).toBe(node.description);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});

	test("the tier word takes the thinking colour, the steps' numbers are dim, failures are red and a clean tally green", () => {
		let clock = 0;
		const stats = createTreeStats({ now: () => clock });
		stats.turnStart("matchup");
		stats.toolStart({ toolCallId: "a", toolName: "voxren_meta_research" });
		clock = 1800;
		stats.toolEnd({ toolCallId: "a", isError: false });
		stats.toolStart({ toolCallId: "b", toolName: "web_search" });
		clock = 4700;
		stats.toolEnd({ toolCallId: "b", isError: true });
		const lines = treeLines(tagged, matchup, stats.read(), 120);
		expect(lines[2]).toContain("[thinkingMedium:standard]");
		expect(lines[5]).toContain("[dim:1] [b:meta    ]");
		expect(lines[5]).toContain("1 call · 1.8 s avg · [success:all ok]");
		expect(lines[6]).toContain("1 call · 2.9 s avg · [error:1 failed]");
	});

	test("a tool's calls count under the command that made them: a meta lookup under /draft is not one of /matchup's", () => {
		const stats = createTreeStats({ now: () => 0 });
		stats.turnStart("draft");
		stats.toolStart({ toolCallId: "a", toolName: "voxren_meta_research" });
		stats.toolEnd({ toolCallId: "a", isError: false });
		stats.turnStart("draft");
		stats.toolStart({ toolCallId: "b", toolName: "voxren_meta_research" });
		expect(treeLines(plain, matchup, stats.read(), 120, 500)[5]).toBe("  │  └─ 1 meta     Reading OP.GG meta · not called yet");
		const draft = tree.find((node) => node.name === "draft")!;
		expect(treeLines(plain, draft, stats.read(), 120, 500)[5]).toBe("  │  └─ 1 meta     Reading OP.GG meta · running 0.5 s");
	});

	test("after runs: the command's count, last duration against the run before, and the tools that run called; while its turn is open, the time so far", () => {
		const stats = createTreeStats({ now: () => 10_000 });
		stats.run({ command: "matchup", ms: 24_300, tools: [{ name: "voxren_meta_research", args: {}, ms: 1, ok: true, result: undefined }, { name: "voxren_strategy_frame", args: {}, ms: 1, ok: true, result: undefined }], aborted: undefined });
		stats.run({ command: "matchup", ms: 9_400, tools: [], aborted: "timeout" });
		expect(treeLines(plain, matchup, stats.read(), 120, 10_000)[6]).toBe("  └─ runs   2 runs this session · last 9.4 s aborted vs 24 s before · called nothing");
		stats.turnStart("matchup");
		stats.toolStart({ toolCallId: "c", toolName: "voxren_meta_research" });
		const lines = treeLines(plain, matchup, stats.read(), 120, 12_250);
		expect(lines[4]).toBe("  ├─ steps");
		expect(lines[5]).toBe("  │  └─ 1 meta     Reading OP.GG meta · running 2.3 s");
		expect(lines[6]).toBe("  └─ runs   now 2.3 s so far vs 9.4 s last");
		const first = createTreeStats({ now: () => 0 });
		first.turnStart("matchup");
		expect(treeLines(plain, matchup, first.read(), 120, 400)[6]).toBe("  └─ runs   now 0.4 s so far");
	});

	test("a tool the command called that its prompt never named hangs under the planned steps with a + mark", () => {
		const stats = createTreeStats({ now: () => 0 });
		stats.turnStart("matchup");
		stats.toolStart({ toolCallId: "a", toolName: "voxren_strategy_frame" });
		stats.toolEnd({ toolCallId: "a", isError: false });
		stats.toolStart({ toolCallId: "b", toolName: "voxren_game_facts" });
		const lines = treeLines(plain, matchup, stats.read(), 120, 700);
		expect(lines.slice(5, 8)).toEqual([
			"  │  ├─ 1 meta     Reading OP.GG meta · not called yet",
			"  │  ├─ + check    Framing the call · 1 call · 0.0 s avg · all ok",
			"  │  └─ + facts    Reading Data Dragon · running 0.7 s",
		]);
	});

	test("a command whose prompt names no tool says so instead of an empty branch", () => {
		const lines = treeLines(plain, { ...matchup, steps: [] }, EMPTY_STATS, 80);
		expect(lines[5]).toBe("  │  └─ no tool: the model answers from the prompt alone");
	});

	test("every line of the panel fits the pane from 20 to 120 columns, for every command, the key hint included", () => {
		const stats = createTreeStats({ now: () => 0 });
		for (const node of tree) stats.run({ command: node.name, ms: 123_456, tools: node.steps.map((name) => ({ name, args: {}, ms: 1, ok: true, result: undefined })), aborted: undefined });
		stats.turnStart("comp");
		stats.toolStart({ toolCallId: "a", toolName: "web_search" });
		for (const width of [20, 30, 36, 40, 60, 80, 120]) {
			for (let selected = 0; selected < tree.length; selected++) {
				for (const line of panelLines(plain, tree, selected, stats.read(), width, 0)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});

describe("TreePanel", () => {
	const tree = commandTree();
	const open = () => {
		const calls = { renders: 0, done: 0 };
		const panel = new TreePanel(plain, tree, () => EMPTY_STATS, { requestRender: () => calls.renders++, done: () => calls.done++ });
		return { panel, calls };
	};

	test("right and left move the lens and stop at the ends; home and end jump; a key it does not use changes nothing", () => {
		const { panel, calls } = open();
		panel.handleInput(KEY.right);
		expect(panel.selection).toBe(1);
		panel.handleInput(KEY.left);
		panel.handleInput(KEY.left);
		expect(panel.selection).toBe(0);
		panel.handleInput(KEY.end);
		expect(panel.selection).toBe(tree.length - 1);
		panel.handleInput(KEY.right);
		expect(panel.selection).toBe(tree.length - 1);
		panel.handleInput(KEY.home);
		expect(panel.selection).toBe(0);
		expect(calls.renders).toBe(6);
		panel.handleInput(KEY.a);
		expect(calls.renders).toBe(6);
		expect(calls.done).toBe(0);
	});

	test("escape and enter close it, and the rendered panel shows the selected command's tree under the lens", () => {
		const { panel, calls } = open();
		panel.handleInput(KEY.right);
		const lines = panel.render(100).map((line) => line.trimEnd());
		expect(lines[0]).toContain("COMMAND TREE");
		expect(lines.some((line) => line.includes("[/matchup]"))).toBe(true);
		expect(lines.some((line) => line.startsWith(" /matchup <enemy> ───"))).toBe(true);
		panel.handleInput(KEY.escape);
		panel.handleInput(KEY.enter);
		expect(calls.done).toBe(2);
	});

	test("a typed character closes the panel and goes to the editor; control keys it does not use are dropped", () => {
		const typed: string[] = [];
		let done = 0;
		const panel = new TreePanel(plain, tree, () => EMPTY_STATS, { requestRender() {}, done: () => done++, onType: (text) => typed.push(text) });
		panel.handleInput("/");
		expect(done).toBe(1);
		expect(typed).toEqual(["/"]);
		panel.handleInput("\x01");
		expect(done).toBe(1);
		expect(typed).toEqual(["/"]);
		const silent = new TreePanel(plain, tree, () => EMPTY_STATS, { requestRender() {}, done: () => done++ });
		silent.handleInput("m");
		expect(done).toBe(1);
	});

	test("while a call is open the panel watches the card clock, and lets go once the call ends", () => {
		const stats = createTreeStats({ now: () => 0 });
		const live = new Set<() => void>();
		const motion = { now: () => 0, watch: (repaint: () => void) => (live.add(repaint), () => live.delete(repaint)) };
		const panel = new TreePanel(plain, tree, () => stats.read(), { requestRender() {}, done() {} }, motion);
		panel.render(80);
		expect(live.size).toBe(0);
		stats.toolStart({ toolCallId: "a", toolName: "web_search" });
		panel.render(80);
		panel.render(80);
		expect(live.size).toBe(1);
		stats.toolEnd({ toolCallId: "a", isError: false });
		panel.render(80);
		expect(live.size).toBe(0);
	});
});

describe("TreePanel clock after motion.stop()", () => {
	test("Pi continues the turn after agent_end: the next call starts the clock again", () => {
		let starts = 0;
		const motion = createCardMotion({ setInterval: (() => ++starts) as unknown as typeof setInterval, clearInterval: (() => {}) as unknown as typeof clearInterval });
		motion.enable(true);
		const stats = createTreeStats({ now: () => 0 });
		const panel = new TreePanel(plain, commandTree(), () => stats.read(), { requestRender() {}, done() {} }, motion);
		stats.turnStart("matchup");
		stats.toolStart({ toolCallId: "a", toolName: "voxren_meta_research" });
		panel.render(80);
		expect(starts).toBe(1);
		motion.stop();
		stats.toolStart({ toolCallId: "b", toolName: "voxren_game_facts" });
		panel.render(80);
		expect(starts).toBe(2);
	});
});

describe("setting rows", () => {
	const tree = commandTree();
	const node = (name: string) => tree.find((entry) => entry.name === name)!;
	const lines = (name: string, settings?: CommandSettings, view: { autoForced?: boolean; focus?: "auto" | "args" } = {}) =>
		treeLines(plain, node(name), EMPTY_STATS, 120, 0, settings && { settings, autoForced: view.autoForced, focus: view.focus });
	const row = (...args: Parameters<typeof lines>) => lines(...args).at(-1);

	test("a Settings group under the tree: auto on /draft, args on the commands that save a default, the focused value in ‹ ›", () => {
		expect(lines("draft", {}).slice(-3)).toEqual(["", expect.stringMatching(/^SETTINGS ─+$/), "  └─ auto   on · calls your pick when it settles, the draft once four enemies lock"]);
		expect(row("draft", { auto: true })).toBe("  └─ auto   on · calls your pick when it settles, the draft once four enemies lock");
		expect(row("draft", { auto: false })).toBe("  └─ auto   off · calls your pick when it settles, the draft once four enemies lock");
		expect(row("draft", { auto: true }, { autoForced: false })).toBe("  └─ auto   off · VOXREN_COACH_AUTO_COMP");
		expect(row("draft", {}, { autoForced: true })).toBe("  └─ auto   on · VOXREN_COACH_AUTO_COMP");
		expect(lines("review", { args: "15" }, { focus: "args" }).at(-2)).toBe("  ├─ args   ‹ 15 › · what a bare /review sends");
		expect(row("comp", {})).toBe("  └─ auto   on · plans your game when it starts");
		expect(row("review", { auto: false })).toBe("  └─ auto   off · reviews your last ranked game when a game ends");
		expect(row("review", {}, { autoForced: false })).toBe("  └─ auto   off · VOXREN_COACH_AUTO_COMP");
		expect(row("otp", {})).toBe("  └─ args   none · what a bare /otp sends");
	});

	test("no Settings group on a command with none, or without a settings store", () => {
		expect(row("matchup", {})).toStartWith("  └─ runs");
		expect(row("draft")).toStartWith("  └─ runs");
	});
});

describe("TreePanel quit", () => {
	test("Ctrl+D closes the panel and quits, from the lens and from a setting row; without a quit hook it does nothing", () => {
		const log: string[] = [];
		const hooks = { requestRender() {}, done: () => log.push("done"), quit: () => log.push("quit") };
		new TreePanel(plain, commandTree(), () => EMPTY_STATS, hooks).handleInput("\x04");
		expect(log).toEqual(["done", "quit"]);
		const silent: string[] = [];
		new TreePanel(plain, commandTree(), () => EMPTY_STATS, { requestRender() {}, done: () => silent.push("done") }).handleInput("\x04");
		expect(silent).toEqual([]);
	});
});

describe("TreePanel settings", () => {
	const tree = commandTree();
	const at = (name: string) => tree.findIndex((entry) => entry.name === name);
	const open = (initial: Record<string, CommandSettings> = {}, opts: { autoForced?: boolean; refuse?: boolean; choices?: Record<string, string[]>; note?: string } = {}) => {
		let store = { ...initial };
		const saves: Array<[string, CommandSettings]> = [];
		let done = 0;
		const save = (name: string, next: CommandSettings) => {
			saves.push([name, next]);
			if (opts.refuse) return false;
			store = { ...store, [name]: next };
			return true;
		};
		const choices = async (name: string) => ({ items: (opts.choices?.[name] ?? []).map((value) => ({ value, label: value })), note: opts.note });
		const panel = new TreePanel(plain, tree, () => EMPTY_STATS, { requestRender() {}, done: () => done++, onType() {}, settings: { read: () => store, autoForced: opts.autoForced, save, choices } });
		const go = (name: string) => {
			panel.handleInput(KEY.home);
			for (let i = 0; i < at(name); i++) panel.handleInput(KEY.right);
		};
		const text = () => panel.render(120).map((line) => line.trimEnd()).join("\n");
		return { panel, saves, go, text, done: () => done };
	};

	test("/comp's auto row is its second row: down, down, right switches game start off", () => {
		const { panel, saves, go } = open();
		go("comp");
		panel.handleInput(KEY.down);
		panel.handleInput(KEY.down);
		panel.handleInput(KEY.right);
		expect(saves).toEqual([["comp", { auto: false }]]);
	});

	test("down steps into /draft's auto row, left and right flip it through the store, up returns to the lens", () => {
		const { panel, saves, go, text } = open();
		go("draft");
		expect(text()).toContain("← → move · ↓ settings");
		panel.handleInput(KEY.down);
		expect(text()).toContain("auto   ‹ on ›"); // unset shows the default, on
		expect(text()).toContain("↑ ↓ row · ← → change");
		panel.handleInput(KEY.right);
		expect(text()).toContain("auto   ‹ off ›");
		panel.handleInput(KEY.left);
		expect(saves).toEqual([["draft", { auto: false }], ["draft", { auto: true }]]);
		panel.handleInput(KEY.up);
		expect(text()).toContain("└─ auto   on");
		panel.handleInput(KEY.left);
		expect(panel.selection).toBe(at("draft") - 1);
	});

	test("on a setting row only the arrows, Del and Esc act: Home, End, Tab, Shift+Tab and Enter do nothing", () => {
		for (const key of [KEY.home, KEY.end, "\t", "\x1b[Z", KEY.enter, "\n"]) {
			const { panel, done } = open();
			panel.handleInput(KEY.home);
			for (let i = 0; i < at("patch"); i++) panel.handleInput(KEY.right);
			panel.handleInput(KEY.down);
			panel.handleInput(key);
			expect(panel.selection).toBe(at("patch"));
			expect(done()).toBe(0);
			panel.handleInput(KEY.escape); // still on the row: Esc steps back to the lens, not out of the panel
			expect(done()).toBe(0);
		}
	});

	test("on a setting row Ctrl+D still quits and a typed character still reaches the editor", () => {
		const events: string[] = [];
		const panel = new TreePanel(plain, tree, () => EMPTY_STATS, {
			requestRender() {},
			done: () => events.push("done"),
			quit: () => events.push("quit"),
			onType: (text) => events.push(`type:${text}`),
			settings: { read: () => ({}), save: () => true, choices: async () => ({ items: [] }) },
		});
		for (let i = 0; i < at("draft"); i++) panel.handleInput(KEY.right);
		panel.handleInput(KEY.down);
		panel.handleInput("\x04");
		expect(events).toEqual(["done", "quit"]);
		events.length = 0;
		panel.handleInput(KEY.down);
		panel.handleInput(KEY.a);
		expect(events).toEqual(["done", "type:a"]);
	});

	test("the args row hint names arrows and Esc only", () => {
		const { panel, go, text } = open();
		go("review");
		panel.handleInput(KEY.down);
		expect(text()).toContain("↑ ↓ row · ← → change · Esc back");
		expect(text()).not.toContain("Del");
	});

	test("a list that lands after the player left the args row saves nothing, and keeps the list for the next try", async () => {
		let release!: (value: { items: Array<{ value: string; label: string }> }) => void;
		const saves: Array<[string, CommandSettings]> = [];
		let done = 0;
		const panel = new TreePanel(plain, tree, () => EMPTY_STATS, {
			requestRender() {},
			done: () => done++,
			settings: { read: () => ({}), save: (name, next) => (saves.push([name, next]), true), choices: () => new Promise((resolve) => (release = resolve)) },
		});
		panel.handleInput(KEY.home);
		for (let i = 0; i < at("patch"); i++) panel.handleInput(KEY.right);
		panel.handleInput(KEY.down);
		panel.handleInput(KEY.right); // loading
		panel.handleInput(KEY.escape);
		panel.handleInput(KEY.escape);
		expect(done).toBe(1);
		release({ items: [{ value: "Ahri", label: "Ahri" }] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(saves).toEqual([]);
		panel.handleInput(KEY.down);
		panel.handleInput(KEY.right);
		expect(saves).toEqual([["patch", { args: "Ahri" }]]);
	});

	test("forced auto shows the env var, on or off, and does not flip", () => {
		const { panel, saves, go, text } = open({}, { autoForced: true });
		go("draft");
		panel.handleInput(KEY.down);
		panel.handleInput(KEY.right);
		expect(saves).toEqual([]);
		expect(text()).toContain("auto   ‹ on › · VOXREN_COACH_AUTO_COMP");
		const off = open({ draft: { auto: true } }, { autoForced: false });
		off.go("draft");
		off.panel.handleInput(KEY.down);
		off.panel.handleInput(KEY.right);
		expect(off.saves).toEqual([]);
		expect(off.text()).toContain("auto   ‹ off › · VOXREN_COACH_AUTO_COMP");
	});

	test("left and right step a fixed list (/review: none, 3, 5, ... 20) both ways and wrap; delete clears", () => {
		const { panel, saves, go, text } = open();
		go("review");
		panel.handleInput(KEY.down);
		panel.handleInput(KEY.right);
		panel.handleInput(KEY.right);
		expect(saves.map(([, next]) => next.args)).toEqual(["3", "5"]);
		expect(text()).toContain("args   ‹ 5 › · what a bare /review sends");
		panel.handleInput(KEY.left);
		panel.handleInput(KEY.left);
		panel.handleInput(KEY.left);
		expect(saves.slice(2).map(([, next]) => next.args)).toEqual(["3", undefined, "20"]);
		panel.handleInput(KEY.delete);
		expect(saves.at(-1)).toEqual(["review", {}]);
		expect(text()).toContain("args   ‹ none ›");
	});

	test("a data list loads on the first step, then left and right walk it with none between the ends", async () => {
		const { panel, saves, go, text } = open({}, { choices: { patch: ["Ahri", "Akali", "Zed"] } });
		go("patch");
		panel.handleInput(KEY.down);
		panel.handleInput(KEY.right);
		expect(text()).toContain("args   ‹ loading… ›");
		await Bun.sleep(0);
		expect(saves).toEqual([["patch", { args: "Ahri" }]]);
		panel.handleInput(KEY.right);
		panel.handleInput(KEY.left);
		panel.handleInput(KEY.left);
		panel.handleInput(KEY.left);
		expect(saves.map(([, next]) => next.args)).toEqual(["Ahri", "Akali", "Ahri", undefined, "Zed"]);
		expect(text()).toContain("args   ‹ Zed ›");
	});

	test("an empty data list says why on the row and saves nothing", async () => {
		const { panel, saves, go, text } = open({}, { choices: { otp: [] }, note: "no saved one-tricks yet" });
		go("otp");
		panel.handleInput(KEY.down);
		panel.handleInput(KEY.right);
		await Bun.sleep(0);
		expect(saves).toEqual([]);
		expect(text()).toContain("args   ‹ none › · no saved one-tricks yet");
	});

	test("down does nothing on a command with no setting; up then right moves the lens; a typed letter on a row closes the panel, enter does not", () => {
		const { panel, go, text, done } = open();
		go("matchup");
		panel.handleInput(KEY.down);
		expect(text()).toContain("← → move · Home/End ends · Esc close");
		go("review");
		panel.handleInput(KEY.down);
		panel.handleInput(KEY.up);
		panel.handleInput(KEY.right);
		expect(panel.selection).toBe(at("review") + 1);
		panel.handleInput(KEY.down);
		panel.handleInput("x");
		expect(done()).toBe(1);
		go("review");
		panel.handleInput(KEY.down);
		panel.handleInput(KEY.enter);
		expect(done()).toBe(1);
	});
});

describe("/flow command wiring", () => {
	function fakePi() {
		const commands = new Map<string, any>();
		const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
		const sent: string[] = [];
		return {
			commands,
			handlers,
			sent,
			pi: {
				registerTool: () => {},
				setActiveTools: () => {},
				sendUserMessage: (text: string) => sent.push(text),
				sendMessage: () => {},
				registerMessageRenderer: () => {},
				registerMarkdownTransformer: () => {},
				getThinkingLevel: () => "medium",
				setModel: async () => true,
				setThinkingLevel: () => {},
				registerCommand: (name: string, options: any) => commands.set(name, options),
				on: (event: string, handler: (payload: any, ctx?: any) => any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			},
		};
	}

	function fakeCtx(mode = "tui") {
		const notes: Array<[string, string]> = [];
		let factory: any;
		let opened = 0;
		return {
			notes,
			opened: () => opened,
			panel: () => factory({ requestRender() {} }, plain, {}, () => {}),
			ctx: { hasUI: true, mode, isIdle: () => true, sessionManager: { getBranch: () => [], getEntries: () => [] }, ui: { notify: (text: string, level: string) => notes.push([text, level]), custom: async (next: any) => void ((factory = next), opened++) } },
		};
	}

	const custodian = { fetch: async () => ({ status: 200, body: "{}" }), status: async () => ({ state: { stored: false } }) } as any;
	const strip = (lines: string[]) => lines.map((line) => line.trimEnd()).join("\n");

	test("auto /draft turns on from the profile, and its row stops and restarts it mid-session", async () => {
		const environment = { PI_CODING_AGENT_DIR: join(mkdtempSync(join(tmpdir(), "voxren-flow-auto-")), "agent") };
		saveProfile(profilePath(environment), { riotIds: { known: [] }, commands: { draft: { auto: true } } });
		const fake = fakePi();
		let state: any = { kind: "closed" };
		let onChange = () => {};
		installVoxrenCoach(fake.pi as any, environment, custodian, async () => ({ text: "Champ select, 30s left." }), async () => undefined, (change) => ((onChange = change), { read: () => state, stop() {} }), async () => undefined);
		const tui = fakeCtx();
		Object.assign(tui.ctx.ui, { setTitle() {}, setHeader() {}, setFooter() {}, setWorkingMessage() {}, setHiddenThinkingLabel() {}, setWidget() {}, setEditorText() {}, getEditorText: () => "" });
		await fake.handlers.get("session_start")![0]({}, tui.ctx);
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
		const poll = async (lockedDraft: string) => {
			state = { kind: "champSelect", secondsLeft: 30, picksMade: 10, picksTotal: 10, bansMade: 10, bansTotal: 10, lockedDraft };
			onChange();
			await settle();
		};
		await poll("a");
		expect(fake.sent).toHaveLength(1);
		const panel = tui.panel();
		panel.handleInput(KEY.end);
		panel.handleInput(KEY.left);
		panel.handleInput(KEY.down);
		panel.handleInput(KEY.right);
		expect(loadProfile(profilePath(environment)).commands).toEqual({ draft: { auto: false } }); // a saved off beats the default on
		await poll("b");
		expect(fake.sent).toHaveLength(1);
		panel.handleInput(KEY.left);
		await settle();
		expect(fake.sent).toHaveLength(2); // the toggle checks the draft itself: "b" runs with no new poll
		expect(loadProfile(profilePath(environment)).commands).toEqual({ draft: { auto: true } });
	});

	test("a TUI session opens the panel at startup; a typed character hands off to the editor; print mode opens nothing", async () => {
		const fake = fakePi();
		installVoxrenCoach(fake.pi as any, {}, custodian, async () => undefined, async () => undefined, () => ({ read: () => ({ kind: "closed" as const }), stop() {} }), async () => undefined);
		const tui = fakeCtx();
		let editor = "";
		Object.assign(tui.ctx.ui, { setTitle() {}, setHeader() {}, setFooter() {}, setWorkingMessage() {}, setHiddenThinkingLabel() {}, setWidget() {}, setEditorText: (text: string) => (editor = text), getEditorText: () => editor });
		await fake.handlers.get("session_start")![0]({}, tui.ctx);
		expect(tui.opened()).toBe(1);
		const panel = tui.panel();
		expect(strip(panel.render(100))).toContain("[/review]");
		panel.handleInput("/");
		expect(editor).toBe("/");
		const print = fakeCtx("print");
		await fake.handlers.get("session_start")![0]({}, { ...print.ctx, hasUI: false });
		expect(print.opened()).toBe(0);
	});

	test("takes no arguments, needs the TUI, and never starts a model turn", async () => {
		const fake = fakePi();
		installVoxrenCoach(fake.pi as any, {}, custodian, async () => undefined, async () => undefined, undefined, async () => undefined);
		const command = fake.commands.get(TREE_COMMAND);
		expect(command.description).toBe(TREE_COMMAND_DESCRIPTION);
		const withArgs = fakeCtx();
		await command.handler("matchup", withArgs.ctx);
		expect(withArgs.notes).toEqual([[TREE_NO_ARGS_MESSAGE, "error"]]);
		expect(withArgs.opened()).toBe(0);
		const printMode = fakeCtx("print");
		const savedWrite = process.stderr.write;
		let code = 0;
		const written: string[] = [];
		process.stderr.write = ((chunk: string) => (written.push(String(chunk)), true)) as any;
		try {
			await command.handler("", { ...printMode.ctx, setExitCode: (c: number) => void (code = c) });
			expect(code).toBe(1);
		} finally {
			process.stderr.write = savedWrite;
		}
		expect(written.join("")).toBe(`${TREE_TUI_ONLY_MESSAGE}\n`);
		expect(printMode.notes).toEqual([]);
		expect(printMode.opened()).toBe(0);
		const tui = fakeCtx();
		await command.handler("", tui.ctx);
		expect(tui.notes).toEqual([]);
		expect(tui.opened()).toBe(1);
		expect(strip(tui.panel().render(100))).toContain("COMMAND TREE");
		expect(fake.sent).toEqual([]);
	});

	test("a command's run and its tool calls reach the tree through the same hooks the exchange log uses", async () => {
		const fake = fakePi();
		installVoxrenCoach(fake.pi as any, { VOXREN_COACH_CHAMPION: "Fizz" }, custodian, async () => undefined, async () => undefined, undefined, async () => undefined);
		const { ctx } = fakeCtx();
		// /matchup Syndra as Pi drives it: the handler sends the prompt, the turn starts on it, one meta call, then the turn ends and settles.
		await fake.commands.get("matchup").handler("Syndra", ctx);
		await fake.handlers.get("before_agent_start")![0]({ prompt: fake.sent.at(-1), systemPromptOptions: {} }, ctx);
		await fake.handlers.get("tool_execution_start")![0]({ toolCallId: "t1", toolName: "voxren_meta_research", args: {} }, ctx);
		const open = fakeCtx();
		await fake.commands.get(TREE_COMMAND).handler("", open.ctx);
		const during = open.panel();
		during.handleInput(KEY.right);
		expect(strip(during.render(120))).toMatch(/\[\/matchup ●\]/);
		expect(strip(during.render(120))).toMatch(/└─ runs {3}now \d+\.\d s so far$/m);
		expect(strip(during.render(120))).toMatch(/1 meta {5}Reading OP.GG meta · running \d+\.\d s/);
		await fake.handlers.get("tool_execution_end")![0]({ toolCallId: "t1", result: {}, isError: false }, ctx);
		await fake.handlers.get("agent_end")![0]({ messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }, ctx);
		for (const settled of fake.handlers.get("agent_settled")!) await settled({}, ctx);
		const after = strip(during.render(120));
		expect(after).toContain("[/matchup ×1]");
		expect(after).toContain("├─ steps\n");
		expect(after).toMatch(/1 meta {5}Reading OP.GG meta · 1 call · \d+\.\d s avg · all ok/);
		expect(after).toMatch(/└─ runs {3}1 run this session · last \d+\.\d s · called meta/);
		expect(after).not.toContain(" before");
		// The call counted under /matchup only: /draft's own meta row is untouched.
		const draft = open.panel();
		draft.handleInput(KEY.end);
		draft.handleInput(KEY.left);
		expect(strip(draft.render(120))).toContain("1 meta     Reading OP.GG meta · not called yet");
		expect(strip(draft.render(120))).toContain("└─ runs   not run this session");
		// /new, /resume, /fork: Pi fires session_start again and "this session" starts over.
		await fake.handlers.get("session_start")![0]({ reason: "new" }, { hasUI: false });
		expect(strip(during.render(120))).toContain("└─ runs   not run this session");
		expect(strip(during.render(120))).toContain("1 meta     Reading OP.GG meta · not called yet");
	});
});
