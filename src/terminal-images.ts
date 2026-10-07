import { existsSync } from "node:fs";
import { allocateImageId, encodeITerm2, getCapabilities, getCellDimensions, getPngDimensions, renderImage, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { clearNotice, logEvent, raiseNotice } from "./coach-log";

/**
 * The one place that knows how pictures reach the terminal. Charts hand it SVG, icons hand it PNG; it picks
 * the protocol, rasterizes, and returns card rows ready for pi-tui. Nothing here throws: a terminal without
 * images, a missing optional dependency, or bad markup returns undefined and the caller keeps its text.
 *
 * Protocols: Kitty (Kitty, Ghostty, WezTerm, Warp on macOS) and iTerm2 (iTerm2, and VS Code, VSCodium, and
 * Cursor terminals with PI_IMAGE_PROTOCOL=iterm2) come from pi-tui's detection; Sixel is opt-in only.
 *
 * xterm.js (the VS Code family) decodes a PNG asynchronously, and its resize parses whatever is queued without
 * waiting for that decode: the text after a picture lands first, the picture lands wherever the cursor is by then,
 * and the parser can give up for good. So on xterm.js every picture goes out as QOI at the terminal's own CSS pixel
 * size, the one format and size its image addon places synchronously. That size is the terminal's answer to
 * `CELL_SIZE_QUERY`; until it answers, xterm.js gets the text fallback.
 */

export type ImageProtocol = "kitty" | "iterm2" | "sixel";

/**
 * Sixel is opt-in only: PI_FORCE_IMAGE_PROTOCOL=sixel turns it on. Never auto-enabled from a
 * terminal identity variable (WT_SESSION included) — pi-tui has no Sixel path of its own to
 * validate against, so guessing wrong would draw garbage instead of falling back to text.
 */
export function sixelEnabled(environment: Record<string, string | undefined> = process.env): boolean {
	return environment.PI_FORCE_IMAGE_PROTOCOL?.toLowerCase() === "sixel";
}

/** How this terminal draws pictures, or undefined for text only. */
export function imageProtocol(): ImageProtocol | undefined {
	return getCapabilities().images ?? (sixelEnabled() ? "sixel" : undefined);
}

/** iTerm2 pictures drawn by xterm.js: VS Code, VSCodium, and Cursor all set TERM_PROGRAM=vscode. */
export function xtermImages(environment: Record<string, string | undefined> = process.env): boolean {
	return getCapabilities().images === "iterm2" && environment.TERM_PROGRAM?.toLowerCase() === "vscode";
}

/** Asks for the exact cell size in CSS pixels; xterm.js (and iTerm2) answer `ReportCellSize=height;width;scale`. */
export const CELL_SIZE_QUERY = "\x1b]1337;ReportCellSize\x07";
const CELL_SIZE_REPLY = /\x1b\]1337;ReportCellSize=([\d.]+);([\d.]+)(?:;[\d.]+)?(?:\x07|\x1b\\)/;
/** "A few seconds" for `pictureStatus`'s late check: long enough that a normal reply never trips it. */
const CELL_SIZE_TIMEOUT_MS = 4000;

let exactCell: { width: number; height: number } | undefined;
/** Set once by `watchCellSize`'s own timeout when it fires with still no answer; cleared the moment a cell size lands. */
let cellTimedOut = false;

/** The cell size the terminal last reported, for xterm.js pictures; undefined forgets it. */
export function setExactCell(cell: { width: number; height: number } | undefined): void {
	exactCell = cell;
	if (cell) cellTimedOut = false;
}

/** Test-only: force the cached "cell-size query timed out" state `pictureStatus` reports, without waiting out a real timer. */
export function setCellTimedOut(timedOut: boolean): void {
	cellTimedOut = timedOut;
}

/**
 * Takes the terminal's answer to `CELL_SIZE_QUERY` out of a chunk of input. `rest` is the chunk without it, so a key
 * pressed in the same chunk still reaches the editor; `cell` is the size it reported, undefined when there is none.
 */
export function takeCellSizeReply(data: string): { rest: string; cell?: { width: number; height: number } } {
	const match = CELL_SIZE_REPLY.exec(data);
	if (!match) return { rest: data };
	const rest = data.slice(0, match.index) + data.slice(match.index + match[0].length);
	const cell = { height: Number(match[1]), width: Number(match[2]) };
	return cell.width > 0 && cell.height > 0 ? { rest, cell } : { rest };
}

