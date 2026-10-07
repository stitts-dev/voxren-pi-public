/**
 * The UI catalogue: every main view and state of the coach drawn by its real renderer from made-up data, with no model
 * and no network. `src/ui-catalog.test.ts` gates each entry in bun test, `ui-shoot.ts` prints, shoots, and critiques them
 * (`just ui`). A new view or state is one entry here; a new tool without entries fails the gate.
 */
import { setCapabilities, setCellDimensions, resetCapabilitiesCache } from "@earendil-works/pi-tui";
import { deflateSync } from "node:zlib";
import { buildIconNames, buildLines } from "../build-lines";
import { VOXREN_TOOLS, type VoxrenToolName } from "../contracts";
import { ConfigPanel } from "../config";
import { commandTree, panelLines } from "../command-tree";
import { prefetchItemIcons, prefetchRuneIcons, resetIcons } from "../icons";
import type { LcuFooterState } from "../lcu";
import { panelLines as coachPanelLines, panelModel } from "../panel";
import {
	buildStripLines,
	coachLabels,
	createCardMotion,
	createHeader,
	createToolCall,
	createToolResult,
	footerLines,
	jevLines,
	routeLines,
	toolCallLines,
		type CardDetail,
	type RouteView,
	type UiTheme,
} from "../ui";
import { textGates } from "./stories.ts";
import { CATALOGUE_SAMPLES, auditResponse, disputedFrame, unsupportedFrame, cardCalls, madeUpFlow, reply, toolSamples } from "./ui-data.ts";

export interface Fixture {
	name: string;
	/** What state of the coach this is, in a few words, for the shoot and the critics. */
	state: string;
	render(theme: UiTheme, width: number): string[];
	/** Draws item, rune, or spell icons: `--shoot` loads the real ones from Data Dragon for these and reports how many drew. */
	icons?: boolean;
	/** The answer whose build lines the entry draws: `--shoot` checks its icons are on screen (icon-check.ts). */
	source?: string;
	/** Text that must be on the render at every width and theme, on top of the built-in gates. */
	expect?: string[];
}

/** A solid 24 px square PNG, so an icon fixture draws something visible without Data Dragon. */
function solidPng(r: number, g: number, b: number): Buffer {
	const size = 24;
	const crc = (buffer: Buffer) => {
		let c = ~0;
		for (const byte of buffer) {
			c ^= byte;
			for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
		}
		return ~c >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const out = Buffer.alloc(12 + data.length);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc(body), 8 + data.length);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

/** Item names the audit card's item rows draw icons for. */
const auditItems = () => {
	const data: any = auditResponse().data;
	return [...new Set([...Object.keys(data.summary.medianItemTimingMin), ...Object.keys(data.reference.itemTimingMin)])];
};

let prepared: Promise<void> | undefined;
/**
 * Fills the icon cache, once, and returns a note when the icons are not the real ones. Offline (the default, and what
 * bun test uses) it is a fake Data Dragon serving solid squares; `real` is the shoot: icons from Data Dragon through
 * icons.ts and its cache. A real fetch that fails leaves the cache short, so those entries draw their text fallback
 * and `iconReport` says so.
 */
/** Drops the icons the catalogue loaded: the icon cache is one per process, and another test file must see it as it found it. */
export function releaseFixtures(): void {
	resetIcons();
	prepared = undefined;
}

export function prepareFixtures(real = false): Promise<void> {
	prepared ??= (async () => {
		const png = solidPng(70, 160, 200);
		const names = merge([...CATALOGUE_SAMPLES.map((sample) => buildIconsOf(sample.markdown)), { items: auditItems(), runes: [] }]);
		const fetchImpl = real ? (fetch as typeof fetch) : (async (url: string) => {
			if (url.endsWith("/item.json")) return { json: async () => ({ data: Object.fromEntries(names.items.map((name, index) => [String(1000 + index), { name }])) }) } as Response;
			if (url.endsWith("/runesReforged.json")) return { json: async () => [{ slots: [{ runes: names.runes.map((name) => ({ name, icon: `perk-images/${name}.png` })) }] }] } as Response;
			if (url.endsWith("/summoner.json")) return { json: async () => ({ data: {} }) } as Response;
			return { arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) } as Response;
		}) as typeof fetch;
		// The prefetch loads nothing on a terminal with no pictures, so it runs as a Kitty one.
		setCapabilities({ images: imageProtocol, trueColor: true, hyperlinks: false });
		try {
			let version = "26.19.1-ui";
			let base = "https://ddragon.example";
			if (real) {
				base = "https://ddragon.leagueoflegends.com";
				try {
					version = ((await (await fetch(`${base}/api/versions.json`, { signal: AbortSignal.timeout(8000) })).json()) as string[])[0];
				} catch (error) {
					console.error(`icons: Data Dragon version unavailable (${error instanceof Error ? error.message : error})`);
					return;
				}
			}
			await prefetchItemIcons(names.items, version, base, fetchImpl);
			await prefetchRuneIcons(names.runes, version, base, fetchImpl);
		} finally {
			resetCapabilitiesCache();
		}
	})();
	return prepared;
}

