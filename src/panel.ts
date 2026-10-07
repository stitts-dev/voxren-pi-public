/**
 * The coach panel: a finished answer drawn as boxed sections (docs/superpowers/specs/2026-10-06-coach-panel-design.md).
 * `panelModel` sorts the answer's call rows into this phase's box and the other's, and reads its build and swaps;
 * the drawing lives below it. Presentation only: what the rows say is the model's, which box they go in is decided here.
 */
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bareItem, type BuildLines, buildLines, isBuildFormatLine, SWAP } from "./build-lines";
import { greyIconLine, iconLine, type IconKind, knownNames } from "./icons";
import type { LivePanelFacts } from "./lcu";
import { setupSwaps } from "./setup-swaps";
import { fitInlineIcons, hasInlineIcon, iconRows, INLINE_ICON } from "./terminal-images";
import { ANSWER_ROW, CARD_MARGIN, chip, CUE_WORDS, packPieces, type UiComponent, type UiTheme, withoutEmphasis } from "./ui";

export type CallRow = { label: string; cue: string; action: string; champions: string[] };
export type SwapRow = { from: string; to: string; how: "instead of" | "before"; reason: string };
export type Box = { title: string; colour: string; quiet: boolean; rows: CallRow[] };
export type PanelModel = { boxes: Box[]; build?: BuildLines; swaps: SwapRow[]; owned: string[]; next?: string; clock?: string; status: string };

/** Under this game time the lane calls are the ones that matter now; from it, the fights. */
export const LANING_UNTIL_SEC = 14 * 60;

export const COLOURS = {
	now: "#5fd4ff",
	quiet: "#8592ad",
	build: "#ffc24d",
	swap: "#ff8f66",
	fights: "#d9a4ff",
	threat: "#ff8f66",
	kill: "#8ee07a",
	lane: "#8592ad",
	cue: "#a3acbf",
	action: "#ffffff",
	keyText: "#0f1420",
} as const;

const LANING = new Set(["Lane", "Kill", "Gank", "Side", "Matchup"]);
const LATER = new Set(["Fights", "Macro", "Win", "Edge"]);
/** The coach's call labels (coach.yaml's frames); any other "Word:" line is prose and stays where it was written. */
const CALLS = new Set([...LANING, ...LATER, "Answer", "Threat", "Now", "Next", "Buy", "Dodge", "Setup"]);
const SETUP = /^Setup$/i;
/** A line's call label, when it is one of the coach's calls. */
const callLabel = (line: string) => {
	const label = ANSWER_ROW.exec(line.trim())?.[1];
	return label && CALLS.has(label) ? label : undefined;
};