// System fonts by platform; resvg scanning every installed font costs ~400 ms, three named files ~40 ms.
const FONT_FILES = ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/segoeui.ttf", "/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/SFNSMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"];

function fontOptions() {
	const files = FONT_FILES.filter((file) => existsSync(file));
	return files.length ? { loadSystemFonts: false, fontFiles: files, defaultFontFamily: files[0].includes("consola") ? "Consolas" : "Menlo" } : { loadSystemFonts: true };
}

type ResvgClass = new (svg: string, options?: object) => { render(): { pixels: Buffer | Uint8Array; width: number; height: number; asPng(): Buffer | Uint8Array } };
let resvg: ResvgClass | undefined;
type Image2Sixel = (pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, maxColors?: number, backgroundSelect?: 0 | 1 | 2) => string;
let image2sixel: Image2Sixel | undefined;
/** Set when `loadRasterizer` last failed to load the optional package; `pictureStatus` reports it, cleared on a later success. */
let rasterizerFailed = false;

/**
 * Load what drawing SVG needs on this terminal: @resvg/resvg-js, plus the `sixel` encoder on the Sixel path.
 * Both are optionalDependencies (native binary / opt-in), so false just means text. Call before `svgRows`.
 */
export async function loadRasterizer(): Promise<boolean> {
	const protocol = imageProtocol();
	if (!protocol) return false;
	try {
		resvg ??= (await import("@resvg/resvg-js")).Resvg as unknown as ResvgClass;
		if (protocol === "sixel") image2sixel ??= (await import("sixel")).image2sixel;
		rasterizerFailed = false;
		return true;
	} catch (error) {
		rasterizerFailed = true; // package absent or missing native binary: text fallback, pictureStatus reports why
		// AGENTS.md rule 11: the same notice a startup or cell-size check would raise. session_start fires this
		// function once, unawaited, right at startup (index.ts), so this usually beats the first real attempt to
		// draw a picture (prepareAuditCharts, src/charts.ts) to it; a print-mode run with no session_start call
		// still gets the notice from here, just later.
		syncPicturesNotice("rasterizer-load-failed", undefined, error);
		return false;
	}
}

/** Test-only: force the cached "rasterizer missing" state `pictureStatus` reports, without needing the optional package actually absent. */
export function setRasterizerFailed(failed: boolean): void {
	rasterizerFailed = failed;
}

// Windows Terminal maps Sixel onto a virtual 10x20-pixel cell whatever the font (the VT340 geometry).
const SIXEL_CELL = { widthPx: 10, heightPx: 20 };
// Kitty "delete all placements", quiet, used only on the opt-in Sixel path: Windows Terminal ignores it,
// and its presence makes pi-tui's isImageLine() treat the row as an image row, skipping the width checks
// a Sixel payload would fail.
// ponytail: couples to pi-tui's private isImageLine() (matches this exact escape); ceiling is pi-tui has
// no Sixel protocol of its own to check against instead. Upgrade path: a real Sixel path in pi-tui
// upstream, then drop this marker and sixelEnabled()'s opt-in flag with it.
export const IMAGE_ROW_MARK = "\x1b_Ga=d,d=A,q=2\x1b\\";

/**
 * What a drawn picture depends on besides its own content: protocol and cell size. Callers that memoize rows
 * key on it, so a picture redraws when pi-tui learns the terminal's real cell size after the first frame.
 */
/**
 * On xterm.js, asks for the cell size now and after every resize (a font zoom changes it), takes the answers out of
 * the player's input, and calls `onChange` when the size changes so pictures redraw at it. A no-op elsewhere.
 * `onTimeout` fires once, at most, if `timeoutMs` passes with still no answer -- `pictureStatus` then reports why.
 */