/** How many icons an icon-bearing entry draws at one width, so a shot never quietly shows the text fallback. */
export function iconCount(fixture: Fixture, theme: UiTheme, width = 100): number {
	return (fixture.render(theme, width).join("\n").match(/\x1b_G|\x1b\]1337;File=/g) ?? []).length;
}

function buildIconsOf(markdown: string) {
	const lines = buildLines(markdown);
	return lines ? buildIconNames(lines) : { items: [], runes: [] };
}
// One list of names across samples.
const merge = (parts: Array<{ items: string[]; runes: string[] }>) => ({ items: [...new Set(parts.flatMap((p) => p.items))], runes: [...new Set(parts.flatMap((p) => p.runes))] });

/** The picture protocol icon entries draw with: Kitty offline (what the gate counts), iTerm2 in the shoot, since WezTerm's own config turns Kitty graphics off and the coach draws iTerm2 there. */
let imageProtocol: "kitty" | "iterm2" = "kitty";
export function shootInWezTerm(): void {
	imageProtocol = "iterm2";
	setCellDimensions({ widthPx: 12, heightPx: 27 }); // the grid's WezTerm font in pixels (what pi-tui learns from CSI 16 t in a live session): a cell 2.25 times taller than wide, not pi-tui's 9x18 guess
	process.env.TERM_PROGRAM = "WezTerm";
}

/** Draws with this image protocol (or none) for the one render, then forgets it. */
function withImages<T>(images: "kitty" | null, draw: () => T): T {
	setCapabilities({ images: images && imageProtocol, trueColor: true, hyperlinks: false });
	try {
		return draw();
	} finally {
		resetCapabilitiesCache();
	}
}

const champSelect: LcuFooterState = { kind: "champSelect", summoner: { gameName: "Sample", tagLine: "0001", summonerLevel: 312 }, secondsLeft: 24, selfPosition: "middle", picksMade: 6, picksTotal: 10, bansMade: 10, bansTotal: 10 };
const liveGame: LcuFooterState = { kind: "liveGame", summoner: { gameName: "Sample", tagLine: "0001", summonerLevel: 312 }, gameTimeSec: 842, self: { championName: "Ahri", position: "middle", kills: 3, deaths: 1, assists: 4, creepScore: 96, level: 9 } };
const lobby: LcuFooterState = { kind: "lobby", summoner: { gameName: "Sample", tagLine: "0001", summonerLevel: 312 }, rank: { tier: "EMERALD", division: "IV", leaguePoints: 37, wins: 52, losses: 47 }, recent: [true, true, false, true, false] };
const closed: LcuFooterState = { kind: "closed" };
const labels = coachLabels("openai/gpt-6-luna", ["Sample#0001"]);
const jevIdle = { busy: 0, frame: 0, tally: { screened: 6, cut: 1, checked: 8, flagged: 1 } };
const stats = { inputTokens: 18_400, outputTokens: 2_300, contextPercent: 6.4, contextWindow: 272_000, costUsd: 0.083, subscription: true, thinking: "low", model: "gpt-6-luna", route: "jev" };