const squeezed = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const clockText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Where `name` first appears in `text` as a whole word, or -1. */
function wordAt(text: string, name: string): number {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![A-Za-z'])${escaped}(?![A-Za-z'])`).exec(text)?.index ?? -1;
}

function callRow(label: string, call: string, champions: string[]): CallRow {
	const colon = call.indexOf(": ");
	const cue = colon > 0 && call.slice(0, colon).split(/\s+/).length <= CUE_WORDS ? call.slice(0, colon) : "";
	const named = champions.map((name) => [name, wordAt(call, name)] as const).filter(([, at]) => at >= 0);
	return { label, cue, action: cue ? call.slice(colon + 2).trimStart() : call, champions: named.sort((a, b) => a[1] - b[1]).map(([name]) => name) };
}

function buildSwap(text: string): SwapRow | undefined {
	const match = SWAP.exec(text);
	if (!match) return undefined;
	const [, first, how, second, rest = ""] = match;
	return { from: bareItem(second.trim()), to: bareItem(first.trim()), how: how.toLowerCase() === "before" ? "before" : "instead of", reason: rest.replace(/^,\s*into\s+/i, "").trim() };
}

/** The answer's calls, build, and swaps, sorted for the panel. `champions` are the names Data Dragon found in the answer (`championsIn`). */
export function panelModel(answer: string, facts: { champions: string[]; live?: LivePanelFacts; status: string }): PanelModel {
	const late = (facts.live?.gameTimeSec ?? 0) >= LANING_UNTIL_SEC;
	const now: CallRow[] = [];
	const quiet: CallRow[] = [];
	const swaps: SwapRow[] = [];
	for (const line of answer.split("\n")) {
		if (isBuildFormatLine(line) || !callLabel(line)) continue;
		const [, label, call] = ANSWER_ROW.exec(line.trim())!;
		if (SETUP.test(label)) {
			for (const swap of setupSwaps(call, knownNames()).filter((swap) => swap.verdict === "ok")) {
				swaps.push({ from: swap.from, to: swap.to, how: "instead of", reason: /\bbecause\s+(.*)$/i.exec(swap.text)?.[1] ?? "" });
			}
			continue;
		}
		const elsewhere = late ? LANING.has(label) : LATER.has(label);
		(elsewhere ? quiet : now).push(callRow(label, call, facts.champions));
	}
	// A champion every call names (two calls or more) is the player's own: the rows are about the others, so no row keys on them.
	const calls = [...now, ...quiet];
	const own = calls.length >= 2 ? facts.champions.filter((name) => calls.every((row) => row.champions.includes(name))) : [];
	for (const row of calls) row.champions = row.champions.filter((name) => !own.includes(name));
	const build = buildLines(answer);
	for (const text of build?.swaps ?? []) {
		const swap = buildSwap(text);
		if (swap) swaps.push(swap);
	}
	const clock = facts.live ? clockText(facts.live.gameTimeSec) : undefined;
	const boxes: Box[] = [];
	if (now.length) boxes.push({ title: clock ? `NOW · ${clock}` : "NOW", colour: COLOURS.now, quiet: false, rows: now });
	if (quiet.length) boxes.push({ title: late ? "LANING" : "LATER", colour: COLOURS.quiet, quiet: true, rows: quiet });
	// Bought means at or before the last path item the player holds: a starter sold or a potion drunk is behind them, not next.
	const path = (build?.build ?? []).flat().map(bareItem);
	const singular = (name: string) => squeezed(name).replace(/s$/, "");
	const have = new Set((facts.live?.ownedItems ?? []).map(singular));
	const last = facts.live ? path.reduce((at, item, index) => (have.has(singular(item)) ? index : at), -1) : -1;
	const owned = path.slice(0, last + 1);
	const next = facts.live ? path[last + 1] : undefined;
	return { boxes, ...(build && { build }), swaps, owned, ...(next && { next }), ...(clock && { clock }), status: facts.status };
}

/** The lines the panel draws in the answer's place: its call rows, and its build lines when a Runes or Build line gives it a build to draw. */
function drawnByPanel(answer: string): (line: string) => boolean {
	const build = buildLines(answer) !== undefined;
	return (line) => (isBuildFormatLine(line) ? build : callLabel(line) !== undefined);
}

/** True when the answer has calls or a build for the panel to draw. */
export function hasPanelContent(answer: string): boolean {
	return answer.split("\n").some(drawnByPanel(answer));
}

/** The answer without the lines its panel draws: its prose, which still shows above the panel. */
export function withoutPanelRows(answer: string): string {
	const drawn = drawnByPanel(answer);
	return answer
		.split("\n")
		.filter((line) => !drawn(line))
		.join("\n")
		.trim();
}

// --- drawing ----------------------------------------------------------------------------------------------------------

/** A run of a row and the cells it steps over (an inline icon's bytes are not its width). */
type Piece = { s: string; w: number };
type BoxLine = { label: Piece; body: Piece };
export type PanelOptions = { header?: { self?: string; opponent?: string; detail: string }; ownPicks?: string[] };

/** The label column: seven cells, five below 40 columns, where the call needs the room more than the label. */
const labelWidth = (width: number) => (width < 40 ? 5 : 7);
/** Below this many columns a call draws no portraits; above it, portraits give way until the words keep this much room. */
const FACES_FROM = 40;
const WORDS_ROOM = 16;
const GLYPH = 3;
/** Side by side from this many columns; narrower, the boxes stack. */
const WIDE = 130;
const FAINT = "#6b7488";
const LANE_TEXT = "#c3cad8";
const RESET = "\x1b[0m";
const GLYPHS: Record<string, string> = { Fights: "⚔", Threat: "⚠" };
const LABEL_COLOURS: Record<string, string> = { Fights: COLOURS.fights, Threat: COLOURS.threat, Kill: COLOURS.kill, Lane: COLOURS.lane };

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";");
const fg = (hex: string, s: string) => `\x1b[38;2;${rgb(hex)}m${s}\x1b[39m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const text = (s: string): Piece => ({ s, w: visibleWidth(s) });
const blank = (w: number): Piece => ({ s: " ".repeat(Math.max(0, w)), w: Math.max(0, w) });
const pad = (p: Piece, w: number) => p.s + " ".repeat(Math.max(0, w - p.w));
const joined = (pieces: Piece[], gap = " "): Piece => ({ s: pieces.map((p) => p.s).join(gap), w: pieces.reduce((t, p) => t + p.w, 0) + visibleWidth(gap) * Math.max(0, pieces.length - 1) });
const asPiece = (c: { shown: string; width: number }): Piece => ({ s: c.shown, w: c.width });
/** Cells a packed row steps over: its text, with each inline icon counted as its step, never its bytes. */
const rowWidth = (row: string) => visibleWidth(row.replace(INLINE_ICON, (_m, n) => " ".repeat(Number(n))));

/** `body` with each ability key a key cap and each champion it names bold, white, and underlined; `base` is the style around them. */
function rich(body: string, champions: string[], base: string): string {
	const names = champions.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const token = new RegExp(`(?<![A-Za-z'])(?:${[...names, "[QWER]"].join("|")})(?![A-Za-z'])`, "g");
	const marked = withoutEmphasis(body).replace(token, (match) =>
		champions.includes(match)
			? `\x1b[1m\x1b[38;2;255;255;255m\x1b[4m${match}${RESET}${base}`
			: `\x1b[48;2;${rgb(COLOURS.now)}m\x1b[38;2;${rgb(COLOURS.keyText)}m\x1b[1m ${match} \x1b[49m${RESET}${base}`,
	);
	return `${base}${marked}${RESET}`;
}

function box(title: string, colour: string, width: number, lines: BoxLine[]): string[] {
	const inner = width - 4;
	const label = labelWidth(width);
	const room = inner - label - 1;
	const head = `${fg(colour, "┏━")} ${bold(fg(colour, title))} ${fg(FAINT, "─".repeat(Math.max(0, width - visibleWidth(title) - 5)))}${fg(FAINT, "╮")}`;
	const rows = lines.map((line) => `${fg(colour, "┃")} ${pad(line.label, label)} ${pad(line.body, room)} ${fg(FAINT, "│")}`);
	return [head, ...rows, `${fg(colour, "┗")}${fg(FAINT, `${"─".repeat(Math.max(0, width - 2))}╯`)}`];
}

/** Rows of icons packed to `room`; a tall icon row gets the empty row above it that it rises into, the label on that row. */
function iconRowsOf(label: Piece, pieces: Piece[], gap: string, room: number, tall: number): BoxLine[] {
	return packPieces(pieces.map((p) => ({ shown: p.s, width: p.w })), gap, room).flatMap((row, index) => {
		const body = { s: row, w: rowWidth(row) };
		const head = index === 0 ? label : blank(0);
		return tall >= 2 && hasInlineIcon(row) ? [{ label: head, body: blank(0) }, { label: blank(0), body }] : [{ label: head, body }];
	});
}

function callLines(model: Box, width: number, tall: number): BoxLine[] {
	const labelW = labelWidth(width);
	const room = width - 4 - labelW - 1;
	// Portraits give way from the right until the words keep WORDS_ROOM cells; a narrow box draws none.
	const faces = model.rows.map((row) => {
		const icons = width < FACES_FROM ? [] : row.champions.flatMap((name) => iconLine(name, ["champion"], tall) ?? []).map((icon): Piece => ({ s: icon.sequence, w: icon.columns }));
		while (icons.length && room - GLYPH - joined(icons).w - 1 < WORDS_ROOM) icons.pop();
		return joined(icons);
	});
	const facesW = Math.max(0, ...faces.map((f) => f.w));
	const textRoom = Math.max(4, room - GLYPH - (facesW ? facesW + 1 : 0));
	const actionBase = model.quiet ? `\x1b[38;2;${rgb(LANE_TEXT)}m` : `\x1b[1m\x1b[38;2;${rgb(COLOURS.action)}m`;
	const cueBase = `\x1b[38;2;${rgb(COLOURS.cue)}m`;
	return model.rows.flatMap((row, r) => {
		const lines = [...wrapTextWithAnsi(rich(row.action, row.champions, actionBase), textRoom), ...(row.cue ? wrapTextWithAnsi(rich(`when ${row.cue}`, row.champions, cueBase), textRoom) : [])];
		// A tall portrait stands on the row's second line and rises into its first, whose portrait columns stay empty.
		const faceAt = tall >= 2 ? 1 : 0;
		if (faces[r].w && lines.length <= faceAt) lines.push("");
		const colour = LABEL_COLOURS[row.label] ?? COLOURS.now;
		return lines.map((line, i) => {
			const glyph = i === 0 && GLYPHS[row.label] ? text(fg(colour, GLYPHS[row.label])) : blank(0);
			const face = i === faceAt ? faces[r] : blank(0);
			const lead = facesW ? `${pad(glyph, GLYPH)}${pad(face, facesW)} ` : pad(glyph, GLYPH);
			return { label: i === 0 ? text(bold(fg(colour, row.label.toUpperCase().slice(0, labelW)))) : blank(0), body: { s: `${lead}${line}`, w: GLYPH + (facesW ? facesW + 1 : 0) + visibleWidth(line) } };
		});
	});
}

function buildBoxLines(model: PanelModel, width: number, tall: number, ownPicks: string[]): BoxLine[] {
	const build = model.build;
	if (!build) return [];
	const room = width - 4 - labelWidth(width) - 1;
	const swapped = new Set(model.swaps.filter((swap) => swap.how === "instead of").map((swap) => squeezed(swap.to)));
	const mark = (name: string, piece: Piece): Piece => (swapped.has(squeezed(name)) ? { s: `${piece.s}${fg(COLOURS.swap, bold("↻"))}`, w: piece.w + 1 } : piece);
	const dot = ` ${fg(FAINT, "·")} `;
	// An all-icon group stays whole; a group with a name drawn as words splits into its names, so a narrow box wraps it instead of cutting it.
	const page = build.runes
		.filter((group) => group.length)
		.flatMap((group) => {
			const chips = group.map((name) => ({ name, chip: chip(name, ["rune", "summoner"], tall) }));
			const pieces = chips.map(({ name, chip: c }) => mark(name, asPiece(c)));
			return chips.every(({ chip: c }) => c.icon) ? [joined(pieces)] : pieces;
		});
	const lines = iconRowsOf(text(bold(fg(COLOURS.build, "runes"))), page, dot, room, tall);
	const path = build.build.flat();
	const itemsLabel = text(bold(fg(COLOURS.build, "items")));
	if (model.owned.length || model.next) {
		const have = new Set(model.owned.map(squeezed));
		const owns = (item: string) => have.has(squeezed(bareItem(item)));
		const owned = path.filter(owns).map((item): Piece => {
			const grey = greyIconLine(bareItem(item), ["item"], tall);
			if (grey) return { s: grey.sequence, w: grey.columns };
			const plain = chip(item, ["item"], tall);
			return { s: `${plain.shown}${fg(FAINT, "✓")}`, w: plain.width + 1 };
		});
		const rest = path.filter((item) => !owns(item)).map((item) => asPiece(chip(item, ["item"], tall)));
		lines.push(...iconRowsOf(itemsLabel, [...owned, text(bold(fg(COLOURS.build, "▸"))), ...rest], " ", room, tall));
	} else if (path.length) {
		const steps = build.build.map((step) => joined(step.map((item) => asPiece(chip(item, ["item"], tall))), " + "));
		lines.push(...iconRowsOf(itemsLabel, steps, ` ${fg(FAINT, "→")} `, room, tall));
	}
	const words = (label: string, body: string) => wrapTextWithAnsi(body, room).map((line, i) => ({ label: i ? blank(0) : text(fg(FAINT, label)), body: text(line) }));
	if (build.skills) lines.push(...words("skills", build.skills));
	if (ownPicks.length) lines.push(...words("own", fg(FAINT, ownPicks.join(", "))));
	return lines;
}

function swapBoxLines(model: PanelModel, width: number, tall: number): BoxLine[] {
	const room = width - 4 - labelWidth(width) - 1;
	const kinds: IconKind[] = ["item", "rune", "summoner"];
	return model.swaps.flatMap((swap) => {
		const arrow = text(fg(COLOURS.swap, bold(swap.how === "before" ? "before" : "→")));
		const icons = iconRowsOf(blank(0), [asPiece(chip(swap.from, kinds, tall)), arrow, asPiece(chip(swap.to, kinds, tall))], " ", room, tall);
		const reason = swap.reason ? wrapTextWithAnsi(fg(COLOURS.swap, swap.reason), room).map((line) => ({ label: blank(0), body: text(line) })) : [];
		return [...icons, ...reason];
	});
}

function sideBySide(left: string[], right: string[], lw: number, rw: number): string[] {
	return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => `${left[i] ?? " ".repeat(lw)}  ${right[i] ?? " ".repeat(rw)}`);
}

function headerLines(model: PanelModel, width: number, tall: number, header?: PanelOptions["header"]): string[] {
	if (!header && !model.clock) return [];
	const portrait = (name?: string): Piece | undefined => {
		const icon = name ? iconLine(name, ["champion"], tall) : undefined;
		return icon && { s: icon.sequence, w: icon.columns };
	};
	const self = portrait(header?.self);
	const opponent = portrait(header?.opponent);
	const parts = [self, self && opponent ? text(fg(FAINT, "vs")) : undefined, opponent, header?.detail ? text(fg(COLOURS.cue, header.detail)) : undefined];
	const left = joined(parts.filter((p): p is Piece => p !== undefined));
	const clock = model.clock ? text(bold(fg(COLOURS.fights, model.clock))) : blank(0);
	const line = `${left.s}${" ".repeat(Math.max(1, width - left.w - clock.w))}${clock.s}`;
	return tall >= 2 && hasInlineIcon(left.s) ? ["", line] : [line];
}

/** The panel at `width` cells: the header, the call boxes, the build and swap boxes, and the status line. */
export function panelLines(theme: UiTheme, model: PanelModel, width: number, options: PanelOptions = {}): string[] {
	const tall = iconRows();
	const out: string[] = [...headerLines(model, width, tall, options.header)];
	const pair = (a: ((w: number) => string[]) | undefined, b: ((w: number) => string[]) | undefined, share: number) => {
		if (a && b && width >= WIDE) {
			const lw = Math.floor((width - 2) * share);
			out.push(...sideBySide(a(lw), b(width - 2 - lw), lw, width - 2 - lw));
		} else for (const draw of [a, b]) if (draw) out.push(...draw(width));
	};
	const calls = (b: Box | undefined) => b && ((w: number) => box(b.title, b.colour, w, callLines(b, w, tall)));
	pair(calls(model.boxes[0]), calls(model.boxes[1]), 0.56);
	const build = model.build ? (w: number) => box("BUILD", COLOURS.build, w, buildBoxLines(model, w, tall, options.ownPicks ?? [])) : undefined;
	const swaps = model.swaps.length ? (w: number) => box("SWAP ↻", COLOURS.swap, w, swapBoxLines(model, w, tall)) : undefined;
	pair(build, swaps, 0.68);
	if (model.status) out.push(theme.fg("dim", model.status));
	return out.map((line) => `${fitInlineIcons(line, width)}${RESET}`);
}

/** The panel as a transcript entry, one cell in like the cards. */
export function createPanel(theme: UiTheme, model: PanelModel, options: PanelOptions = {}): UiComponent {
	const indent = " ".repeat(CARD_MARGIN);
	return { render: (width) => panelLines(theme, model, width - indent.length, options).map((line) => `${indent}${line}`), invalidate() {} };
}