export function watchCellSize(
	onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => () => void,
	write: (text: string) => void,
	onChange: () => void,
	onTimeout?: () => void,
	timeoutMs = CELL_SIZE_TIMEOUT_MS,
): () => void {
	if (!xtermImages()) return () => {};
	cellTimedOut = false;
	const stopInput = onTerminalInput((data) => {
		const { rest, cell } = takeCellSizeReply(data);
		if (!cell) return undefined;
		if (cell.width !== exactCell?.width || cell.height !== exactCell?.height) {
			setExactCell(cell);
			syncPicturesNotice("cell-size-landed"); // clears a stale cell-size-timeout notice now that one has landed
			onChange();
		}
		return rest ? { data: rest } : { consume: true };
	});
	const ask = () => write(CELL_SIZE_QUERY);
	process.stdout.on("resize", ask);
	ask();
	// Fire-and-forget housekeeping (AGENTS.md rule 8): nothing awaits this, so it is unref'd and cleared on stop,
	// exactly like the resize listener next to it.
	const timer = setTimeout(() => {
		if (!exactCell) {
			cellTimedOut = true;
			onTimeout?.();
		}
	}, timeoutMs);
	timer.unref?.();
	return () => {
		stopInput();
		process.stdout.off("resize", ask);
		clearTimeout(timer);
	};
}

export interface PictureStatus {
	on: boolean;
	/** Set when only SVG charts are affected -- this protocol's icons draw straight from the PNG, no rasterizer needed. Omitted when pictures are fully on or fully off. */
	scope?: "charts";
	reason?: string;
	fix?: string;
}

const VSCODE_FIX =
	'turn on terminal.integrated.enableImages and GPU acceleration, and add PI_IMAGE_PROTOCOL=iterm2 under terminal.integrated.env.<os> (docs/configuration.md "Terminal images"), then open a new terminal';

/**
 * Whether this terminal draws pictures right now, and why not when it does not. Reads only state this module
 * already has -- no probe of its own -- so it is cheap to call at startup and again later from a timeout: no
 * image protocol at all (the VS Code family turns images off by default, so it gets the settings fix; any
 * other terminal is simply told which ones draw pictures), the xterm.js cell-size query that `watchCellSize`
 * asked and never heard back on, and the optional rasterizer failing to load when a chart or icon last needed
 * it -- whole-picture on xterm.js (its icons rasterize through it too, see xtermIcon), charts only elsewhere
 * (Kitty and iTerm2 icons draw straight from the PNG, see inlineIcon).
 */
export function pictureStatus(environment: Record<string, string | undefined> = process.env): PictureStatus {
	if (!imageProtocol()) {
		return environment.TERM_PROGRAM?.toLowerCase() === "vscode"
			? { on: false, reason: "this editor's terminal has images turned off", fix: VSCODE_FIX }
			: { on: false, reason: "this terminal draws no inline images", fix: "use WezTerm, Kitty, Ghostty, or iTerm2" };
	}
	if (cellTimedOut) return { on: false, reason: "the terminal never answered the cell-size query", fix: VSCODE_FIX };
	if (rasterizerFailed) return { on: false, scope: xtermImages(environment) ? undefined : "charts", reason: "the optional image rasterizer isn't installed", fix: "run npm run setup" };
	return { on: true };
}

/** The notice text for an off `status`, or undefined when pictures are on. "charts drawn as text", not "pictures off", when `scope` says only charts are affected. */
export function picturesNoticeText(status: PictureStatus): string | undefined {
	if (status.on) return undefined;
	const subject = status.scope === "charts" ? "charts drawn as text" : "pictures off";
	return `${subject}: ${status.reason}${status.fix ? ` fix: ${status.fix}` : ""}`;
}

/**
 * Raises or clears the "pictures" notice from the current `pictureStatus`: on clears it, off raises
 * `picturesNoticeText`'s reading of it. Every call site that can change the answer goes through this one
 * function -- session_start and the cell-size timeout (index.ts), loadRasterizer's own catch above, and the
 * moment a cell size lands (watchCellSize below) -- so the header never keeps a stale warning once pictures
 * (or just the charts) recover.
 */
export function syncPicturesNotice(event: string, environment: Record<string, string | undefined> = process.env, error?: unknown): void {
	const text = picturesNoticeText(pictureStatus(environment));
	if (!text) {
		clearNotice("pictures");
		return;
	}
	raiseNotice("pictures", "warn", text, "terminal-images", event, { protocol: imageProtocol() }, error);
}

export function drawKey(): string {
	if (xtermImages()) return `xterm:${exactCell ? `${exactCell.width}x${exactCell.height}` : "unknown"}`;
	const protocol = imageProtocol() ?? "none";
	const cell = protocol === "sixel" ? SIXEL_CELL : getCellDimensions();
	return `${protocol}:${cell.widthPx}x${cell.heightPx}`;
}

