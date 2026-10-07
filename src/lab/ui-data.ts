/**
 * The made-up data every UI lab draws from, in one place: the fake /matchup turn (card-demo.ts and the UI catalogue), the
 * /flow session (tree-demo.ts and the catalogue), the BUILD strip samples (strip-preview.ts and the catalogue), and the
 * theme loader. Names and numbers here are invented; none of it is coaching advice and no real Riot ID appears.
 */
import { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RESEARCH_CONTRACT_VERSION, type GatewayResponse, type VoxrenToolName } from "../contracts";
import { createTreeStats } from "../command-tree";
import { CHART_SCENARIOS } from "./chart-scenarios.ts";

const THEMES_DIR = fileURLToPath(new URL("../../themes/", import.meta.url));
/** Every theme file in themes/, by name. */
export const themeNames = (): string[] => readdirSync(THEMES_DIR).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort();

/** Pi's own Theme class on a theme file of the coach: the escape codes are the ones the real screen gets. */
export function loadTheme(name: string): Theme {
	const colors: Record<string, string | number> = JSON.parse(readFileSync(`${THEMES_DIR}${name}.json`, "utf8")).colors;
	const backgrounds = ["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"];
	const pick = (wanted: boolean) => Object.fromEntries(Object.entries(colors).filter(([key]) => backgrounds.includes(key) === wanted)) as any;
	return new Theme(pick(false), pick(true), "truecolor");
}

export const markdownThemeFor = (theme: Theme): MarkdownTheme => ({
	heading: (text) => theme.fg("mdHeading", text),
	link: (text) => theme.fg("mdLink", text),
	linkUrl: (text) => theme.fg("mdLinkUrl", text),
	code: (text) => theme.fg("mdCode", text),
	codeBlock: (text) => theme.fg("mdCodeBlock", text),
	codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
	quote: (text) => theme.fg("mdQuote", text),
	quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
	hr: (text) => theme.fg("mdHr", text),
	listBullet: (text) => theme.fg("mdListBullet", text),
	bold: (text) => theme.bold(text),
	italic: (text) => theme.italic(text),
	strikethrough: (text) => theme.strikethrough(text),
	underline: (text) => theme.underline(text),
});

// --- the fake turn ----------------------------------------------------------

export const reply = (operation: GatewayResponse["operation"], data: Record<string, unknown>, evidence: Array<[id: string, title: string]> = []): GatewayResponse => ({
	version: RESEARCH_CONTRACT_VERSION,
	operation,
	data,
	evidence: evidence.map(([id, title]) => ({ id, source: "web_search", title, url: `https://example.invalid/${id}`, retrievedAt: "2026-10-01T12:00:00.000Z" })),
});


/** What a keyed session's judgment carries: the model that judged, and its time. */
export const judged = { status: "judged", judge: "jev", model: "jev-1.13.0" };

export interface Call {
	name: VoxrenToolName;
	args: Record<string, unknown>;
	response: GatewayResponse;
	/** Draws the card as Ctrl+O does, at the level --detail names (the claims level unless it says full). */
	expanded?: boolean;
	/** Milliseconds into the turn when the call starts, and how long it takes. */
	at: number;
	takes: number;
}

/**
 * The fake turn's calls. The first four are one batch: the model dispatches them together and they finish in their own time.
 * `keyless` draws them as a session with no judge key sees them, `unread` adds a check that cites a source the judge never read.
 */
