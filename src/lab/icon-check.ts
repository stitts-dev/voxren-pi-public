/**
 * The icon gate's evidence. A screen read as text shows an icon as blank cells, so a missing or broken icon passed every
 * text check. Three independent witnesses instead:
 *
 *   expectedIcons   from the answer's build lines: the chips the BUILD strip should draw an icon for (same name
 *                   resolution as src/ui.ts's `chip`: `bareItem`, the trailing-s retry, the kinds each row tries).
 *   parsePlacements from the bytes Pi wrote (PI_TUI_WRITE_LOG): every Kitty or iTerm2 picture with its cell and size.
 *   cropSpread      from the pane's pixels: how much colour the placed icon's cell rectangle holds.
 *
 * The verdict (`iconVerdict`) lives in stories.ts beside the other gates. Nothing here is shipped code: the coach is
 * untouched, so this survives changes to terminal-images.ts, icons.ts, and the strip's icon size.
 */
import { spawnSync } from "node:child_process";
import { bareItem, buildIconNames, buildLines, SWAP } from "../build-lines";
import { isKnownName, prefetchItemIcons, prefetchRuneIcons, type IconKind } from "../icons";

// --- I1: expected icons, from text ------------------------------------------------------------------------------

/** Whether `name` has an icon under one of `kinds`; the runner backs it with Data Dragon (`dataDragonKnown`). */
export type Known = (name: string, kinds: IconKind[]) => boolean;

export interface Expected {
	/** The names that should draw an icon, in strip order (a name twice is two icons). */
	names: string[];
	/** Names the strip should draw but that resolve to no item, rune, or spell: the model's mistake, drawn as text. */
	unresolved: string[];
}

const RUNE_KINDS: IconKind[] = ["rune", "summoner"];
const ALL_KINDS: IconKind[] = ["item", "rune", "summoner"];

/** The chips `buildStripLines` makes, as [name, kinds]: rune page by group, item steps, both names of each swap. */
function chips(source: string): Array<[string, IconKind[]]> {
	const lines = buildLines(source);
	if (!lines) return [];
	const [primary = [], secondary = [], shards = [], spells = [], ...extra] = lines.runes;
	const out: Array<[string, IconKind[]]> = [];
	for (const name of primary) out.push([name, RUNE_KINDS]);
	for (const name of secondary) out.push([name, RUNE_KINDS]);
	for (const name of shards) out.push([name, ["rune"]]);
	for (const name of spells) out.push([name, ["summoner", "rune"]]);
	for (const group of extra) for (const name of group) out.push([name, RUNE_KINDS]);
	for (const name of lines.build.flat()) out.push([name, ["item"]]);
	for (const swap of lines.swaps) {
		const match = SWAP.exec(swap);
		if (match) out.push([match[1], ALL_KINDS], [match[3], ALL_KINDS]);
	}
	return out;
}

/** What the strip for `text` (an answer with Runes, Build, and Swap lines) should draw. `known` unset: every name counts. */
export function expectedIcons(text: string, known?: Known): Expected {
	const names: string[] = [];
	const unresolved: string[] = [];
	for (const [name, kinds] of chips(text)) {
		const bare = bareItem(name);
		if (!known || known(bare, kinds) || known(bare.replace(/s$/, ""), kinds)) names.push(bare);
		else unresolved.push(bare);
	}
	return { names, unresolved };
}

/** A resolver backed by the live Data Dragon (the icons module's own prefetch and `isKnownName`), or undefined when it cannot be reached. */
export async function dataDragonKnown(text: string, base = "https://ddragon.leagueoflegends.com"): Promise<Known | undefined> {
	const lines = buildLines(text);
	if (!lines) return undefined;
	try {
		const version = ((await (await fetch(`${base}/api/versions.json`)).json()) as string[])[0];
		const names = buildIconNames(lines);
		// The prefetch skips the network on a terminal with no images; this process only asks which names exist.
		const { setCapabilities } = await import("@earendil-works/pi-tui");
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		await Promise.all([prefetchItemIcons(names.items, version, base, fetch, 20_000), prefetchRuneIcons(names.runes, version, base, fetch, 20_000)]);
		return (name, kinds) => isKnownName(name, kinds, version);
	} catch (error) {
		console.error(`icon gate: Data Dragon names not loaded, every name counts as expected: ${error instanceof Error ? error.message : error}`);
		return undefined;
	}
}