/**
 * An iTerm2 picture. WezTerm on Windows reaches the program through ConPTY, which keeps its own cursor and handles
 * save and restore itself: a picture that moves WezTerm's cursor leaves the two apart, and every row after it lands
 * off by the picture's size. WezTerm's `doNotMoveCursor` keeps its cursor where ConPTY thinks it is.
 */
function itermImage(base64: string, options: Parameters<typeof encodeITerm2>[1] = {}): string {
	const sequence = encodeITerm2(base64, options);
	return process.env.TERM_PROGRAM === "WezTerm" ? sequence.replace("File=", "File=doNotMoveCursor=1;") : sequence;
}

/**
 * Last row of a `rows`-tall picture: save the cursor, move up into the reserved rows and to the first column, paint,
 * restore. The carriage return is for ConPTY, which can pass the picture on before the cursor moves that put it there.
 */
function paintUp(sequence: string, rows: number): string {
	return `\x1b7${rows > 1 ? `\x1b[${rows - 1}A` : ""}\r${sequence}\x1b8`;
}

const ZOOM = 2; // rasterize at 2x so the picture stays crisp when the terminal scales it into cells

/** An SVG as PNG bytes at twice its size, or undefined before `loadRasterizer` or on bad markup. */
export function svgToPng(markup: string): Buffer | undefined {
	try {
		return resvg ? Buffer.from(new resvg(markup, { font: fontOptions(), fitTo: { mode: "zoom", value: ZOOM } }).render().asPng()) : undefined;
	} catch (error) {
		logEvent("warn", "terminal-images", "svg-to-png-failed", undefined, error);
		return undefined;
	}
}

/**
 * Card rows for an SVG scaled to fill `widthCells` with its aspect kept, or undefined when this terminal cannot
 * draw it. Kitty: pi-tui's sequence, then blank rows reserving its height; `imageId` makes a redraw replace the
 * placement instead of stacking one. iTerm2 and Sixel: blank rows first, then a last row that paints upward
 * into them and restores the cursor, because xterm.js (VS Code, VSCodium, Cursor) and Windows Terminal move the
 * cursor below a picture. The iTerm2 picture is boxed to its rows, so a guessed cell size can shrink it but
 * never push it past them and scroll the screen.
 */
export function svgRows(markup: string, widthCells: number, imageId: number): string[] | undefined {
	const protocol = imageProtocol();
	if (!protocol || !resvg || (protocol === "sixel" && !image2sixel)) return undefined;
	try {
		if (xtermImages()) return xtermRows(markup, widthCells);
		if (protocol === "sixel") return sixelRows(markup, widthCells * SIXEL_CELL.widthPx);
		const png = svgToPng(markup);
		if (!png) return undefined;
		const base64 = png.toString("base64");
		const dims = getPngDimensions(base64);
		const rendered = dims ? renderImage(base64, dims, { maxWidthCells: widthCells, imageId, moveCursor: false }) : null;
		if (!rendered) return undefined;
		const reserved = Array.from({ length: Math.max(0, rendered.rows - 1) }, () => "");
		// iTerm2, WezTerm too: pi-tui clears each row it writes (ESC[2K), and in WezTerm that erases picture cells, so a
		// picture leading its first row lost every row under it. Painting up from the last row means no row is written
		// after it. doNotMoveCursor (itermImage) keeps WezTerm's cursor where ConPTY thinks it is, as the build-strip icons do.
		if (protocol === "iterm2") return [...reserved, paintUp(itermImage(base64, { width: rendered.columns, height: rendered.rows }), rendered.rows)];
		return [rendered.sequence, ...reserved];
	} catch (error) {
		logEvent("warn", "terminal-images", "svg-rows-failed", { protocol }, error); // bad markup: the caller keeps its text
		return undefined;
	}
}

/**
 * xterm.js rows: the picture rasterized at the CSS pixels `widthCells` cover and sent as QOI with no size, so the
 * image addon places it synchronously across exactly those cells and the rows reserved here. A picture taller than
 * the screen would be scaled by the addon (asynchronously), so it is drawn narrower until it fits.
 */
function xtermRows(markup: string, widthCells: number): string[] | undefined {
	const cell = exactCell;
	if (!cell) return undefined;
	const maxHeight = Math.max(1, (process.stdout.rows || 24) - 2) * cell.height;
	const raster = (widthPx: number) => new resvg!(markup, { font: fontOptions(), fitTo: { mode: "width", value: Math.max(1, widthPx) } }).render();
	let rendered = raster(Math.floor(widthCells * cell.width));
	if (rendered.height > maxHeight) rendered = raster(Math.floor((rendered.width * maxHeight) / rendered.height));
	const rows = Math.max(1, Math.ceil(rendered.height / cell.height));
	const sequence = encodeITerm2(qoi(rendered.pixels, rendered.width, rendered.height).toString("base64"));
	return [...Array.from({ length: rows - 1 }, () => ""), paintUp(sequence, rows)];
}

function sixelRows(markup: string, widthPx: number): string[] {
	const rendered = new resvg!(markup, { font: fontOptions(), fitTo: { mode: "width", value: widthPx } }).render();
	// Sixel paints in 6-pixel bands: trim to whole bands so the last band carries no stray pixels.
	const height = Math.max(6, Math.floor(rendered.height / 6) * 6);
	const pixels = Uint8Array.from(rendered.pixels.subarray(0, rendered.width * height * 4)); // a copy: the encoder reads the whole backing buffer
	const sequence = image2sixel!(pixels, rendered.width, height, 256, 1);
	const rows = Math.max(1, Math.ceil(height / SIXEL_CELL.heightPx));
	return [...Array.from({ length: rows - 1 }, () => `${IMAGE_ROW_MARK}\x1b[0m`), `${IMAGE_ROW_MARK}${paintUp(sequence, rows)}`];
}

/** Rows a build-strip icon stands on: two in WezTerm, one everywhere else. */
// ponytail: WezTerm only, the coach's own terminal. pi-tui skips the rows under a Kitty picture and xterm.js wants the picture redrawn at its cell size: each gets a tall path of its own when a player asks for one there.
export function iconRows(environment: Record<string, string | undefined> = process.env): number {
	return getCapabilities().images === "iterm2" && environment.TERM_PROGRAM === "WezTerm" ? 2 : 1;
}

/**
 * A PNG as a picture inside a line of text, or undefined on terminals without Kitty or iTerm2 (Sixel draws no
 * inline icons). `columns` is how far the cursor ends up past where the icon started. `rows` above one (from
 * `iconRows`) draws it that many rows tall, standing on the row it is written on and rising into the rows above,
 * which the caller keeps empty: a row written after a picture is cleared first, and that would wipe a picture
 * running down into it.
 */
export function inlineIcon(base64: string, dims: { widthPx: number; heightPx: number }, imageId: number, rows = 1): { sequence: string; columns: number } | undefined {
	const protocol = getCapabilities().images;
	if (!protocol) return undefined;
	if (xtermImages()) return xtermIcon(base64);
	const rendered = renderImage(base64, dims, { maxHeightCells: 1, imageId, moveCursor: false });
	if (!rendered) return undefined;
	// Kitty draws with C=1 (the cursor stays), so step over the picture's cells the way the iTerm2 branch does.
	if (protocol !== "iterm2") return { sequence: `${rendered.sequence}\x1b[${rendered.columns}C`, columns: rendered.columns };
	// WezTerm sizes an iTerm2 picture from its width and ignores the height, and a width in whole cells cannot make a square
	// icon exactly `rows` tall (cells 2.25 times taller than wide: 4 columns draw 0.89 of two rows, 5 draw 1.1). So the width
	// is in pixels, `rows` cell heights times the picture's aspect, and only the cursor step is whole columns.
	const cell = getCellDimensions();
	const widthPx = Math.max(1, Math.round((cell.heightPx * rows * dims.widthPx) / Math.max(1, dims.heightPx)));
	const columns = Math.max(1, Math.ceil(widthPx / cell.widthPx));
	// xterm.js drops the cursor below an iTerm2 picture: pin it, box the icon to its rows, then step over it.
	return { sequence: `\x1b7${rows > 1 ? `\x1b[${rows - 1}A` : ""}${itermImage(base64, { width: `${widthPx}px`, height: rows })}\x1b8\x1b[${columns}C`, columns };
}

// ponytail: cleared whole past the cap; a session draws a few dozen distinct icons at one or two cell sizes.
const xtermIcons = new Map<string, { sequence: string; columns: number }>();

/** An xterm.js inline icon: the PNG redrawn one cell tall at the terminal's CSS pixels, as QOI, memoized per cell size. */
function xtermIcon(base64: string): { sequence: string; columns: number } | undefined {
	const cell = exactCell;
	if (!cell || !resvg) return undefined;
	const key = `${cell.width}x${cell.height}:${base64}`;
	const hit = xtermIcons.get(key);
	if (hit) return hit;
	try {
		const side = Math.floor(cell.height);
		const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><image href="data:image/png;base64,${base64}" width="${side}" height="${side}"/></svg>`;
		// An icon has no text: without this resvg loads every system font for each one, seconds on Windows.
		const rendered = new resvg(markup, { font: { loadSystemFonts: false } }).render();
		const columns = Math.ceil(rendered.width / cell.width);
		const icon = { sequence: `\x1b7${encodeITerm2(qoi(rendered.pixels, rendered.width, rendered.height).toString("base64"))}\x1b8\x1b[${columns}C`, columns };
		if (xtermIcons.size >= 256) xtermIcons.clear();
		xtermIcons.set(key, icon);
		return icon;
	} catch (error) {
		logEvent("warn", "terminal-images", "xterm-icon-failed", undefined, error);
		return undefined;
	}
}

// ponytail: cleared whole past the cap, like xtermIcons; a panel greys a handful of owned items.
const greyIcons = new Map<string, { sequence: string; columns: number } | undefined>();

/**
 * An inline icon drawn grey and faded (an item the player already owns), through the rasterizer; undefined without it,
 * or on a terminal that draws no inline icons, so the caller draws the plain icon instead.
 */
export function greyIcon(base64: string, dims: { widthPx: number; heightPx: number }, rows = 1): { sequence: string; columns: number } | undefined {
	if (!resvg) return undefined;
	const key = `${rows}:${base64}`;
	if (greyIcons.has(key)) return greyIcons.get(key);
	const { widthPx: w, heightPx: h } = dims;
	const png = svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><filter id="g"><feColorMatrix type="saturate" values="0"/></filter><image href="data:image/png;base64,${base64}" width="${w}" height="${h}" filter="url(#g)" opacity="0.45"/></svg>`);
	const icon = png && inlineIcon(png.toString("base64"), { widthPx: w * ZOOM, heightPx: h * ZOOM }, allocateImageId(), rows);
	if (greyIcons.size >= 64) greyIcons.clear();
	greyIcons.set(key, icon);
	return icon;
}

/** RGBA pixels as a QOI image (qoiformat.org): lossless with alpha, and the one format xterm.js's image addon places synchronously. */
export function qoi(pixels: Uint8Array, width: number, height: number): Buffer {
	const out = Buffer.alloc(14 + width * height * 5 + 8);
	out.write("qoif", 0, "latin1");
	out.writeUInt32BE(width, 4);
	out.writeUInt32BE(height, 8);
	out[12] = 4; // RGBA
	out[13] = 0; // sRGB
	let at = 14;
	const put = (...bytes: number[]) => {
		out.set(bytes, at);
		at += bytes.length;
	};
	const seen = new Uint8Array(64 * 4);
	let [pr, pg, pb, pa] = [0, 0, 0, 255];
	let run = 0;
	const count = width * height;
	const wrap = (n: number) => ((n + 384) & 255) - 128;
	for (let i = 0; i < count; i++) {
		const [r, g, b, a] = [pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2], pixels[i * 4 + 3]];
		if (r === pr && g === pg && b === pb && a === pa) {
			if (++run === 62 || i === count - 1) {
				put(0xc0 | (run - 1));
				run = 0;
			}
			continue;
		}
		if (run) {
			put(0xc0 | (run - 1));
			run = 0;
		}
		const slot = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
		if (seen[slot] === r && seen[slot + 1] === g && seen[slot + 2] === b && seen[slot + 3] === a) put(slot / 4);
		else {
			seen.set([r, g, b, a], slot);
			const [dr, dg, db] = [wrap(r - pr), wrap(g - pg), wrap(b - pb)];
			if (a !== pa) put(0xff, r, g, b, a);
			else if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) put(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2));
			else if (dg >= -32 && dg <= 31 && dr - dg >= -8 && dr - dg <= 7 && db - dg >= -8 && db - dg <= 7) put(0x80 | (dg + 32), ((dr - dg + 8) << 4) | (db - dg + 8));
			else put(0xfe, r, g, b);
		}
		[pr, pg, pb, pa] = [r, g, b, a];
	}
	put(0, 0, 0, 0, 0, 0, 0, 1);
	return out.subarray(0, at);
}

