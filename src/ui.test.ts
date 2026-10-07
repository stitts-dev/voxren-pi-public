import { afterEach, describe, expect, test } from "bun:test";
import { Theme, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, resetCapabilitiesCache, setCapabilities, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RESEARCH_CONTRACT_VERSION, type VoxrenToolName } from "./contracts";
import { buildLines } from "./build-lines";
import { prefetchItemIcons, prefetchRuneIcons } from "./icons";
import { fitInlineIcons } from "./terminal-images";
import { createCoachTools } from "./tools";
import { HIDDEN_THINKING_LABEL, answerMarkdown, buildStripLines, cutAtWord, toolCallLines, claimRows, createCardMotion, createToolCall, createToolResult, judgmentLine, panelStatus, parseCardDetail, quoteUserText, routeLines, thinkingMarkdown, toolResultLines, withoutEmphasis, type CardDetail, type Row } from "./ui";

const theme = { fg: (_style: string, text: string) => text, bold: (text: string) => text } as any;
/** Tags every span with its role so colour rules are testable: `[role:text]`, `[b:text]`. */
const tagged = { fg: (role: string, text: string) => `[${role}:${text}]`, bold: (text: string) => `[b:${text}]` } as any;
/** A row as its text reads: head then body. */
const text = (row: Row) => `${row.head}${row.body}`;
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
/** Rows as they read: a score's label and number are joined by a no-break space so they never wrap apart. */
const spaced = (lines: string[]) => lines.map((line) => line.replace(/\u00a0/g, " "));

describe("build strip", () => {
	afterEach(() => resetCapabilitiesCache());
	const answer = [
		"Lane: Lux Q down: E in, burst, then disengage.",
		"Runes: Electrocute, Sudden Impact, Grisly Mementos, Treasure Hunter; Transcendence, Scorch; Adaptive Force, Adaptive Force, Health; Flash, Ignite",
		"Build: Doran's Ring + 2 Health Potions → Lich Bane → Sorcerer's Shoes → Zhonya's Hourglass → Shadowflame",
		"Skills: E, W, Q, then max E > W > Q",
		"Swap: Zhonya's Hourglass before Shadowflame, into Corki and Naafiri burst",
	].join("\n");

	test("draws every name as text where the terminal draws no pictures", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const strip = buildStripLines(theme, buildLines(answer)!, 160).map(plain);
		// The title once; the names speak for themselves, so only the path and the swap carry a label. Every value starts in one column.
		expect(strip[0]).toBe("│ BUILD    Electrocute · Sudden Impact · Grisly Mementos · Treasure Hunter");
		expect(strip[1]).toBe("│          Transcendence · Scorch");
		expect(strip.join("\n")).toContain("│          Adaptive Force · Adaptive Force · Health");
		expect(strip.join("\n")).toContain("│          Flash · Ignite");
		expect(strip.join("\n")).toContain("│ items    Doran's Ring + 2 Health Potions → Lich Bane → Sorcerer's Shoes → Zhonya's Hourglass → Shadowflame");
		expect(strip.join("\n")).toContain("│          E, W, Q, then max E > W > Q");
		expect(strip.join("\n")).toContain("│ swap     Zhonya's Hourglass before Shadowflame, into Corki and Naafiri burst");
		// A narrow pane breaks the path between steps, never inside an item.
		const narrow = buildStripLines(theme, buildLines(answer)!, 48).map(plain);
		expect(narrow.every((line) => visibleWidth(line) <= 48)).toBe(true);
		expect(narrow.join("\n")).toContain("Zhonya's Hourglass");
	});

	test("names the coach's own picks, the ones no data this turn mentioned, in a quiet last row; no row when every name was in the data", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const strip = buildStripLines(theme, buildLines(answer)!, 160, ["Shadowflame", "Scorch"]).map(plain);
		expect(strip.at(-1)).toBe("│ unsourced Shadowflame, Scorch");
		// The 9-cell label fills the label column, so the value keeps one space of its own, and a wrapped row hangs under the value.
		for (const width of [80, 120]) for (const row of buildStripLines(theme, buildLines(answer)!, width, ["Shadowflame"]).map(plain)) expect(row.startsWith("│ unsourced Shadowflame") || !row.includes("unsourced")).toBe(true);
		expect(buildStripLines(theme, buildLines(answer)!, 160).map(plain).join("\n")).not.toContain("unsourced");
		// A long list wraps between names, never inside one.
		const narrow = buildStripLines(theme, buildLines(answer)!, 40, ["Zhonya's Hourglass", "Sorcerer's Shoes", "Shadowflame"]).map(plain);
		expect(narrow.every((line) => visibleWidth(line) <= 40)).toBe(true);
		expect(narrow.slice(-3)).toEqual(["│ unsourced Zhonya's Hourglass,", "│           Sorcerer's Shoes,", "│           Shadowflame"]);
	});

	test("draws each name it has an icon for as the icon alone, the page on one row, and the rest as text", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
		const fetchImpl = (async (url: string) => {
			if (url.endsWith("/item.json")) return { json: async () => ({ data: { 3100: { name: "Lich Bane" } } }) } as Response;
			if (url.endsWith("/runesReforged.json")) return { json: async () => [{ slots: [{ runes: [{ name: "Electrocute", icon: "perk-images/Electrocute.png" }] }] }] } as Response;
			if (url.endsWith("/summoner.json")) return { json: async () => ({ data: { SummonerFlash: { name: "Flash", image: { full: "SummonerFlash.png" } } } }) } as Response;
			return { arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) } as Response;
		}) as typeof fetch;
		await prefetchItemIcons(["Lich Bane"], "14.19.1-strip", "https://ddragon.example", fetchImpl);
		await prefetchRuneIcons(["Electrocute", "Flash"], "14.19.1-strip", "https://ddragon.example", fetchImpl);
		const strip = buildStripLines(theme, buildLines(answer)!, 160);
		const all = strip.join("\n");
		// Three icons drawn; their names gone, since the icon carries the name. Names with no icon stay text.
		expect(all.match(/\x1b_G/g)?.length).toBe(3);
		for (const name of ["Electrocute", "Flash", "Lich Bane"]) expect(all).not.toContain(name);
		expect(all).toContain("Sudden Impact · Grisly Mementos");
		expect(all).toContain("Doran's Ring + 2 Health Potions");
		// The page is one row: the BUILD row holds the runes, the shards, and the spells; the next row is the items.
		expect(strip[0]).toContain("Transcendence · Scorch");
		expect(strip[0]).toContain("Adaptive Force · Adaptive Force · Health");
		expect(strip[1]).toContain("items");
	});

	test("in WezTerm the runes and the items stand two rows tall: the label leads the row kept empty above them, and a swap's icons stay in its row", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const program = process.env.TERM_PROGRAM;
		process.env.TERM_PROGRAM = "WezTerm";
		try {
			const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
			const fetchImpl = (async (url: string) => {
				if (url.endsWith("/item.json")) return { json: async () => ({ data: { 3100: { name: "Lich Bane" }, 3157: { name: "Zhonya's Hourglass" } } }) } as Response;
				if (url.endsWith("/runesReforged.json")) return { json: async () => [{ slots: [{ runes: [{ name: "Electrocute", icon: "perk-images/Electrocute.png" }] }] }] } as Response;
				if (url.endsWith("/summoner.json")) return { json: async () => ({ data: {} }) } as Response;
				return { arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) } as Response;
			}) as typeof fetch;
			await prefetchItemIcons(["Lich Bane", "Zhonya's Hourglass"], "14.19.1-tall", "https://ddragon.example", fetchImpl);
			await prefetchRuneIcons(["Electrocute"], "14.19.1-tall", "https://ddragon.example", fetchImpl);
			const strip = buildStripLines(theme, buildLines(answer)!, 160).map(plain);
			const up = "[1A]1337;File=";
			expect(strip[0]).toBe("│ BUILD");
			expect(strip[1]).toContain(up);
			expect(strip[1]).toContain("Sudden Impact");
			expect(strip[2]).toBe("│ items");
			expect(strip[3]).toContain(up);
			expect(strip[3]).toContain("Doran's Ring + 2 Health Potions");
			const swap = strip.find((line) => line.includes("swap"))!;
			expect(swap).toContain("]1337;File=");
			expect(swap).not.toContain(up);
			expect(swap).toContain("before Shadowflame");
		} finally {
			if (program === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = program;
		}
	});

	test("a long swap row wraps between whole names where icons draw, instead of cutting one off", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
		const fetchImpl = (async (url: string) => {
			if (url.endsWith("/item.json")) return { json: async () => ({ data: { 1: { name: "Zhonya's Hourglass" }, 2: { name: "Shadowflame" } } }) } as Response;
			return { arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) } as Response;
		}) as typeof fetch;
		await prefetchItemIcons(["Zhonya's Hourglass", "Shadowflame"], "14.19.1-swap-wrap", "https://ddragon.example", fetchImpl);
		const width = 40;
		const strip = buildStripLines(theme, buildLines(answer)!, width);
		const swapAt = strip.findIndex((line) => line.includes("swap"));
		// Too long for one row at this width: the swap wraps after its icons, never cutting a word or an icon.
		expect(strip[swapAt]).toContain("before");
		expect(strip[swapAt].match(/\x1b_G/g)?.length).toBe(2);
		expect(strip.slice(swapAt + 1).join(" ")).toContain("burst");
		expect(strip.some((line) => line.includes("…"))).toBe(false);
		// fitInlineIcons (what barLines itself cuts an icon row with) is a no-op on every produced line: each already fits.
		expect(strip.every((line) => fitInlineIcons(line, width) === line)).toBe(true);
	});
});

describe("claimRows", () => {
	test("a disputed claim names both sources and stays on the collapsed card (#202)", () => {
		const data = { claims: [{ route: "disputed", source: "web-2", contradictedBy: "video-1", claim: "Let Ahri push" }, { route: "grounded", source: "game-1", claim: "G" }] };
		expect(claimRows(theme, data, true).map(text)).toEqual(["  disputed     [web-2 vs video-1] Let Ahri push"]);
	});

	test("a collapsed check names its unsupported claims after the flagged ones, three at most (#219)", () => {
		const claim = (route: string, text: string) => ({ route, claim: text });
		const two = { claims: [claim("unsupported", "Ahri charm is 3 s"), claim("grounded", "G"), claim("unsupported", "Buy rocketbelt"), claim("disputed", "D")] };
		expect(claimRows(theme, two, true).map(text)).toEqual(["  disputed     D", "  unsupported  Ahri charm is 3 s", "  unsupported  Buy rocketbelt"]);
		const five = { claims: Array.from({ length: 5 }, (_, i) => claim("unsupported", `U${i}`)) };
		expect(claimRows(theme, five, true).map(text).slice(3)).toEqual(["  unsupported  +2 more"]);
		expect(claimRows(theme, { claims: [claim("grounded", "G")] }, true)).toEqual([]);
	});

	test("a contradicted claim shows the contradicting id, and no bracket when it has none", () => {
		const rows = claimRows(theme, { claims: [{ route: "contradicted", contradictedBy: "web-1", claim: "Rush Lich Bane" }, { route: "contradicted", claim: "Max Q first" }] });
		expect(text(rows[0])).toContain("[web-1]");
		expect(text(rows[0])).toContain("Rush Lich Bane");
		expect(text(rows[1])).not.toContain("[");
		expect(text(rows[1])).toContain("Max Q first");
	});

	test("a grounded claim still shows its source id regardless of contradictedBy", () => {
		const rows = claimRows(theme, { claims: [{ route: "grounded", source: "meta-1", contradictedBy: "web-1", claim: "Max E first" }] });
		expect(text(rows[0])).toContain("[meta-1]");
		expect(text(rows[0])).not.toContain("[web-1]");
	});

	test("unsupported and not_judged rows ignore contradictedBy: no bracket unless source is set", () => {
		const rows = claimRows(theme, {
			claims: [
				{ route: "unsupported", contradictedBy: "web-1", claim: "Max W first" },
				{ route: "not_judged", contradictedBy: "web-1", claim: "Max R first" },
			],
		});
		for (const row of rows) expect(text(row)).not.toContain("[");
	});

	test("flaggedOnly keeps contradicted rows, then unsupported ones, and drops grounded and not judged", () => {
		const data = { claims: [{ route: "grounded", source: "audit-1", claim: "A" }, { route: "unsupported", claim: "B" }, { route: "contradicted", contradictedBy: "game-1", claim: "C" }, { route: "not_judged", claim: "D" }] };
		expect(claimRows(theme, data, true).map(text)).toEqual(["  contradicted [game-1] C", "  unsupported  B"]);
		expect(claimRows(theme, data)).toHaveLength(4);
	});

	test("each verdict word takes its own colour and sits one level in, with the claim as the value that wraps", () => {
		const [row] = claimRows(tagged, { claims: [{ route: "contradicted", contradictedBy: "web-1", claim: "Max Q first" }] });
		expect(row.head).toBe("  [error:contradicted ]");
		expect(row.body).toBe("[dim:[web-1] ]Max Q first");
		const heads = claimRows(tagged, { claims: [{ route: "grounded", claim: "a" }, { route: "unsupported", claim: "b" }, { route: "not_judged", claim: "c" }] }).map((claim) => claim.head);
		expect(heads).toEqual(["  [success:grounded     ]", "  [warning:unsupported  ]", "  [dim:not judged   ]"]);
	});
});