export function cardCalls(keyless: boolean, unread = false): Call[] {
	/** A result's `judgment` key, with the per-passage scores the judge also writes into the rows: absent in a keyless session, where nothing screened or checked it. */
	const judgedBy = (judgment: Record<string, unknown>, scores: Record<string, unknown> = {}) => (keyless ? {} : { ...scores, judgment });

	/** A video's quoted parts: more than the claims level quotes, and the first longer than the 200 characters it allows a part. */
	const quotes = [
		{ at: 185, text: Array.from({ length: 4 }, () => "Hold E for charm, then step in once and leave before her return damage lands.").join(" ") },
		{ at: 610, text: "All in at six." },
		{ at: 905, text: "Back off when her charm is up." },
		{ at: 1210, text: "Ward the river at three." },
	];

	/** A result row as the judge leaves it: the route and the scores are its own, so a keyless session's rows carry neither. */
	const scored = <Row extends object>(row: Row, route: string, p: Record<string, number>) => (keyless ? row : { ...row, route, p });

	const claims = [
		...Array.from({ length: 7 }, (_, index) => ({ claim: `Sample claim ${index + 1}`, route: "grounded", source: "web-1", p: { supported: 0.9, contradicted: 0.03 }, sourceP: { "web-1": 0.85 } })),
		{ claim: "A Katarina guide describes taking the rocketbelt first against Ahri, which the lane data does not support", route: "contradicted", p: { supported: 0.12, contradicted: 0.97 }, contradictedBy: "guide-2" },
	];


	/** The first four are one batch: the model dispatches them together and they finish in their own time. */
	const CALLS: Call[] = [
		{ name: "voxren_meta_research", args: { query_type: "matchup", champion: "Katarina", opponent: "Ahri", position: "middle" }, response: reply("meta.matchup", { provider: "OP.GG", sample: "Emerald+ · ranked", staleness: "patch 26.19", laneAdvantage: "even", soloKillAdvantage: "+3%", playStyle: "burst", patch: "26.19", tip: "Close in while her Q is down.", notes: { rows: Array.from({ length: 6 }, () => ({ kind: "dodge", text: "Hold E for her charm.", authors: 2 })), source: "6 matchup notes by 3 authors", built: "2026-09-20" }, ...judgedBy({ ...judged, kept: 1, removed: [], answer: "evidence", p: { relevant: 0.93, support: 0.8, injection: 0.02 }, latencyMs: 90 }) }, [["matchup-1", "OP.GG matchup: Katarina vs Ahri mid"]]), at: 1300, takes: 2700 },
		{ name: "web_search", args: { query: "katarina vs ahri mid lane matchup" }, response: reply("research_web_search", { provider: "hosted search", ...judgedBy({ ...judged, kept: 3, removed: [{ domain: "example.net", title: "Sample guide that tells the reader what to do", route: "withheld", p: { relevant: 0.9, support: 0.5, injection: 0.97 } }], answer: "evidence", answerP: { relevant: 0.92, support: 0.88, injection: 0.02 }, latencyMs: 410 }, { results: [{ route: "evidence", p: { relevant: 0.95, support: 0.9, injection: 0.02 } }, { route: "evidence", p: { relevant: 0.8, support: 0.7, injection: 0.03 } }, { route: "weak", p: { relevant: 0.9, support: 0.3, injection: 0.01 } }] }) }, [["web-1", "Sample result one"], ["web-2", "Sample result two"], ["web-3", "Sample result three"]]), at: 1300, takes: 1300 },
		{ name: "voxren_video_research", args: { query: "katarina vs ahri matchup guide" }, response: reply("research_video", { provider: "YouTube transcripts", videos: [scored({ title: "Sample video one", published: "2 months ago", autoCaptions: true, passages: quotes }, "evidence", { relevant: 0.9, support: 0.8, injection: 0.01 }), scored({ title: "Sample video two", published: "3 weeks ago", autoCaptions: false, passages: [{ at: 0, text: "Charm when she lands." }] }, "weak", { relevant: 0.85, support: 0.4, injection: 0.02 })], ...judgedBy({ ...judged, kept: 2, removed: [], latencyMs: 380 }) }, [["video-1", "Sample video one"], ["video-2", "Sample video two"]]), at: 1300, takes: 2100 },
		{ name: "voxren_game_facts", args: { entities: [{ kind: "champion", name: "Katarina" }, { kind: "champion", name: "Ahri" }], detail: "compact" }, response: reply("gamedata.lookup", { patch: "26.19" }), at: 1300, takes: 700 },
		{ name: "voxren_strategy_frame", args: { question: "How do I play it?", claims: claims.map((entry) => entry.claim), evidence: [{ id: "web-1" }] }, response: reply("strategy_frame", { goal: "Play the lane", claims: keyless ? claims.map(({ claim }) => ({ claim, route: "not_judged" })) : claims, sources: [{ id: "web-1", title: "Sample result one" }, { id: "guide-2", title: "Sample matchup guide" }], ...judgedBy({ ...judged, checked: claims.length, latencyMs: 520 }) }), at: 5200, takes: 700 },
	];

	if (keyless) {
		CALLS.push(
			{ name: "web_search", args: { query: "ahri katarina level 3 trade" }, response: reply("research_web_search", { judgment: { status: "unavailable", judge: "jev", model: "jev-latest", reason: "timeout", latencyMs: 3000 } }, [["web-4", "Sample result four"], ["web-5", "Sample result five"]]), at: 1300, takes: 3400 },
		);
	}

	if (unread) {
		CALLS.push(
			{
				name: "voxren_strategy_frame",
				args: { question: "When do I trade?", claims: ["Sample claim 1", "Sample claim 2"], evidence: [{ id: "web-4" }, { id: "game-1" }] },
				response: reply("strategy_frame", {
					goal: "Trade on cooldown",
					claims: [
						{ claim: "Sample claim 1", route: "grounded", source: "game-1", p: { supported: 0.91, contradicted: 0.03 }, sourceP: { "game-1": 0.88 } },
						{ claim: "Sample claim 2", route: "unsupported", p: { supported: 0.2, contradicted: 0.04 } },
					],
					sources: [{ id: "web-4", title: "Sample result four", unread: true }, { id: "game-1", title: "Sample champion facts" }],
					judgment: { ...judged, checked: 2, latencyMs: 480 },
				}),
				expanded: true,
				at: 5200,
				takes: 700,
			},
		);
	}

	return CALLS;
}