const routes: Array<[string, string, RouteView]> = [
	["jev picked", "Jev graded the prompt and picked the model", { model: "gpt-6-luna", thinking: "low", source: "jev", tier: "quick", p: 0.82, ms: 280, by: "jev-1.13.0" }],
	["jev off", "no judge key: fixed fallback", { model: "gpt-6-luna", thinking: "medium", source: "fallback", tier: "standard", failure: "off" }],
	["jev timeout", "Jev call failed, model kept", { model: "gpt-6-luna", thinking: "medium", source: "fallback", failure: "timeout" }],
	["held", "grade below the switch bar", { model: "gpt-6-luna", thinking: "low", source: "held", tier: "deep", p: 0.55, ms: 310, by: "jev-1.13.0" }],
	["command", "a command's fixed tier", { model: "gpt-6-luna", thinking: "high", source: "command", command: "draft", tier: "deep" }],
	["pinned", "the player pinned the model", { model: "gpt-6-luna", thinking: "high", source: "pinned" }],
];

/** A card as Pi draws it: the real component, its status cell carrying a clock that stopped at `ms`. */
function card(theme: UiTheme, name: VoxrenToolName, args: Record<string, unknown>, width: number, ms: number, finish?: { response?: ReturnType<typeof reply>; errorText?: string; expanded: boolean; detail: CardDetail }): string[] {
	let now = 0;
	const motion = createCardMotion({ now: () => now, setInterval: (() => 0) as unknown as typeof setInterval, clearInterval: () => {} });
	motion.enable(true);
	const context = { state: {}, invalidate() {}, executionStarted: true };
	const pending = createToolCall(theme, name, args, context, motion);
	pending.render(width); // starts the clock at 0
	now = ms;
	const lines = finish ? createToolResult(theme, name, args, { response: finish.response, errorText: finish.errorText }, finish.expanded, context, motion, finish.detail).render(width) : pending.render(width);
	motion.stop();
	return lines;
}

