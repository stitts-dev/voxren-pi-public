import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { SWAP, bareItem, buildLines, isBuildFormatLine, type BuildLines } from "./build-lines";
import { COACH_COMMANDS, COACH_YAML, DEFAULT_MODEL_ID, DEFAULT_PROVIDER, type VoxrenToolName as ToolName, type GatewayResponse } from "./contracts";
import { DEBUG_COMMAND } from "./debug-handoff";
import { GROUNDING_THRESHOLDS } from "./grounding-judge";
import { PASSAGE_THRESHOLDS } from "./passage-judge";
import type { DeathScene } from "./audit-metrics";
import { type ChartGame, chartKeys, chartLines, chartedGames, goldStrip, itemTimings, markerRow, minuteAxis, sceneOffsetText, worstGame } from "./charts";
import { damageText } from "./death-damage";
import { iconLine, itemIconLine, knownNames, type IconKind } from "./icons";
import { gateSetupRows } from "./setup-swaps";
import { jevBadgeText, type JevBadgeState } from "./jev-badge";
import { lcuPlayerName, type LcuFooterState } from "./lcu";
import { ROUTE_SWITCH_P } from "./model-router";
import { normalizeTakeaway, stripTerminalControl } from "./policy";
import { fitInlineIcons, hasInlineIcon, iconRows, imageProtocol } from "./terminal-images";

/**
 * Width-aware TUI surface for Voxren Coach: startup header, footer, and tool
 * cards. Everything here is presentation only; it never touches the tool
 * boundary or the gateway.
 */

/** Minimal theme surface shared by pi's Theme and the test fake. No background: nothing the coach draws sits on a band. */
export interface UiTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface UiComponent {
	render(width: number): string[];
	invalidate(): void;
}

export const WINDOW_TITLE = "Voxren Coach";
export { SHELL_DENIED_MESSAGE } from "./contracts";
export const WORKING_MESSAGE = "Coaching…";

/** What this launch can do; built once from the environment. */
export interface SurfaceLabels {
	model: string;
	/** One line per disabled capability, saying how to enable it. */
	notes: string[];
	accounts: string[];
	/** The running build, `branch@commit`: which coach a bug report is about. */
	version?: string;
}

export function coachLabels(model: string, auditAccounts: string[], notes: string[] = []): SurfaceLabels {
	return { model, notes, accounts: auditAccounts };
}

const MIN_WIDTH = 8;

function clampWidth(width: number): number {
	return Math.max(MIN_WIDTH, Math.floor(width));
}

/** Wrap logical lines to the pane width; continuation lines keep the given indent. */
export function wrapLines(lines: string[], width: number, indent = ""): string[] {
	const safeWidth = clampWidth(width);
	const output: string[] = [];
	for (const line of lines) {
		if (line === "") {
			output.push("");
			continue;
		}
		const lead = /^ */.exec(line)![0];
		const rows = wrapTextWithAnsi(line.slice(lead.length), Math.max(1, safeWidth - Math.max(lead.length, visibleWidth(indent))));
		rows.forEach((row, index) => {
			const placed = index === 0 ? `${lead}${row}` : `${indent}${row}`;
			output.push(visibleWidth(placed) > safeWidth ? truncateToWidth(placed, safeWidth) : placed);
		});
	}
	return output;
}

function component(build: (width: number) => string[]): UiComponent {
	return { render: (width) => build(width), invalidate() {} };
}

// --- blocks -----------------------------------------------------------------

/** The line every coach block draws down its left edge; one colour per kind of block, all from the theme. */
const BAR = "│";
/** Cells a row spends before its head: the bar and the space after it. */
const EDGE_CELLS = 2;
/** Cards sit one cell in, level with the output padding Pi gives the answer and the thinking line. */
export const CARD_MARGIN = 1;
/** One level of indent for a row that belongs under a card's first row. */
const SUB_INDENT = "  ";
/** The label column of a card's first row and its data rows; `REMEMBER` is the longest name. */
const LABEL_WIDTH = 9;

/**
 * Lookups, the grounding check, the route row, and errors each own one theme colour. The thinking line (Pi's
 * thinkingText) and the player's line (Pi's mdQuoteBorder and mdQuote) have theirs in the theme files, so no two
 * kinds of block share a colour in any theme. The quiet kinds step darker: the player's line (text), thinking
 * (muted), then the route row (dim).
 */
const BLOCK_ROLE = { lookup: "accent", check: "mdLink", route: "dim", error: "error" } as const;
type BlockKind = keyof typeof BLOCK_ROLE;

/** One logical row of a block, before the bar and the wrap are added. */
export interface Row {
	/** Cells before the value: a label, a reason, or an indent. Drawn once; wrapped lines hang under the value instead. */
	head: string;
	/** The value. Wraps at the pane width, each wrapped line under the first. */
	body: string;
	/** The body was already sized to its width (a table, a chart strip): cut it, never wrap it. */
	fit?: boolean;
	/** A tool card's row: each " ·" separator in the body stays at the end of its line when the body wraps, so no line opens with a bare one. */
	glue?: boolean;
}

/** A row's text as it reads without the bar: the form the tests read. */
function flat(rows: Row[]): string[] {
	return rows.map((row) => `${row.head}${row.body}`);
}

/** A character the wrapper reads as part of a word, standing in for a separator while the text wraps: pi-tui's tokenizer files "·" (U+00B7) under Han script, so it always breaks before one and a no-break space cannot hold it. */
const SEPARATOR_STAND_IN = "\ue000";

/**
 * `text` wrapped to `room` cells with each " ·" separator joined to the word before it by a no-break space (as `tight`
 * joins a score to its label), so a wrap breaks after the separator and never before it. The separator may be coloured.
 */