// --- the other cards --------------------------------------------------------

/** A finished audit: five made-up games with their charts' data, an item summary, and the one-trick's reference to compare with. */
export function auditResponse(): GatewayResponse {
	const scenario = CHART_SCENARIOS.find((entry) => entry.name === "five-games")!;
	const games = scenario.games.map((game, index) => ({ ...game, kda: game.win ? "9/3/5" : "2/8/4", d6: index % 3, dLate: 2 + (index % 2), cs15: 120 + index * 4, dur: 24 + index * 2 }));
	return reply("player_audit", {
		analyzed: games.length,
		requested: games.length,
		patches: ["26.19"],
		summary: { games: games.length, wins: 2, avgKills: 6.2, avgDeaths: 5.4, avgAssists: 7, avgDeathsAfter15: 2.5, avgGoldDiffAt15: -80, avgCsAt15: 128, medianItemTimingMin: scenario.timings!.mine, itemPurchaseCount: scenario.timings!.counts },
		games,
		reference: { itemTimingMin: scenario.timings!.reference, matchups: [] },
	});
}

/** A finished one-trick lookup: two games of a made-up player and what recurs across them. */
export function otpResponse(): GatewayResponse {
	const top = (...values: Array<[string, number]>) => values.map(([value, count]) => ({ value, count }));
	return reply("otp_build", {
		cluster: "kr",
		record: "1-1",
		patches: ["26.19"],
		analyzed: 2,
		requested: 2,
		games: [
			{ win: true, vs: "Ahri", kda: "11/2/6", runes: { keystone: "Electrocute", primary: "Domination", secondary: "Inspiration" }, items: ["Hextech Rocketbelt", "Sorcerer's Shoes", "Zhonya's Hourglass"] },
			{ win: false, vs: "Syndra", kda: "4/7/3", runes: { keystone: "Electrocute", primary: "Domination", secondary: "Sorcery" }, items: ["Hextech Rocketbelt", "Void Staff"] },
		],
		recurring: { primaryRunes: top(["Electrocute", 2], ["Sudden Impact", 2]), secondaryRunes: top(["Cosmic Insight", 1]), shards: top(["Adaptive Force", 2]), firstThreeItems: top(["Doran's Ring", 2]), skillMax: top(["Q > W > E", 2]) },
	});
}