/**
 * One inline icon as `inlineIcon` writes it, for Kitty and iTerm2: Kitty's chunked APC sequence, or iTerm2's pinned
 * picture (a tall one moves up first), then the cursor step (its digits, the one capture group, are the cells the
 * icon takes). Global, so use it only with `replace` or `matchAll`, never `test` or `exec`. Every Kitty icon must come
 * from `inlineIcon`: a Kitty picture drawn without the cursor step does not match, and width measuring counts it as text.
 */
export const INLINE_ICON = /(?:(?:\x1b_G[^\x1b]*\x1b\\)+|\x1b7(?:\x1b\[\d+A)?\x1b\]1337;File=[^\x07]*\x07\x1b8)\x1b\[(\d+)C/g;

/** True when `text` carries an inline icon. pi-tui's width count reads an icon's bytes as cells, so such a row must go through `fitInlineIcons`, never `truncateToWidth` or a wrap. */
export function hasInlineIcon(text: string): boolean {
	return text.includes("\x1b_G") || text.includes("\x1b]1337;File=");
}

/**
 * A row with inline icons cut to `cells`. Text is measured without the icon bytes and each icon counts the cells it
 * steps over, so a row that fits is returned as it came. A row that does not fit is cut in its text with an
 * ellipsis; an icon is kept whole or dropped whole, with everything after the cut.
 */
export function fitInlineIcons(row: string, cells: number): string {
	let out = "";
	let used = 0;
	let from = 0;
	/** Adds `text`, cut to what is left; false once the room is gone. */
	const take = (text: string): boolean => {
		const width = visibleWidth(text);
		if (used + width <= cells) {
			out += text;
			used += width;
			return true;
		}
		out += truncateToWidth(text, Math.max(0, cells - used), "…");
		return false;
	};
	for (const icon of row.matchAll(INLINE_ICON)) {
		if (!take(row.slice(from, icon.index))) return out;
		const step = Number(icon[1] ?? 0);
		if (used + step > cells) return out;
		out += icon[0];
		used += step;
		from = icon.index + icon[0].length;
	}
	take(row.slice(from));
	return out;
}

/**
 * WezTerm on Windows reaches the program through ConPTY, which only tells WezTerm where its cursor is while the
 * cursor is shown. Pi hides it, so WezTerm's cursor stays wherever ConPTY last painted (the end of a cleared row) and
 * anything ConPTY passes through untouched lands there: pictures at the right edge, and Pi's OSC 133;A prompt mark,
 * which WezTerm reads as "start a fresh line", pushing every row after it one line down. In WezTerm, Pi's hide-cursor
 * is dropped from what it writes; terminal/wezterm.lua draws the cursor in the background colour instead (Pi draws
 * its own in the editor). macOS WezTerm gets the same, so both platforms behave the same.
 */
const HIDE_CURSOR = /\x1b\[\?25l/g;

export function dropHideCursor(text: string): string {
	return text.replace(HIDE_CURSOR, "");
}

/** Wraps `stream.write` with `dropHideCursor` in WezTerm on a terminal; a no-op elsewhere, and on a pipe (TERM_PROGRAM is inherited by children). Returns the undo. */
export function keepCursorShown(stream: NodeJS.WriteStream = process.stdout, environment: Record<string, string | undefined> = process.env): () => void {
	if (environment.TERM_PROGRAM !== "WezTerm" || !stream.isTTY) return () => {};
	const write = stream.write;
	stream.write = ((chunk: string | Uint8Array, ...rest: any[]) => write.call(stream, typeof chunk === "string" ? dropHideCursor(chunk) : chunk, ...rest)) as typeof stream.write;
	stream.write("\x1b[?25h");
	return () => {
		stream.write = write;
	};
}