function wrapGlued(text: string, room: number): string[] {
	return wrapTextWithAnsi(text.replace(/ ((?:\x1b\[[0-9;]*m)*)·/g, `\u00a0$1${SEPARATOR_STAND_IN}`), room).map((piece) => piece.replaceAll(SEPARATOR_STAND_IN, "·"));
}

/** The block's rows behind one coloured bar. A wrapped value hangs under its own first line, never under its head. */
function barLines(theme: UiTheme, role: string, rows: Row[], width: number): string[] {
	const safeWidth = clampWidth(width);
	const bar = `${theme.fg(role, BAR)} `;
	const lines: string[] = [];
	for (const row of rows) {
		const hang = " ".repeat(visibleWidth(row.head));
		const room = Math.max(1, safeWidth - EDGE_CELLS - visibleWidth(row.head));
		// A blank row keeps the bar running and carries no trailing spaces.
		if (row.body === "" && !/\S/.test(stripTerminalControl(row.head))) {
			lines.push(bar.trimEnd());
			continue;
		}
		// An inline icon's escape bytes are not cells, and pi-tui counts them as cells: such a row is sized by its builder and cut here by what it really takes.
		if (hasInlineIcon(row.body)) {
			lines.push(`${bar}${row.head}${fitInlineIcons(row.body, room)}`);
			continue;
		}
		const pieces = row.fit ? [truncateToWidth(row.body.replace(/[\r\n]+/g, " "), room, "…")] : row.glue ? wrapGlued(row.body, room) : wrapTextWithAnsi(row.body, room);
		pieces.forEach((piece, index) => lines.push(truncateToWidth(`${bar}${index === 0 ? row.head : hang}${piece}`, safeWidth, "…")));
	}
	return lines;
}

/** A block's first-row label: upper case, bold, in the block's colour, padded to the label column. */
function header(theme: UiTheme, role: string, text: string): string {
	const word = text.toUpperCase();
	return `${theme.fg(role, theme.bold(word))}${" ".repeat(Math.max(0, LABEL_WIDTH - word.length))}`;
}

/** A row under a card's first row: one level in, its head (a reason, a time) hanging before the value. */
function sub(head: string, body: string, fit = false): Row {
	return { head: `${SUB_INDENT}${head}`, body, fit };
}

// --- header -----------------------------------------------------------------

/**
 * `VOXREN COACH  player ━━━━━━━━━━━━ ◆ Jev · 3 cut` filled to `width`: the name leads its row and a heavy rule runs
 * from it, so the coach's own heading outranks the light rule of a section under it. The Jev badge ends the row
 * while the screen is on; its tally drops first, then the badge, then the rule, as room runs out.
 */
function titleRule(theme: UiTheme, labels: SurfaceLabels, width: number, lcu?: LcuFooterState, jev?: JevBadgeState): string {
	// The open client knows who is signed in (lobby, champ select, or in game); the env accounts only fill in while it is closed.
	const player = lcuPlayerName(lcu) ?? (labels.accounts.length ? labels.accounts.join(", ") : "player not set");
	const named = `${theme.bold(theme.fg("accent", "VOXREN COACH"))}  ${theme.fg("text", player)}`;
	// The build label goes first when the row is short of room: it is for a bug report, not for play.
	const versioned = labels.version ? `${named}  ${theme.fg("dim", labels.version)}` : named;
	const head = visibleWidth(versioned) + 4 <= width ? versioned : named;
	const rule = (n: number) => theme.fg("accent", "━".repeat(n));
	if (jev) {
		for (const badge of [jevBadgeText(theme, jev), jevBadgeText(theme, jev, false)]) {
			// head, space, rule, space, badge.
			const room = width - visibleWidth(head) - visibleWidth(badge) - 2;
			if (room >= 3) return `${head} ${rule(room)} ${badge}`;
		}
	}
	const room = width - visibleWidth(head) - 1;
	return room >= 3 ? `${head} ${rule(room)}` : head;
}

/**
 * Launch text earns each row: the title says who is coached, the commands say what to type,
 * and a warning appears only when something needs the player's action. A healthy key, an
 * optional screen that is off, the model (footer), and standard keys are not shown.
 */
export function headerLines(theme: UiTheme, riotKeyLine?: string, labels: SurfaceLabels = coachLabels(`${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`, []), width = 80, lcu?: LcuFooterState, jev?: JevBadgeState, marks?: ReadonlyMap<string, string>): string[] {
	const warnings = [...(riotKeyLine && /REJECTED|not stored|unavailable|untested|expire/.test(riotKeyLine) ? [riotKeyLine] : []), ...labels.notes, ...(lcu?.kind === "closed" && lcu.reason ? [`LCU: ${lcu.reason}`] : [])];
	// Same room-based degrade as the title rule, but one hint at a time: [optional] hints drop before <required> ones
	// (a required hint says what the command cannot run without), newest command first within each class.
	const clamped = clampWidth(width);
	const hinted = COACH_COMMANDS.filter((command) => command.args);
	const dropOrder = [...hinted.filter((command) => command.args!.startsWith("[")).reverse(), ...hinted.filter((command) => !command.args!.startsWith("[")).reverse()];
	// A command's live mark (×N runs this session, ● while the coach is busy on it) follows the hint, never reading as an argument.
	// /report closes the bar: the one command that is not coaching, there for the moment an answer looks wrong.
	// It outlives the optional hints and goes before any required one: a narrow bar keeps what a command cannot run without.
	// The name is what the player types, so it carries the colour; its hint steps back to dim.
	const line = (dropped: number, debug: boolean) => [...COACH_COMMANDS.map((command) => `${theme.fg("accent", `/${command.name}`)}${command.args && !dropOrder.slice(0, dropped).includes(command) ? ` ${theme.fg("dim", command.args)}` : ""}${marks?.get(command.name) ? theme.fg("accent", marks.get(command.name)!) : ""}`), ...(debug ? [theme.fg("accent", `/${DEBUG_COMMAND}`)] : [])].join("  ");
	const optional = dropOrder.filter((command) => command.args!.startsWith("[")).length;
	let dropped = 0;
	let debug = true;
	while (visibleWidth(line(dropped, debug)) > clamped && (debug || dropped < dropOrder.length)) {
		if (debug && dropped >= optional) debug = false;
		else dropped++;
	}
	return [
		"",
		titleRule(theme, labels, clampWidth(width), lcu, jev),
		line(dropped, debug),
		...warnings.map((text) => `${theme.fg("warning", "●")} ${theme.fg("warning", text)}`),
		"",
	];
}

/** `readRiotKeyLine` is re-read on every render so the header follows sanitized key state. */
export function createHeader(
	theme: UiTheme,
	readRiotKeyLine?: () => string | undefined,
	labels: SurfaceLabels = coachLabels(`${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`, []),
	readLcu?: () => LcuFooterState,
	readJev?: () => JevBadgeState | undefined,
	readMarks?: () => ReadonlyMap<string, string> | undefined,
): UiComponent {
	// Rows wrap at width minus the 3-column continuation indent; the title rule is sized to that so it never spills.
	return component((width) =>
		wrapLines(headerLines(theme, readRiotKeyLine?.(), labels, width - 3, readLcu?.(), readJev?.(), readMarks?.()).map((line) => (line ? ` ${line}` : line)), width, "   "),
	);
}

// --- footer -----------------------------------------------------------------

export interface FooterStats {
	inputTokens: number;
	outputTokens: number;
	contextPercent: number | undefined;
	contextWindow: number;
	/** Summed provider-reported cost in USD. */
	costUsd?: number;
	/** True when the provider bills a plan, not this cost (cost reads $0). */
	subscription?: boolean;
	/** Current thinking level, only when the model reasons. */
	thinking?: string;
	/** The model actually answering this turn (`ctx.model.id`); falls back to the launch label when absent. */
	model?: string;
	/** Who chose that model, from `routeWord`: jev, a command's fixed tier, jev's fallback, or the player's pin. */
	route?: string;
}

/** A decision model's name for a row, or undefined: a reply that names no model is filled with "unknown" (`SystemOneClient`), which is not a name to show. */
function knownJudge(name: unknown): string | undefined {
	return typeof name === "string" && name && name !== "unknown" ? name : undefined;
}

/** Who chose the model on the right: the decision model (named as the route row names it, `jev` when the route names none), a command's fixed tier, the fallback, or the player's pin; a half pin (model or thinking only) is named after the word. */
export function routeWord(route: { source: string; command?: string; failure?: string; by?: string; modelPinned?: boolean; thinkingPinned?: boolean } | undefined): string | undefined {
	if (!route) return undefined;
	if (route.source === "pinned") return "pinned";
	const jev = knownJudge(route.by) ?? "jev";
	const word =
		route.source === "jev" || route.source === "held" ? jev : route.source === "command" ? (route.command ? `/${route.command}` : undefined) : `${jev} ${route.failure ?? "off"}`;
	if (!word) return undefined;
	return route.modelPinned ? `${word} · model pinned` : route.thinkingPinned ? `${word} · thinking pinned` : word;
}

// --- route row ----------------------------------------------------------------

/** What `routeLines` reads: a Route from model-router plus index.ts's command name and half-pin flags. */
export interface RouteView {
	model: string;
	thinking: string;
	source: string;
	tier?: string;
	failure?: string;
	p?: number;
	ms?: number;
	/** The decision model that graded the prompt; "Jev" is the word when a route carries none. */
	by?: string;
	command?: string;
	modelPinned?: boolean;
	thinkingPinned?: boolean;
}

/** The row's spans with their colour roles; a Jev failure is the one span not dim, since it means Jev did not pick. */
function routeParts(route: RouteView): Array<[role: string, text: string]> {
	const parts: Array<[string, string]> = [];
	const by = knownJudge(route.by) ?? "Jev";
	const dim = (text: string) => parts.push(["dim", text]);
	// The model stays the current one on a held grade or a failed call; "kept" says the switch did not happen.
	const kept = !route.modelPinned && (route.source === "held" || (route.source === "fallback" && route.failure !== "off"));
	const pct = typeof route.p === "number" ? ` ${Math.round(route.p * 100)}%` : "";
	if (route.source === "pinned") dim("pinned");
	else if (route.source === "command") dim(`${route.command ? `/${route.command}` : "command"} · ${route.tier ?? "?"}`);
	else if (route.source === "fallback") parts.push(route.failure === "off" || !route.failure ? ["dim", `${by} off`] : ["warning", `${by} ${route.failure}`]);
	else dim(`${by} ${route.tier ?? "?"}${pct}`);
	dim(kept ? `kept ${route.model}` : route.model);
	dim(route.thinking);
	if (typeof route.ms === "number") dim(`${Math.round(route.ms)} ms`); // no-break space: the number never wraps away from its unit
	// A held grade names why: below the switch bar, or (at or above it) a model Pi could not switch to.
	if (route.source === "held") dim(typeof route.p === "number" && route.p < ROUTE_SWITCH_P ? `held: below ${Math.round(ROUTE_SWITCH_P * 100)}%` : "held: model unavailable");
	if (route.source !== "pinned" && route.modelPinned) dim("model pinned");
	else if (route.source !== "pinned" && route.thinkingPinned) dim("thinking pinned");
	return parts.map(([role, text]) => [role, stripTerminalControl(text)]);
}

const ROUTE_LABEL = "route".padEnd(LABEL_WIDTH);

/** One plain line for a turn's route: the chat message's content, so the session file reads without a renderer. */
export function routeText(route: RouteView): string {
	return `${ROUTE_LABEL}${routeParts(route)
		.map(([, text]) => text)
		.join(" · ")}`;
}

/**
 * The panel's status line: the turn's route, then how many of the check's claims were grounded ("✓ 4/4 grounded"), or
 * "not checked" when the check ran unjudged. Empty with neither. `messages` are the turn's, as agent_end gives them.
 */
export function panelStatus(route: RouteView | undefined, messages: any[]): string {
	const parts = route ? routeParts(route).map(([, text]) => text) : [];
	const frame = [...messages].reverse().find((message) => message?.role === "toolResult" && message.toolName === "voxren_strategy_frame")?.details?.response?.data;
	if (frame) {
		const claims: any[] = Array.isArray(frame.claims) ? frame.claims : [];
		const judged = frame.judgment?.status === "judged";
		parts.push(judged ? `✓ ${claims.filter((entry) => entry?.route === "grounded").length}/${claims.length} grounded` : "not checked");
	}
	return parts.join(" · ");
}

/** The chat row between the player's prompt and the answer: who picked the model, which model, what thinking, and Jev's confidence and time. The grader's name tells the player whether to pin a model when it is not the one the 70% bar was fit to. */
export function routeLines(theme: UiTheme, route: RouteView, width: number): string[] {
	const body = routeParts(route)
		.map(([role, text]) => theme.fg(role, text))
		.join(theme.fg("dim", " · "));
	return barLines(theme, BLOCK_ROLE.route, [{ head: header(theme, BLOCK_ROLE.route, "route"), body }], width);
}

/** The chat row as a component, indented by Pi's output pad so it lines up with the answer. */
export function createRouteRow(theme: UiTheme, route: RouteView, pad = 0): UiComponent {
	const indent = " ".repeat(Math.max(0, pad));
	return component((width) => routeLines(theme, route, width - indent.length).map((line) => `${indent}${line}`));
}

/** The line under the red row Pi paints for an automatic call a typed turn stopped (#383): the player did nothing wrong, their own turn took its place. */
const AUTO_STOPPED_LINE = "auto call stopped for your turn";

/** That line as a component: dim, one cell in like the cards, cut to the pane. */
export function createAutoStoppedLine(theme: UiTheme): UiComponent {
	return createDimLine(theme, AUTO_STOPPED_LINE);
}

/** One quiet line under an answer (the /report hint, the feedback prompt): dim, under the card margin, cut to the pane. */
export function createDimLine(theme: UiTheme, text: string): UiComponent {
	const indent = " ".repeat(CARD_MARGIN);
	return component((width) => [`${indent}${truncateToWidth(theme.fg("dim", text), Math.max(1, width - indent.length), "…")}`]);
}

/** The what's-new note (src/update.ts): its first line, the build, in the accent colour, each commit dim under it, cut to the pane. */
export function createWhatsNew(theme: UiTheme, text: string): UiComponent {
	const indent = " ".repeat(CARD_MARGIN);
	return component((width) => text.split("\n").map((line, index) => `${indent}${truncateToWidth(theme.fg(index ? "dim" : "accent", line), Math.max(1, width - indent.length), "…")}`));
}

// --- build strip ------------------------------------------------------------
// Parsing (BuildLines, buildLines, withoutBuildLines, buildIconNames) lives in build-lines.ts; this is rendering only.

/** A name as its icon alone, `rows` tall, when one is cached and this terminal draws it, else its text; a counted step ("2 Health Potions") draws the single item's icon with its count. */
export function chip(name: string, kinds: IconKind[], rows = 1): { shown: string; width: number; icon?: true } {
	const bare = bareItem(name);
	const icon = iconLine(bare, kinds, rows) ?? iconLine(bare.replace(/s$/, ""), kinds, rows);
	if (!icon) return { shown: name, width: visibleWidth(name) };
	const count = /^(\d+)\s/.exec(name)?.[1];
	return count ? { shown: `${icon.sequence}×${count}`, width: icon.columns + 1 + count.length, icon: true } : { shown: icon.sequence, width: icon.columns, icon: true };
}

/** Pieces packed into rows of `room` cells, never split inside a piece; a continuation row opens with `lead`. */
export function packPieces(pieces: Array<{ shown: string; width: number }>, separator: string, room: number, lead = ""): string[] {
	const gap = visibleWidth(separator);
	const rows: string[] = [];
	let row = "";
	let used = 0;
	for (const piece of pieces) {
		if (row && used + gap + piece.width > room) {
			rows.push(row);
			row = `${lead}${piece.shown}`;
			used = visibleWidth(lead) + piece.width;
		} else {
			row = row ? `${row}${separator}${piece.shown}` : piece.shown;
			used += (used ? gap : 0) + piece.width;
		}
	}
	if (row) rows.push(row);
	return rows;
}

/** A swap's pieces for `packPieces`: a name and its icon never split, and the words around them wrap one by one. */
function swapPieces(swap: string): Array<{ shown: string; width: number }> {
	const words = (text: string) => text.split(" ").filter(Boolean).map((word) => ({ shown: word, width: visibleWidth(word) }));
	const match = SWAP.exec(swap);
	if (!match) return words(swap);
	const [, first, how, second, rest = ""] = match;
	const kinds: IconKind[] = ["item", "rune", "summoner"];
	const secondChip = chip(second, kinds);
	const comma = rest ? "," : "";
	return [chip(first, kinds), ...words(how), { shown: `${secondChip.shown}${comma}`, width: secondChip.width + comma.length }, ...words(rest.replace(/^,\s*/, ""))];
}

/**
 * The runes, items, skills, and swaps as one card: icons where the terminal draws them, the names always. `ownPicks` are
 * names no data this turn mentioned (build-lines.ts unsourcedBuildNames), named in a last row so the player can weigh them.
 */
export function buildStripLines(theme: UiTheme, lines: BuildLines, width: number, ownPicks: readonly string[] = []): string[] {
	const role = BLOCK_ROLE.lookup;
	// The card's title once in the label column; the icons and the skill order name themselves, so only the path (arrows) and
	// the swaps (variants) carry a quiet label there.
	const room = Math.max(10, clampWidth(width) - EDGE_CELLS - LABEL_WIDTH);
	const dot = ` ${theme.fg("dim", "·")} `;
	// The runes and the items are the build itself, so their icons stand as tall as the terminal lets them; a swap's icons stay in its sentence.
	const tall = iconRows();
	const chips = (names: string[], kinds: IconKind[]) => names.map((name) => chip(name, kinds, tall));
	// Icons sit a space apart; a name drawn as text (no icon, or no pictures) keeps the separator that tells it from the next name.
	const joined = (parts: Array<{ shown: string; width: number; icon?: true }>, text: string) => {
		const separator = parts.every((part) => part.icon) ? " " : text;
		return { shown: parts.map((part) => part.shown).join(separator), width: parts.reduce((total, part) => total + part.width, 0) + visibleWidth(separator) * Math.max(0, parts.length - 1) };
	};
	const groups: Array<{ label: string; rows: string[]; tall?: true }> = [];
	const [primary = [], secondary = [], shards = [], spells = [], ...extra] = lines.runes;
	const pages = [chips(primary, ["rune", "summoner"]), chips(secondary, ["rune", "summoner"]), chips(shards, ["rune"]), chips(spells, ["summoner", "rune"]), ...extra.map((group) => chips(group, ["rune", "summoner"]))];
	if (imageProtocol()) {
		// Pictures: the icons carry the names, so the whole page is one row of groups (wrapping between groups), not four labelled rows.
		// An all-icon group stays whole; one with a name drawn as text splits into its names, so a narrow pane wraps it instead of cutting it.
		const page = pages.filter((group) => group.length).flatMap((group) => (group.every((part) => part.icon) ? [joined(group, dot)] : group));
		if (page.length) groups.push({ label: "", rows: packPieces(page, dot, room), tall: true });
	} else {
		const [first, second, shardChips, spellChips, ...more] = pages;
		if (first.length) groups.push({ label: "", rows: packPieces(first, dot, room) });
		if (second.length) groups.push({ label: "", rows: packPieces(second, dot, room) });
		if (shardChips.length) groups.push({ label: "", rows: packPieces(shardChips.map((part) => ({ ...part, shown: theme.fg("muted", part.shown) })), dot, room) });
		if (spellChips.length) groups.push({ label: "", rows: packPieces(spellChips, dot, room) });
		for (const group of more) if (group.length) groups.push({ label: "", rows: packPieces(group, dot, room) });
	}
	if (lines.build.length) {
		const steps = lines.build.map((step) => joined(chips(step, ["item"]), " + "));
		groups.push({ label: "items", rows: packPieces(steps, ` ${theme.fg("dim", "→")} `, room, `${theme.fg("dim", "→")} `), tall: true });
	}
	if (lines.skills) groups.push({ label: "", rows: [lines.skills] });
	// Icon rows cannot be wrapped by pi-tui, so a long swap is packed into rows here, the way the items row already is.
	for (const swap of lines.swaps) groups.push({ label: "swap", rows: packPieces(swapPieces(swap), " ", room) });
	const picks = ownPicks.map((name, index) => `${name}${index < ownPicks.length - 1 ? "," : ""}`).map((shown) => ({ shown: theme.fg("dim", shown), width: visibleWidth(shown) }));
	// The label fills the label column, so the value takes one space of its own on every row.
	if (picks.length) groups.push({ label: "unsourced", rows: packPieces(picks, " ", room - 1).map((row) => ` ${row}`) });
	const rows: Row[] = groups.flatMap((group, index) =>
		group.rows.flatMap((body, line) => {
			const head = index === 0 && line === 0 ? header(theme, role, "build") : theme.fg("dim", (line === 0 ? group.label : "").padEnd(LABEL_WIDTH));
			if (!group.tall || tall < 2 || !hasInlineIcon(body)) return [{ head, body }];
			// A tall icon stands on its row and rises above it: the label leads the rows it covers, which stay empty past it.
			return [{ head: head.trimEnd(), body: "" }, ...Array.from({ length: tall - 2 }, () => ({ head: "", body: "" })), { head: " ".repeat(LABEL_WIDTH), body }];
		}),
	);
	return barLines(theme, role, rows, width);
}

/** The build strip as a component, one cell in like the cards. Empty when the lines carry no runes or build. */
export function createBuildStrip(theme: UiTheme, source: string, ownPicks: readonly string[] = []): UiComponent {
	const lines = buildLines(source);
	const indent = " ".repeat(CARD_MARGIN);
	return component((width) => (lines ? buildStripLines(theme, lines, width - indent.length, ownPicks).map((line) => `${indent}${line}`) : []));
}

/** 272000 → 272k, 1500000 → 1.5M. */
function tokensText(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
	return String(count);
}

/** Context pressure as a coloured percent (dim under 50%, warning to 75%, error to 90%, bold error past it), with the window it is a share of. */
export function contextMeter(theme: UiTheme, percent: number | undefined, contextWindow = 0): string {
	const pct = percent ?? 0;
	const text = `ctx ${percent === undefined ? "?" : `${percent.toFixed(1)}%`}${contextWindow > 0 ? ` of ${tokensText(contextWindow)}` : ""}`;
	if (pct >= 90) return theme.bold(theme.fg("error", text));
	return theme.fg(pct >= 75 ? "error" : pct >= 50 ? "warning" : "dim", text);
}

/** Widening the terminal never adds a new fact, only spells out the same ones (rank tier/LP written out, "this season" added). */
const LCU_WIDE_WIDTH = 120;

function titleCase(word: string): string {
	return word ? `${word[0]}${word.slice(1).toLowerCase()}` : word;
}

/** `m:ss`, floored/rounded to whole seconds — same shape whether the source is a countdown (champ select) or a clock (in game). */
function formatClock(totalSeconds: number): string {
	const seconds = Math.max(0, Math.round(totalSeconds));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Last ranked results as `W L W W L`, green wins and red losses, newest first; empty when there is no history. */
export function recentResultsStrip(theme: UiTheme, recent: boolean[]): string {
	return recent.map((win) => theme.fg(win ? "success" : "error", win ? "W" : "L")).join(" ");
}

/** One row per state: closed → nothing; lobby → recent form + rank; champ select → phase/role/progress; in game → live KDA. */
export function lcuFooterLine(theme: UiTheme, state: LcuFooterState, width: number): string | undefined {
	const wide = width >= LCU_WIDE_WIDTH;
	if (state.kind === "lobby") {
		const { summoner, rank, recent } = state;
		const name = `${summoner.gameName}#${summoner.tagLine}`;
		const form = recent.length ? `${recentResultsStrip(theme, recent)}  ` : "";
		return wide
			? `${form}${name} · ${titleCase(rank.tier)} ${rank.division} · ${rank.leaguePoints} LP · ${rank.wins}W-${rank.losses}L this season`
			: `${form}${name} · ${rank.tier} ${rank.division} ${rank.leaguePoints}LP · ${rank.wins}W-${rank.losses}L`;
	}
	if (state.kind === "champSelect") {
		const parts = [`champ select`, `${formatClock(state.secondsLeft)} left${wide ? " in current phase" : ""}`];
		if (state.selfPosition) parts.push(`you ${state.selfPosition.toUpperCase()}`);
		parts.push(`picks ${state.picksMade}/${state.picksTotal}`);
		if (wide && state.bansTotal > 0) parts.push(`bans ${state.bansMade}/${state.bansTotal}`);
		return parts.join(" · ");
	}
	if (state.kind === "liveGame") {
		if (!state.self) return undefined; // self not found in the roster yet — nothing honest to show
		const { championName, position, kills, deaths, assists, creepScore, level } = state.self;
		const parts = [`in game ${formatClock(state.gameTimeSec)}`, `${championName}${position ? ` ${position.toUpperCase()}` : ""} ${kills}/${deaths}/${assists}`];
		if (wide) parts.push(`cs ${creepScore}`, `lvl ${level}`);
		return parts.join(" · ");
	}
	return undefined; // closed
}

/** Cost (and whether a plan pays it), context share of the window; the model and its thinking level on the right. Plus one conditional LCU row below. */
export function footerLines(
	theme: UiTheme,
	stats: FooterStats,
	width: number,
	labels: SurfaceLabels = coachLabels(`${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`, []),
	lcu?: LcuFooterState,
): string[] {
	const safeWidth = clampWidth(width);
	const cost = `$${(stats.costUsd ?? 0).toFixed(3)}${stats.subscription ? " sub" : ""}`;
	const left = `${theme.fg("warning", cost)} ${theme.fg("dim", "·")} ${contextMeter(theme, stats.contextPercent, stats.contextWindow)}`;
	const modelId = stats.model ?? labels.model;
	const model = theme.fg("dim", `${modelId.split("/").pop() ?? modelId}${stats.thinking ? ` · thinking ${stats.thinking}` : ""}${stats.route ? ` · ${stats.route}` : ""}`);
	const base =
		visibleWidth(left) + 2 + visibleWidth(model) <= safeWidth
			? [`${left}${" ".repeat(safeWidth - visibleWidth(left) - visibleWidth(model))}${model}`]
			: [left, model].map((line) => truncateToWidth(line, safeWidth));
	const lcuLine = lcu && lcuFooterLine(theme, lcu, safeWidth);
	return lcuLine ? [...base, truncateToWidth(lcuLine, safeWidth)] : base;
}

export function createFooter(
	theme: UiTheme,
	readStats: () => FooterStats,
	labels: SurfaceLabels = coachLabels(`${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`, []),
	readLcu?: () => LcuFooterState,
): UiComponent {
	return component((width) => footerLines(theme, readStats(), width, labels, readLcu?.()));
}

// --- tool cards -------------------------------------------------------------

/** A pasted op.gg link encodes the Riot ID's space as %20; malformed encoding just keeps the raw text. */
function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/**
 * `text` cut to at most `limit` characters, on a word boundary when a space falls in the second half of the limit (the
 * cut then lands between words), else where the limit falls. The caller adds its ellipsis.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function cutAtWord(text: string, limit: number): string {
	// Keep whole graphemes only: a cut inside an emoji, flag or ZWJ sequence would leave a lone surrogate.
	let head = "";
	for (const { segment } of GRAPHEMES.segment(text)) {
		if (head.length + segment.length > limit) break;
		head += segment;
	}
	if (/\s/.test(text[head.length] ?? "")) return head.trimEnd();
	const space = head.search(/\s\S*$/);
	return (space >= limit / 2 ? head.slice(0, space) : head).trimEnd();
}

/** A search query as the card's first row shows it: the first words of a long one on a collapsed or pending card, all of it wrapped on an expanded card, so no expanded row ends in an ellipsis. */
function quotedQuery(query: string, whole: boolean): string {
	return `"${whole || query.length <= SEARCH_QUERY_CHARS ? query : `${cutAtWord(query, SEARCH_QUERY_CHARS)}…`}"`;
}

function summarizeArgs(name: ToolName, args: Record<string, unknown> | undefined, whole = false): string {
	if (!args) return "";
	switch (name) {
		case "web_search":
		case "voxren_video_research":
			// A long query wraps a collapsed card to three rows: the first words say what was searched.
			return typeof args.query === "string" ? quotedQuery(args.query, whole) : "";
		case "voxren_game_facts": {
			const entities = Array.isArray(args.entities) ? args.entities : [];
			const names = entities.map((entity: any) => (entity && typeof entity.name === "string" ? entity.name : "?"));
			return names.length ? names.join(", ") : "";
		}
		case "voxren_meta_research":
			switch (args.query_type) {
				case "matchup":
					return typeof args.champion === "string" && typeof args.opponent === "string" ? `${args.champion} vs ${args.opponent}${typeof args.position === "string" ? ` · ${args.position}` : ""}` : "";
				case "tier_list":
					return typeof args.position === "string" ? args.position : "";
				case "synergy":
					return [args.champion, args.position, typeof args.ally_position === "string" ? `with ${args.ally_position}` : undefined].filter((part) => typeof part === "string").join(" · ");
				case "top_players":
					return [args.champion, args.region].filter((part) => typeof part === "string").join(" · ");
				case "pro_player_riot_id":
					return [args.player_name, args.region].filter((part) => typeof part === "string").join(" · ");
				default:
					return [args.champion, args.position, args.tier].filter((part) => typeof part === "string").join(" · ");
			}
		case "voxren_strategy_frame": {
			// The cited ids show on the expanded card's sources line; the collapsed row is the count the verdicts are out of.
			const claims = Array.isArray(args.claims) ? args.claims.length : 0;
			return claims ? `${claims} claim${claims === 1 ? "" : "s"}` : "";
		}
		case "voxren_player_audit":
			return [args.riot_id, typeof args.count === "number" ? `${args.count} ranked` : undefined, args.champion]
				.filter((part) => typeof part === "string")
				.join(" · ");
		case "voxren_otp_build":
			return [typeof args.player === "string" ? safeDecode(args.player.replace(/^https?:\/\/[^ ]*\/summoners\/[a-z]+\//i, "").replace(/\?.*$/, "")) : undefined, args.champion, typeof args.count === "number" ? `${args.count} games` : undefined]
				.filter((part) => typeof part === "string")
				.join(" · ");
		// The player's audit trail for what the coach will remember (AGENTS.md rule 2): the card must show the
		// exact text that gets saved, so it is normalized here the same way live-gateway.ts normalizes before saving.
		case "voxren_remember":
			return typeof args.text === "string" ? normalizeTakeaway(args.text) : "";
		case "voxren_command_frame":
			return typeof args.command === "string" ? `/${args.command}` : "";
	}
}

const SEARCH_QUERY_CHARS = 56;

// --- tool cards -----------------------------------------------------------------

/** Short card names; the full tool name only shows on the expanded contract line. */
const SHORT_NAME: Record<ToolName, string> = {
	web_search: "search",
	voxren_video_research: "videos",
	voxren_game_facts: "facts",
	voxren_meta_research: "meta",
	voxren_strategy_frame: "check",
	voxren_player_audit: "audit",
	voxren_otp_build: "otp",
	voxren_remember: "remember",
	voxren_command_frame: "frame",
};

/** A data row's label column: lower case in the block's colour, blank for a table's continuation rows. */
function label(theme: UiTheme, text: string, role: string = BLOCK_ROLE.lookup): string {
	return theme.fg(role, text.padEnd(LABEL_WIDTH));
}

/** A row with its own label under the card's first row; `fit` rows were already sized to the width. */
function labelled(theme: UiTheme, text: string, body: string, fit = false): Row {
	return { head: label(theme, text), body, fit };
}

/**
 * How much of a card shows. `brief` is the collapsed card. `claims` is the expanded card: each claim or passage once, with
 * what the judge found under it, the default when a card is expanded. `full` is the judge's own view, every question with
 * its score bars, kept for debugging a verdict. The level an expanded card opens at is the one setting,
 * VOXREN_COACH_CARD_DETAIL; `brief` there keeps an expanded card as short as a collapsed one.
 */
export type CardDetail = "brief" | "claims" | "full";

/** The launch setting's word; anything else, or nothing, is `claims`. */
export function parseCardDetail(raw: string | undefined): CardDetail {
	const word = raw?.trim().toLowerCase();
	return word === "brief" || word === "full" ? word : "claims";
}

export interface ToolResultView {
	response?: GatewayResponse;
	errorText?: string;
}

/** A title with the box-drawing bars a channel or page name may hold drawn as plain pipes: a "│" in a row would read as a second card bar. */
const flatBars = (text: string) => text.replace(/[│┃]/g, "|");

/** One row per evidence id; the URL joins it only in the expanded card. */
function evidenceRows(theme: UiTheme, response: GatewayResponse, expanded: boolean): Row[] {
	const rows: Row[] = [];
	const results: any[] = Array.isArray(response.data.results) ? response.data.results : [];
	response.evidence.forEach((entry, index) => {
		const route = typeof results[index]?.route === "string" ? ` ${theme.fg("dim", `(${plainVerdict(results[index].route)})`)}` : "";
		rows.push(sub("", `${theme.fg("accent", `[${entry.id}]`)} ${flatBars(stripTerminalControl(entry.title))}${route}`));
		if (expanded) rows.push(sub(SUB_INDENT, theme.fg("mdLinkUrl", stripTerminalControl(entry.url))));
	});
	return rows;
}

const BAR_CELLS = 10;

/** One Jev probability as a ten-cell bar: `█████████░`. */
function probabilityBar(theme: UiTheme, value: number): string {
	const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(value * BAR_CELLS)));
	return `${theme.fg("accent", "█".repeat(filled))}${theme.fg("dim", "░".repeat(BAR_CELLS - filled))}`;
}

function percent(value: number): string {
	return `${String(Math.round(value * 100)).padStart(2)}%`;
}

/** A question's text as the player should read it: the untrusted preamble is boilerplate for Jev, not for them. */
function questionText(question: { instructions: string } | undefined): string {
	return (question?.instructions ?? "").replace(COACH_YAML.jev.untrusted, "").trim();
}

/** A prefix of known cell width plus a label cut to the rest of the width. Bars are block glyphs that some width tables count double, so the label is measured on its own. */
function fixedRow(prefix: string, prefixCells: number, label: string, width: number): string {
	return `${prefix}${truncateToWidth(label, Math.max(1, width - prefixCells))}`;
}

/** `Q<n>  <full question>` wrapped, then one row per item sorted by probability: `    yes  █████████░ 92%   <label>`. */
function questionBlock(theme: UiTheme, n: number, text: string, rows: Array<{ p: number; label: string; yes: boolean }>, width: number): string[] {
	const lines = wrapLines([`${theme.fg("accent", `Q${n}`)}  ${text}`], width, "    ");
	for (const row of [...rows].sort((a, b) => b.p - a.p)) {
		const verdict = theme.fg(row.yes ? "success" : "dim", (row.yes ? "yes" : "no").padEnd(5));
		// 4 indent + 5 verdict + 10 bar + 1 space + 3 percent + 3 gap = 26 cells before the label.
		lines.push(fixedRow(`    ${verdict}${probabilityBar(theme, row.p)} ${percent(row.p)}   `, 26, row.label, width));
	}
	return lines;
}

/** Expanded only: every Jev question in full with each passage's or claim's answer under it, then the verdict rule and rows. Absent unless the response carries a judged screen. */
export function jevLines(theme: UiTheme, response: GatewayResponse, width: number): string[] {
	const data: any = response.data;
	const judgment: any = data.judgment;
	if (!judgment || judgment.status !== "judged") return [];
	const lines: string[] = [""];
	// The verdict word takes its route's colour; `pad` is its column, so the label after it lines up.
	const verdictRow = (route: string, verdict: string, label: string, pad = 14) => fixedRow(`    ${theme.fg(ROUTE_ROLE[route] ?? "dim", verdict.padEnd(pad))}`, 4 + pad, label, width);
	if (response.operation === "strategy_frame") {
		const claims: any[] = Array.isArray(data.claims) ? data.claims : [];
		const judged = claims.filter((claim) => claim?.p);
		const sources: any[] = Array.isArray(data.sources) ? data.sources : [];
		// "(not read)": the check never saw that source, so an unsupported claim resting on it is the player's to verify by hand.
		if (sources.length) lines.push(truncateToWidth(`${label(theme, "sources", BLOCK_ROLE.check)}${sources.map((entry) => `${entry.id} ${asText(entry.title)}${entry.unread ? " (not read)" : ""}`).join(" · ")}`, width));
		const q = COACH_YAML.jev.grounding;
		lines.push(...questionBlock(theme, 1, questionText(q.supported), judged.map((claim) => ({ p: claim.p.supported, label: asText(claim.claim), yes: claim.p.supported >= GROUNDING_THRESHOLDS.supportedMin })), width));
		lines.push(...questionBlock(theme, 2, questionText(q.contradicted), judged.map((claim) => ({ p: claim.p.contradicted, label: asText(claim.claim), yes: claim.p.contradicted >= GROUNDING_THRESHOLDS.contradictedMin })), width));
		lines.push(...wrapLines([`${theme.fg("accent", "Q3")}  ${questionText(q.source)}`], width, "    "));
		const picks = judged.map((claim) => ({ pick: typeof claim.source === "string" ? claim.source : "none", p: claim.sourceP?.[typeof claim.source === "string" ? claim.source : "none"], label: asText(claim.claim) }));
		for (const pick of picks.sort((a, b) => (b.p ?? 0) - (a.p ?? 0))) lines.push(fixedRow(`    ${theme.fg("dim", pick.pick.padEnd(11))}${typeof pick.p === "number" ? percent(pick.p).trim().padStart(3) : "   "}   `, 21, pick.label, width));
		lines.push(...wrapLines([`${theme.fg("accent", "Q4")}  ${questionText(q.contradictedBy)}`], width, "    "));
		for (const claim of judged) {
			const pick = typeof claim.contradictedBy === "string" ? claim.contradictedBy : "none";
			lines.push(fixedRow(`    ${theme.fg("dim", pick.padEnd(11))}   `, 18, asText(claim.claim), width));
		}
		lines.push(...wrapLines([theme.fg("dim", "verdicts   Q1+Q2, two sources: disputed; Q2 alone: contradicted; Q1: grounded")], width, " ".repeat(11)));
		const verdicts = claims.map((claim) => {
			const idFor = claimSourceId(claim);
			return `${String(claim?.route ?? "not_judged").replace("_", " ")}${typeof idFor === "string" ? ` · ${idFor}` : ""}`;
		});
		const pad = Math.max(23, ...verdicts.map((verdict) => verdict.length + 3));
		claims.forEach((claim, index) => lines.push(verdictRow(String(claim?.route ?? "not_judged"), verdicts[index], asText(claim?.claim), pad)));
		return lines;
	}
	const items = passageItems(response);
	if (!items.length) return [];
	const words = (item: PassageItem) => [item.ref, item.name].filter(Boolean).join("  ");
	const q = COACH_YAML.jev.passage;
	lines.push(...questionBlock(theme, 1, questionText(q.relevant), items.map((item) => ({ p: item.p.relevant, label: words(item), yes: item.p.relevant >= PASSAGE_THRESHOLDS.relevantMin })), width));
	lines.push(...questionBlock(theme, 2, questionText(q.support), items.map((item) => ({ p: item.p.support, label: words(item), yes: item.p.support >= PASSAGE_THRESHOLDS.supportMin })), width));
	lines.push(...questionBlock(theme, 3, questionText(q.injection), items.map((item) => ({ p: item.p.injection, label: words(item), yes: item.p.injection >= PASSAGE_THRESHOLDS.injectionMax })), width));
	lines.push(...wrapLines([theme.fg("dim", "verdicts   yes to Q3 blocks, no to Q1 removes, yes to Q2 is usable, else weak")], width, " ".repeat(11)));
	for (const item of items) lines.push(verdictRow(item.route, plainVerdict(item.route), `${words(item)}${item.mark ? `  ${item.mark}` : ""}`));
	return lines;
}

/** One result of a search, a video list, or an OP.GG lookup as the claims level lists it. */
interface Listed {
	/** What the result is known by: its evidence id, the domain of a removed result, or `tip` before a matchup tip's words; empty for the search answer and the summary. */
	ref: string;
	name: string;
	/** `(removed)` on a result the screen cut, `(blanked)` on an OP.GG tip it blanked. */
	mark: string;
	/** Where the player can read a kept result. */
	url?: string;
	/** A video's publish date and whether its words are auto captions. */
	about?: string;
	/** What a video said, each part with the second it starts at. */
	quotes?: Array<{ at: number; text: string }>;
	/** Set on a matchup's tip: the evidence id of its card, `""` when the card has none. The claims level names the tip `<id> tip: <words>` (the check card's claims cite that id); the full level keeps `tip  <words>`. */
	tipOf?: string;
}

/** One judged passage of a search, a video list, or an OP.GG summary, as the judge scored it. */
interface PassageItem extends Listed {
	p: { relevant: number; support: number; injection: number };
	route: string;
}

/** The rows a search or video result sits in, in the order of the evidence: `results` for a search, `videos` for a video list, none for an OP.GG lookup. */
function resultRows(data: Record<string, unknown>): any[] {
	return Array.isArray(data.results) ? data.results : Array.isArray(data.videos) ? data.videos : [];
}

/** One result as listed: its evidence id and title, its link, and what a video row adds (date, caption note, quoted parts). */
function listed(entry: GatewayResponse["evidence"][number], row: any): Listed {
	const about = [typeof row?.published === "string" ? stripTerminalControl(row.published) : "", row?.autoCaptions ? "auto captions" : ""].filter(Boolean).join(" · ");
	const quotes = Array.isArray(row?.passages) ? row.passages.map((passage: any) => ({ at: Number(passage?.at) || 0, text: asText(passage?.text) })) : undefined;
	return { ref: entry.id, name: stripTerminalControl(entry.title), mark: "", url: stripTerminalControl(entry.url), ...(about && { about }), ...(quotes && { quotes }) };
}

/**
 * Every passage a judged screen scored, in the order the card lists them: the search answer, the kept results, the
 * removed ones; an OP.GG summary is one. Empty unless the screen judged. Each passage is scored in one batch that
 * succeeds or fails whole, so a judged screen leaves no kept result without its scores.
 */
function passageItems(response: GatewayResponse): PassageItem[] {
	const data: any = response.data;
	const judgment: any = data.judgment;
	if (!judgment || judgment.status !== "judged") return [];
	const items: PassageItem[] = [];
	if (response.operation === "research_web_search" || response.operation === "research_video") {
		if (judgment.answerP) items.push({ ref: "", name: "search answer", p: judgment.answerP, route: String(judgment.answer), mark: "" });
		const rows = resultRows(data);
		response.evidence.forEach((entry, index) => {
			if (rows[index]?.p) items.push({ ...listed(entry, rows[index]), p: rows[index].p, route: String(rows[index].route) });
		});
		for (const entry of Array.isArray(judgment.removed) ? judgment.removed : []) if (entry?.p) items.push({ ref: asText(entry.domain), name: stripTerminalControl(asText(entry.title)), p: entry.p, route: String(entry.route), mark: "(removed)" });
	} else if (judgment.p) {
		// A matchup's judged passage is its tip, so the entry is the tip's own words: the verdict sits on the text it judged. A blanked tip has no words left to show.
		const matchup = response.operation === "meta.matchup";
		const tip = matchup && typeof data.tip === "string" ? stripTerminalControl(data.tip) : "";
		items.push({ ref: matchup ? "tip" : "", name: matchup ? tip : "summary", p: judgment.p, route: String(judgment.answer), mark: judgment.answer === "withheld" ? "(blanked)" : "", ...(matchup && { tipOf: response.evidence[0]?.id ?? "" }), ...(matchup && response.evidence[0]?.url && { url: stripTerminalControl(response.evidence[0].url) }) });
	}
	return items;
}

/** Cards that list their results at the claims level: a search, a video list, an OP.GG lookup. The check card lists claims, and the rest list nothing. */
const listsResults = (operation: string) => operation !== "strategy_frame" && JUDGED_OPERATIONS.has(operation);

/**
 * What the claims level lists on a search, video, or meta card, each result once: the judged passages with their
 * verdicts and scores, or, when nothing screened the card (no key, nothing to screen, the judge unavailable), every result
 * the tool returned in the same order of details, with no verdict and no scores.
 */
function listedItems(response: GatewayResponse): Array<Listed | PassageItem> {
	if (!listsResults(response.operation)) return [];
	const judged = passageItems(response);
	const rows = resultRows(response.data);
	if (judged.length) return judged;
	const entries: Listed[] = response.evidence.map((entry, index) => listed(entry, rows[index]));
	// An unscreened matchup's first entry is the OP.GG lookup the tip came from: it is listed as the tip, under the id the check card cites, as a screened one is.
	const tip = response.operation === "meta.matchup" && typeof response.data.tip === "string" ? stripTerminalControl(response.data.tip) : "";
	const [first, ...rest] = entries;
	return first && tip ? [{ ...first, name: tip, tipOf: first.ref }, ...rest] : entries;
}

/** The colour of a verdict word, for claims (grounded, unsupported, contradicted) and passages (evidence, weak, withheld) alike. */
const ROUTE_ROLE: Record<string, string> = { grounded: "success", evidence: "success", unsupported: "warning", disputed: "warning", weak: "warning", contradicted: "error", withheld: "error", off_topic: "dim", not_judged: "dim" };
/** A passage verdict in the player's words. The judge's own route names (evidence, withheld, off_topic) stay in the data the model reads. */
const PLAIN_VERDICT: Record<string, string> = { evidence: "usable", withheld: "blocked", off_topic: "off topic" };
const plainVerdict = (route: unknown) => PLAIN_VERDICT[String(route)] ?? asText(route).replace("_", " ");

/** The reason column of a sub-row: the longest verdict word, `contradicted`, and a space. */
const REASON_WIDTH = 13;

/**
 * The routes a collapsed check card shows a row for: a source that disagrees (contradicted) or that argues back against another that states it (disputed) is what the player must read.
 * Grounded and unsupported claims are counts on the card's first row (unsupported is usually the coach's own judgment, which no passage states).
 */
const FLAGGED_ROUTES = new Set(["contradicted", "disputed"]);

/** The id a claim row names: the opposing source on a contradicted claim, both on a disputed one (`web-2 vs video-1`), else the source. */
function claimSourceId(entry: any): unknown {
	const route = String(entry?.route);
	if (route === "disputed" && typeof entry?.source === "string" && typeof entry?.contradictedBy === "string") return `${entry.source} vs ${entry.contradictedBy}`;
	return route === "contradicted" ? entry?.contradictedBy : entry?.source;
}

/** One sub-row per claim: its verdict in the verdict's colour, then the source id when grounded or contradicted and the claim. `flaggedOnly` keeps the rows that change what the player trusts. */
export function claimRows(theme: UiTheme, data: Record<string, unknown>, flaggedOnly = false): Row[] {
	const claims: any[] = (Array.isArray(data.claims) ? data.claims : []).filter((entry) => !flaggedOnly || FLAGGED_ROUTES.has(String(entry?.route)));
	const rows = claims.map((entry) => {
		const route = String(entry?.route ?? "not_judged");
		const idFor = claimSourceId(entry);
		const source = typeof idFor === "string" ? `[${idFor}] ` : "";
		return sub(theme.fg(ROUTE_ROLE[route] ?? "dim", route.replace("_", " ").padEnd(REASON_WIDTH)), `${theme.fg("dim", source)}${asText(entry?.claim)}`);
	});
	if (!flaggedOnly) return rows;
	// Unsupported claims follow the flagged ones, one cut line each (#219): the player sees which claim the check could not back.
	const unsupported: any[] = (Array.isArray(data.claims) ? data.claims : []).filter((entry) => entry?.route === "unsupported");
	const head = theme.fg(ROUTE_ROLE.unsupported, "unsupported".padEnd(REASON_WIDTH));
	rows.push(...unsupported.slice(0, MAX_UNSUPPORTED_ROWS).map((entry) => sub(head, asText(entry?.claim), true)));
	if (unsupported.length > MAX_UNSUPPORTED_ROWS) rows.push(sub(head, theme.fg("dim", `+${unsupported.length - MAX_UNSUPPORTED_ROWS} more`), true));
	return rows;
}

/** Unsupported claims a collapsed check card names before it says `+N more`. */
const MAX_UNSUPPORTED_ROWS = 3;

/** A score as the player reads it: `88%`. */
function pct(value: unknown): string {
	return typeof value === "number" ? `${Math.round(value * 100)}%` : "?";
}

/** Words that never wrap apart (no-break spaces), so a score stays on the line of its label. */
const tight = (...words: string[]) => words.join("\u00a0");

/** A row under a verdict row, level with the text after the verdict column. */
function under(body: string): Row {
	return sub(" ".repeat(REASON_WIDTH), body);
}

/** The blank row that sets one block of an expanded card apart from the next; the bar runs through it. */
const gap = (): Row => sub("", "");

/**
 * The expanded check card at the claims level: each claim once, its verdict first, then one dim line of what the judge
 * found. That line lets the player decide how far to trust a claim and where to look: the best source and its score (or
 * none), how sure the check is that the claim is stated and that it is opposed, and, on a contradicted claim, which
 * source to open. A claim nothing judged has no scores to show.
 */
function claimDetailRows(theme: UiTheme, data: Record<string, unknown>): Row[] {
	const claims: any[] = Array.isArray(data.claims) ? data.claims : [];
	if (!claims.length) return [];
	return [
		gap(),
		...claims.flatMap((entry) => {
			const route = String(entry?.route ?? "not_judged");
			const row = sub(theme.fg(ROUTE_ROLE[route] ?? "dim", plainVerdict(route).padEnd(REASON_WIDTH)), asText(entry?.claim));
			if (!entry?.p) return [row];
			const best = typeof entry.source === "string" ? tight("source", asText(entry.source), ...(typeof entry.sourceP?.[entry.source] === "number" ? [pct(entry.sourceP[entry.source])] : [])) : tight("no", "source");
			const by = (route === "contradicted" || route === "disputed") && typeof entry.contradictedBy === "string" ? ["by", asText(entry.contradictedBy)] : [];
			return [row, under(theme.fg("dim", [best, tight("stated", pct(entry.p.supported)), tight("opposed", pct(entry.p.contradicted), ...by)].join(" · ")))];
		}),
		// The two cut-offs the verdicts rest on, once: without them `stated 63% · opposed 57%` on a grounded claim cannot be read.
		...(claims.some((entry) => entry?.p)
			? [sub(theme.fg("dim", "cut-offs".padEnd(REASON_WIDTH)), theme.fg("dim", `contradicted from ${tight("opposed", pct(GROUNDING_THRESHOLDS.contradictedMin))} · grounded from ${tight("stated", pct(GROUNDING_THRESHOLDS.supportedMin))}`))]
			: []),
	];
}

/**
 * The cited sources under an expanded check card's claims, each once. A source the check never read goes last and is marked:
 * an unsupported claim may rest on it, and the one line after the list says so, which tells the player which claims to verify by hand.
 */
function sourceRows(theme: UiTheme, data: Record<string, unknown>): Row[] {
	const sources: any[] = Array.isArray(data.sources) ? data.sources : [];
	if (!sources.length) return [];
	const ordered = [...sources.filter((entry) => !entry?.unread), ...sources.filter((entry) => entry?.unread)];
	const unread = ordered.filter((entry) => entry?.unread).map((entry) => asText(entry.id));
	const claims: any[] = Array.isArray(data.claims) ? data.claims : [];
	return [
		gap(),
		...ordered.map((entry, index) => sub(index ? " ".repeat(REASON_WIDTH) : theme.fg(BLOCK_ROLE.check, "sources".padEnd(REASON_WIDTH)), `${asText(entry?.id)} ${flatBars(asText(entry?.title))}${entry?.unread ? ` ${tight("(not", "read)")}` : ""}`)),
		...(unread.length && claims.some((entry) => entry?.route === "unsupported") ? [under(theme.fg("dim", `an unsupported claim could not be checked ${tight("against", unread.join(", "))}`))] : []),
	];
}

/**
 * What a video lists of its quotes at the claims level: at most this many parts, each at most this many characters (the
 * ellipsis of a cut one included). A transcript part is a paragraph of speech, often several hundred characters, and a
 * video holds several: the claims level quotes the first lines of two and leaves the rest to the full level, where
 * the whole of every part shows.
 */
const QUOTE_PARTS = 2;
const QUOTE_PART_CHARS = 200;

/** The dim line under a video's quoted parts: how many were left out and how many shown were cut short, so the player knows the quotes are partial. Each number stays on the line of its label. */
function quoteNote(left: number, cut: number): string {
	const more = left ? `${tight(String(left), "more")} quoted ${left === 1 ? "part" : "parts"} not shown` : "";
	const short = cut ? `${tight(String(cut), left ? "cut" : "quoted")}${left ? "" : ` ${cut === 1 ? "part" : "parts"} cut`} short` : "";
	return [more, short].filter(Boolean).join(", ");
}

/** A listed result's text: its id (or domain) and title, and for a matchup's tip the card's evidence id, then `tip:` and the words. */
function entryText(item: Listed): string {
	const words = item.tipOf === undefined ? [item.ref, item.name] : [item.tipOf, item.name ? `tip: ${item.name}` : "tip"];
	return flatBars(`${words.filter(Boolean).join(" ")}${item.mark ? ` ${item.mark}` : ""}`);
}

/**
 * The expanded search, video, and meta card at the claims level: each result once. A judged one has its verdict in plain
 * words first, then its three scores named in plain words, which lets the player decide how far to trust a usable
 * passage and why another was weak or cut; a removed one is marked, so the player knows what the coach never saw. A
 * result nothing screened has the same columns with no verdict and no scores. A kept result carries its link, and a
 * video its date and caption note, then (when usable) a few quoted parts with their minutes, so the player can open it
 * where it was said.
 */
function passageRows(theme: UiTheme, items: Array<Listed | PassageItem>): Row[] {
	if (!items.length) return [];
	return [
		gap(),
		...items.flatMap((item, index) => {
			const judged = "p" in item ? item : undefined;
			// A video the screen did not call usable shows no quote; one nothing screened is taken as usable.
			const quotes = !judged || judged.route === "evidence" ? (item.quotes ?? []) : [];
			const shown = quotes.slice(0, QUOTE_PARTS);
			const cut = shown.filter((quote) => quote.text.length > QUOTE_PART_CHARS).length;
			const left = quotes.length - shown.length;
			return [
				sub(theme.fg(judged ? ROUTE_ROLE[judged.route] ?? "dim" : "dim", (judged ? plainVerdict(judged.route) : "unscreened").padEnd(REASON_WIDTH)), entryText(item)),
				...(judged ? [under(theme.fg("dim", [tight("on", "topic", pct(judged.p.relevant)), tight("support", pct(judged.p.support)), tight("injection", pct(judged.p.injection))].join(" · ")))] : []),
				...(item.about ? [under(theme.fg("dim", item.about))] : []),
				...(item.url ? [under(theme.fg("mdLinkUrl", item.url))] : []),
				...shown.map((quote) => sub(`${" ".repeat(REASON_WIDTH)}${theme.fg("dim", formatClock(quote.at).padStart(5))} `, quote.text.length > QUOTE_PART_CHARS ? `${cutAtWord(quote.text, QUOTE_PART_CHARS - 1)}…` : quote.text)),
				...(left || cut ? [under(theme.fg("dim", quoteNote(left, cut)))] : []),
				// Quoted parts run to several lines: a blank row sets the next result apart from them.
				...(shown.length && index < items.length - 1 ? [gap()] : []),
			];
		}),
	];
}

/** Results a decision model screens or checks when a key is set: a card for one of these with no judgment says the check did not run. */
const JUDGED_OPERATIONS = new Set(["research_web_search", "research_video", "meta.matchup", "meta.champion_overview", "meta.tier_list", "meta.synergy", "meta.top_players", "meta.pro_player_riot_id", "strategy_frame"]);

/**
 * The one judgment row under a card, collapsed or expanded; it carries only what the first row lacks. Judged names the
 * model whose yes/no the kept passages or the verdicts rest on, with what it removed, so a verdict from a model the cuts
 * were never fit to is not trusted like Jev's. Unavailable (error colour) says why, and on a screen what went unscreened:
 * retry, or state the text as unverified. A result with no judgment gets a dim row saying why the check did not run, so
 * a skipped check never reads as a passed one. The frame's first row already says "not checked", so its row gives the reason alone.
 */
export function judgmentLine(theme: UiTheme, response: GatewayResponse): string | undefined {
	const frame = response.operation === "strategy_frame";
	const matchup = response.operation === "meta.matchup";
	const judgment: any = response.data.judgment;
	if (!judgment || typeof judgment !== "object") {
		if (!JUDGED_OPERATIONS.has(response.operation)) return undefined;
		// An empty matchup tip is never sent, key or not, and a search or video list with no passage sends nothing, so "no key" would be false there.
		const searched = response.operation === "research_web_search" || response.operation === "research_video";
		const why = matchup && !response.data.tip ? "no tip text" : searched && !response.evidence.length && !response.data.answer ? "nothing to screen" : "no key";
		return theme.fg("dim", frame ? why : `not screened · ${why}`);
	}
	const by = asText(knownJudge(judgment.model) ?? knownJudge(judgment.judge) ?? "Jev");
	if (judgment.status !== "judged") {
		// `input` is the judge's word for a request over the byte cap or a 400 as well as for sources with no text, so the cause is named only when every cited source is marked unread.
		const sources: any[] = Array.isArray(response.data.sources) ? response.data.sources : [];
		const unread = frame && judgment.reason === "input" && sources.length > 0 && sources.every((entry) => entry?.unread);
		const reason = unread ? "cited sources carry no text" : asText(judgment.reason);
		return theme.fg("error", `${by} unavailable (${reason})${frame ? "" : " · passages unscreened"}`);
	}
	const removed: any[] = Array.isArray(judgment.removed) ? judgment.removed : [];
	const parts = [`${frame ? "checked" : matchup ? "tip screened" : "screened"} by ${by}`];
	// The first row counts the results, so this row names only what the screen removed and its verdict on the answer when one was judged (the matchup's tip is no answer: it gets the bare verdict).
	if (removed.length) parts.push(`removed ${removed.length} (${removed.map((entry) => `${asText(entry.domain)} ${plainVerdict(entry.route)}`).join(", ")})`);
	if (typeof judgment.answer === "string") parts.push(matchup ? plainVerdict(judgment.answer) : `answer ${plainVerdict(judgment.answer)}`);
	parts.push(tight(asText(judgment.latencyMs), "ms"));
	return theme.fg("dim", parts.join(" · "));
}

function asText(value: unknown): string {
	if (value === undefined || value === null) return "?";
	return typeof value === "string" ? stripTerminalControl(value) : JSON.stringify(value);
}

// --- audit card ------------------------------------------------------------------


/** One ▮ per game, green win / red loss, in the order the audit returned them. */
export function winLossStrip(theme: UiTheme, games: any[]): string {
	return games.map((game) => theme.fg(game?.win ? "success" : "error", "▮")).join("");
}

/** Averages read at one decimal; integers stay integers. */
function num(value: unknown): string {
	return typeof value === "number" && !Number.isInteger(value) ? value.toFixed(1) : asText(value);
}

/** Minutes (possibly fractional) as m:ss. */
function clock(minutes: unknown): string {
	return typeof minutes === "number" ? formatClock(minutes * 60) : asText(minutes);
}

function signed(value: number): string {
	return `${value > 0 ? "+" : ""}${Math.round(value)}`;
}

/** ±1234 → +1.2k; below a thousand stays exact. */
function compact(value: number): string {
	return Math.abs(value) >= 1000 ? `${value > 0 ? "+" : "-"}${(Math.abs(value) / 1000).toFixed(1)}k` : signed(value);
}

/** Signed gold difference, colored by direction only. */
export function goldText(theme: UiTheme, value: unknown): string {
	if (typeof value !== "number") return asText(value);
	return theme.fg(value < 0 ? "error" : "success", signed(value));
}

/** `(otp +1.6k)` beside a number: the one-trick's figure for the same matchup, or nothing when the reference has no row. */
function otp(theme: UiTheme, text: string | undefined): string {
	return text ? ` ${theme.fg("muted", `(otp ${text})`)}` : "";
}

function referenceFor(response: GatewayResponse, opponent: unknown): any | undefined {
	const reference: any = response.data.reference;
	const matchups: any[] = Array.isArray(reference?.matchups) ? reference.matchups : [];
	return matchups.find((entry) => entry?.vs === opponent);
}

/** `Dark Seal 3:18 3/3 games` per tracked item, most-bought first, icon in front where the terminal draws one. */
function itemTexts(summary: any, limit: number): Array<{ shown: string; width: number }> {
	const timings = summary?.medianItemTimingMin;
	if (!timings || typeof timings !== "object") return [];
	const counts = summary.itemPurchaseCount ?? {};
	return Object.entries(timings)
		.sort(([a], [b]) => (counts[b] ?? 0) - (counts[a] ?? 0))
		.slice(0, limit)
		.map(([name, minute], index) => {
			const icon = itemIconLine(name);
			// The first count names its unit once (games bought in), so the rest read as the same.
			const text = typeof counts[name] === "number" ? `${name} ${clock(minute)} ${counts[name]}/${asText(summary.games)}${index === 0 ? " games" : ""}` : `${name} ${clock(minute)}`;
			return icon ? { shown: `${icon.sequence} ${text}`, width: icon.columns + 1 + visibleWidth(text) } : { shown: text, width: visibleWidth(text) };
		});
}

/** Items packed into rows by width, never split inside an item; continuation rows keep the label column blank. */
function itemRows(theme: UiTheme, summary: any, limit: number, width: number): Row[] {
	const texts = itemTexts(summary, limit);
	if (!texts.length) return [];
	const separator = ` ${theme.fg("dim", "·")} `;
	const rows: string[] = [];
	let row = "";
	let rowWidth = 0;
	for (const { shown, width: itemWidth } of texts) {
		if (row && rowWidth + 3 + itemWidth + LABEL_WIDTH > width) {
			rows.push(row);
			row = shown;
			rowWidth = itemWidth;
		} else {
			row = row ? `${row}${separator}${shown}` : shown;
			rowWidth += (rowWidth ? 3 : 0) + itemWidth;
		}
	}
	rows.push(row);
	return rows.map((text, index) => labelled(theme, index === 0 ? "items" : "", text, true));
}

/** Per-game rows show collapsed up to here; a bigger sample keeps only the avg and otp rows until expanded. */
const PER_GAME_MAX = 10;

type Align = "left" | "right";
interface Column {
	head: string;
	align: Align;
}

/** Labeled table: header, one row per game (worst gold at 15 first), then `avg` and `otp` in the same columns. */
const COLUMNS: Column[] = [
	{ head: "", align: "left" },
	{ head: "you vs", align: "left" },
	{ head: "kda", align: "right" },
	{ head: "gold@15", align: "right" },
	{ head: "cs@15", align: "right" },
	{ head: "d<6", align: "right" },
	{ head: "d>15", align: "right" },
	{ head: "len", align: "right" },
	{ head: "gold", align: "left" },
];

/** Mean of the numeric entries; "?" when none. */
function mean(values: unknown[]): unknown {
	const numbers = values.filter((value): value is number => typeof value === "number");
	return numbers.length ? Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 10) / 10 : undefined;
}

function cell(text: string, width: number, align: Align): string {
	const pad = " ".repeat(Math.max(0, width - visibleWidth(text)));
	return align === "left" ? `${text}${pad}` : `${pad}${text}`;
}

// Result, opponent, kda, and gold@15 are the columns the audit card exists to show; the gold strip and
// cs@15/d<6/d>15/len are context and go first when the pane is too narrow for all nine. Order here is drop priority, least first.
const CORE_COLUMNS = [0, 1, 2, 3];
const OPTIONAL_COLUMNS = [8, 7, 6, 5, 4];

function columnWidths(rows: string[][], indices: number[]): number[] {
	return indices.map((index) => Math.max(COLUMNS[index].head.length, ...rows.map((row) => visibleWidth(row[index] ?? ""))));
}

/** A cut cell keeps at least this many cells (`Twi…`) while any column is wider; below it the name or number is gone. */
const MIN_CELLS = 4;

/** Column indices that fit `width`, dropping optional columns least-important-first before any core column ever goes. */
function fittingColumns(rows: string[][], width: number): number[] {
	// An optional column no row fills (the gold strip when no game sent a timeline) never shows, header included.
	const optional = OPTIONAL_COLUMNS.filter((index) => rows.some((row) => row[index]));
	for (let drop = 0; drop <= optional.length; drop++) {
		const indices = [...CORE_COLUMNS, ...optional.slice(drop)].sort((a, b) => a - b);
		const widths = columnWidths(rows, indices);
		if (widths.reduce((sum, w) => sum + w, 0) + (indices.length - 1) * 2 <= width) return indices;
	}
	return CORE_COLUMNS;
}

/**
 * Fixed-width table: degrades by dropping columns for room, then cutting the widest surviving cell; never word-wraps.
 * The columns are the ones this pane held before a card had a margin and a bar. The margin and the bar take three
 * cells, which the gaps give back: a table that no longer fits with two spaces between columns closes them to one.
 */
function tableRows(theme: UiTheme, rows: string[][], dimHeader = true, width = Number.POSITIVE_INFINITY): Row[] {
	const budget = width - LABEL_WIDTH;
	const indices = fittingColumns(rows, budget + CARD_MARGIN + EDGE_CELLS);
	let widths = columnWidths(rows, indices);
	const gap = widths.reduce((sum, w) => sum + w, 0) + (indices.length - 1) * 2 <= budget ? 2 : 1;
	// Core columns alone still don't fit (an unusually long name, a very narrow pane): cut the widest column, again if
	// needed, rather than let wrapLines split a row. No column goes under MIN_CELLS while another is wider; a pane
	// too narrow for that (about 30 cells) cuts down to one cell each, the last resort.
	for (let over = widths.reduce((sum, w) => sum + w, 0) + (indices.length - 1) * gap - budget; over > 0; ) {
		const floor = widths.some((w) => w > MIN_CELLS) ? MIN_CELLS : 1;
		const widest = widths.indexOf(Math.max(...widths));
		if (widths[widest] <= floor) break;
		const take = Math.min(over, widths[widest] - floor);
		widths = widths.map((w, i) => (i === widest ? w - take : w));
		over -= take;
	}
	const line = (cells: string[]) =>
		indices
			.map((columnIndex, position) => cell(truncateToWidth(cells[columnIndex] ?? "", widths[position], "…"), widths[position], COLUMNS[columnIndex].align))
			.join(" ".repeat(gap))
			.trimEnd();
	const header = line(COLUMNS.map((column) => column.head));
	return [dimHeader ? theme.fg("muted", header) : header, ...rows.map(line)].map((text) => labelled(theme, "", text, true));
}

/** One cell per 2 minutes, so a 40-minute game is 20 cells; every game on the same gold `scale` and minute axis. */
const STRIP_MINUTES = 2;

function gameRow(theme: UiTheme, game: any, scale: number): string[] {
	const gd: unknown = game.chart?.gd;
	return [
		game.remake ? theme.fg("dim", "remake") : theme.fg(game.win ? "success" : "error", game.win ? "W" : "L"),
		asText(game.vs),
		asText(game.kda),
		goldText(theme, game.gd15),
		asText(game.cs15),
		asText(game.d6),
		asText(game.dLate),
		theme.fg("dim", clock(game.dur)),
		scale && !game.remake && Array.isArray(gd) && gd.length > 1 ? goldStrip((role, text) => theme.fg(role, text), gd.filter((_, minute) => minute % STRIP_MINUTES === 0), scale) : "",
	];
}

function avgRow(theme: UiTheme, summary: any, games: any[]): string[] {
	return [
		"",
		theme.fg("accent", "avg"),
		`${num(summary.avgKills)}/${num(summary.avgDeaths)}/${num(summary.avgAssists)}`,
		goldText(theme, summary.avgGoldDiffAt15),
		num(summary.avgCsAt15),
		num(mean(games.map((game) => game.d6))),
		num(summary.avgDeathsAfter15),
		theme.fg("dim", clock(mean(games.map((game) => game.dur)))),
	];
}

/** The one-trick's mean gold at 15 and deaths over the matchups the reference knows (`otp 1/3` = one of three games had a reference row); blank when none match. */
function otpRow(theme: UiTheme, response: GatewayResponse, games: any[]): string[] | undefined {
	const known = games.map((game) => referenceFor(response, game.vs)).filter((entry) => entry && typeof entry.gd15 === "number");
	if (!known.length) return undefined;
	const mean = (key: string) => known.reduce((sum, entry) => sum + (typeof entry[key] === "number" ? entry[key] : 0), 0) / known.length;
	const deaths = known.every((entry) => typeof entry.deaths === "number") ? `d ${num(Math.round(mean("deaths") * 10) / 10)}` : "";
	return ["", `${theme.fg("accent", "otp")} ${theme.fg("dim", `${known.length}/${games.length}`)}`, theme.fg("muted", deaths), theme.fg("muted", signed(mean("gd15"))), "", "", "", ""];
}

function auditRows(theme: UiTheme, response: GatewayResponse, expanded: boolean, width: number): Row[] {
	const summary: any = response.data.summary ?? {};
	const games: any[] = Array.isArray(response.data.games) ? response.data.games : [];
	// Remakes render their own row (below) but carry no LP and no real stats, so they never enter the avg or otp figures.
	const nonRemake = games.filter((game) => !game.remake);
	const ordered = [...games].sort((a, b) => (typeof a.gd15 === "number" ? a.gd15 : 0) - (typeof b.gd15 === "number" ? b.gd15 : 0));
	const charted = chartedGames(games);
	// One game shows its own card (or text strips) under the table, so only several games get the gold column.
	const scale = charted.length > 1 ? Math.max(1, ...charted.flatMap((game) => game.chart!.gd.map(Math.abs))) : 0;
	const perGame = expanded || games.length <= PER_GAME_MAX ? ordered.map((game) => gameRow(theme, game, scale)) : [];
	const otp = otpRow(theme, response, nonRemake);
	const rows = [...perGame, ...(nonRemake.length ? [avgRow(theme, summary, nonRemake)] : []), ...(otp ? [otp] : [])];
	const drawn = auditCharts(response, expanded, width);
	// Several games carry their gold strips in the table; one game gets text strips when this terminal could not draw its card.
	const charts = charted.length > 1 || drawn.card.length ? [] : chartFallbackRows(theme, games);
	return [...(rows.length ? tableRows(theme, rows, true, width) : []), ...itemRows(theme, summary, expanded ? Number.POSITIVE_INFINITY : 3, width), ...charts, ...(expanded ? deathContextRows(theme, games) : [])];
}


/** The death heat map is square, so it is capped here: at Sixel's 10x20 cell that is 28 rows tall. */
const HEAT_MAX_CELLS = 56;

/**
 * Chart rows: the worst game's timeline + death map for one game or when expanded (several games carry their gold
 * strips in the table); and, expanded with several games, every death on one heat map.
 */
function auditCharts(response: GatewayResponse, expanded: boolean, width: number): { card: string[]; scenes: string[]; heat: string[]; tracks: string[] } {
	if (response.operation !== "player_audit") return { card: [], scenes: [], heat: [], tracks: [] };
	const charted = chartedGames(response.data.games);
	const keys = chartKeys(charted, itemTimings(response.data));
	const one = charted.length < 2;
	return {
		card: one || expanded ? (chartLines(keys.card, width) ?? []) : [],
		// The card's game death by death, wherever the card itself shows: who stood where is what "who could reach me" is answered from.
		scenes: one || expanded ? (chartLines(keys.scenes, width) ?? []) : [],
		heat: expanded ? (chartLines(keys.heat, Math.min(width, HEAT_MAX_CELLS)) ?? []) : [],
		// Item timings against the one-trick: expanded only, under the other charts.
		tracks: expanded ? (chartLines(keys.tracks, width) ?? []) : [],
	};
}

export function auditImageRows(response: GatewayResponse, expanded: boolean, width: number): string[] | undefined {
	const { card, scenes, heat, tracks } = auditCharts(response, expanded, width);
	const rows = [...card, ...scenes, ...heat, ...tracks];
	return rows.length ? rows : undefined;
}

/** One game's text chart for terminals without images: its gold strip with deaths and kills aligned under it. */
function chartFallbackRows(theme: UiTheme, all: any[]): Row[] {
	const games = chartedGames(all);
	if (!games.length) return [];
	const fg = (role: string, text: string) => theme.fg(role, text);
	const chart = games[0].chart!;
	const length = chart.gd.length;
	return [
		labelled(theme, "gold", goldStrip(fg, chart.gd), true),
		labelled(theme, "kills", theme.fg("success", markerRow(chart.kills, length, "•")), true),
		labelled(theme, "died", theme.fg("error", markerRow(chart.deaths.map((death) => death.min), length, "✕")), true),
		labelled(theme, "", theme.fg("dim", minuteAxis(length)), true),
	];
}

/** The per-death map in words, for a terminal that draws none: who killed, and how many of each side the nearest minute frame put near the death. */
function sceneParts(theme: UiTheme, scene: DeathScene | undefined, named = false): string[] {
	if (!scene) return [];
	const enemies = scene.champions.filter((champion) => !champion.ally).length;
	const allies = scene.champions.length - enemies;
	const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	return [
		// The damage list names the killers with their shares, so "by" is dropped where one follows: a death takes two rows, not three.
		...(named ? [] : [scene.killers.length ? `${theme.fg("dim", "by ")}${scene.killers.join(", ")}` : theme.fg("dim", "executed")]),
		theme.fg("muted", `${count(enemies, "enemy", "enemies")}, ${count(allies, "ally", "allies")} near ${sceneOffsetText(scene.offsetSec)}`),
	];
}

/** Expanded only: each death of the worst game with its context: after a teammate's death nearby, whether the team traded, and the gold lead then. */
function deathContextRows(theme: UiTheme, games: any[]): Row[] {
	const game = worstGame(games.filter((entry) => entry?.chart) as ChartGame[]);
	if (!game?.chart?.deaths.length) return [];
	const lead = (minute: number) => game.chart!.gd[Math.min(game.chart!.gd.length - 1, Math.floor(minute))];
	return game.chart.deaths.map((death, index) => {
		const gold = lead(death.min);
		const parts = [
			death.afterAllyDeath ? theme.fg("error", "after ally death") : theme.fg("dim", "alone"),
			death.traded ? theme.fg("success", "traded") : theme.fg("error", "no trade"),
			typeof gold === "number" ? goldText(theme, gold) : "",
			...sceneParts(theme, death.scene, !!death.damage?.length),
			death.damage?.length ? `${theme.fg("dim", "damage ")}${death.damage.map(damageText).join(", ")}` : "",
		].filter(Boolean);
		return labelled(theme, index === 0 ? "deaths" : "", `${theme.fg("muted", clock(death.min).padStart(5))}  ${parts.join(theme.fg("dim", " · "))}${index === 0 && game.vs ? theme.fg("dim", `  vs ${game.vs}`) : ""}`);
	});
}

// --- other cards ----------------------------------------------------------------

/** `shown`: what passageRows lists. It lists each video with what it said, so the video list steps aside, and a matchup's judged tip, so the tip row steps aside; a tip nothing judged is no listed result and keeps its row. */
function dataRows(theme: UiTheme, response: GatewayResponse, shown: Listed[] = []): Row[] {
	const data = response.data;
	switch (response.operation) {
		case "research_web_search":
		case "player_audit":
		case "otp_build":
		case "remember":
		case "command_frame":
			return [];
		case "research_video": {
			if (shown.length) return [];
			// Expanded only: what each speaker said, with the minute it was said at, so the player can open the video there.
			const videos: any[] = Array.isArray(data.videos) ? data.videos : [];
			return videos.flatMap((video) => [
				sub("", `${theme.fg("accent", asText(video?.title))} ${theme.fg("dim", `${asText(video?.published)}${video?.autoCaptions ? " · auto captions" : ""}`)}`),
				...(Array.isArray(video?.passages) ? video.passages : []).map((passage: any) => sub(`${SUB_INDENT}${theme.fg("dim", `${Math.floor((Number(passage?.at) || 0) / 60)}:${String((Number(passage?.at) || 0) % 60).padStart(2, "0")}`)} `, asText(passage?.text))),
			]);
		}
		case "gamedata.lookup": {
			const entities = Array.isArray(data.entities) ? data.entities : [];
			return entities.map((entity: any) => sub("", `${theme.fg("accent", asText(entity?.name))}: ${asText(entity?.fact)}`));
		}
		case "meta.matchup":
			return [
				sub("", `${theme.fg("accent", "lane")}: ${asText(data.laneAdvantage)} · solo kills ${asText(data.soloKillAdvantage)} · play ${asText(data.playStyle)} · patch ${asText(data.patch)}`),
				...(shown.some((item) => item.tipOf !== undefined) ? [] : [sub("", `${theme.fg("accent", "tip")}: ${asText(data.tip)}`)]),
				sub("", `${asText(data.sample)} · ${asText(data.staleness)}`),
				...matchupNoteRows(theme, data.notes),
			];
		case "meta.champion_overview":
		case "meta.tier_list":
		case "meta.synergy":
		case "meta.top_players":
		case "meta.pro_player_riot_id":
			return [sub("", `${asText(data.sample)} · ${asText(data.staleness)}`)];
		case "strategy_frame":
			return claimRows(theme, data);
	}
}

/** Source text. The retrieved date shows only expanded; a shortfall (2 of 3 games) always shows. */
/** Collapsed matchup card: says the call also rests on matchup videos and guides, or that those notes are still being built, so the player knows whether to ask again in a minute. */
function noteCount(data: Record<string, unknown>): string {
	const rows = (data.notes as { rows?: unknown } | undefined)?.rows;
	const count = Array.isArray(rows) && rows.length ? ` · ${rows.length} matchup notes` : "";
	return `${count}${data.notesBuilding ? " · notes building" : ""}`;
}

/** The stored matchup note, expanded card only: where it came from, then each row with how many of its authors say it. */
function matchupNoteRows(theme: UiTheme, notes: unknown): Row[] {
	const note = notes as { source?: unknown; built?: unknown; rows?: unknown } | undefined;
	const rows: any[] = Array.isArray(note?.rows) ? note.rows : [];
	if (!rows.length) return [];
	// "2 of 4": how many of the note's authors say the row, so one voice and a consensus read differently.
	const authors = /by (\d+) author/.exec(asText(note?.source))?.[1] ?? "?";
	return [
		sub("", `${theme.fg("accent", "notes")}: ${asText(note?.source)} · built ${asText(note?.built)}`),
		...rows.map((row) => sub(`${SUB_INDENT}${theme.fg("dim", `${asText(row?.kind)} ·`)} `, `${asText(row?.text)} ${theme.fg("dim", `(${asText(row?.authors)} of ${authors})`)}`)),
	];
}

function sourceText(response: GatewayResponse, expanded: boolean, detail: CardDetail): string {
	const data = response.data;
	const retrieved = expanded && typeof data.retrievedAt === "string" ? ` · retrieved ${data.retrievedAt.slice(0, 10)}` : "";
	const count = response.evidence.length;
	switch (response.operation) {
		case "research_web_search":
			// Collapsed: how many results the coach may use, and how many Jev took out. Titles and the provider wait for the expanded card.
			if (!expanded) {
				const removed = Array.isArray((data.judgment as { removed?: unknown[] } | undefined)?.removed) ? (data.judgment as { removed: unknown[] }).removed.length : 0;
				return `${count} result${count === 1 ? "" : "s"}${removed ? ` · ${removed} removed` : ""}`;
			}
			return `live web (${asText(data.provider)}) · ${count} result${count === 1 ? "" : "s"}${retrieved}`;
		case "research_video": {
			// Collapsed: how many videos the coach may use, and what cut the read short. A deadline or a throttle explains a thin answer.
			const removed = Array.isArray((data.judgment as { removed?: unknown[] } | undefined)?.removed) ? (data.judgment as { removed: unknown[] }).removed.length : 0;
			const summary = `${count} video${count === 1 ? "" : "s"}${removed ? ` · ${removed} removed` : ""}${data.timedOut ? ` · ${data.timedOut} timed out` : ""}${data.rateLimited ? " · YouTube rate limit" : ""}`;
			return expanded ? `${asText(data.provider)} · ${summary} · third-party${retrieved}` : summary;
		}
		case "gamedata.lookup":
			return `Data Dragon ${asText(data.patch)}${retrieved}`;
		case "meta.champion_overview":
		case "meta.matchup":
		case "meta.tier_list":
		case "meta.synergy":
		case "meta.top_players":
		case "meta.pro_player_riot_id":
			// Collapsed: who and which sample, the two facts that set how far to trust the number. Expanded: the provider string as returned.
			return expanded ? `${asText(data.provider)} · ${asText(data.sample)} · third-party${retrieved}` : `OP.GG · ${asText(data.sample).replace(/ \(OP\.GG default\)$/, "")}${response.operation === "meta.matchup" ? noteCount(data) : ""}`;
		case "strategy_frame": {
			// The verdict as one count, on every card up to the claims level. The goal sentence is the model's own restatement of the question, so it waits for the full card.
			if (detail === "full") return asText(data.goal);
			const claims: any[] = Array.isArray(data.claims) ? data.claims : [];
			const judged = (data.judgment as { status?: string } | undefined)?.status === "judged";
			if (!judged) return "not checked";
			const count = (route: string) => claims.filter((entry) => entry?.route === route).length;
			return [`${count("grounded")} grounded`, count("unsupported") ? `${count("unsupported")} unsupported` : "", count("disputed") ? `${count("disputed")} disputed` : "", count("contradicted") ? `${count("contradicted")} contradicted` : ""].filter(Boolean).join(" · ");
		}
		case "player_audit": {
			const shortfall = data.analyzed !== data.requested ? ` · ${asText(data.analyzed)} of ${asText(data.requested)} games` : "";
			return `Riot match history · patch ${Array.isArray(data.patches) ? data.patches.join(", ") : asText(data.patches)}${shortfall}${retrieved}`;
		}
		case "otp_build": {
			const shortfall = data.analyzed !== data.requested ? ` · ${asText(data.analyzed)} of ${asText(data.requested)} games` : "";
			return `Riot match history (${asText(data.cluster)}) · ${asText(data.record)} · patch ${Array.isArray(data.patches) ? data.patches.join(", ") : asText(data.patches)}${shortfall}${retrieved}`;
		}
		case "remember":
			return `saved to ${asText(data.riotId)}'s memory`;
		// The player sees why the coach had, or lacked, another frame (AGENTS.md rule 2).
		case "command_frame":
			return typeof data.unavailable === "string" ? `not loaded: ${asText(data.unavailable)}` : "loaded for this answer, not sent";
	}
}

/** One row per game: result, opponent, KDA, rune shape, then the item order with minutes; the recurring block follows when expanded. */
function otpRows(theme: UiTheme, response: GatewayResponse, expanded: boolean): Row[] {
	const games: any[] = Array.isArray(response.data.games) ? response.data.games : [];
	const rows = games.map((game) => {
		const result = theme.fg(game.win ? "success" : "error", game.win ? "W" : "L");
		const runes = game.runes ? `${asText(game.runes.keystone)} ${theme.fg("dim", `${asText(game.runes.primary)}/${asText(game.runes.secondary)}`)}` : "";
		const items = Array.isArray(game.items) ? game.items.slice(0, expanded ? undefined : 4).join(theme.fg("dim", " → ")) : "";
		return labelled(theme, "", `${result} ${theme.fg("accent", `vs ${asText(game.vs)}`)} ${asText(game.kda)} · ${runes} · ${items}`);
	});
	if (!expanded) return rows;
	const recurring: any = response.data.recurring ?? {};
	const top = (entries: unknown) => (Array.isArray(entries) ? entries.slice(0, 3).map((entry: any) => `${asText(entry.value)} ×${asText(entry.count)}`).join(theme.fg("dim", " · ")) : "");
	return [
		...rows,
		labelled(theme, "runes", top(recurring.primaryRunes)),
		labelled(theme, "second", top(recurring.secondaryRunes)),
		labelled(theme, "shards", top(recurring.shards)),
		labelled(theme, "start", top(recurring.firstThreeItems)),
		labelled(theme, "skills", top(recurring.skillMax)),
	];
}

/** Which colour a card draws in: the grounding check and errors have their own, every lookup shares one. */
function cardKind(name: ToolName, view?: ToolResultView): BlockKind {
	return view?.errorText ? "error" : name === "voxren_strategy_frame" ? "check" : "lookup";
}

/** First row of every card: short name, the call's arguments, then the source. */
function headRow(theme: UiTheme, name: ToolName, args: Record<string, unknown> | undefined, source: string | undefined, role: string, expanded = false): Row {
	const parts = [stripTerminalControl(summarizeArgs(name, args, expanded)), source ? theme.fg("warning", source) : ""].filter(Boolean);
	return { head: header(theme, role, SHORT_NAME[name]), body: parts.join(` ${theme.fg("dim", "·")} `) };
}

/** The first row of a card as plain text, before the bar. */
export function toolCallLines(theme: UiTheme, name: ToolName, args: Record<string, unknown> | undefined, source?: string): string[] {
	return flat([headRow(theme, name, args, source, BLOCK_ROLE.lookup)]);
}

/** Every row of a finished card at one level of detail. `width` is the pane width less the card's margin; the bar takes two more cells. */
function toolResultRows(theme: UiTheme, name: ToolName, args: Record<string, unknown> | undefined, view: ToolResultView, detail: CardDetail, width = 80): Row[] {
	const role = BLOCK_ROLE[cardKind(name, view)];
	const expanded = detail !== "brief";
	if (view.errorText) return [headRow(theme, name, args, undefined, role, expanded), sub("", theme.fg("error", view.errorText))];
	if (!view.response) return [headRow(theme, name, args, undefined, role, expanded), sub("", theme.fg("dim", "no response"))];
	const response = view.response;
	// Builders that size their own rows (the audit table, Jev's question blocks) get what is left of the pane after the bar.
	const inner = width - EDGE_CELLS;
	const frame = response.operation === "strategy_frame";
	// At the claims level a search, video, or meta card lists each result once (judged or not) and a check lists each claim once, so the rows that restate them (the evidence rows, the video list, the claim list, the contract line) step aside.
	const items = detail === "claims" ? listedItems(response) : [];
	// Evidence rows restate the source: one row per card until expanded, a web search included (its count is on the first row).
	const rows = [headRow(theme, name, args, sourceText(response, expanded, detail), role, expanded), ...(expanded && !items.length ? evidenceRows(theme, response, expanded) : [])];
	// The exact upstream call, expanded only: collapsed cards stay short, and the raw OP.GG request is never the first thing shown.
	if (expanded && typeof response.data.request === "string") rows.push(labelled(theme, "request", theme.fg("dim", response.data.request)));
	// The judgment row shows collapsed too: the frame's grounded count is on its first row and its flagged claims get a row below.
	const screen = judgmentLine(theme, response);
	if (screen) rows.push(sub("", screen));
	if (response.operation === "player_audit") rows.push(...auditRows(theme, response, expanded, inner));
	else if (response.operation === "otp_build") rows.push(...otpRows(theme, response, expanded));
	else if (detail === "claims" && frame) rows.push(...claimDetailRows(theme, response.data), ...sourceRows(theme, response.data));
	else if (expanded) rows.push(...dataRows(theme, response, items));
	else if (frame) rows.push(...claimRows(theme, response.data, true));
	if (detail === "claims") rows.push(...passageRows(theme, items));
	if (detail === "full") rows.push(...jevLines(theme, response, inner - SUB_INDENT.length).map((line) => sub("", line, true)));
	// The contract row is for debugging: the full level shows it, and a card no decision model reads has no list to put in its place and keeps it.
	if (detail === "full" || (expanded && !JUDGED_OPERATIONS.has(response.operation))) rows.push(sub("", theme.fg("dim", `contract ${response.version} · ${response.operation} · ${name}`)));
	return rows;
}

/** A finished card as plain text, before the bar and the wrap: what its rows say. An expanded card draws at `detail`, the launch's card level. */
export function toolResultLines(theme: UiTheme, name: ToolName, args: Record<string, unknown> | undefined, view: ToolResultView, expanded: boolean, width = 80, detail: CardDetail = "claims"): string[] {
	return flat(toolResultRows(theme, name, args, view, expanded ? detail : "brief", width));
}

// --- card motion -----------------------------------------------------------------

/** One spinner step: 80 ms, about twelve a second, quick enough to read as work in flight. */
export const FRAME_MS = 80;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * The clock and the repaint timer behind a pending card's spinner and elapsed time. One timer serves every card
 * on the screen, so four calls dispatched together tick together. Off until a session with a UI turns it on:
 * print mode and a headless run draw static lines and start nothing.
 */
export interface CardMotion {
	now(): number;
	/** True only while a UI is attached. */
	readonly live: boolean;
	/** Switching it off stops everything that is running. */
	enable(on: boolean): void;
	/** Calls `repaint` every frame until the returned function runs. While not live it starts nothing. */
	watch(repaint: () => void): () => void;
	/** Ends every watch and the timer behind them: the turn is over, or the session is. Safe to call twice. */
	stop(): void;
	/** Pi's tool_execution_start and tool_execution_end handlers record when a call ran, by Pi's toolCallId. A card for a call never recorded (an /export, a resumed transcript) shows no time and starts no timer. */
	callStarted(toolCallId: string): void;
	callEnded(toolCallId: string): void;
	callTiming(toolCallId: string): { start: number; end?: number } | undefined;
}

export function createCardMotion(clock: { now?: () => number; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval } = {}): CardMotion {
	const { now = Date.now, setInterval: start = setInterval, clearInterval: cancel = clearInterval } = clock;
	const watchers = new Set<() => void>();
	const calls = new Map<string, { start: number; end?: number }>();
	let live = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = () => {
		watchers.clear();
		if (timer !== undefined) cancel(timer);
		timer = undefined;
	};
	return {
		now,
		get live() {
			return live;
		},
		enable(on) {
			live = on;
			if (!on) stop();
		},
		watch(repaint) {
			if (!live) return () => {};
			watchers.add(repaint);
			if (timer === undefined) {
				timer = start(() => watchers.forEach((tick) => tick()), FRAME_MS);
				// Housekeeping nothing awaits: a repaint timer must never be what keeps a run or an exiting coach alive.
				(timer as { unref?: () => void }).unref?.();
			}
			return () => {
				watchers.delete(repaint);
				if (!watchers.size) stop();
			};
		},
		stop,
		callStarted: (toolCallId) => void calls.set(toolCallId, { start: now() }),
		callEnded(toolCallId) {
			const call = calls.get(toolCallId);
			if (call) call.end = now();
		},
		callTiming: (toolCallId) => calls.get(toolCallId),
	};
}

/** What a card drawn without a session (a test, a resumed transcript) uses: no clock ticks and nothing repaints. */
const STILL = createCardMotion();

// --- card rendering ---------------------------------------------------------------

/** The marker and elapsed time between a card's label and its value: eight cells, so the value never moves when the card finishes. */
interface CardStatus {
	mark: string;
	role: string;
	ms?: number;
}

/** `0.4s`, `12.3s`, `1m05s`: five cells for any turn under ten minutes. */
function elapsedText(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

function statusCell(theme: UiTheme, status: CardStatus): string {
	const time = status.ms === undefined ? "" : elapsedText(status.ms);
	return `${theme.fg(status.role, status.mark)} ${theme.fg("dim", time.padEnd(5))} `;
}

/** A card as drawn: its rows behind the kind's bar, the first row carrying the status, one cell in from the pane edge. */
function cardLines(theme: UiTheme, role: string, rows: Row[], status: CardStatus, width: number): string[] {
	const [first, ...rest] = rows;
	const margin = " ".repeat(CARD_MARGIN);
	// Every row of a tool card wraps with its separators kept at line ends: the first row, the judgment row, a score line.
	return barLines(theme, role, [{ ...first, head: `${first.head}${statusCell(theme, status)}` }, ...rest].map((row) => ({ ...row, glue: true })), width - CARD_MARGIN).map((line) => `${margin}${line}`);
}

/** Shared between the call and result renders of one tool row; the result render hides the pending call row. */
export interface ToolRenderState {
	state: { done?: boolean; startedAt?: number; endedAt?: number; unwatch?: () => void };
	invalidate(): void;
	/** Pi's id for this call; with it, a card times itself only from what the tool handlers recorded (CardMotion.callTiming). */
	toolCallId?: string;
	/** Pi's flag: false while the model is still writing the call's arguments, true once the call runs. */
	executionStarted?: boolean;
}

/** The pending card: its marker spins and its time runs from the moment Pi starts the call, until the result card takes its place. */
export function createToolCall(theme: UiTheme, name: ToolName, args: Record<string, unknown> | undefined, context?: ToolRenderState, motion: CardMotion = STILL): UiComponent {
	const state = context?.state;
	const timing = context?.toolCallId === undefined ? undefined : motion.callTiming(context.toolCallId);
	// A call Pi names but the handlers never saw run has no real clock: no time, no timer.
	const unseen = context?.toolCallId !== undefined && !timing;
	if (context && state && !state.done && context.executionStarted && !unseen) {
		state.startedAt ??= timing?.start ?? motion.now();
		state.unwatch ??= motion.watch(() => context.invalidate());
	}
	const role = BLOCK_ROLE[cardKind(name)];
	// Cards that start in the same frame would spin in step: each tool begins its spinner a few steps along.
	const phase = [...name].reduce((sum, letter) => sum + letter.charCodeAt(0), 0);
	return component((width) => {
		if (state?.done) return [];
		const started = state?.startedAt;
		const status: CardStatus =
			started === undefined
				? { mark: "○", role: "dim" }
				: motion.live
					? { mark: SPINNER[(Math.floor((motion.now() - started) / FRAME_MS) + phase) % SPINNER.length], role, ms: motion.now() - started }
					: { mark: "…", role };
		// What it is fetching, quiet until the result lands.
		return cardLines(theme, role, [{ head: header(theme, role, SHORT_NAME[name]), body: theme.fg("muted", stripTerminalControl(summarizeArgs(name, args))) }], status, width);
	});
}

/** The finished card: ✓ or ✗, the time the call took, then its rows. Taking over from the pending card ends that card's repaint. An expanded card draws at `detail`, the launch's card level. */
export function createToolResult(theme: UiTheme, name: ToolName, args: Record<string, unknown> | undefined, view: ToolResultView, expanded: boolean, context?: ToolRenderState, motion: CardMotion = STILL, detail: CardDetail = "claims"): UiComponent {
	const state = context?.state;
	if (context && state && !state.done) {
		state.done = true;
		const timing = context.toolCallId === undefined ? undefined : motion.callTiming(context.toolCallId);
		if (timing) state.startedAt ??= timing.start;
		state.endedAt = timing?.end ?? motion.now();
		state.unwatch?.();
		state.unwatch = undefined;
		queueMicrotask(() => context.invalidate()); // after this render pass, so the pending call row disappears
	}
	const kind = cardKind(name, view);
	const level = expanded ? detail : "brief";
	return component((width) => {
		const ms = state?.startedAt === undefined ? undefined : (state.endedAt ?? motion.now()) - state.startedAt;
		// A tick says the call finished, not that the check passed: a frame nothing judged shows a warning, so the player states its rows as unverified.
		const unchecked = view.response?.operation === "strategy_frame" && (view.response.data.judgment as { status?: string } | undefined)?.status !== "judged";
		const status: CardStatus = view.errorText ? { mark: "✗", role: "error", ms } : unchecked ? { mark: "!", role: "warning", ms } : { mark: "✓", role: "success", ms };
		const text = cardLines(theme, BLOCK_ROLE[kind], toolResultRows(theme, name, args, view, level, width - CARD_MARGIN), status, width);
		// Image rows are not framed: the image covers their cells, and a space written over a Sixel cell erases it.
		const images = view.response ? auditImageRows(view.response, level !== "brief", width) : undefined;
		return images ? [...text, ...images] : text;
	});
}

/** Derive the view model from a tool result without trusting its shape. */
export function toolResultView(result: { content?: Array<{ type: string; text?: string }>; details?: any }): ToolResultView {
	const response = result?.details?.response;
	if (response && typeof response === "object" && Array.isArray(response.evidence)) return { response: response as GatewayResponse };
	const text = result?.content?.find((block) => block.type === "text")?.text ?? "";
	return { errorText: text.startsWith("ERROR[") ? text : text || "no response" };
}

// --- working text -------------------------------------------------------------

const WORKING_VERBS: Record<ToolName, string> = {
	web_search: "Searching the web",
	voxren_video_research: "Reading video transcripts",
	voxren_game_facts: "Reading Data Dragon",
	voxren_meta_research: "Reading OP.GG meta",
	voxren_strategy_frame: "Framing the call",
	voxren_player_audit: "Pulling Riot match history",
	voxren_otp_build: "Reading the one-trick's games",
	voxren_remember: "Saving that",
	voxren_command_frame: "Loading a frame",
};

/** Text beside Pi's spinner while one tool runs; Pi's own pending card already lists the call. */
export function workingMessage(name: ToolName, args: Record<string, unknown> | undefined): string {
	const summary = stripTerminalControl(summarizeArgs(name, args));
	return summary ? `${WORKING_VERBS[name]} · ${summary}` : WORKING_VERBS[name];
}

/** A tool's card name and its working verb, for the one other surface that names tools (the command tree). */
export function toolShortName(name: ToolName): string {
	return SHORT_NAME[name];
}
export function toolVerb(name: ToolName): string {
	return WORKING_VERBS[name];
}

// --- transcript text ----------------------------------------------------------

/**
 * The player's own line as a Markdown quote: Pi draws a quote's left bar where it used to paint a background band.
 * A line the player began with `>` would read as a quote inside the quote, with a second bar and no `>`; a
 * zero-width space after our marker keeps it text, and Pi draws the `>` the player typed.
 */
export function quoteUserText(markdown: string): string {
	return markdown.trim() ? markdown.split("\n").map((line) => (line ? `> ${/^ {0,3}>/.test(line) ? "\u200b" : ""}${line}` : ">")).join("\n") : markdown;
}

/** An answer's row: one capitalised word, a colon, the call ("Lane: Ezreal Q missed: E in"). A label the model wrote in bold is still one. */
export const ANSWER_ROW = /^(?:\*\*)?([A-Z][A-Za-z]{1,7}):(?:\*\*)?[ \t]+(\S.*)$/;
/** Lines Markdown gives a shape of their own (a list, a heading, a quote, a table, a rule, indented code): left as written. */
const OWN_SHAPE = /^(?:\s*(?:[-*+]|\d+[.)])\s|\s*[#>|]|\s{4,}|\s*(?:---|\*\*\*|___)\s*$)/;
/** A cue is the words before a call's first colon, up to ten of a row's sixteen; a longer clause before a colon is a sentence, not a cue. */
export const CUE_WORDS = 10;
/** One capitalised word, with or without its colon: a row's label arriving, or a sentence's first word. */
const LONE_WORD = /^(?:\*\*)?[A-Z][A-Za-z]{1,7}:?(?:\*\*)?$/;

/**
 * The coach's answer laid out like the cards above it. A row's label goes to the cards' label column in the lookups'
 * colour, its cue (the words before the call's first colon) takes the colour the cards give a finding, and the call
 * wraps under itself; prose starts at the label column. Pi's Markdown draws what comes back, so the bold and italics
 * the model wrote still draw; it strips a line's leading spaces, so every indent here is no-break spaces.
 * While the answer streams, the line being written holds back words that could still turn out to be a label or a
 * cue, so text never changes place or colour once it is on screen; the finished answer draws everything.
 */
export function answerMarkdown(markdown: string, width: number, theme: UiTheme, streaming = false): string {
	const margin = "\u00a0".repeat(EDGE_CELLS);
	const hang = "\u00a0".repeat(EDGE_CELLS + LABEL_WIDTH);
	let fenced = false;
	// A Setup row keeps only the swaps whose two sides are different Data Dragon names (#367).
	return gateSetupRows(markdown, knownNames(), streaming)
		.split("\n")
		.map((line, index, lines) => {
			if (/^\s*(?:```|~~~)/.test(line)) {
				fenced = !fenced;
				return line;
			}
			if (fenced || !line.trim() || OWN_SHAPE.test(line)) return line;
			// The line still being written. One word alone may be a label or the start of a sentence: nothing draws until the next word says which.
			const pending = streaming && index === lines.length - 1;
			if (pending && LONE_WORD.test(line.trim())) return "";
			// ponytail: wrapped with the emphasis marks counted as cells, so a line with bold in it ends up to four cells early, never late.
			const row = isBuildFormatLine(line) ? null : ANSWER_ROW.exec(line.trim());
			if (!row) return wrapTextWithAnsi(line.trim(), Math.max(1, width - EDGE_CELLS)).map((part) => `${margin}${part}`).join("\n");
			const [, label, call] = row;
			const colon = call.indexOf(": ");
			// Still being written, with no colon yet and few enough words to be a cue: only the label draws, so the words never change colour.
			if (pending && colon < 0 && call.split(/\s+/).length <= CUE_WORDS) return `${margin}${header(theme, BLOCK_ROLE.lookup, label).trimEnd()}`;
			const cue = colon > 0 && call.slice(0, colon).split(/\s+/).length <= CUE_WORDS ? call.slice(0, colon) : "";
			const body = cue ? `${theme.fg("warning", cue)}  ${call.slice(colon + 2).trimStart()}` : call;
			const head = `${margin}${header(theme, BLOCK_ROLE.lookup, label).replace(/ /g, "\u00a0")}`;
			return wrapTextWithAnsi(body, Math.max(1, width - EDGE_CELLS - LABEL_WIDTH)).map((part, index) => `${index ? hang : head}${part}`).join("\n");
		})
		.join("\n");
}

/**
 * The answer for print mode, where no Markdown draws: the bold and italic marks the model wrote go, the words stay.
 * Only a pair of marks around words is emphasis; a list bullet, a product ("2 * 3"), or a lone mark is left alone.
 */
export function withoutEmphasis(markdown: string): string {
	// ponytail: fenced code is not skipped, since a coach answer carries none; walk the fences as answerMarkdown does if one ever does.
	return markdown.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1").replace(/(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?![*\w])/g, "$1");
}

const THINK_SEPARATOR = " › ";

/** What Pi draws for a thinking run once the player has hidden it with Ctrl+T (the coach launches with it shown): the same bar and label as the visible line. */
export const HIDDEN_THINKING_LABEL = `${BAR} ${"THINK".padEnd(LABEL_WIDTH)}…`;

/**
 * One compact line for a run of thinking summaries: the bar, THINK, then each summary's title in order. Pi gives
 * the model's summaries to this as one Markdown text, joined by blank lines, and renders what comes back in italic
 * in the theme's thinking colour. A line too long for the pane drops its oldest titles, so the newest stays on screen.
 */
export function thinkingMarkdown(markdown: string, width: number): string {
	const paragraphs = stripTerminalControl(markdown).split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
	// A summary leads with its bold title; thinking with no titles gives each paragraph's first line.
	const titled = paragraphs.filter((paragraph) => paragraph.startsWith("**"));
	// Markdown would read brackets as a link or LaTeX, so those and backslashes, backticks and dollar signs are dropped from the words.
	const parts = (titled.length ? titled : paragraphs)
		.map((paragraph) => (titled.length ? /^\*\*([^*\n]*)/.exec(paragraph)![1] : paragraph.split("\n")[0].replace(/^[#>\s]+/, "")).replace(/[\\`\[\]$]/g, "").trim())
		.filter(Boolean);
	if (!parts.length) return "";
	const room = Math.max(1, width - EDGE_CELLS - LABEL_WIDTH);
	let shown = parts;
	let text = shown.join(THINK_SEPARATOR);
	while (shown.length > 1 && visibleWidth(text) > room) {
		shown = shown.slice(1);
		text = `… ${shown.join(THINK_SEPARATOR)}`;
	}
	// The cut text is plain; pi-tui's cut brings reset codes of its own, which are dropped. Emphasis marks and tags are
	// escaped, and so is the dot of `www.`: Markdown would turn that host into a link and print its address after it, past the width measured here.
	const safe = stripTerminalControl(truncateToWidth(text, room, "…")).replace(/[*_~<>]/g, "\\$&").replace(/www\./gi, "www\\.");
	return `${BAR} **THINK**${" ".repeat(LABEL_WIDTH - "THINK".length)}${safe}`;
}
