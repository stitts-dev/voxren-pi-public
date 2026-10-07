import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createAutoComp, installVoxrenCoach } from "../index";
import { computeLcuFooterState, readComposition, replaySource, settlePick, type LcuFrame } from "../lcu";
import { draftFrames, type Draft } from "../lab/drafts";
import { FIXTURE_CHAMPION_IDS, FIXTURE_CHAMPION_NAMES, fixtureLaneLookup } from "../test-fixtures";

// A recorded-shape draft from the draft lab, played frame by frame as the League client would show it, through the real
// composition reader, the real commands, and a fake Pi: the prompt the model would receive for each command at each stage.
// Bans are left out: the fixture id file covers the picks, and no command reads the bans.
const draft: Draft = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "data", "lab", "drafts", "pyke-picks.json"), "utf8"));
const frames = draftFrames({ ...draft, bans: undefined }, FIXTURE_CHAMPION_IDS);
const frameAt = (label: string) => frames.find((frame) => frame.label === label)!.frame;
const ENV = { VOXREN_COACH_ACCOUNTS: "Test#NA1", PERPLEXITY_API_KEY: "test", VOXREN_COACH_LANE: "mid" };
const custodian = { fetch: async () => ({ status: 200, body: "{}" }), status: async () => ({ state: { stored: false } }) } as any;

/** Types `command` with the client showing `frame`; what reached the model, and what the player was told instead. */
async function run(frame: LcuFrame, command: "draft" | "pick") {
	const sent: string[] = [];
	const notes: Array<[string, string]> = [];
	const commands = new Map<string, any>();
	const source = replaySource(frame);
	const pi = {
		getThinkingLevel: () => "medium",
		setModel: async () => true,
		setThinkingLevel: () => {},
		registerTool: () => {},
		setActiveTools: () => {},
		registerCommand: (name: string, options: any) => commands.set(name, options),
		registerMessageRenderer: () => {},
		sendUserMessage: (text: string) => sent.push(text),
		sendMessage: () => {},
		on: () => {},
	};
	installVoxrenCoach(pi as any, ENV, custodian, () => readComposition(source.discover, source.makeClient, undefined, async () => FIXTURE_CHAMPION_NAMES), async () => undefined, () => ({ read: () => ({ kind: "closed" as const }), stop: () => {} }), fixtureLaneLookup);
	await commands.get(command).handler("", { hasUI: true, mode: "tui", isIdle: () => true, ui: { notify: (message: string, level: string) => notes.push([message, level]) } });
	return { sent, notes };
}

/** A composition row by its label: the command's prompt quotes the labels it reads, so a substring match would find those. */
const hasRow = (prompt: string, label: string) => prompt.split("\n").some((line) => line.startsWith(label));

/** The same frame with the player's own cell hovering `champion` (the draft lab's frames only ever lock). */
function hovering(frame: LcuFrame, champion: string): LcuFrame {
	const session = JSON.parse(frame.body);
	const self = session.myTeam.find((cell: any) => cell.cellId === session.localPlayerCellId);
	self.championPickIntent = FIXTURE_CHAMPION_IDS.get(champion.toLowerCase());
	return { ...frame, body: JSON.stringify(session) };
}

test("first pick in, own slot still open: /pick tells the player to hover and sends nothing; /draft plans around the open slots", async () => {
	const first = frames[0].frame;
	const pick = await run(first, "pick");
	expect(pick.sent).toEqual([]);
	expect(pick.notes).toEqual([["Hover or lock a champion first: /pick needs your own pick.", "info"]]);

	const { sent } = await run(first, "draft");
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("Your team: TOP Pantheon, JUNGLE open, MIDDLE open (you), BOTTOM open, UTILITY open");
	expect(sent[0]).toContain("Enemy team: open, open, open, open, open");
});

test("hovering Fizz with two enemies in: /pick goes out with the hover marked, and no lane opponent is named yet", async () => {
	const { sent } = await run(hovering(frameAt("pick 3"), "Fizz"), "pick");
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("MIDDLE Fizz (you, hovering)");
	expect(sent[0]).toContain("Enemy team (roles guessed from lane play rates): MIDDLE Yasuo, JUNGLE Wukong, open, open, open");
	expect(hasRow(sent[0], "Your lane opponent:")).toBe(false);
	expect(sent[0]).toContain("Pick call for my champion");
});

test("locked Fizz with three enemies open: the probable opponent comes from the Lanes line, and /pick says which line to read", async () => {
	const { sent } = await run(frameAt("pick 5"), "pick");
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("MIDDLE Fizz (you)");
	expect(sent[0]).toContain("Lanes: JUNGLE Graves vs Wukong; MIDDLE Fizz vs Yasuo");
	expect(hasRow(sent[0], "Your lane opponent:")).toBe(false);
	expect(sent[0]).toContain('"Lanes:"');
});

test("draft complete: /draft and /pick both carry the five-lane read and Fizz's lane opponent", async () => {
	for (const command of ["draft", "pick"] as const) {
		const { sent } = await run(frameAt("final"), command);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("Lanes: TOP Pantheon vs Darius; JUNGLE Graves vs Wukong; MIDDLE Fizz vs Malzahar; BOTTOM Corki vs Jinx");
		expect(hasRow(sent[0], "Your lane opponent: Malzahar (guessed by lane rate)")).toBe(true);
	}
});

async function lockFires(frame: LcuFrame) {
	let fired: string | undefined;
	const trigger = createAutoComp((call) => (fired = call));
	const source = replaySource(frame);
	trigger(settlePick(undefined, await computeLcuFooterState(source.discover, source.makeClient)), true);
	return fired;
}

test("a lock replayed through the router: Fizz locked with two enemies in runs /pick, the finished draft runs /draft", async () => {
	expect(await lockFires(frameAt("pick 5"))).toBe("pick");
	expect(await lockFires(frameAt("final"))).toBe("draft");
});