// --- I2: placed icons, from bytes -------------------------------------------------------------------------------

export interface Placement {
	protocol: "kitty" | "iterm2";
	/** Size in cells. */
	cols: number;
	rows: number;
	/** Cursor cell at the sequence: the column, and the row relative to the frame's `BUILD` label row (undefined without one). */
	col: number;
	row: number;
	rowFromBuild?: number;
	/** Which synchronized-output frame (CSI ? 2026 h) wrote it. */
	frame: number;
}

// ESC [ params final | ESC ] ... BEL or ST | ESC _ ... ST | ESC then one more character.
const TOKEN = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b_([^\x1b]*)\x1b\\|\x1b([^[\]_])|(\r)|(\n)|([^\x1b\r\n]+)/gs;

const cellCount = (value: string | undefined, fallback: number) => (value && /^\d+$/.test(value) ? Number(value) : fallback);

/**
 * Every Kitty (`ESC _ G ... ESC \`) and iTerm2 (`ESC ] 1337 ; File=... BEL`) picture in what a terminal was written, with
 * its cell and size, and the frame it came in. The cursor is followed through `\r`, `\n`, CSI A B C D G, and ESC 7 and 8
 * (Pi saves, paints, restores). Each printed code point counts one cell: the strip's text is ASCII plus │ → · ×.
 * ponytail: no wide-character widths and no scrolling, so a row is relative to its frame only, never an absolute screen row.
 */
export function parsePlacements(bytes: string, cellWidthPx = 0): Placement[] {
	const placements: Placement[] = [];
	let row = 0;
	let col = 0;
	let saved = { row: 0, col: 0 };
	let frame = 0;
	let line = "";
	const buildRows = new Map<number, number>();
	for (const token of bytes.matchAll(TOKEN)) {
		const [, csiParams, csiFinal, osc, apc, esc, cr, nl, text] = token;
		if (csiFinal) {
			const n = Number(csiParams.split(";")[0]) || 1;
			if (csiFinal === "A") row -= n;
			else if (csiFinal === "B") row += n;
			else if (csiFinal === "C") col += n;
			else if (csiFinal === "D") col = Math.max(0, col - n);
			else if (csiFinal === "G") col = (Number(csiParams) || 1) - 1;
			else if (csiFinal === "h" && csiParams === "?2026") frame++;
		} else if (osc !== undefined) {
			const file = /^1337;File=([^:]*):/.exec(osc);
			if (file) {
				const args = new Map(file[1].split(";").map((pair) => pair.split("=") as [string, string | undefined]));
				const px = /^(\d+)px$/.exec(args.get("width") ?? "");
				const cols = px && cellWidthPx > 0 ? Math.ceil(Number(px[1]) / cellWidthPx) : cellCount(args.get("width"), 1); // a pixel width covers the cells the cursor steps over
				placements.push({ protocol: "iterm2", cols, rows: cellCount(args.get("height"), 1), col, row, frame });
				if (!args.has("doNotMoveCursor")) col += cols;
			}
		} else if (apc !== undefined) {
			const picture = /^G([^;]*);?/.exec(apc);
			const keys = new Map((picture?.[1] ?? "").split(",").map((pair) => pair.split("=") as [string, string | undefined]));
			// A chunk after the first carries only `m` (more) and `q`; the first names an action.
			if (picture && (keys.has("a") || keys.has("f") || keys.has("i"))) {
				if ((keys.get("a") ?? "t") !== "t" || keys.has("f")) {
					const cols = cellCount(keys.get("c"), 1);
					placements.push({ protocol: "kitty", cols, rows: cellCount(keys.get("r"), 1), col, row, frame });
					if (keys.get("C") !== "1") col += cols;
				}
			}
		} else if (esc === "7") saved = { row, col };
		else if (esc === "8") ({ row, col } = saved);
		else if (cr !== undefined) {
			col = 0;
			line = "";
		} else if (nl !== undefined) {
			row++;
			line = "";
		} else if (text !== undefined) {
			col += [...text].length;
			line += text;
			if (line.includes("BUILD") && !buildRows.has(frame)) buildRows.set(frame, row);
		}
	}
	return placements.map((placement) => {
		const anchor = buildRows.get(placement.frame);
		return anchor === undefined ? placement : { ...placement, rowFromBuild: placement.row - anchor };
	});
}