/** A check where one source states a claim and another argues back: disputed, not contradicted. */
export function disputedFrame(): { args: Record<string, unknown>; response: GatewayResponse; takes: number } {
	const claims = [
		{ claim: "Sample claim 1", route: "grounded", source: "web-1", p: { supported: 0.9, contradicted: 0.03 }, sourceP: { "web-1": 0.85 } },
		{ claim: "Take the rocketbelt first against Ahri", route: "disputed", source: "web-2", contradictedBy: "video-1", p: { supported: 0.74, contradicted: 0.68 }, sourceP: { "web-2": 0.8, "video-1": 0.7 } },
	];
	return {
		args: { question: "What do I buy first?", claims: claims.map((entry) => entry.claim), evidence: [{ id: "web-2" }, { id: "video-1" }] },
		response: reply("strategy_frame", { goal: "Pick the first item", claims, sources: [{ id: "web-2", title: "Sample guide" }, { id: "video-1", title: "Sample video one" }], judgment: { ...judged, checked: 2, latencyMs: 510 } }),
		takes: 800,
	};
}

/** A frame with two unsupported claims, one grounded: the collapsed card names both (#219). */
export function unsupportedFrame(): { args: Record<string, unknown>; response: GatewayResponse; takes: number } {
	const claims = [
		{ claim: "Sample claim 1", route: "grounded", source: "web-1", p: { supported: 0.9, contradicted: 0.03 }, sourceP: { "web-1": 0.85 } },
		{ claim: "Ahri's charm has a 3 second cooldown at level 9", route: "unsupported", p: { supported: 0.1, contradicted: 0.05 }, sourceP: {} },
		{ claim: "Take the rocketbelt first against Ahri", route: "unsupported", p: { supported: 0.2, contradicted: 0.1 }, sourceP: {} },
	];
	return {
		args: { question: "What do I buy first?", claims: claims.map((entry) => entry.claim), evidence: [{ id: "web-1" }] },
		response: reply("strategy_frame", { goal: "Pick the first item", claims, sources: [{ id: "web-1", title: "Sample guide" }], judgment: { ...judged, checked: 3, latencyMs: 510 } }),
		takes: 800,
	};
}

export const rememberResponse = (): GatewayResponse => reply("remember", { riotId: "Sample#0001" });

/** One finished call per tool, keyed by name, so a new tool without a fixture fails the type check. */
export function toolSamples(): Record<VoxrenToolName, { args: Record<string, unknown>; response: GatewayResponse; takes: number }> {
	const calls = cardCalls(false);
	const of = (name: VoxrenToolName) => calls.find((call) => call.name === name)!;
	const from = (name: VoxrenToolName) => ({ args: of(name).args, response: of(name).response, takes: of(name).takes });
	return {
		web_search: from("web_search"),
		voxren_video_research: from("voxren_video_research"),
		voxren_game_facts: from("voxren_game_facts"),
		voxren_meta_research: from("voxren_meta_research"),
		voxren_strategy_frame: from("voxren_strategy_frame"),
		voxren_player_audit: { args: { count: 5 }, response: auditResponse(), takes: 6200 },
		voxren_otp_build: { args: { player: "Sample#0001" }, response: otpResponse(), takes: 3100 },
		voxren_remember: { args: { text: "hold your dash for hers" }, response: rememberResponse(), takes: 40 },
		voxren_command_frame: { args: { command: "build" }, response: reply("command_frame", { command: "build", frame: "Build call for the sample champion." }), takes: 80 },
	};
}