// --- the card layout ---------------------------------------------------------------

const WIDTHS = [60, 80, 100, 140];
const reply = (operation: string, data: Record<string, unknown> = {}, evidence: Array<[string, string]> = []): any => ({
	version: RESEARCH_CONTRACT_VERSION,
	operation,
	data,
	evidence: evidence.map(([id, title]) => ({ id, source: "web_search", title, url: `https://example.invalid/${id}`, retrievedAt: "2026-10-01T12:00:00.000Z" })),
});
const claim = "A Katarina guide describes taking the rocketbelt first against Ahri, which the lane data does not support at all";
const frame = reply("strategy_frame", { goal: "g", claims: [{ claim: "Max E first", route: "grounded", source: "web-1" }, { claim, route: "contradicted", contradictedBy: "guide-2" }], judgment: { status: "judged" } });

/** One card of every kind: the tool, its arguments, a response it can draw, its header label, and the theme role its bar takes. */
const KINDS: Array<[VoxrenToolName, Record<string, unknown>, any, string, string]> = [
	["voxren_meta_research", { query_type: "matchup", champion: "Katarina", opponent: "Ahri", position: "middle" }, reply("meta.matchup", { sample: "Emerald+ · ranked" }), "META", "accent"],
	["web_search", { query: "katarina vs ahri mid lane" }, reply("research_web_search", {}, [["web-1", "One"], ["web-2", "Two"]]), "SEARCH", "accent"],
	["voxren_video_research", { query: "katarina vs ahri guide" }, reply("research_video", {}, [["video-1", "One"]]), "VIDEOS", "accent"],
	["voxren_game_facts", { entities: [{ kind: "champion", name: "Ahri" }], detail: "compact" }, reply("gamedata.lookup", { patch: "26.19" }), "FACTS", "accent"],
	["voxren_strategy_frame", { question: "q", claims: ["a", "b"], evidence: [{ id: "web-1" }] }, frame, "CHECK", "mdLink"],
	["voxren_player_audit", { count: 2 }, reply("player_audit", { summary: {}, games: [], patches: ["16.18"], analyzed: 2, requested: 2 }), "AUDIT", "accent"],
	["voxren_otp_build", { player: "Hide on bush#KR1" }, reply("otp_build", { games: [], cluster: "kr", record: "1-0", patches: ["16.18"], analyzed: 1, requested: 1 }), "OTP", "accent"],
	["voxren_remember", { text: "hold your dash for hers" }, reply("remember", { riotId: "Player01#NA1" }), "REMEMBER", "accent"],
	["voxren_command_frame", { command: "build" }, reply("command_frame", { command: "build", frame: "Build call." }), "FRAME", "accent"],
];