/**
 * The placements of the build strip's last full draw: the synchronized frame that placed the most pictures (Pi redraws only
 * what changed, so a frame that places fewer is a partial repaint). Ties go to the later frame.
 */
export function stripPlacements(placements: Placement[]): Placement[] {
	const byFrame = new Map<number, Placement[]>();
	for (const placement of placements) byFrame.set(placement.frame, [...(byFrame.get(placement.frame) ?? []), placement]);
	let best: Placement[] = [];
	for (const [, group] of [...byFrame].sort((a, b) => a[0] - b[0])) if (group.length >= best.length) best = group;
	return best;
}

// --- I3: pixels -------------------------------------------------------------------------------------------------

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Metrics {
	cellW: number;
	cellH: number;
	/** The shot's pixel offset of cell (0, 0) of the pane. */
	originX: number;
	originY: number;
}

/**
 * Pixel metrics of one pane in a whole-window shot, from `wezterm cli list --format json` (per pane: cols, rows, pixel
 * width and height, left_col, top_row). The panes tile the tab, so the window's content spans every pane's cells; the
 * horizontal padding is what is left of the shot's width over them, split in two, and the padding scale (the lua's 8 and 6
 * points) follows from it. The title bar is what remains of the shot's height. Undefined when the list lacks the fields.
 */
export function paneMetrics(list: unknown, paneId: number, shot: { width: number; height: number }): Metrics | undefined {
	type Entry = { pane_id: number; left_col?: number; top_row?: number; size: { cols: number; rows: number; pixel_width?: number; pixel_height?: number } };
	const entries = (Array.isArray(list) ? list : []) as Entry[];
	const pane = entries.find((entry) => entry.pane_id === paneId);
	if (!pane || !pane.size.pixel_width || !pane.size.pixel_height || pane.left_col === undefined || pane.top_row === undefined) return undefined;
	const cellW = pane.size.pixel_width / pane.size.cols;
	const cellH = pane.size.pixel_height / pane.size.rows;
	const totalCols = Math.max(...entries.map((entry) => (entry.left_col ?? 0) + entry.size.cols));
	const totalRows = Math.max(...entries.map((entry) => (entry.top_row ?? 0) + entry.size.rows));
	const padX = (shot.width - totalCols * cellW) / 2;
	const padY = (padX / 8) * 6; // terminal/wezterm.lua: window_padding left and right 8, top and bottom 6
	return { cellW, cellH, originX: padX + pane.left_col * cellW, originY: shot.height - padY - totalRows * cellH + pane.top_row * cellH };
}

/** Where a placement sits in the shot: `viewportRow` is the screen row of the strip's BUILD label. */
export function cropRect(placement: Placement, viewportRow: number, metrics: Metrics): Rect | undefined {
	if (placement.rowFromBuild === undefined) return undefined;
	return {
		x: Math.round(metrics.originX + placement.col * metrics.cellW),
		y: Math.round(metrics.originY + (viewportRow + placement.rowFromBuild) * metrics.cellH),
		w: Math.round(placement.cols * metrics.cellW),
		h: Math.round(placement.rows * metrics.cellH),
	};
}

/** The screen row of the strip's BUILD label in a raw viewport (`wezterm cli get-text`, rows kept), the last one, or undefined when it is off screen. */
export function buildLabelRow(viewport: string): number | undefined {
	const lines = viewport.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) if (/^\s*│\s+BUILD\b/.test(lines[i])) return i;
	return undefined;
}