/** The made-up /flow session: two /matchup runs, one /review, a /comp with a failed search, and a meta call open right now. */
export function madeUpFlow() {
	let clock = 0;
	const stats = createTreeStats({ now: () => clock });
	const call = (id: string, name: string, ms: number, ok = true) => {
		stats.toolStart({ toolCallId: id, toolName: name });
		clock += ms;
		stats.toolEnd({ toolCallId: id, isError: !ok });
		return { name, args: {}, ms, ok, result: undefined };
	};
	stats.turnStart("matchup");
	let tools = [call("1", "voxren_meta_research", 1800), call("2", "web_search", 2900), call("3", "voxren_video_research", 4100), call("4", "voxren_strategy_frame", 600)];
	stats.run({ command: "matchup", ms: 24_000, tools });
	stats.turnStart("matchup");
	tools = [call("5", "voxren_meta_research", 1500), call("6", "voxren_strategy_frame", 700)];
	stats.run({ command: "matchup", ms: 11_000, tools });
	stats.turnStart("review");
	tools = [call("7", "voxren_player_audit", 6200)];
	stats.run({ command: "review", ms: 41_000, tools });
	stats.turnStart("comp");
	tools = [call("8", "voxren_meta_research", 1600), call("9", "voxren_game_facts", 400), call("10", "web_search", 9000, false), call("11", "voxren_strategy_frame", 500)];
	stats.run({ command: "comp", ms: 33_000, tools });
	stats.turnStart("draft");
	stats.toolStart({ toolCallId: "12", toolName: "voxren_meta_research" });
	const opened = clock;
	return { stats, opened, setClock: (to: number) => void (clock = to) };
}

export interface Sample {
	title: string;
	markdown: string;
	/** Names the turn's data never mentioned, for the own-pick row. */
	ownPicks?: string[];
}

/** Three real answers from this project's sessions: a lane matchup, a bot-lane matchup, and a jungler. */
export const SAMPLES: Sample[] = [
	{
		title: "Fizz vs Lux mid",
		markdown: [
			"Lane: Lux Q/E down: E in, burst, then disengage before her spells return.",
			"Runes: Electrocute, Sudden Impact, Grisly Mementos, Treasure Hunter; Transcendence, Scorch; Adaptive Force, Adaptive Force, Health; Flash, Ignite",
			"Build: Doran's Ring + 2 Health Potions → Lich Bane → Sorcerer's Shoes → Zhonya's Hourglass → Shadowflame",
			"Swap: Zhonya's Hourglass before Shadowflame, into Corki and Naafiri burst",
		].join("\n"),
	},
	{
		title: "Katarina bot vs Corki",
		markdown: [
			"Runes: Conqueror, Triumph, Legend: Alacrity, Coup de Grace; Relentless Hunter, Sudden Impact; Adaptive Force, Adaptive Force, Health; Flash, Ignite",
			"Build: Doran's Blade + Health Potion → Kraken Slayer → Gluttonous Greaves → Blade of The Ruined King → Terminus",
			"Skills: Q, E, W, then max Q > E > W",
			"Swap: Plated Steelcaps instead of Gluttonous Greaves, into Corki and Naafiri physical burst",
		].join("\n"),
	},
	{
		title: "A jungler",
		markdown: [
			"Runes: Press the Attack, Triumph, Legend: Alacrity, Coup de Grace; Magical Footwear, Cosmic Insight; Attack Speed, Adaptive Force, Health; Flash, Smite",
			"Build: Scorchclaw Pup + Health Potion → Dusk and Dawn → Sorcerer's Shoes → Nashor's Tooth → Zhonya's Hourglass",
		].join("\n"),
		ownPicks: ["Dusk and Dawn", "Cosmic Insight"],
	},
];


/** The strip-preview samples plus one the catalogue adds: notes after items (#203), which are not in the real answers strip-preview prints. */
export const CATALOGUE_SAMPLES: Sample[] = [
	...SAMPLES,
	{
		title: "Notes after items",
		markdown: [
			"Runes: Arcane Comet, Manaflow Band, Transcendence, Scorch; Biscuits, Cosmic Insight; Adaptive Force, Adaptive Force, Health; Flash, Teleport",
			"Build: Doran's Ring + Health Potion → Amplifying Tome (first back, at 12 min) → Sorcerer's Shoes → Lich Bane → Zhonya's Hourglass (vs burst)",
			"Skills: Q, W, E, then max Q > W > E",
		].join("\n"),
	},
];