describe("card layout", () => {
	test("every kind of card is one coloured bar down the left with its upper-case label as the header, pending or finished", () => {
		for (const [name, args, response, label, role] of KINDS) {
			const done = createToolResult(tagged, name, args, { response }, true).render(100);
			const pending = createToolCall(tagged, name, args).render(100);
			for (const lines of [done, pending]) expect(lines[0]).toStartWith(` [${role}:│] [${role}:[b:${label}]]`);
			// Every row of the card keeps the bar, so it reads as one block.
			for (const line of done) expect(line).toStartWith(` [${role}:│]`);
		}
	});

	test("an error card takes the error colour for its bar and label, and its text sits one level in under it", () => {
		const lines = createToolResult(tagged, "web_search", { query: "q" }, { errorText: "ERROR[UPSTREAM_UNAVAILABLE] try again" }, false).render(100);
		expect(lines[0]).toStartWith(" [error:│] [error:[b:SEARCH]]");
		expect(lines[0]).toContain("[error:✗]");
		expect(lines[1]).toBe(" [error:│]   [error:ERROR[UPSTREAM_UNAVAILABLE] try again]");
	});

	test("a wrapped value hangs under the value column, never under the label, at every width", () => {
		const names = ["Ahri", "Zed", "Syndra", "Orianna", "Viktor", "Azir", "Sylas", "Akali", "Lissandra", "Vex", "Katarina", "Yone", "Fizz", "Talon"];
		const args = { entities: names.map((name) => ({ kind: "champion", name })), detail: "compact" };
		const response = reply("gamedata.lookup", { patch: "26.19" });
		for (const width of WIDTHS.slice(0, 3)) {
			const lines = createToolResult(theme, "voxren_game_facts", args, { response }, false).render(width);
			expect(lines.length).toBeGreaterThan(1);
			// Margin, bar, space, the 9-cell label, then the 8-cell status: the value starts at column 20.
			const value = lines[0].indexOf("Ahri");
			expect(value).toBe(20);
			for (const line of lines.slice(1)) {
				expect(line.slice(0, value)).toBe(` │ ${" ".repeat(value - 3)}`);
				expect(line[value]).not.toBe(" ");
			}
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("a claim sits one level in under the check card with its verdict in its colour; its wrap hangs under the claim", () => {
		// Role tags are text to a width count, so the colour is read on a pane wide enough to hold them.
		const coloured = createToolResult(tagged, "voxren_strategy_frame", {}, { response: frame }, false).render(400);
		expect(spaced(coloured)[1]).toBe(" [mdLink:│]   [dim:checked by Jev · ? ms]"); // the judgment row, then the flagged claim
		expect(coloured[2]).toBe(` [mdLink:│]   [error:contradicted ][dim:[guide-2] ]${claim}`);
		for (const width of WIDTHS) {
			const lines = createToolResult(theme, "voxren_strategy_frame", {}, { response: frame }, false).render(width);
			expect(spaced(lines)[0]).toContain("1 grounded · 1 contradicted");
			expect(lines[2]).toStartWith(" │   contradicted [guide-2] A Katarina guide");
			// Margin, bar, space, one level of indent, the 13-cell verdict column: the claim starts at column 18.
			expect(lines[2].indexOf("[guide-2]")).toBe(18);
			if (width < 140) expect(lines.length).toBeGreaterThan(3);
			for (const line of lines.slice(3)) expect(line.slice(0, 18)).toBe(` │ ${" ".repeat(15)}`);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("the screen line and a removed source sit one level in under the card, the withheld verdict in the error colour", () => {
		const removed = { domain: "example.net", title: "Fizz guide", route: "withheld", p: { relevant: 0.9, support: 0.5, injection: 0.97 } };
		const response = reply(
			"research_web_search",
			{ provider: "hosted", results: [{ route: "evidence", p: { relevant: 0.95, support: 0.9, injection: 0.02 } }], judgment: { status: "judged", model: "jev-1.13.0", answer: "evidence", answerP: { relevant: 0.9, support: 0.9, injection: 0.02 }, kept: 1, removed: [removed], latencyMs: 120 } },
			[["web-1", "Fizz build mid"]],
		);
		const lines = createToolResult(tagged, "web_search", { query: "q" }, { response }, true).render(120);
		expect(spaced(lines).find((line) => line.includes("screened by"))).toBe(" [accent:│]   [dim:screened by jev-1.13.0 · removed 1 (example.net blocked) · answer usable · 120 ms]");
		expect(lines.some((line) => line.includes("[error:blocked      ]example.net Fizz guide (removed)"))).toBe(true);
		// The full level keeps the judge's own layout, its verdict column one cell wider.
		const full = createToolResult(tagged, "web_search", { query: "q" }, { response }, true, undefined, undefined, "full").render(120);
		expect(full.some((line) => line.includes("[error:blocked       ]example.net  Fizz guide  (removed)"))).toBe(true);
	});

	test("every line of every card fits the width at 60, 80, 100 and 140 columns, wide characters counted by cell", () => {
		const wide = "해적 Pyke 대 아리 matchup 정글 ".repeat(6);
		const wideFrame = reply("strategy_frame", { goal: wide, claims: [{ claim: wide, route: "contradicted", contradictedBy: "guide-2" }, { claim: wide, route: "grounded", source: "web-1" }], judgment: { status: "judged" } });
		for (const width of WIDTHS) {
			for (const [name, args, response] of KINDS) {
				const wideArgs = name === "web_search" || name === "voxren_video_research" ? { query: wide } : args;
				const shown = name === "voxren_strategy_frame" ? wideFrame : response;
				for (const detail of ["brief", "claims", "full"] as const) for (const expanded of [false, true]) for (const line of createToolResult(theme, name, wideArgs, { response: shown }, expanded, undefined, undefined, detail).render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				for (const line of createToolCall(theme, name, wideArgs).render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			for (const line of routeLines(theme, { model: wide, thinking: "low", source: "jev", tier: "quick", p: 0.8, ms: 100 }, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("frame card (#463)", () => {
	test("a frame card names the command, and says why when the frame was not loaded", () => {
		const row = (data: Record<string, unknown>) => createToolResult(theme, "voxren_command_frame", { command: "build" }, { response: reply("command_frame", data) }, false).render(100).join("\n");
		expect(row({ command: "build", frame: "x" })).toContain("/build");
		expect(row({ command: "build", frame: "x" })).toContain("loaded for this answer, not sent");
		expect(row({ command: "build", unavailable: "No League client draft or game detected." })).toContain("not loaded: No League client draft or game detected.");
	});
});

describe("judgment row", () => {
	const judge = { judge: "jev", model: "jev-1.13.0", latencyMs: 120 };
	const judgedFrame = (judgment: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => reply("strategy_frame", { goal: "g", claims: [{ claim: "Max E first", route: "grounded", source: "web-1" }, { claim, route: "contradicted", contradictedBy: "guide-2" }], ...extra, ...(judgment && { judgment }) });
	// A number and its unit are joined by a no-break space on the card; these tests read the words.
	const rows = (name: VoxrenToolName, response: any, expanded: boolean) => spaced(toolResultLines(theme, name, {}, { response }, expanded, 140));
	const frameDown = (reason: string, sources?: Array<Record<string, unknown>>) => judgedFrame({ status: "unavailable", ...judge, model: "jev-latest", reason }, sources && { sources });

	test("a screened search, video and meta card name the model, what it removed, and its time, never the kept count its first row has, collapsed and expanded alike", () => {
		const judgment = { status: "judged", ...judge, kept: 3, removed: [{ domain: "example.net", route: "withheld" }], latencyMs: 120 };
		const row = "  screened by jev-1.13.0 · removed 1 (example.net blocked) · 120 ms";
		for (const expanded of [false, true]) {
			expect(rows("web_search", reply("research_web_search", { judgment }, [["web-1", "One"]]), expanded)).toContain(row);
			expect(rows("voxren_video_research", reply("research_video", { judgment }, [["video-1", "One"]]), expanded)).toContain(row);
			expect(rows("voxren_meta_research", reply("meta.champion_overview", { sample: "Emerald+", judgment }), expanded)).toContain(row);
		}
		// Nothing removed: the part is left out, never shown as 0, and the row still says the screen ran.
		const clean = rows("web_search", reply("research_web_search", { judgment: { status: "judged", ...judge, kept: 2, removed: [] } }, [["web-1", "One"]]), false);
		expect(clean).toContain("  screened by jev-1.13.0 · 120 ms");
		expect(clean.join("\n")).not.toContain("kept");
	});

	test("the answer shows only when one was judged, a model other than Jev shows as itself, and a judgment naming nothing reads Jev, never unknown", () => {
		const answered = { status: "judged", ...judge, kept: 1, removed: [], answer: "weak", answerP: { relevant: 0.9, support: 0.4, injection: 0.01 } };
		expect(rows("web_search", reply("research_web_search", { judgment: answered }, [["web-1", "One"]]), false)).toContain("  screened by jev-1.13.0 · answer weak · 120 ms");
		const none = rows("web_search", reply("research_web_search", { judgment: { status: "judged", ...judge, kept: 1, removed: [] } }, [["web-1", "One"]]), true);
		expect(none.join("\n")).not.toContain("answer");
		const named = (judgment: Record<string, unknown>) => rows("web_search", reply("research_web_search", { judgment: { status: "judged", kept: 1, removed: [], latencyMs: 80, ...judgment } }, [["web-1", "One"]]), false);
		expect(named({ judge: "other", model: "other-2.1" })).toContain("  screened by other-2.1 · 80 ms");
		expect(named({ judge: "other" })).toContain("  screened by other · 80 ms");
		expect(named({})).toContain("  screened by Jev · 80 ms");
		// A reply that names no model reaches the card as "unknown" (SystemOneClient): the judge's name stands in for it, then Jev.
		expect(named({ judge: "other", model: "unknown" })).toContain("  screened by other · 80 ms");
		expect(named({ judge: "unknown", model: "unknown" })).toContain("  screened by Jev · 80 ms");
		expect(rows("web_search", reply("research_web_search", { judgment: { status: "unavailable", reason: "timeout", model: "unknown" } }, [["web-1", "One"]]), false)).toContain("  Jev unavailable (timeout) · passages unscreened");
	});

	test("a matchup card's row says the tip was screened, with the tip's verdict and never the word answer", () => {
		const matchup = (judgment: Record<string, unknown>) => reply("meta.matchup", { sample: "Emerald+", tip: "Close in.", judgment: { status: "judged", ...judge, kept: 1, removed: [], answer: "evidence", latencyMs: 90, ...judgment } });
		for (const expanded of [false, true]) {
			expect(rows("voxren_meta_research", matchup({}), expanded)).toContain("  tip screened by jev-1.13.0 · usable · 90 ms");
			expect(rows("voxren_meta_research", matchup({ kept: 0, answer: "withheld" }), expanded)).toContain("  tip screened by jev-1.13.0 · blocked · 90 ms");
			expect(rows("voxren_meta_research", matchup({}), expanded).filter((line) => line.includes("screened by")).join("\n")).not.toContain("answer");
		}
		// Another meta card judges a summary, not the tip: its row keeps its own words.
		expect(rows("voxren_meta_research", reply("meta.tier_list", { judgment: { status: "judged", ...judge, kept: 1, removed: [], answer: "evidence", latencyMs: 90 } }), false)).toContain("  screened by jev-1.13.0 · answer usable · 90 ms");
	});

	test("a checked frame names the model and its time, not the claim count its first row has; a judge that names nothing reads Jev", () => {
		for (const expanded of [false, true]) expect(rows("voxren_strategy_frame", judgedFrame({ status: "judged", ...judge, checked: 2, latencyMs: 300 }), expanded)).toContain("  checked by jev-1.13.0 · 300 ms");
		expect(rows("voxren_strategy_frame", judgedFrame({ status: "judged", checked: 2, latencyMs: 300 }), false)).toContain("  checked by Jev · 300 ms");
		expect(rows("voxren_strategy_frame", judgedFrame({ status: "judged", ...judge, checked: 2, latencyMs: 300 }), false).join("\n")).not.toContain("claims ·");
	});

	test("an unavailable judge is in the error colour and says why; a screen also names what went unscreened, the frame (whose first row says not checked) does not", () => {
		const down = (operation: string, reason: string, name: VoxrenToolName = "web_search") => spaced(createToolResult(tagged, name, {}, { response: reply(operation, { judgment: { status: "unavailable", judge: "jev", model: "jev-latest", reason, latencyMs: 3000 } }, [["web-1", "One"]]) }, false).render(140));
		expect(down("research_web_search", "timeout")[1]).toBe(" [accent:│]   [error:jev-latest unavailable (timeout) · passages unscreened]");
		expect(down("research_video", "server", "voxren_video_research")[1]).toBe(" [accent:│]   [error:jev-latest unavailable (server) · passages unscreened]");
		expect(down("meta.tier_list", "rate_limited", "voxren_meta_research")[1]).toBe(" [accent:│]   [error:jev-latest unavailable (rate_limited) · passages unscreened]");
		expect(down("strategy_frame", "timeout", "voxren_strategy_frame")[1]).toBe(" [mdLink:│]   [error:jev-latest unavailable (timeout)]");
		expect(down("strategy_frame", "timeout", "voxren_strategy_frame")[0]).toContain("not checked");
		expect(down("research_web_search", "input")[1]).toContain("(input)");
	});

	test("a frame says its cited sources carry no text only when it has sources and every one is unread; any other input failure prints the judge's reason", () => {
		const one = { id: "web-1", title: "One" };
		const second = { id: "game-1", title: "Two" };
		const card = (response: any) => createToolResult(tagged, "voxren_strategy_frame", {}, { response }, false).render(140)[1];
		expect(card(frameDown("input", [{ ...one, unread: true }]))).toBe(" [mdLink:│]   [error:jev-latest unavailable (cited sources carry no text)]");
		expect(card(frameDown("input", [{ ...one, unread: true }, { ...second, unread: true }]))).toBe(" [mdLink:│]   [error:jev-latest unavailable (cited sources carry no text)]");
		// One read source: the request was refused for another reason (over the byte cap, a 400), so the judge's own word stands.
		expect(card(frameDown("input", [one]))).toBe(" [mdLink:│]   [error:jev-latest unavailable (input)]");
		expect(card(frameDown("input", [{ ...one, unread: true }, second]))).toBe(" [mdLink:│]   [error:jev-latest unavailable (input)]");
		expect(card(frameDown("input"))).toBe(" [mdLink:│]   [error:jev-latest unavailable (input)]");
		expect(card(frameDown("input", []))).toBe(" [mdLink:│]   [error:jev-latest unavailable (input)]");
		expect(card(frameDown("timeout", [{ ...one, unread: true }]))).toBe(" [mdLink:│]   [error:jev-latest unavailable (timeout)]");
	});

	test("a card whose results are normally screened but carry no judgment says why, so a skipped check never reads as a passed one", () => {
		for (const [operation, name] of [["research_web_search", "web_search"], ["research_video", "voxren_video_research"], ["meta.matchup", "voxren_meta_research"], ["meta.champion_overview", "voxren_meta_research"], ["meta.tier_list", "voxren_meta_research"], ["meta.synergy", "voxren_meta_research"], ["meta.top_players", "voxren_meta_research"], ["meta.pro_player_riot_id", "voxren_meta_research"]] as const) {
			for (const expanded of [false, true]) expect(rows(name, reply(operation, { tip: "Close in." }, [["web-1", "One"]]), expanded)).toContain("  not screened · no key");
		}
		expect(spaced(createToolResult(tagged, "web_search", {}, { response: reply("research_web_search", {}, [["web-1", "One"]]) }, false).render(140))[1]).toBe(" [accent:│]   [dim:not screened · no key]");
		// The frame's first row already says "not checked": the row under it is the reason alone.
		for (const expanded of [false, true]) expect(rows("voxren_strategy_frame", judgedFrame(undefined), expanded)).toContain("  no key");
		expect(rows("voxren_strategy_frame", judgedFrame(undefined), false)[0]).toEndWith("not checked");
		expect(createToolResult(tagged, "voxren_strategy_frame", {}, { response: judgedFrame(undefined) }, false).render(140)[1]).toBe(" [mdLink:│]   [dim:no key]");
		// An empty matchup tip is never sent, key or not: "no key" would be false.
		expect(rows("voxren_meta_research", reply("meta.matchup", { tip: "" }), false)).toContain("  not screened · no tip text");
		// A search or video list with no passage sends nothing, key or not; a search answer alone is a passage.
		expect(rows("web_search", reply("research_web_search", { answer: "" }), false)).toContain("  not screened · nothing to screen");
		expect(rows("voxren_video_research", reply("research_video", {}), false)).toContain("  not screened · nothing to screen");
		expect(rows("web_search", reply("research_web_search", { answer: "Max E." }), false)).toContain("  not screened · no key");
	});

	test("cards whose results no decision model reads carry no judgment row", () => {
		for (const [name, , response] of KINDS) if (["voxren_game_facts", "voxren_player_audit", "voxren_otp_build", "voxren_remember", "voxren_command_frame"].includes(name)) expect(judgmentLine(theme, response)).toBeUndefined();
	});

	test("the status cell ticks a frame only when it was judged: a frame nothing checked shows a warning, every other finished card keeps its tick", () => {
		const first = (name: VoxrenToolName, response: any) => createToolResult(tagged, name, {}, { response }, false).render(140)[0];
		expect(first("voxren_strategy_frame", judgedFrame({ status: "judged", ...judge, checked: 2 }))).toContain("[success:✓]");
		expect(first("voxren_strategy_frame", judgedFrame(undefined))).toContain("[warning:!]");
		expect(first("voxren_strategy_frame", judgedFrame({ status: "unavailable", ...judge, reason: "timeout" }))).toContain("[warning:!]");
		expect(first("voxren_strategy_frame", judgedFrame(undefined))).not.toContain("✓");
		expect(first("web_search", reply("research_web_search", {}, [["web-1", "One"]]))).toContain("[success:✓]");
	});

	test("a cited source with no stored text is marked not read on the expanded sources row, last in the list at the claims level", () => {
		const response = reply("strategy_frame", { goal: "g", claims: [], sources: [{ id: "web-1", title: "Guide", unread: true }, { id: "game-1", title: "Ahri" }], judgment: { status: "judged", ...judge, checked: 0 } });
		expect(rows("voxren_strategy_frame", response, true)).toContain("  sources      game-1 Ahri");
		expect(rows("voxren_strategy_frame", response, true)).toContain("               web-1 Guide (not read)");
		expect(toolResultLines(theme, "voxren_strategy_frame", {}, { response }, true, 140, "full")).toContain("  sources  web-1 Guide (not read) · game-1 Ahri");
		expect(rows("voxren_strategy_frame", response, false).join("\n")).not.toContain("not read");
	});
});

describe("expanded cards by claim", () => {
	const judge = { judge: "jev", model: "jev-1.13.0", latencyMs: 480 };
	const claimsOf = (claims: unknown[], sources: unknown[], judgment: Record<string, unknown> | null = { status: "judged", ...judge, checked: claims.length }) =>
		reply("strategy_frame", { goal: "Trade on cooldown", claims, sources, ...(judgment && { judgment }) });
	const grounded = { claim: "Sample claim 1", route: "grounded", source: "game-1", p: { supported: 0.91, contradicted: 0.03 }, sourceP: { "game-1": 0.88 } };
	const unsupported = { claim: "Sample claim 2", route: "unsupported", p: { supported: 0.2, contradicted: 0.04 } };
	const checked = claimsOf([grounded, unsupported], [{ id: "web-4", title: "Sample result four", unread: true }, { id: "game-1", title: "Sample champion facts" }]);
	/** The check as Pi draws it: its call's arguments carry the claims, so the first row counts them. */
	const card = (response: any, detail?: CardDetail, expanded = true) => toolResultLines(theme, "voxren_strategy_frame", { claims: response.data.claims.map((entry: any) => entry.claim) }, { response }, expanded, 100, detail);

	test("a check lists each claim once: its verdict and text, one dim line of what the judge found, then the sources, the one nobody read last", () => {
		expect(spaced(card(checked))).toEqual([
			"CHECK    2 claims · 1 grounded · 1 unsupported",
			"  checked by jev-1.13.0 · 480 ms",
			"  ",
			"  grounded     Sample claim 1",
			"               source game-1 88% · stated 91% · opposed 3%",
			"  unsupported  Sample claim 2",
			"               no source · stated 20% · opposed 4%",
			"  cut-offs     contradicted from opposed 60% · grounded from stated 50%",
			"  ",
			"  sources      game-1 Sample champion facts",
			"               web-4 Sample result four (not read)",
			"               an unsupported claim could not be checked against web-4",
		]);
		for (const text of ["Sample claim 1", "Sample claim 2"]) expect(card(checked).filter((line) => line.includes(text))).toHaveLength(1);
	});

	test("the two cut-offs the verdicts rest on show once under the judged claims, each number with its label; a check nothing judged shows none", () => {
		const row = "  cut-offs     contradicted from opposed 60% · grounded from stated 50%";
		expect(spaced(card(checked)).filter((line) => line.includes("cut-offs"))).toEqual([row]);
		expect(spaced(card(claimsOf([{ claim: "Sample claim 1", route: "not_judged" }], [], null))).some((line) => line.includes("cut-offs"))).toBe(false);
		// The collapsed card and the full level do not carry the row: full shows the same cut-offs as yes and no on each question.
		expect(spaced(card(checked, "brief")).some((line) => line.includes("cut-offs"))).toBe(false);
		expect(spaced(card(checked, "full")).some((line) => line.includes("cut-offs"))).toBe(false);
		// A number never wraps away from its label.
		for (let width = 40; width <= 80; width++) for (const line of spaced(createToolResult(theme, "voxren_strategy_frame", {}, { response: checked }, true).render(width))) expect(/^ │\s*\d+%/.test(line)).toBe(false);
	});

	test("a contradicted claim names the id that opposes it, a verdict word takes its colour, and a claim nothing judged has no scores line", () => {
		const contradicted = { claim: "Rush Lich Bane", route: "contradicted", p: { supported: 0.12, contradicted: 0.97 }, contradictedBy: "guide-2" };
		const lines = spaced(createToolResult(tagged, "voxren_strategy_frame", {}, { response: claimsOf([contradicted], []) }, true).render(400));
		expect(lines).toContain(" [mdLink:│]   [error:contradicted ]Rush Lich Bane");
		expect(lines).toContain(" [mdLink:│]                [dim:no source · stated 12% · opposed 97% by guide-2]");
		// No key: the claims are stated as unverified, with no scores to show, and the sources still list.
		const unjudged = claimsOf([{ claim: "Max E first", route: "not_judged" }], [{ id: "game-1", title: "Ahri" }], null);
		expect(card(unjudged)).toEqual(["CHECK    1 claim · not checked", "  no key", "  ", "  not judged   Max E first", "  ", "  sources      game-1 Ahri"]);
	});

	test("the unread-source line shows only while an unsupported claim exists and names every source nobody read", () => {
		const note = (claims: unknown[], sources: unknown[]) => spaced(card(claimsOf(claims, sources))).filter((line) => line.includes("could not be checked"));
		const read = { id: "game-1", title: "Facts" };
		const unread = (id: string) => ({ id, title: "Guide", unread: true });
		expect(note([grounded], [read, unread("web-4")])).toEqual([]); // nothing unsupported rests on it
		expect(note([unsupported], [read])).toEqual([]); // every source was read
		expect(note([unsupported], [read, unread("web-4"), unread("web-5")])).toEqual(["               an unsupported claim could not be checked against web-4, web-5"]);
	});

	test("brief is the collapsed card, claims the default expanded card, and full the judge's questions and score bars, kept for debugging", () => {
		expect(card(checked, "brief")).toEqual(card(checked, undefined, false));
		expect(card(checked, "claims")).toEqual(card(checked));
		const full = card(checked, "full");
		expect(full[0]).toBe("CHECK    2 claims · Trade on cooldown"); // the goal sentence waits for the full level
		expect(full.join("\n")).toContain("Q1  ");
		expect(full.join("\n")).toContain("verdicts   Q1+Q2, two sources: disputed; Q2 alone: contradicted; Q1: grounded");
		expect(full.at(-1)).toBe("  contract research-contract-v1 · strategy_frame · voxren_strategy_frame");
		for (const detail of ["brief", "claims"] as const) expect(card(checked, detail).join("\n")).not.toContain("contract");
		expect(card(checked).join("\n")).not.toContain("Trade on cooldown");
		// A card no decision model reads keeps its contract line at the claims level.
		const facts = reply("gamedata.lookup", { patch: "26.19" });
		expect(toolResultLines(theme, "voxren_game_facts", {}, { response: facts }, true, 100).at(-1)).toStartWith("  contract ");
		expect(toolResultLines(theme, "voxren_game_facts", {}, { response: facts }, false, 100).join("\n")).not.toContain("contract");
	});

	test("a judged video list shows each video once: its scores, its date, its link, and the minutes it was quoted at", () => {
		const video = reply(
			"research_video",
			{
				provider: "YouTube",
				videos: [{ title: "One", url: "https://youtu.be/a", published: "2 months ago", autoCaptions: true, passages: [{ at: 185, text: "Hold E for charm." }, { at: 610, text: "All in at six." }], route: "evidence", p: { relevant: 0.9, support: 0.8, injection: 0.01 } }],
				judgment: { status: "judged", ...judge, kept: 1, removed: [] },
			},
			[["video-1", "One"]],
		);
		const lines = spaced(toolResultLines(theme, "voxren_video_research", {}, { response: video }, true, 100));
		expect(lines.slice(2)).toEqual([
			"  ",
			"  usable       video-1 One",
			"               on topic 90% · support 80% · injection 1%",
			"               2 months ago · auto captions",
			"               https://example.invalid/video-1",
			"                3:05 Hold E for charm.",
			"               10:10 All in at six.",
		]);
		expect(lines.filter((line) => line.includes("video-1 One"))).toHaveLength(1);
	});

	test("a matchup tip shows once at the claims level: its verdict sits on its own words; a blanked tip says so and leaves no empty tip row; unscreened, the tip row stays", () => {
		const matchup = (tip: string, judgment?: Record<string, unknown>) => reply("meta.matchup", { sample: "Emerald+", tip, ...(judgment && { judgment: { status: "judged", ...judge, removed: [], p: { relevant: 0.93, support: 0.8, injection: 0.02 }, ...judgment } }) });
		const lines = (response: any, detail?: CardDetail) => spaced(toolResultLines(theme, "voxren_meta_research", {}, { response }, true, 100, detail));

		const kept = lines(matchup("Close in while her Q is down.", { kept: 1, answer: "evidence" }));
		expect(kept.filter((line) => line.includes("Close in while her Q is down."))).toEqual(["  usable       tip: Close in while her Q is down."]);
		expect(kept).toContain("               on topic 93% · support 80% · injection 2%");

		const blanked = lines(matchup("", { kept: 0, answer: "withheld" }));
		expect(blanked).toContain("  blocked      tip (blanked)");
		expect(blanked.some((line) => line.startsWith("  tip:"))).toBe(false);

		// Nothing judged the tip, or the level is full: the tip keeps its own row.
		expect(lines(matchup("Close in."))).toContain("  tip: Close in.");
		expect(lines(matchup("Close in.", { kept: 1, answer: "evidence" }), "full")).toContain("  tip: Close in.");
	});

	test("X1: a judged tip leads with the evidence id of its card, the id a check's claims cite it by, then tip: and its words; a blanked tip keeps the id; no evidence entry, no id; the full level is unchanged", () => {
		const matchup = (tip: string, judgment: Record<string, unknown>, evidence: Array<[string, string]>) =>
			reply("meta.matchup", { sample: "Emerald+", tip, judgment: { status: "judged", ...judge, removed: [], p: { relevant: 0.93, support: 0.8, injection: 0.02 }, ...judgment } }, evidence);
		const cards: Array<[string, string]> = [["matchup-1", "OP.GG matchup: Fizz vs Ahri mid"], ["guide-1", "Matchup notes: Fizz vs Ahri"]];
		const lines = (response: any, detail?: CardDetail) => spaced(toolResultLines(theme, "voxren_meta_research", {}, { response }, true, 100, detail));

		expect(lines(matchup("Close in while her Q is down.", { kept: 1, answer: "evidence" }, cards))).toContain("  usable       matchup-1 tip: Close in while her Q is down.");
		expect(lines(matchup("", { kept: 0, answer: "withheld" }, cards))).toContain("  blocked      matchup-1 tip (blanked)");
		// The lookup's link sits under the tip, as a link sits under a search result.
		const kept = lines(matchup("Close in while her Q is down.", { kept: 1, answer: "evidence" }, cards));
		expect(kept.slice(kept.indexOf("  usable       matchup-1 tip: Close in while her Q is down.") + 1, kept.indexOf("  usable       matchup-1 tip: Close in while her Q is down.") + 3)).toEqual(["               on topic 93% · support 80% · injection 2%", "               https://example.invalid/matchup-1"]);
		expect(lines(matchup("Close in.", { kept: 1, answer: "evidence" }, []))).toContain("  usable       tip: Close in.");
		// The full level names the item as it always did, with no id.
		const full = lines(matchup("Close in.", { kept: 1, answer: "evidence" }, cards), "full");
		expect(full.some((line) => line.endsWith("tip  Close in."))).toBe(true);
		expect(full.join("\n")).not.toContain("matchup-1  tip");
	});

	/** A search or video card nothing screened, and the same card judged: the first has the shape of the second without verdicts and scores. */
	const videoRow = { title: "One", published: "2 months ago", autoCaptions: true, passages: [] as Array<{ at: number; text: string }> };
	const parts = (n: number, text = "Hold E for charm.") => Array.from({ length: n }, (_, index) => ({ at: 60 * (index + 1), text: `${text} ${index + 1}` }));
	const videoReply = (rows: any[], extra: Record<string, unknown> = {}) =>
		reply("research_video", { provider: "YouTube", videos: rows, ...extra }, rows.map((row, index): [string, string] => [`video-${index + 1}`, row.title]));
	const scores = { relevant: 0.9, support: 0.8, injection: 0.01 };
	const judgedBy = { status: "judged", ...judge, kept: 1, removed: [] };

	test("X2: a usable video quotes its first two parts, each cut at a word to 200 characters; the rest waits for the full level, and a dim line says how many", () => {
		const long = "alpha ".repeat(70).trim(); // 419 characters
		const lines = (rows: any[], detail?: CardDetail) => spaced(toolResultLines(theme, "voxren_video_research", {}, { response: videoReply(rows, { judgment: judgedBy }) }, true, 300, detail));
		const judgedRow = (passages: any[], route = "evidence") => ({ ...videoRow, passages, route, p: scores });
		const quoted = (rows: string[]) => rows.filter((line) => /^ {13}\s*\d+:\d\d /.test(line));

		// Five parts: the first two show, and the line counts the other three.
		const many = lines([judgedRow(parts(5))]);
		expect(quoted(many)).toEqual(["                1:00 Hold E for charm. 1", "                2:00 Hold E for charm. 2"]);
		expect(many).toContain("               3 more quoted parts not shown");
		expect(lines([judgedRow(parts(3))])).toContain("               1 more quoted part not shown");
		// A count stays on the line of its label: no wrapped line opens with "cut short" or "more quoted", at any width.
		for (let width = 40; width <= 80; width++) {
			const drawn = spaced(createToolResult(theme, "voxren_video_research", {}, { response: videoReply([judgedRow([...parts(1), { at: 90, text: long }, ...parts(3)])], { judgment: judgedBy }) }, true).render(width));
			for (const line of drawn) expect(/^(cut short|more quoted)/.test(line.replace(/^ │\s*/, ""))).toBe(false);
		}
		// A result that quoted is followed by a blank row, so the next one does not run into its quotes; the last one and one that quoted nothing are not.
		const three = lines([judgedRow(parts(1)), judgedRow(parts(1), "weak"), judgedRow(parts(1))]);
		// (the first blank row is the one that sets the list apart from the judgment row)
		expect(three.map((line, index) => (line === "  " ? index : -1)).filter((index) => index >= 0).slice(1)).toEqual([three.indexOf("                1:00 Hold E for charm. 1") + 1]);
		expect(three[three.length - 1]).not.toBe("  ");

		// A long part is cut on a word with an ellipsis, inside 200 characters; the line says one was cut.
		const cut = lines([judgedRow([{ at: 65, text: long }, { at: 70, text: "Short." }])]);
		expect(quoted(cut)[0]).toBe(`                1:05 ${"alpha ".repeat(33).trim()}…`);
		expect(quoted(cut)[0].slice(21).length).toBeLessThanOrEqual(200);
		expect(cut).toContain("               1 quoted part cut short");
		expect(lines([judgedRow([...parts(1), { at: 90, text: long }, ...parts(3)])]).filter((line) => line.includes("not shown"))).toEqual(["               3 more quoted parts not shown, 1 cut short"]);

		// Exactly 200 characters is whole; two whole parts leave no line at all.
		const edge = lines([judgedRow([{ at: 5, text: "x".repeat(200) }, { at: 9, text: "y".repeat(201) }])]);
		expect(quoted(edge)[0]).toEndWith("x".repeat(200));
		expect(quoted(edge)[1]).toEndWith(`${"y".repeat(199)}…`);
		expect(lines([judgedRow(parts(2))]).some((line) => line.includes("not shown") || line.includes("cut short"))).toBe(false);

		// A video the screen called weak or off topic shows no quoted part and no line about them.
		for (const route of ["weak", "off_topic"]) {
			const quiet = lines([judgedRow(parts(5), route)]);
			expect(quiet.some((line) => line.includes("Hold E") || line.includes("full detail"))).toBe(false);
			expect(quiet.some((line) => line.includes("video-1 One"))).toBe(true);
		}

		// The full level keeps every part whole.
		const full = lines([judgedRow([{ at: 65, text: long }, ...parts(4)])], "full").join("\n");
		expect(full).toContain(long);
		for (const index of [1, 2, 3, 4]) expect(full).toContain(`Hold E for charm. ${index}`);
	});

	test("X3: a title holding a box bar is drawn with plain pipes in every list of the claims level, so it never reads as a second card bar", () => {
		const barred = "Ahri vs Katarina │ Grandmaster ┃ MMR";
		const piped = "Ahri vs Katarina | Grandmaster | MMR";
		const drawn = (name: VoxrenToolName, response: any) => createToolResult(theme, name, {}, { response }, true).render(120);
		const clean = (lines: string[]) => lines.forEach((line) => expect(line.slice(3), line).not.toMatch(/[│┃]/)); // past the card's own bar
		const texts = (lines: string[]) => spaced(lines).map((line) => line.slice(3).trim()).join("\n");

		const judgedVideo = videoReply([{ ...videoRow, title: barred, route: "evidence", p: scores }], { judgment: judgedBy });
		const unscreenedVideo = videoReply([{ ...videoRow, title: barred }]);
		const removed = reply("research_web_search", { judgment: { status: "judged", ...judge, kept: 0, removed: [{ domain: "example.net", title: barred, route: "withheld", p: scores }] } });
		const check = reply("strategy_frame", { goal: "g", claims: [], sources: [{ id: "video-1", title: barred }], judgment: { status: "judged", ...judge, checked: 0 } });
		const facts = reply("gamedata.lookup", { patch: "26.19" }, [["game-1", barred]]);
		for (const [name, response] of [["voxren_video_research", judgedVideo], ["voxren_video_research", unscreenedVideo], ["web_search", removed], ["voxren_strategy_frame", check], ["voxren_game_facts", facts]] as const) {
			const lines = drawn(name, response);
			clean(lines);
			expect(texts(lines), name).toContain(piped);
		}
		// Only titles change: a bar the model's own claim holds is its own text.
		expect(texts(drawn("voxren_strategy_frame", reply("strategy_frame", { goal: "g", claims: [{ claim: "a │ b", route: "not_judged" }], judgment: { status: "judged", ...judge, checked: 1 } })))).toContain("a │ b");
	});

	test("a result nothing screened carries the label unscreened where a judged one carries its verdict, never a blank column", () => {
		const down = reply("research_web_search", { judgment: { status: "unavailable", ...judge, model: "jev-latest", reason: "timeout" } }, [["web-1", "One"], ["web-2", "Two"]]);
		const rows = toolResultLines(theme, "web_search", {}, { response: down }, true, 80).map(plain).filter((line) => /web-\d (One|Two)/.test(line));
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row).toMatch(/^\s*unscreened {3}web-\d/);
	});

	test("X4: a card nothing screened lists each result once in the order of a judged one, with no verdict and no scores, and the row that says why sits under the first row", () => {
		const lines = (name: VoxrenToolName, response: any, detail?: CardDetail) => spaced(toolResultLines(theme, name, {}, { response }, true, 100, detail));
		const sample = [{ at: 185, text: "Hold E for charm." }, ...parts(4)];

		// Search: id and title, then the link; the row under the first row says why.
		expect(lines("web_search", reply("research_web_search", { provider: "hosted" }, [["web-1", "One"], ["web-2", "Two"]]))).toEqual([
			"SEARCH   live web (hosted) · 2 results",
			"  not screened · no key",
			"  ",
			"  unscreened   web-1 One",
			"               https://example.invalid/web-1",
			"  unscreened   web-2 Two",
			"               https://example.invalid/web-2",
		]);

		// Video: id and title, date and caption note, link, two quoted parts and the line for the rest; no second list of titles.
		const video = lines("voxren_video_research", videoReply([{ ...videoRow, passages: sample }]));
		expect(video.slice(1)).toEqual([
			"  not screened · no key",
			"  ",
			"  unscreened   video-1 One",
			"               2 months ago · auto captions",
			"               https://example.invalid/video-1",
			"                3:05 Hold E for charm.",
			"                1:00 Hold E for charm. 1",
			"               3 more quoted parts not shown",
		]);
		expect(video.filter((line) => line.includes("One"))).toHaveLength(1);

		// Judge unavailable: the error row sits where the screen's row would, and the results list the same way.
		const down = lines("web_search", reply("research_web_search", { judgment: { status: "unavailable", ...judge, model: "jev-latest", reason: "timeout" } }, [["web-1", "One"]]));
		expect(down.slice(1)).toEqual(["  jev-latest unavailable (timeout) · passages unscreened", "  ", "  unscreened   web-1 One", "               https://example.invalid/web-1"]);

		// Nothing to list: just the row.
		expect(lines("web_search", reply("research_web_search", { answer: "" }))).toEqual(["SEARCH   live web (?) · 0 results", "  not screened · nothing to screen"]);

		// An OP.GG card lists its evidence entry; a matchup lists its tip under that entry's id, with the link, as a screened one does.
		const overview = lines("voxren_meta_research", reply("meta.champion_overview", { sample: "Emerald+", staleness: "patch 26.19" }, [["champion_overview-1", "OP.GG champion analysis: Fizz mid"]]));
		expect(overview.slice(1)).toEqual(["  not screened · no key", "  Emerald+ · patch 26.19", "  ", "  unscreened   champion_overview-1 OP.GG champion analysis: Fizz mid", "               https://example.invalid/champion_overview-1"]);
		const matchup = lines("voxren_meta_research", reply("meta.matchup", { sample: "Emerald+", staleness: "patch 26.19", tip: "Close in.", request: "lol_get_lane_matchup_guide()" }, [["matchup-1", "OP.GG matchup: Fizz vs Ahri mid"]]));
		expect(matchup.slice(1)).toEqual(["request  lol_get_lane_matchup_guide()", "  not screened · no key", "  lane: ? · solo kills ? · play ? · patch ?", "  Emerald+ · patch 26.19", "  ", "  unscreened   matchup-1 tip: Close in.", "               https://example.invalid/matchup-1"]);
		// With no tip words the lookup is listed by its title; with no evidence entry the tip keeps its own row.
		expect(lines("voxren_meta_research", reply("meta.matchup", { sample: "Emerald+", tip: "" }, [["matchup-1", "OP.GG matchup: Fizz vs Ahri mid"]]))).toContain("  unscreened   matchup-1 OP.GG matchup: Fizz vs Ahri mid");
		expect(lines("voxren_meta_research", reply("meta.matchup", { sample: "Emerald+", tip: "Close in." }))).toContain("  tip: Close in.");

		// Same shape as the judged card: the row under the first row sits at the same place, and the entries open at the same column.
		const screened = lines("voxren_video_research", videoReply([{ ...videoRow, passages: sample, route: "evidence", p: scores }], { judgment: judgedBy }));
		expect(screened.findIndex((line) => line.includes("screened by"))).toBe(video.findIndex((line) => line.includes("not screened")));
		expect(screened.find((line) => line.includes("video-1 One"))!.indexOf("video-1")).toBe(video.find((line) => line.includes("video-1 One"))!.indexOf("video-1"));

		// The collapsed card, the full level, and a card no decision model reads keep their own rows.
		const search = reply("research_web_search", {}, [["web-1", "One"]]);
		expect(toolResultLines(theme, "web_search", { query: "q" }, { response: search }, false, 100)).toEqual(['SEARCH   "q" · 1 result', "  not screened · no key"]);
		expect(toolResultLines(theme, "web_search", { query: "q" }, { response: search }, true, 100, "full").slice(0, 4)).toEqual(['SEARCH   "q" · live web (?) · 1 result', "  [web-1] One", "    https://example.invalid/web-1", "  not screened · no key"]);
		expect(lines("voxren_game_facts", reply("gamedata.lookup", { patch: "26.19" }, [["game-1", "Riot Data Dragon 26.19"]])).slice(0, 3)).toEqual(["FACTS    Data Dragon 26.19", "  [game-1] Riot Data Dragon 26.19", "    https://example.invalid/game-1"]);
	});

	test("X5: a wrapped first row never opens a line with a separator: it stays at the end of the line before, at every width", () => {
		const response = reply("research_web_search", { provider: "hosted web search (model provider)", retrievedAt: "2026-10-04T12:00:00.000Z" }, [["web-1", "One"], ["web-2", "Two"], ["web-3", "Three"]]);
		const args = { query: "katarina versus ahri mid lane matchup guide charm dagger lane levels first back" };
		let wrapped = 0;
		for (let width = 40; width <= 140; width++) {
			const lines = spaced(createToolResult(theme, "web_search", args, { response }, true).render(width));
			// The first row runs to the row that says why nothing was screened; its lines after the first hang at column 20.
			const row = lines.slice(0, lines.findIndex((line) => line.includes("not screened")));
			for (const line of row.slice(1)) expect(line.slice(20), `${width}: ${line}`).not.toStartWith("·");
			if (row.length > 1) wrapped++;
			// Wrapped, not cut: the row still reads in full.
			expect(row.map((line) => line.slice(20)).join(" ").replace(/\s+/g, " ")).toContain(`"${args.query}" · live web (hosted web search (model provider)) · 3 results · retrieved 2026-10-04`);
		}
		expect(wrapped).toBeGreaterThan(50);
		// Without the glue the same row opens a line with the separator at some width in the sweep: the check above is not empty.
		const plainWrap = (width: number) => wrapTextWithAnsi(toolResultLines(theme, "web_search", args, { response }, true, 140)[0], width - 3);
		expect(Array.from({ length: 101 }, (_, n) => plainWrap(n + 40)).some((lines) => lines.slice(1).some((line) => line.trimStart().startsWith("·")))).toBe(true);
		// The judgment row under it and a pending card's first row follow the same rule.
		const judged = reply("research_web_search", { provider: "hosted", results: [], judgment: { status: "judged", model: "jev-1.13.0", removed: [{ domain: "removed.example", title: "T", route: "withheld", p: { relevant: 0.9, support: 0.5, injection: 0.97 } }], answer: "evidence", latencyMs: 120 } });
		for (let width = 40; width <= 140; width++) {
			for (const line of spaced(createToolResult(theme, "web_search", args, { response: judged }, true).render(width)).slice(1)) expect(line.replace(/^ │\s*/, "").startsWith("·")).toBe(false);
			for (const line of spaced(createToolCall(theme, "voxren_meta_research", { query_type: "matchup", champion: "Katarina", opponent: "Ahri", position: "middle" }).render(width)).slice(1)) expect(line.replace(/^ │\s*/, "").startsWith("·")).toBe(false);
		}
		// A coloured separator (the first row dims the one between the call and its source) holds as well.
		const coloured = { fg: (_role: string, text: string) => `\x1b[2m${text}\x1b[22m`, bold: (text: string) => text } as any;
		for (let width = 40; width <= 100; width++) {
			const lines = createToolResult(coloured, "web_search", args, { response }, true).render(width).map((line) => spaced([plain(line)])[0]);
			for (const line of lines.slice(1, lines.findIndex((entry) => entry.includes("not screened")))) expect(line.slice(20), `${width}: ${line}`).not.toStartWith("·");
		}
		// The plain text of the row, before any wrap, carries no glue.
		expect(toolResultLines(theme, "web_search", args, { response }, true)[0]).not.toContain("\u00a0");
	});

	test("X6: a collapsed search cuts its query between words when a space falls in the second half of the limit, else where the limit falls", () => {
		const first = (query: string) => toolResultLines(theme, "web_search", { query }, { response: reply("research_web_search", {}, [["web-1", "One"]]) }, false, 200)[0];
		expect(first("katarina vs ahri mid matchup guide charm shunpo dagger early levels lobafire")).toBe('SEARCH   "katarina vs ahri mid matchup guide charm shunpo dagger…" · 1 result');
		// The limit falls on the end of a word: that word stays whole.
		expect(first(`${"alpha ".repeat(8)}alphabet more words`)).toBe(`SEARCH   "${"alpha ".repeat(8)}alphabet…" · 1 result`);
		// The only space is in the first half: the cut falls where the limit does.
		expect(first(`abcdefghij ${"y".repeat(80)}`)).toBe(`SEARCH   "abcdefghij ${"y".repeat(45)}…" · 1 result`);
		// A short query is whole, and a pending card cuts the same way.
		expect(first("shunpo dagger e")).toBe('SEARCH   "shunpo dagger e" · 1 result');
		expect(plain(createToolCall(theme, "web_search", { query: "katarina vs ahri mid matchup guide charm shunpo dagger early levels lobafire" }).render(200)[0])).toContain('"katarina vs ahri mid matchup guide charm shunpo dagger…"');
	});

	test("the level an expanded card opens at is the launch's: the default, full, or brief; anything else is the default", () => {
		expect(["full", " FULL ", "brief", "claims", "", undefined, "wide"].map((word) => parseCardDetail(word))).toEqual(["full", "full", "brief", "claims", "claims", "claims", "claims"]);
		const result = { content: [{ type: "text", text: "x" }], details: { response: checked } };
		const drawn = (detail?: CardDetail) =>
			(createCoachTools({} as any, undefined, detail).find((tool) => tool.name === "voxren_strategy_frame") as any)
				.renderResult(result, { expanded: true, isPartial: false }, theme, { args: {} })
				.render(100)
				.map(plain);
		expect(drawn().join("\n")).not.toContain("Q1  ");
		expect(drawn("full").join("\n")).toContain("Q1  ");
		expect(drawn("brief")).toEqual(createToolResult(theme, "voxren_strategy_frame", {}, { response: checked }, false).render(100).map(plain));
	});
});

describe("expanded cards fit any width", () => {
	const long = "Take the rocketbelt first against Ahri and skip Hextech Alternator until the second back, because her burst kills you before it pays off";
	const korean = "해적 Pyke 대 아리 matchup 정글 동선과 레벨 업 노트 확인 중입니다 정말로 끝까지 확인해 주세요";
	const query = "katarina versus ahri mid lane matchup level three trade pattern with rocketbelt first item and the runes that go with it";
	const source = "Matchup guide from a long-named channel about trading patterns at level three";
	const paths = ["https://example.invalid/guides/katarina/ahri/mid-lane/level-three-trade-pattern-with-rocketbelt-first-item-and-runes"];
	const check = reply("strategy_frame", {
		goal: "g",
		claims: [
			{ claim: long, route: "grounded", source: "web-1", p: { supported: 0.9, contradicted: 0.02 }, sourceP: { "web-1": 0.8 } },
			{ claim: korean, route: "contradicted", p: { supported: 0.1, contradicted: 0.95 }, contradictedBy: "guide-2" },
			{ claim: long, route: "unsupported", p: { supported: 0.2, contradicted: 0.04 } },
		],
		sources: [{ id: "web-1", title: source }, { id: "web-9", title: source, unread: true }],
		judgment: { status: "judged", judge: "jev", model: "jev-1.13.0", latencyMs: 480, checked: 3 },
	});
	const searched = reply(
		"research_web_search",
		{
			provider: "hosted",
			results: [{ route: "evidence", p: { relevant: 0.95, support: 0.9, injection: 0.02 } }, { route: "weak", p: { relevant: 0.5, support: 0.2, injection: 0.1 } }],
			judgment: { status: "judged", judge: "jev", model: "jev-1.13.0", answer: "evidence", answerP: { relevant: 0.9, support: 0.9, injection: 0.02 }, kept: 2, removed: [{ domain: "a-long-domain-name.example.net", title: korean, route: "withheld", p: { relevant: 0.9, support: 0.4, injection: 0.97 } }], latencyMs: 120 },
		},
		[["web-1", source], ["web-2", korean]],
	);
	searched.evidence[0].url = paths[0];
	// The same search with nothing screening it, and a judged video whose parts are long enough to wrap at every width but under the 200 characters the claims level quotes.
	const unscreened = reply("research_web_search", { provider: "hosted" }, [["web-1", source], ["web-2", korean]]);
	unscreened.evidence[0].url = paths[0];
	const parts = [{ at: 324, text: `${long} and then take the second item` }, { at: 209, text: `${korean} ${korean} ${korean}` }, { at: 61, text: "A third part the claims level leaves to the full level." }];
	const videos = reply(
		"research_video",
		{
			provider: "YouTube",
			videos: [
				{ title: source, published: "5 months ago", autoCaptions: true, passages: parts, route: "evidence", p: { relevant: 0.9, support: 0.8, injection: 0.01 } },
				{ title: korean, published: "3 weeks ago", passages: parts, route: "weak", p: { relevant: 0.8, support: 0.3, injection: 0.01 } },
			],
			judgment: { status: "judged", judge: "jev", model: "jev-1.13.0", latencyMs: 120, kept: 2, removed: [] },
		},
		[["video-1", source], ["video-2", korean]],
	);
	videos.evidence[0].url = paths[0];

	test("no row of an expanded check, search (screened or not) or video card ends in an ellipsis or runs past the width, every wrapped line keeps the bar, and every word is still there, at 50, 64, 100 and 140 columns", () => {
		for (const width of [50, 64, 100, 140]) {
			const cards = [
				{ lines: createToolResult(theme, "voxren_strategy_frame", {}, { response: check }, true).render(width), texts: [long, korean, source] },
				{ lines: createToolResult(theme, "web_search", { query }, { response: searched }, true).render(width), texts: [query, source, korean, paths[0], "a-long-domain-name.example.net"] },
				{ lines: createToolResult(theme, "web_search", { query }, { response: unscreened }, true).render(width), texts: [query, source, korean, paths[0], "not screened · no key"] },
				{ lines: createToolResult(theme, "voxren_video_research", { query }, { response: videos }, true).render(width), texts: [query, source, korean, paths[0], parts[0].text, parts[1].text, "5 months ago · auto captions", "1 more quoted part not shown"] },
			];
			for (const { lines, texts } of cards) {
				for (const line of lines) {
					expect(visibleWidth(line), `${width}: ${line}`).toBeLessThanOrEqual(width);
					expect(line.startsWith(" │"), `${width}: ${line}`).toBe(true);
					expect(line, `${width}: ${line}`).not.toContain("…");
				}
				// Wrapped, never cut: the text of each long row is on the card in full once the bar and the breaks are taken out.
				const flat = lines.map((line) => line.replace(/[│\s]/g, "")).join("");
				for (const text of texts) expect(flat, `${width}: ${text}`).toContain(text.replace(/\s/g, ""));
			}
		}
	});
});

describe("pending cards say what they are doing", () => {
	test("a pending check says how many claims it is checking and a pending search what it is searching, spinning from the moment Pi runs the call", () => {
		const time = fakeTime();
		const motion = createCardMotion(time.clock);
		motion.enable(true);
		const checking = createToolCall(theme, "voxren_strategy_frame", { question: "q", claims: ["a", "b", "c"], evidence: [{ id: "web-1" }] }, context(true).context, motion);
		const searching = createToolCall(theme, "web_search", search, context(true).context, motion);
		time.advance(300);
		expect(plain(checking.render(100)[0])).toMatch(/^ │ CHECK    [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 0\.3s +3 claims$/);
		expect(plain(searching.render(100)[0])).toMatch(/^ │ SEARCH   [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 0\.3s +"katarina vs ahri"$/);
		// One claim reads singular, and a call whose arguments are still being written has no count to show yet.
		expect(plain(createToolCall(theme, "voxren_strategy_frame", { claims: ["a"] }).render(100)[0])).toMatch(/^ │ CHECK    ○ +1 claim$/);
		expect(plain(createToolCall(theme, "voxren_strategy_frame", {}).render(100)[0])).toMatch(/^ │ CHECK    ○ *$/);
	});
});

describe("narrow panes", () => {
	test("a pane narrower than a card's label and status cells still never overflows", () => {
		for (const width of [10, 20, 30]) {
			for (const [name, args, response] of KINDS) {
				for (const line of createToolResult(theme, name, args, { response }, true).render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				for (const line of createToolCall(theme, name, args).render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			for (const line of routeLines(theme, { model: "gpt-6-luna", thinking: "low", source: "jev", tier: "quick", p: 0.8, ms: 100 }, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("audit table inside the bar", () => {
	const game = (win: boolean, vs: string, extra: Record<string, unknown> = {}) => ({ win, vs, kda: win ? "9/3/5" : "2/8/4", d6: 1, dLate: 2, cs15: 130, gd15: win ? 900 : -2900, dur: 27.5, ...extra });
	const audit = (games: any[], matchups: any[]) =>
		reply("player_audit", {
			analyzed: games.length,
			requested: games.length,
			patches: ["16.18"],
			summary: { games: games.length, wins: 2, avgKills: 9, avgDeaths: 3.333, avgAssists: 5, avgDeathsAfter15: 2.5, avgGoldDiffAt15: 900, avgCsAt15: 120 },
			games,
			reference: { matchups },
		});
	/** The table of a collapsed card, rows last: its header, a row per game, then avg and otp (no items or charts in these games). */
	const table = (response: any, width: number, rows: number) => createToolResult(theme, "voxren_player_audit", {}, { response }, false).render(width).slice(-rows);
	const remake = game(false, "Zed", { remake: true, kda: "0/0/0", d6: 0, dLate: 0, cs15: null, gd15: null, dur: 4 });
	const remakeAndOtp = audit([game(true, "Ryze"), game(false, "Ahri"), remake], [{ vs: "Ryze", n: 38, gd15: 1262, deaths: 4.47 }]);

	test("a remake and a one-trick row in a 40-column pane still read the opponents, and no column is cut to dots", () => {
		for (const width of [31, 34, 37, 40, 41, 50]) {
			const rows = table(remakeAndOtp, width, 6);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			const drawn = rows.join("\n");
			for (const opponent of ["Ryze", "Ahri", "Zed"]) expect(drawn).toContain(opponent);
			expect(drawn).not.toContain("..");
			expect(drawn).toContain("avg");
		}
	});

	test("the table holds the columns it held before the card had a margin and a bar, at the same pane widths", () => {
		// 188c131 first showed cs@15 at 49 columns, d<6 at 54, d>15 at 60 and len at 67 for these games; the bar and margin take three cells, which the gaps give back.
		const games = [game(true, "Twisted Fate"), game(false, "Lissandra"), game(true, "Aurelion Sol")];
		const response = audit(games, [{ vs: "Twisted Fate", n: 3, gd15: -300, deaths: 3.1 }]);
		const header = (width: number) => createToolResult(theme, "voxren_player_audit", {}, { response }, false).render(width).find((line) => line.includes("kda"))!;
		for (const [column, from] of [["cs@15", 49], ["d<6", 54], ["d>15", 60], ["len", 67]] as const) {
			expect(header(from)).toContain(column);
			expect(header(from - 1)).not.toContain(column);
		}
		// Wide enough for two spaces between columns, the table keeps them.
		expect(header(140)).toMatch(/vs {2,}kda {2}gold@15 {2}cs@15 {2}d<6 {2}d>15 {2,}len/);
	});
});

describe("item icons in the audit card", () => {
	afterEach(() => resetCapabilitiesCache());
	// An icon PNG as big as a real one: the 1x1 header sized 64x64, then a body. Every PNG's base64 starts the same way, and so does what pi-tui's width count gets wrong.
	const head = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
	head.writeUInt32BE(64, 16);
	head.writeUInt32BE(64, 20);
	const png = Buffer.concat([head, Buffer.alloc(5000, 0x6b)]);
	const ITEMS = ["Ui Test Dark Seal", "Ui Test Doran's Ring", "Ui Test Boots"];
	const fetchImpl = (async (url: string) =>
		url.endsWith("/item.json")
			? ({ json: async () => ({ data: Object.fromEntries(ITEMS.map((name, index) => [String(7001 + index), { name }])) }) } as Response)
			: ({ arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) } as Response)) as typeof fetch;
	const audit = (names: string[]) =>
		reply("player_audit", {
			patches: ["16.18"],
			analyzed: 3,
			requested: 3,
			summary: { games: 3, medianItemTimingMin: Object.fromEntries(names.map((name, index) => [name, 3.3 + index])), itemPurchaseCount: Object.fromEntries(names.map((name) => [name, 3])) },
			games: [],
		});
	/** A line's cells as the terminal draws them: an iTerm2 icon steps over the cells the sequence names, and its bytes take none. */
	const cells = (line: string) => visibleWidth(line.replace(/\x1b7\x1b\]1337;File=[^\x07]*\x07\x1b8\x1b\[(\d+)C/g, (_, n) => " ".repeat(Number(n))));

	test("on an iTerm2 terminal no width cuts an icon's escape sequence, and the row keeps every icon and every item", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		await prefetchItemIcons(ITEMS, "ui-icons-1", "https://ddragon.example", fetchImpl);
		for (const width of [60, 70, 80, 90, 100, 110, 120, 140, 200]) {
			const lines = createToolResult(theme, "voxren_player_audit", {}, { response: audit(ITEMS) }, false).render(width);
			const drawn = lines.join("\n");
			expect(drawn.split("\x1b]1337;File=")).toHaveLength(4); // all three icons are there...
			expect(drawn.match(/\x1b\]1337;File=[^\x07]*\x07/g)).toHaveLength(3); // ...each one whole, ended by its BEL
			expect(drawn.split("\x1b7")).toHaveLength(drawn.split("\x1b8").length);
			for (const name of ITEMS) expect(drawn).toContain(name);
			for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(width);
		}
	});

	test("an item too wide for a narrow pane is cut in its words, never in its icon", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const long = ["Ui Test Berserker's Greaves Of Swiftness"];
		await prefetchItemIcons(long, "ui-icons-2", "https://ddragon.example", (async (url: string) => (url.endsWith("/item.json") ? ({ json: async () => ({ data: { 7101: { name: long[0] } } }) } as Response) : ({ arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) } as Response))) as typeof fetch);
		const lines = createToolResult(theme, "voxren_player_audit", {}, { response: audit(long) }, false).render(50);
		const row = lines.find((line) => line.includes("\x1b]1337;File="))!;
		expect(row.match(/\x1b\]1337;File=[^\x07]*\x07\x1b8\x1b\[\d+C/g)).toHaveLength(1);
		expect(plain(row)).toContain("…");
		expect(cells(row)).toBeLessThanOrEqual(50);
	});

	test("a Kitty terminal keeps every icon sequence whole at any width", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		await prefetchItemIcons(ITEMS, "ui-icons-3", "https://ddragon.example", fetchImpl);
		for (const width of [70, 100, 140]) {
			const drawn = createToolResult(theme, "voxren_player_audit", {}, { response: audit(ITEMS) }, false).render(width).join("\n");
			expect(drawn.match(/\x1b_G/g)!.length).toBe(drawn.match(/\x1b\\/g)!.length);
			for (const name of ITEMS) expect(drawn).toContain(name);
		}
	});
});

describe("no band behind anything", () => {
	const BAND_ROLES = ["userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"];
	const loadTheme = (name: string) => {
		const colors: Record<string, string> = JSON.parse(readFileSync(fileURLToPath(new URL(`../themes/${name}.json`, import.meta.url)), "utf8")).colors;
		const backgrounds = [...BAND_ROLES, "selectedBg"];
		const pick = (wanted: boolean) => Object.fromEntries(Object.entries(colors).filter(([key]) => backgrounds.includes(key) === wanted)) as any;
		return { colors, real: new Theme(pick(false), pick(true), "truecolor") };
	};

	for (const name of ["tidal", "hextech", "void", "signal"]) {
		test(`${name}: the tool, user and custom message backgrounds are the terminal's own, and no card sets one`, () => {
			const { colors, real } = loadTheme(name);
			for (const role of BAND_ROLES) {
				expect(colors[role]).toBe("");
				expect(real.bg(role as any, "x")).not.toContain("48;");
			}
			const drawn: string[] = [];
			for (const [tool, args, response] of KINDS) drawn.push(...createToolResult(real, tool, args, { response }, true).render(100), ...createToolCall(real, tool, args).render(100));
			drawn.push(...createToolResult(real, "web_search", { query: "q" }, { errorText: "ERROR[X] y" }, false).render(100));
			drawn.push(...routeLines(real, { model: "m", thinking: "low", source: "pinned" }, 100));
			expect(drawn.join("\n")).toContain("\x1b[38;"); // coloured text is drawn...
			expect(drawn.join("\n")).not.toMatch(/\x1b\[(?:4\d|10\d)(?:;|m)/); // ...and no background, not even a reset to the default one
		});

		test(`${name}: lookups, the check, the route row, errors, thinking and the player's line each draw in a colour of their own`, () => {
			const { real } = loadTheme(name);
			const barOf = (lines: string[]) => /\x1b\[38;2;([\d;]+)m│/.exec(lines[0])![1];
			const colourOf = (role: string) => /38;2;([\d;]+)m/.exec(real.getFgAnsi(role as any))![1];
			const webSearch = KINDS[1];
			const kinds = {
				lookup: barOf(createToolResult(real, "web_search", webSearch[1], { response: webSearch[2] }, false).render(100)),
				check: barOf(createToolResult(real, "voxren_strategy_frame", {}, { response: frame }, false).render(100)),
				error: barOf(createToolResult(real, "web_search", { query: "q" }, { errorText: "ERROR[X] y" }, false).render(100)),
				route: barOf(routeLines(real, { model: "m", thinking: "low", source: "pinned" }, 100)),
				// Pi draws the thinking line in thinkingText, and the bar before the player's words in mdQuoteBorder.
				thinking: colourOf("thinkingText"),
				player: colourOf("mdQuoteBorder"),
			};
			expect(new Set(Object.values(kinds)).size, JSON.stringify(kinds)).toBe(6);
			expect(colourOf("mdQuote")).toBe(kinds.player); // the player's words match the bar before them
		});
	}
});

// --- the pending state -------------------------------------------------------------

/** A clock the test turns by hand and timers it fires by hand: nothing waits and nothing real ticks. */
function fakeTime() {
	let now = 0;
	const timers: Array<{ tick: () => void; cleared: boolean; unrefs: number; unref(): void }> = [];
	return {
		advance: (ms: number) => void (now += ms),
		timers,
		running: () => timers.filter((timer) => !timer.cleared).length,
		/** One frame: every timer still running fires. */
		fire: () => timers.filter((timer) => !timer.cleared).forEach((timer) => timer.tick()),
		clock: {
			now: () => now,
			setInterval: ((tick: () => void) => {
				const timer = { tick, cleared: false, unrefs: 0, unref: () => void timer.unrefs++ };
				timers.push(timer);
				return timer;
			}) as any,
			clearInterval: ((timer: { cleared: boolean }) => void (timer.cleared = true)) as any,
		},
	};
}

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const search = { query: "katarina vs ahri" };
const found = reply("research_web_search", {}, [["web-1", "One"]]);
const context = (executionStarted: boolean) => {
	const repaints = { count: 0 };
	return { repaints, context: { state: {}, invalidate: () => void repaints.count++, executionStarted } as any };
};

describe("pending cards", () => {
	test("a card waits as a quiet marker while the model writes it, spins and counts up once Pi runs it, and snaps to a done mark with the time it took", () => {
		const time = fakeTime();
		const motion = createCardMotion(time.clock);
		motion.enable(true);
		const { context: call, repaints } = context(false);
		const line = (lines: string[]) => spaced([plain(lines[0])])[0];
		expect(line(createToolCall(theme, "web_search", search, call, motion).render(100))).toMatch(/^ │ SEARCH   ○ +"katarina vs ahri"$/);
		expect(time.timers).toHaveLength(0); // nothing ticks before the call runs

		call.executionStarted = true;
		time.advance(1000);
		const pending = createToolCall(theme, "web_search", search, call, motion);
		const first = line(pending.render(100));
		expect(first).toMatch(/^ │ SEARCH   [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 0\.0s +"katarina vs ahri"$/);
		time.advance(400);
		const later = line(pending.render(100)); // the same card, drawn again at the next frame
		expect(later).toMatch(/^ │ SEARCH   [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 0\.4s +"katarina vs ahri"$/);
		expect(later.match(SPINNER)![0]).not.toBe(first.match(SPINNER)![0]); // the marker advanced
		time.fire();
		expect(repaints.count).toBe(1); // the one timer repaints this card

		time.advance(900);
		const done = createToolResult(theme, "web_search", search, { response: found }, false, call, motion);
		const finished = line(done.render(100));
		expect(finished).toMatch(/^ │ SEARCH   ✓ 1\.3s +"katarina vs ahri" · 1 result$/);
		// The value stays in its column when the card finishes, so nothing jumps.
		expect(finished.indexOf('"katarina')).toBe(first.indexOf('"katarina'));
		expect(createToolCall(theme, "web_search", search, call, motion).render(100)).toEqual([]); // the result card replaces the pending one
		expect(time.running()).toBe(0); // and the timer is gone with the last card
		time.advance(5000);
		expect(line(done.render(100))).toBe(finished); // a finished card's time is the time it took, not the time since
	});

	test("a call the extension never saw run (an /export, a resumed transcript) draws no time, no spinner, and starts no timer", () => {
		const time = fakeTime();
		const motion = createCardMotion(time.clock);
		motion.enable(true);
		const { context: call } = context(true);
		call.toolCallId = "exported";
		const pending = plain(createToolCall(theme, "web_search", search, call, motion).render(100)[0]);
		expect(pending).not.toMatch(SPINNER);
		expect(pending).not.toMatch(/\d\.\ds/);
		expect(time.timers).toHaveLength(0);
		const finished = plain(createToolResult(theme, "web_search", search, { response: found }, false, call, motion).render(100)[0]);
		expect(finished).toMatch(/✓ +"katarina/);
		expect(finished).not.toMatch(/\d\.\ds/);
	});

	test("a call the handlers saw start and end shows the time between those two moments", () => {
		const time = fakeTime();
		const motion = createCardMotion(time.clock);
		motion.enable(true);
		const { context: call } = context(true);
		call.toolCallId = "ran";
		time.advance(1000);
		motion.callStarted("ran");
		time.advance(2400);
		expect(plain(createToolCall(theme, "web_search", search, call, motion).render(100)[0])).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 2\.4s/);
		time.advance(100);
		motion.callEnded("ran");
		time.advance(5000);
		expect(plain(createToolResult(theme, "web_search", search, { response: found }, false, call, motion).render(100)[0])).toContain("✓ 2.5s ");
	});

	test("a failed call ends with ✗ in the error colour and the time it took", () => {
		const time = fakeTime();
		const motion = createCardMotion(time.clock);
		motion.enable(true);
		const { context: call } = context(true);
		createToolCall(tagged, "web_search", search, call, motion);
		time.advance(2500);
		const lines = createToolResult(tagged, "web_search", search, { errorText: "ERROR[UPSTREAM_UNAVAILABLE] x" }, false, call, motion).render(100);
		expect(lines[0]).toContain("[error:✗] [dim:2.5s ]");
	});

	test("the elapsed time reads 0.4s, 12.3s, 1m05s", () => {
		for (const [ms, shown] of [[400, "0.4s"], [12_300, "12.3s"], [65_000, "1m05s"]] as const) {
			const call: any = { state: { startedAt: 0, endedAt: ms, done: true }, invalidate() {}, executionStarted: true };
			expect(plain(createToolResult(theme, "web_search", search, { response: found }, false, call).render(100)[0])).toContain(`✓ ${shown} `);
		}
	});

	test("four calls dispatched together run side by side on one timer, each ending in its own time", () => {
		const time = fakeTime();
		const motion = createCardMotion(time.clock);
		motion.enable(true);
		const calls = KINDS.slice(0, 4).map(([name, args, response]) => ({ name, args, response, ...context(true) }));
		const pending = calls.map((entry) => createToolCall(theme, entry.name, entry.args, entry.context, motion));
		// All four are on screen at once, each with its own marker and time.
		for (const card of pending) expect(plain(card.render(100)[0])).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 0\.0s/);
		expect(time.timers).toHaveLength(1);
		time.fire();
		expect(calls.map((entry) => entry.repaints.count)).toEqual([1, 1, 1, 1]);
		// They finish at different times; the timer runs until the last one lands.
		const times = [700, 600, 800, 400];
		const done = calls.map((entry, index) => {
			time.advance(times[index]);
			return plain(createToolResult(theme, entry.name, entry.args, { response: entry.response }, false, entry.context, motion).render(100)[0]);
		});
		expect(done.map((line) => line.match(/✓ (\S+)/)![1])).toEqual(["0.7s", "1.3s", "2.1s", "2.5s"]);
		expect(time.running()).toBe(0);
	});

	test("stop() ends every repaint and the timer behind them, and a repaint that fires afterwards finds nothing", () => {
		const time = fakeTime();
		const motion = createCardMotion(time.clock);
		motion.enable(true);
		const { context: first, repaints } = context(true);
		createToolCall(theme, "web_search", search, first, motion);
		createToolCall(theme, "web_search", search, context(true).context, motion);
		expect(time.running()).toBe(1);
		motion.stop();
		expect(time.running()).toBe(0);
		time.fire();
		expect(repaints.count).toBe(0);
		motion.stop(); // safe twice
		// The next turn starts a new timer: stopping a turn does not switch the UI off.
		createToolCall(theme, "web_search", search, context(true).context, motion);
		expect(time.running()).toBe(1);
	});

	test("the timer is unref'd, so it can never keep a run or an exiting coach alive", () => {
		const time = fakeTime();
		const motion = createCardMotion(time.clock);
		motion.enable(true);
		createToolCall(theme, "web_search", search, context(true).context, motion);
		expect(time.timers.map((timer) => timer.unrefs)).toEqual([1]);
	});

	test("without a UI (print mode) a pending card is a static line: no time, no spinner, no timer", () => {
		const time = fakeTime();
		const motion = createCardMotion(time.clock); // never enabled
		const { context: call, repaints } = context(true);
		const card = createToolCall(theme, "web_search", search, call, motion);
		expect(plain(card.render(100)[0])).toMatch(/^ │ SEARCH   … +"katarina vs ahri"$/);
		time.advance(3000);
		expect(plain(card.render(100)[0])).toMatch(/^ │ SEARCH   … +"katarina vs ahri"$/); // still the same line
		expect(time.timers).toHaveLength(0);
		expect(repaints.count).toBe(0);
		motion.enable(true);
		motion.enable(false); // a UI that goes away takes its timer with it
		expect(time.running()).toBe(0);
		// A card shown from a saved session never saw its call run: done mark, no time.
		expect(spaced([plain(createToolResult(theme, "web_search", search, { response: found }, false).render(100)[0])])[0]).toMatch(/^ │ SEARCH   ✓ +"katarina vs ahri" · 1 result$/);
	});

	test("Pi runs a card's call renderer again on every repaint: the clock keeps its start, the card watches once, and the end of the call leaves no timer", () => {
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const time = fakeTime();
		const motion = createCardMotion(time.clock);
		motion.enable(true);
		let watches = 0;
		const watch = motion.watch;
		motion.watch = (repaint) => (watches++, watch(repaint));
		const definition: any = createCoachTools({} as any, motion).find((tool) => tool.name === "web_search");
		const card = new ToolExecutionComponent("web_search", "call-1", search, {}, definition, { requestRender() {} } as any, "/tmp");
		motion.callStarted("call-1"); // the tool_execution_start handler, which Pi runs before it draws the running call
		card.markExecutionStarted();
		for (let frame = 0; frame < 4; frame++) {
			time.advance(150);
			card.invalidate(); // what each timer tick does: Pi draws the call row from its renderer again
		}
		// Counted before any timer fires, so a card that re-watches on every redraw fails here instead of looping.
		expect(watches).toBe(1);
		expect(plain(card.render(100).join("\n"))).toContain(" 0.6s "); // the time since the call started, not since the last redraw
		time.fire();
		expect(watches).toBe(1);
		motion.callEnded("call-1");
		card.updateResult({ content: [{ type: "text", text: "x" }], details: { response: found }, isError: false } as any);
		time.advance(1000);
		expect(plain(card.render(100).join("\n"))).toContain("✓ 0.6s "); // the time the call took, fixed when its result landed
		expect(time.running()).toBe(0);
	});

	test("stop() drops every repaint of the turn it ends: a repaint from that turn is never called by the next turn's timer", () => {
		const time = fakeTime();
		const motion = createCardMotion(time.clock);
		motion.enable(true);
		let ended = 0;
		let next = 0;
		motion.watch(() => void ended++);
		motion.stop();
		motion.watch(() => void next++);
		time.fire();
		expect(ended).toBe(0);
		expect(next).toBe(1);
		expect(time.running()).toBe(1);
	});
});

// --- thinking and the player's line ------------------------------------------------

describe("transcript text", () => {
	const markdownTheme: any = { heading: (t: string) => t, link: (t: string) => t, linkUrl: (t: string) => t, code: (t: string) => t, codeBlock: (t: string) => t, codeBlockBorder: (t: string) => t, quote: (t: string) => t, quoteBorder: (t: string) => `[bar:${t}]`, hr: (t: string) => t, listBullet: (t: string) => t, bold: (t: string) => t, italic: (t: string) => t, strikethrough: (t: string) => t, underline: (t: string) => t };
	/** Pi's thinking block: one cell of padding, the text handed through the registered transformer for the width left. */
	const thinkingRows = (source: string, width: number) => new Markdown(source, 1, 0, markdownTheme, undefined, { transform: thinkingMarkdown }).render(width).map((line) => line.trimEnd());
	const titles = "**Checking fact support**\n\n**Restarting matchup lookup**\n\n**Checking level-up notes**";

	test("summaries collapse to one bar, label and text line instead of one paragraph each", () => {
		expect(thinkingRows(titles, 100)).toEqual([" │ THINK    Checking fact support › Restarting matchup lookup › Checking level-up notes"]);
		expect(thinkingRows("**Checking fact support**", 100)).toEqual([" │ THINK    Checking fact support"]);
	});

	test("a pane too narrow for every title drops the oldest and keeps the newest on screen", () => {
		expect(thinkingRows(titles, 60)).toEqual([" │ THINK    … Checking level-up notes"]);
		for (const width of [20, 30, 40, 60, 80, 100, 140]) for (const line of thinkingRows(titles, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		// One title longer than the pane is cut with an ellipsis, never wrapped.
		const [only, ...rest] = thinkingRows("**" + "Checking the whole matchup lookup again ".repeat(4) + "**", 50);
		expect(rest).toEqual([]);
		expect(only.endsWith("…")).toBe(true);
		expect(visibleWidth(only)).toBeLessThanOrEqual(50);
	});

	test("wide characters are measured by cell", () => {
		const rows = thinkingRows("**해적 대 아리 라인 상성 확인 중**\n\n**정글 동선과 레벨 업 노트 확인 중입니다 정말로**", 40);
		expect(rows).toHaveLength(1);
		expect(visibleWidth(rows[0])).toBeLessThanOrEqual(40);
	});

	test("thinking with no titles gives each paragraph's first line; nothing to show draws nothing", () => {
		expect(thinkingRows("Comparing the two builds first.\nThen the runes.\n\nChecking the patch notes.", 100)).toEqual([" │ THINK    Comparing the two builds first. › Checking the patch notes."]);
		expect(thinkingMarkdown("  \n\n ", 100)).toBe("");
		expect(thinkingRows("", 100)).toEqual([]);
	});

	test("markdown in the model's words cannot become a link, a formula, or emphasis, and escape codes are stripped", () => {
		const [row] = thinkingRows("**Look at `meta_research` [1] again, it costs $5 and $10 \x1b[2Jtoday**", 100);
		expect(row).toBe(" │ THINK    Look at meta_research 1 again, it costs 5 and 10 today");
		expect(thinkingMarkdown("**a**", 100)).not.toContain("\x1b");
	});

	test("a www. host in a title stays plain text: Markdown would link it and print its address after it, wrapping the one line", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false }); // a terminal without OSC 8 shows a link's address beside it
		try {
			for (const width of [40, 60, 100]) {
				const rows = thinkingRows("**Checking www.op.gg champion data**", width);
				expect(rows).toHaveLength(1);
				expect(rows[0]).not.toContain("(http");
				expect(visibleWidth(rows[0])).toBeLessThanOrEqual(width);
			}
			expect(thinkingRows("**Checking www.op.gg champion data**", 100)).toEqual([" │ THINK    Checking www.op.gg champion data"]);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("the hidden-thinking label is the same bar and label with no text", () => {
		expect(HIDDEN_THINKING_LABEL).toBe("│ THINK    …");
		expect(thinkingMarkdown("**x**", 100).replace(/\*\*/g, "").startsWith(HIDDEN_THINKING_LABEL.slice(0, -1))).toBe(true);
	});

	describe("the coach's answer", () => {
		const emphasisTheme = { ...markdownTheme, bold: (t: string) => `<b>${t}</b>`, italic: (t: string) => `<i>${t}</i>` };
		/** Pi's answer block: one cell of padding, the text handed through the registered transformer for the width left. */
		const answerRows = (source: string, width: number, markdown = markdownTheme) =>
			spaced(new Markdown(source, 1, 0, markdown, undefined, { transform: (text, room) => answerMarkdown(text, room, theme) }).render(width).map((line) => line.trimEnd()));

		test("a row's label sits in the cards' label column, its cue apart from the call", () => {
			expect(answerRows("Lane: Ezreal Q missed: E in, W-Q short trade.\nKill: Level 3: all-in after Ezreal misses Q.", 100)).toEqual([
				"   LANE     Ezreal Q missed  E in, W-Q short trade.",
				"   KILL     Level 3  all-in after Ezreal misses Q.",
			]);
			// The label takes the lookups' colour in bold, the cue the colour the cards give a finding.
			const drawn = answerMarkdown("Lane: Ezreal Q missed: E in.", 100, tagged);
			expect(drawn).toContain("[accent:[b:LANE]]");
			expect(drawn).toContain("[warning:Ezreal Q missed]");
		});

		test("a row with no cue keeps its call whole: a clock time is not a cue, and neither is a long clause", () => {
			expect(answerRows("Win: Split push after lane.", 100)).toEqual(["   WIN      Split push after lane."]);
			expect(answerRows("Next: Ward river at 3:00 or lose the lane.", 100)).toEqual(["   NEXT     Ward river at 3:00 or lose the lane."]);
			const long = "Edge: When their jungler shows on the far side of the map and your wave is pushing: trade.";
			expect(answerMarkdown(long, 120, tagged)).not.toContain("[warning:");
			// Up to ten words is still a cue: a row is 16 words at most, and a cue can be most of it.
			expect(answerMarkdown("Kill: Ahri Charm missed and her health is low: all-in.", 120, tagged)).toContain("[warning:Ahri Charm missed and her health is low]");
		});

		test("while the answer streams, the row being written holds its words until they are known to be a cue or the call, so nothing changes colour on screen", () => {
			/** The last line as it draws mid-stream, the row above it already complete. */
			const streamed = (last: string) => answerMarkdown(`Lane: Ezreal Q missed: E in.\n${last}`, 100, tagged, true).split("\n").slice(1).join("\n").replace(/\u00a0/g, " ").trimEnd();
			// A lone word may be a label or the start of a sentence: nothing draws until the next word says which.
			expect(streamed("Threat")).toBe("");
			expect(streamed("Threat:")).toBe("");
			// The label is certain; the words after it may still turn out to be a cue, so they wait for the colon.
			expect(streamed("Threat: Qiyana enters")).toBe("  [accent:[b:THREAT]]");
			expect(streamed("Threat: Qiyana enters river:")).toBe("  [accent:[b:THREAT]]");
			expect(streamed("Threat: Qiyana enters river: st")).toBe("  [accent:[b:THREAT]]   [warning:Qiyana enters river]  st");
			// Past the cue's ten words no colon can make a cue of them: the call draws.
			expect(streamed("Win: Split push after lane and take the tower then group mid with")).toContain("Split push after lane and take the tower then group mid with");
			// The finished row above is untouched, and so is a finished answer.
			expect(answerMarkdown("Lane: Ezreal Q missed: E in.\nThreat: Qiyana", 100, tagged, true).split("\n")[0]).toContain("[warning:Ezreal Q missed]");
			expect(answerMarkdown("Win: Split push after lane.", 100, tagged)).toContain("Split push after lane.");
			// Prose streams as it always did once its second word is in.
			expect(streamed("Draven mid changes")).toBe("  Draven mid changes");
		});

		test("a long row wraps under its own text, never under the label, and never past the pane", () => {
			const row = "Threat: Kha'Zix unseen: stay near minions; save E for his leap, avoid isolated river paths.";
			for (const width of [30, 50, 70]) {
				const rows = answerRows(row, width);
				expect(rows.length).toBeGreaterThan(1);
				for (const line of rows) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				for (const line of rows.slice(1)) expect(/^ {12}\S/.test(line)).toBe(true);
			}
		});

		test("prose starts at the label column and wraps there, a blank line between paragraphs", () => {
			const prose = "Draven mid changes the plan: give up early CS rather than eat repeated autos. Hold the wave near your side.\n\nUntil then, farm safely.";
			const rows = answerRows(prose, 60);
			expect(rows.at(-2)).toBe("");
			expect(rows.at(-1)).toBe("   Until then, farm safely.");
			expect(rows.length).toBeGreaterThan(3);
			for (const line of rows.filter(Boolean)) {
				expect(/^ {3}\S/.test(line)).toBe(true);
				expect(visibleWidth(line)).toBeLessThanOrEqual(60);
			}
		});

		test("bold and italics the model wrote draw in a row and in prose", () => {
			expect(answerRows("Kill: Level 3: **all-in** after Q; *until then, farm.*", 100, emphasisTheme)).toEqual(["   KILL     Level 3  <b>all-in</b> after Q; <i>until then, farm.</i>"]);
			expect(answerRows("Hold the wave: **give up early CS**.", 100, emphasisTheme)).toEqual(["   Hold the wave: <b>give up early CS</b>."]);
			// A label the model wrote in bold is still the row's label.
			expect(answerRows("**Keep:** your farm to 15.", 100, emphasisTheme)).toEqual(["   <b>KEEP</b>     your farm to 15.".replace(/<\/?b>/g, "")]);
		});

		test("build-format lines stay text, and lists and code keep their own shape", () => {
			expect(answerRows("Runes: Electrocute, Legend: Alacrity; Flash", 100)).toEqual(["   Runes: Electrocute, Legend: Alacrity; Flash"]);
			expect(answerMarkdown("- one\n- two", 100, theme)).toBe("- one\n- two");
			expect(answerMarkdown("```\nLane: a: b\n```", 100, theme)).toBe("```\nLane: a: b\n```");
			expect(answerMarkdown("", 100, theme)).toBe("");
		});
	});

	test("print mode's answer loses its emphasis marks and nothing else: no Markdown draws there, so the asterisks would show", () => {
		expect(withoutEmphasis("Kill: Level 3: **all-in** after Q; *until then, farm.*")).toBe("Kill: Level 3: all-in after Q; until then, farm.");
		expect(withoutEmphasis("**Keep:** your farm to 15.\n**Next game:** back at 1300 gold.")).toBe("Keep: your farm to 15.\nNext game: back at 1300 gold.");
		// An asterisk that is not emphasis stays: a list bullet, a product, a footnote mark.
		for (const kept of ["* one\n* two", "2 * 3 * 4 damage", "Q*W and E*R", "ranked* only"]) expect(withoutEmphasis(kept)).toBe(kept);
	});

	test("the player's line is quoted line by line, so Pi draws a bar where it used to paint a band", () => {
		expect(quoteUserText("/matchup Ahri")).toBe("> /matchup Ahri");
		expect(quoteUserText("one\n\ntwo")).toBe("> one\n>\n> two");
		expect(quoteUserText("")).toBe("");
		// A line that already starts with a quote marker (up to three spaces in) would nest; a zero-width space keeps it text. Four spaces is code, not a quote.
		expect(quoteUserText("> why")).toBe("> \u200b> why");
		expect(quoteUserText("intro\n  >> deep")).toBe("> intro\n> \u200b  >> deep");
		expect(quoteUserText("    > code")).toBe(">     > code");
		const rows = new Markdown(quoteUserText("/matchup Ahri"), 1, 0, markdownTheme, undefined, {}).render(60).map((line) => line.trimEnd());
		expect(rows).toEqual([" [bar:│ ]/matchup Ahri"]);
	});
});

describe("a newline in model or search text never reaches the terminal inside one line", () => {
	const messy = "first line\nsecond line\r\nthird";
	const noNewline = (lines: string[]) => lines.forEach((line) => expect(line).not.toMatch(/[\r\n]/));

	test("an expanded strategy_frame card", () => {
		const response = reply("strategy_frame", { goal: messy, claims: [{ claim: messy, route: "grounded", source: "web-1" }, { claim: messy, route: "contradicted", contradictedBy: "web-1" }], judgment: { status: "judged", checked: 2, latencyMs: 90 } }, [["web-1", messy]]);
		for (const detail of ["brief", "claims", "full"] as const) noNewline(createToolResult(theme, "voxren_strategy_frame", {}, { response }, true, undefined, undefined, detail).render(120));
	});

	test("an expanded web_search card with a Jev screen and a title with a newline", () => {
		const removed = { domain: "example.net", title: messy, route: "withheld", p: { relevant: 0.9, support: 0.5, injection: 0.97 } };
		const response = reply("research_web_search", { provider: "hosted", results: [{ route: "evidence", snippet: messy, p: { relevant: 0.95, support: 0.9, injection: 0.02 } }], judgment: { status: "judged", model: "jev-1.13.0", answer: "evidence", answerP: { relevant: 0.9, support: 0.9, injection: 0.02 }, kept: 1, removed: [removed], latencyMs: 120 } }, [["web-1", messy]]);
		for (const detail of ["brief", "claims", "full"] as const) noNewline(createToolResult(theme, "web_search", { query: "q" }, { response }, true, undefined, undefined, detail).render(120));
	});
});

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("cutting text on grapheme boundaries", () => {
	test("a search query cut inside an emoji drops the emoji whole", () => {
		const row = toolCallLines(theme, "web_search", { query: `${"x".repeat(55)}😀 tail words here` }).map(plain).join("\n");
		expect(LONE_SURROGATE.test(row)).toBe(false);
		expect(row).toContain(`"${"x".repeat(55)}…"`);
	});

	test("every cut point of mixed strings is a whole-grapheme prefix within the limit", () => {
		const segs = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
		const spaced = ["ab cd", "日本語 テスト", "한국어 문장", "😀", "👍🏽", "👨‍👩‍👧‍👦", "🇯🇵🇺🇸", "e\u0301"].join(" ").repeat(2);
		const strings = [spaced, "😀👍🏽👨‍👩‍👧‍👦🇯🇵🇺🇸e\u0301".repeat(3), "日本語のテキスト한국어문장".repeat(4)];
		for (const text of strings) {
			const whole = segs(text);
			for (let limit = 0; limit <= text.length + 2; limit++) {
				const cut = cutAtWord(text, limit);
				expect(LONE_SURROGATE.test(cut)).toBe(false);
				expect(cut.length).toBeLessThanOrEqual(limit);
				expect(visibleWidth(cut)).toBeLessThanOrEqual(limit * 2);
				const parts = segs(cut);
				expect(parts).toEqual(whole.slice(0, parts.length));
			}
		}
	});
});

describe("panel status line", () => {
	const check = (routes: string[], status = "judged") => ({ role: "toolResult", toolName: "voxren_strategy_frame", details: { response: { evidence: [], data: { claims: routes.map((route) => ({ route })), judgment: { status } } } } });
	const route = { model: "gpt-6-luna", thinking: "low", source: "command", command: "draft", tier: "quick" };
	test("names the route and how many of the check's claims were grounded", () => {
		const line = panelStatus(route, [check(["grounded", "grounded", "grounded", "grounded"])]);
		expect(line).toContain("/draft");
		expect(line).toContain("gpt-6-luna");
		expect(line).toContain("✓ 4/4 grounded");
	});
	test("a check that was not judged says so", () => {
		expect(panelStatus(route, [check(["grounded"], "skipped")])).toContain("not checked");
	});
	test("no route and no check is no line", () => {
		expect(panelStatus(undefined, [])).toBe("");
	});
});