/** The names the strip drew as text: the strip's rows (from the BUILD label while lines keep their bar) that spell an expected name. A WezTerm that draws images should show none. */
export function textNames(screen: string, names: string[]): string[] {
	const lines = screen.split("\n");
	const start = lines.map((line) => /^\s*│\s+BUILD\b/.test(line)).lastIndexOf(true);
	if (start < 0) return [];
	let end = start + 1;
	// The own-pick row names what no data mentioned, as text on purpose: the strip's icons end above it.
	while (end < lines.length && /^\s*│/.test(lines[end]) && !/^\s*│\s+unsourced\b/.test(lines[end])) end++;
	const strip = lines.slice(start, end).join("\n");
	return [...new Set(names)].filter((name) => strip.includes(name));
}

/** Colour spread of a rectangle of a PNG: the widest of the luma and chroma ranges (0 to 255), through ffmpeg's `signalstats`. Undefined when ffmpeg cannot read it. */
export function cropSpread(png: string, rect: Rect): number | undefined {
	const run = spawnSync("ffmpeg", ["-v", "error", "-i", png, "-vf", `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},signalstats,metadata=print:file=-`, "-f", "null", "-"], { encoding: "utf8", timeout: 20_000 });
	if (run.status !== 0) return undefined;
	const value = (key: string) => Number(new RegExp(`lavfi\\.signalstats\\.${key}=(\\d+)`).exec(run.stdout)?.[1]);
	const ranges = [["YMAX", "YMIN"], ["UMAX", "UMIN"], ["VMAX", "VMIN"]].map(([hi, lo]) => value(hi) - value(lo));
	return ranges.some(Number.isNaN) ? undefined : Math.max(...ranges);
}

/** A crop whose colour range is this or less is blank: an icon has art, and a text name or an empty cell does not span this much. */
export const BLANK_SPREAD = 24;

/** The shot's pixel size, through ffprobe. */
export function imageSize(png: string): { width: number; height: number } | undefined {
	const run = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", png], { encoding: "utf8", timeout: 10_000 });
	const [width, height] = run.stdout.trim().split(",").map(Number);
	return run.status === 0 && width > 0 && height > 0 ? { width, height } : undefined;
}

/** What the gate reads (`IconEvidence` in stories.ts) for one pane. */
export interface IconInputs {
	/** The answer text with the build lines (the last exchange answer that has them). */
	answer: string;
	known?: Known;
	/** Everything Pi wrote to the terminal. */
	bytes: string;
	/** The screen, scrollback included. */
	screen: string;
	/** The raw viewport at the moment of the shot, rows kept. */
	viewport: string;
	shot?: { png: string; metrics?: Metrics };
	/** False when the coach said it draws no pictures. */
	supported: boolean;
}

export interface IconEvidence {
	supported: boolean;
	expected: number;
	placed: number;
	/** Placed icons whose pixels are blank or near uniform. */
	blank: number;
	/** Placed icons not cropped: strip scrolled off, no shot, or no ffmpeg. */
	unchecked: number;
	/** Expected names drawn as text. */
	text: string[];
	unresolved: string[];
	/** Each placed icon's cell, crop rectangle, and colour spread, for reading a failure. */
	crops?: Array<{ col: number; row?: number; rect?: Rect; spread?: number }>;
}

export function iconEvidence(input: IconInputs): IconEvidence {
	const expected = expectedIcons(input.answer, input.known);
	const base = { supported: input.supported, expected: expected.names.length, unresolved: expected.unresolved };
	if (!input.supported) return { ...base, placed: 0, blank: 0, unchecked: 0, text: [] };
	const placed = stripPlacements(parsePlacements(input.bytes, input.shot?.metrics?.cellW));
	const row = buildLabelRow(input.viewport);
	let blank = 0;
	let unchecked = 0;
	const crops: NonNullable<IconEvidence["crops"]> = [];
	for (const placement of placed) {
		const rect = row !== undefined && input.shot?.metrics ? cropRect(placement, row, input.shot.metrics) : undefined;
		const spread = rect && input.shot ? cropSpread(input.shot.png, rect) : undefined;
		crops.push({ col: placement.col, row: placement.rowFromBuild, rect, spread });
		if (spread === undefined) unchecked++;
		else if (spread <= BLANK_SPREAD) blank++;
	}
	return { ...base, placed: placed.length, blank, unchecked, text: textNames(input.screen, expected.names), crops: [...crops, ...(row === undefined ? [{ col: -1 }] : [{ col: -2, row }])] };
}