function build(): Fixture[] {
	const out: Fixture[] = [];
	const add = (name: string, state: string, render: Fixture["render"], expect?: string[], icons?: boolean, source?: string) => out.push({ name, state, render, expect, icons, source });

	// header
	const header = (riotKey: string | undefined, lcu: LcuFooterState, notes: string[] = []) => (theme: UiTheme, width: number) => createHeader(theme, () => riotKey, coachLabels("openai/gpt-6-luna", ["Sample#0001"], notes), () => lcu, () => jevIdle).render(width);
	add("header key ok", "start of a session, Riot key accepted, client closed", header("Riot key: accepted (HTTP 200)", closed), ["VOXREN COACH"]);
	add("header key missing", "no Riot key stored", header("Riot key: not stored. Run /riot-key", closed), ["not stored"]);
	add("header lcu warning", "a League client is found but unreadable", header("Riot key: accepted (HTTP 200)", { kind: "closed", reason: "client found, lockfile unreadable (permission denied)" }), ["LCU:"]);
	add("header icon notice", "a degraded capability raised a note", header("Riot key: accepted (HTTP 200)", closed, ["icons failed this session: Data Dragon did not answer"]), ["icons failed"]);

	// footer
	const footer = (lcu: LcuFooterState) => (theme: UiTheme, width: number) => footerLines(theme, stats, width, labels, lcu);
	add("footer no client", "no League client", footer(closed), ["ctx"]);
	add("footer lobby", "in the lobby with a ranked record", footer(lobby), ["ctx"]);
	add("footer champ select", "champ select, 24 s left", footer(champSelect), ["ctx"]);
	add("footer live game", "a game in progress", footer(liveGame), ["ctx"]);

	// route row
	for (const [name, state, route] of routes) add(`route ${name}`, state, (theme, width) => routeLines(theme, route, width));

	// every tool, every level
	const samples = toolSamples();
	for (const name of VOXREN_TOOLS) {
		const sample = samples[name];
		add(`${name} call`, "the first row of the call, as the pending card draws it", (theme) => toolCallLines(theme, name, sample.args));
		add(`${name} running`, "pending: spinner and clock", (theme, width) => card(theme, name, sample.args, width, 2400), ["2.4s"]);
		add(`${name} collapsed`, "finished, collapsed", (theme, width) => card(theme, name, sample.args, width, sample.takes, { response: sample.response, expanded: false, detail: "claims" }));
		add(`${name} expanded claims`, "expanded at the claims level (Ctrl+O)", (theme, width) => card(theme, name, sample.args, width, sample.takes, { response: sample.response, expanded: true, detail: "claims" }));
		add(`${name} expanded full`, "expanded at the full level", (theme, width) => card(theme, name, sample.args, width, sample.takes, { response: sample.response, expanded: true, detail: "full" }));
	}

	// the judge's questions
	for (const name of ["web_search", "voxren_strategy_frame"] as const) add(`jev lines ${name}`, "Jev's questions and score bars under a judged card", (theme, width) => jevLines(theme, samples[name].response, width));

	// check card variants
	const keyless = cardCalls(true);
	const frame = samples.voxren_strategy_frame;
	add("check contradicted claim", "a check with one contradicted claim", (theme, width) => card(theme, "voxren_strategy_frame", frame.args, width, frame.takes, { response: frame.response, expanded: false, detail: "claims" }), ["contradicted"]);
	const keylessFrame = keyless.find((call) => call.name === "voxren_strategy_frame")!;
	add("check keyless", "no judge key: the claims were not checked", (theme, width) => card(theme, "voxren_strategy_frame", keylessFrame.args, width, keylessFrame.takes, { response: keylessFrame.response, expanded: false, detail: "claims" }));
	const timedOut = keyless.filter((call) => call.name === "web_search").at(-1)!;
	add("search judge timeout", "the judge timed out on a search", (theme, width) => card(theme, "web_search", timedOut.args, width, timedOut.takes, { response: timedOut.response, expanded: true, detail: "claims" }));
	const unread = cardCalls(false, true).at(-1)!;
	add("check unread source", "a check citing a source the judge never read", (theme, width) => card(theme, "voxren_strategy_frame", unread.args, width, unread.takes, { response: unread.response, expanded: true, detail: "claims" }));
	const disputed = disputedFrame();
	for (const [expanded, label] of [[false, "collapsed"], [true, "expanded"]] as const) add(`check disputed claim ${label}`, `a check where two sources disagree (${label})`, (theme, width) => card(theme, "voxren_strategy_frame", disputed.args, width, disputed.takes, { response: disputed.response, expanded, detail: "claims" }), ["disputed"]);
	const unsupported = unsupportedFrame();
	add("check unsupported claims", "a collapsed check naming the claims it could not back", (theme, width) => card(theme, "voxren_strategy_frame", unsupported.args, width, unsupported.takes, { response: unsupported.response, expanded: false, detail: "claims" }), ["unsupported"]);
	add("error card", "a lookup that failed", (theme, width) => card(theme, "voxren_meta_research", samples.voxren_meta_research.args, width, 900, { errorText: "OP.GG did not answer within 8 s. Try again, or ask without the matchup rows.", expanded: false, detail: "claims" }), ["did not answer"]);

	// build strip
	for (const sample of CATALOGUE_SAMPLES) {
		const lines = buildLines(sample.markdown)!;
		add(`build strip ${sample.title}-text`, "the BUILD strip where the terminal draws no pictures", (theme, width) => withImages(null, () => buildStripLines(theme, lines, width, sample.ownPicks)), ["BUILD"]);
		add(`build strip ${sample.title}-icons`, "the BUILD strip with item, rune, and spell icons, the swap row included", (theme, width) => withImages("kitty", () => buildStripLines(theme, lines, width, sample.ownPicks)), ["BUILD"], true, sample.markdown);
	}

	// the coach panel: the answer's calls and build in boxes, outside a game and past 14:00 with owned items
	for (const sample of CATALOGUE_SAMPLES) {
		const owned = (buildLines(sample.markdown)?.build ?? []).flat().slice(0, 2);
		const model = (live: boolean) => panelModel(sample.markdown, { champions: [], status: "/draft · quick · gpt-6-luna · low · ✓ 4/4 grounded", ...(live && { live: { gameTimeSec: 1820, ownedItems: owned } }) });
		add(`panel ${sample.title}-icons`, "the coach panel: calls and build in boxes, with icons", (theme, width) => withImages("kitty", () => coachPanelLines(theme, model(false), width, { ownPicks: sample.ownPicks })), ["BUILD"], true, sample.markdown);
		add(`panel ${sample.title} live-icons`, "the coach panel at 30:20 with two items owned", (theme, width) => withImages("kitty", () => coachPanelLines(theme, model(true), width, { ownPicks: sample.ownPicks })), ["BUILD", "30:20"], true, sample.markdown);
	}

	// the audit card's item rows with icons
	const audit = samples.voxren_player_audit;
	add("audit card-icons", "the audit card's item rows with icons", (theme, width) => withImages("kitty", () => card(theme, "voxren_player_audit", audit.args, width, audit.takes, { response: audit.response, expanded: false, detail: "claims" })), ["AUDIT"], true);

	// /flow and /config
	const flow = madeUpFlow();
	flow.setClock(flow.opened + 2300);
	const tree = commandTree();
	for (const [index, node] of tree.entries()) add(`flow ${node.name}`, `the /flow panel with /${node.name} selected`, (theme, width) => panelLines(theme, tree, index, flow.stats.read(), width, flow.opened + 2300), ["COMMAND TREE"]);
	add("config panel", "/config: theme, champion, Riot IDs, keys", (theme, width) => new ConfigPanel(theme, { theme: "tidal", champion: "Ahri", riotIds: { primary: "Sample#0001", known: ["Sample#0001", "Other#0002"] } }, "tidal", "Ahri", { setTheme() {}, onSave: () => ({ profile: { riotIds: { known: [] } } }), requestRender() {}, done() {} }).render(width), ["Theme"]);
	return out;
}

let cache: Fixture[] | undefined;
export const fixtures = (): Fixture[] => (cache ??= build());

/** A render as the screen shows it: colour, cursor, and picture escapes gone (an inline picture counts the cells the app counts for it: a Kitty one steps over none), no-break spaces plain. */
/**
 * A render with its pictures' volatile parts removed: Kitty's image id (`i=`) is allocated per process, and the base64
 * payload and iTerm2's `size=` (its byte count) follow the PNG, not the layout. Everything else stays in the text, so
 * a change in a picture's size or place (iTerm2 `width=`/`height=`, Kitty `c=`/`r=`/`s=`/`v=`, the cursor moves
 * around it) changes the hash.
 */
export const stablePictures = (text: string): string =>
	text
		.replace(/\x1b_G([^;\x1b]*)(?:;[^\x1b]*)?\x1b\\/g, (_all, keys: string) => `\x1b_G${keys.split(",").filter((key) => !key.startsWith("i=")).join(",")}\x1b\\`)
		.replace(/\x1b\]1337;File=([^:\x07]*)(?::[^\x07]*)?\x07/g, (_all, args: string) => `\x1b]1337;File=${args.split(";").filter((arg) => !arg.startsWith("size=")).join(";")}\x07`);

export const plainText = (lines: string[]): string[] =>
	lines.map((line) =>
		line
			.replace(/\x1b_G[^\x1b]*\x1b\\/g, "")
			.replace(/\x1b\]1337;[^\x07\x1b]*(\x07|\x1b\\)/g, "")
			.replace(/\x1b[78]/g, "")
			.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "")
			.replace(/\u00a0/g, " "),
	);

export const GATE_WIDTHS = [60, 80, 100, 120];

/** The strict gate on one theme: every entry at every width through textGates and its own `expect`. Returns problems by entry name; an entry that throws is a problem too. */
export function gateProblems(theme: UiTheme, only: Fixture[] = fixtures()): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const fixture of only)
		for (const width of GATE_WIDTHS) {
			const add = (text: string) => found.set(fixture.name, [...(found.get(fixture.name) ?? []), `@${width}: ${text}`]);
			let text: string;
			try {
				text = plainText(fixture.render(theme, width)).join("\n");
			} catch (error) {
				add(`threw ${error instanceof Error ? error.message : error}`);
				continue;
			}
			for (const failure of textGates(text, width)) add(`${failure.gate}: ${failure.detail}`);
			for (const wanted of fixture.expect ?? []) if (!text.includes(wanted)) add(`missing "${wanted}"`);
		}
	return found;
}
