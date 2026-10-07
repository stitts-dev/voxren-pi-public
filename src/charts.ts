import { allocateImageId } from "@earendil-works/pi-tui";
import { SCENE_SPAN, type DeathMark } from "./audit-metrics";
import { logEvent } from "./coach-log";
import { MAP_SIZE } from "./map-zones";
import { RIFT_VOID, riftBackground, riftMapHref, riftPoint } from "./rift-map";
import { drawKey, imageProtocol, loadRasterizer, svgRows, svgToPng } from "./terminal-images";
import { championIconData, itemIconData } from "./icons";

/**
 * Audit-card charts: the SVG for each chart, a cache of what the card asked for, and the text strips
 * drawn where the terminal has no images. Maps draw on rift-map.ts; getting pixels onto the screen is
 * terminal-images.ts. Same contract as icons.ts: `prepareAuditCharts` does the async setup before the
 * card renders, `chartLines` draws synchronously, and nothing here ever throws — a chart that failed,
 * a missing optional dependency, or a terminal without images just leaves the card on its text fallback.
 */

/** The per-game chart payload the gateway attaches (display only; the model never sees it). */
export interface ChartGame {
	id?: string;
	win?: boolean;
	remake?: boolean;
	vs?: string;
	gd15?: number | null;
	chart?: { gd: number[]; deaths: DeathMark[]; kills: number[]; items: Array<{ name: string; min: number }> };
}

// Teal ahead / coral behind: separable under red-green color blindness, unlike green/red.
const AHEAD = "#2dd4bf";
const BEHIND = "#ff7a6b";
const EARLY_DEATH = "#f5d58a";
const LATE_DEATH = "#ff7a6b";
const KILL = "#7ce7a2";
const ITEM = "#fbbf24";
const AXIS = "#4d7370";
const LABEL = "#7fa8a3";
const LINE = "#dcf5f1";
const LATE_MIN = 15;
/** Fixed pixel height of the single-game card. */
const CARD_HEIGHT = 280;
/** Charts are designed at this width, then scaled to the pane like a picture, so they grow and shrink with the window. */
const DESIGN_WIDTH = 1000;

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (x: number, y: number, body: string, fill = LABEL, size = 13, anchor = "start") =>
	`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${fill}" font-size="${size}" font-family="Consolas, Menlo, monospace" text-anchor="${anchor}">${esc(body)}</text>`;
const svg = (w: number, h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`;
const cross = (x: number, y: number, fill: string, r = 5) =>
	`<path d="M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}" stroke="${fill}" stroke-width="2.6" stroke-linecap="round"/>`;
const deathColor = (death: DeathMark) => (death.min > LATE_MIN ? LATE_DEATH : EARLY_DEATH);
/**
 * A death Riot sent no position for is stored at (0,0), the map's corner, which no death on the Rift can be at:
 * the maps leave it out, the way the scene tiles do, rather than draw it where the player did not die.
 */
const located = (deaths: DeathMark[]) => deaths.filter((death) => death.x !== 0 || death.y !== 0);
/**
 * Marks past the last plotted minute are dropped, not clamped to the right edge: the gold line is cut at
 * CHART_MAX_MINUTES (audit-metrics.ts), so a mark clamped there would sit on gold it does not belong to.
 */
const plotted = (minute: number, series: number[]) => minute <= series.length - 1;
const kFormat = (gold: number) => `${gold > 0 ? "+" : gold < 0 ? "-" : ""}${(Math.abs(gold) / 1000).toFixed(1)}k`;

let clipIds = 0;

/** Gold-diff area in the box: filled teal above zero, coral below, zero line dashed. */
function area(series: number[], x0: number, y0: number, x1: number, y1: number, scale: number) {
	const mid = (y0 + y1) / 2;
	const xs = (minute: number) => x0 + (minute / Math.max(1, series.length - 1)) * (x1 - x0);
	const ys = (gold: number) => mid - (gold / Math.max(1, scale)) * ((y1 - y0) / 2);
	const points = series.map((gold, minute) => `${xs(minute).toFixed(1)},${ys(gold).toFixed(1)}`).join(" ");
	const shape = `${xs(0)},${mid} ${points} ${xs(series.length - 1)},${mid}`;
	const id = `c${clipIds++}`;
	const body = series.length < 2 ? "" : `<defs><clipPath id="${id}u"><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${mid - y0}"/></clipPath><clipPath id="${id}d"><rect x="${x0}" y="${mid}" width="${x1 - x0}" height="${y1 - mid}"/></clipPath></defs>
<polygon points="${shape}" fill="${AHEAD}" fill-opacity=".32" clip-path="url(#${id}u)"/><polygon points="${shape}" fill="${BEHIND}" fill-opacity=".32" clip-path="url(#${id}d)"/>
<polyline points="${points}" fill="none" stroke="${LINE}" stroke-width="2.4" stroke-linejoin="round"/>`;
	return { xs, ys, mid, body: `${body}<line x1="${x0}" x2="${x1}" y1="${mid}" y2="${mid}" stroke="${AXIS}" stroke-dasharray="3 3"/>` };
}

const goldAt = (series: number[], minute: number) => series[Math.min(series.length - 1, Math.max(0, Math.floor(minute)))] ?? 0;

/**
 * One game: gold vs lane opponent, deaths on the curve (yellow before 15, coral after), kills as ticks, item
 * completions as their Data Dragon icon (a diamond while the icon is not cached).
 */
export function timelineSvg(game: ChartGame, W = 560, H = 200): string {
	const chart = game.chart!;
	const scale = Math.max(1, ...chart.gd.map(Math.abs));
	const ICON = 26;
	const minutes = Math.max(1, chart.gd.length - 1);
	const X0 = 36;
	const X1 = W - 16;
	const xAt = (minute: number) => X0 + (Math.min(minute, minutes) / minutes) * (X1 - X0); // the same x as area() below
	// Up to three marker rows. Each item takes the first row where its marker and name fit after what that row
	// already holds: the full name right of the marker, else left of it, then its first word ("Zhonya's"), then the
	// marker alone. Only when no row has room even for the marker does it share the emptiest one.
	const rowEnds: number[] = [];
	const placed = [...chart.items]
		.sort((p, q) => p.min - q.min)
		.map((item) => {
			const x = xAt(item.min);
			const icon = itemIconData(item.name);
			const gap = icon ? ICON / 2 + 6 : 9;
			const spans = [...new Set([item.name, item.name.split(" ")[0]])]
				.flatMap((name) => {
					const nameW = name.length * 8.3; // monospace at 15 px
					return [
						{ left: x - gap, right: x + gap + nameW, anchor: "start", name },
						{ left: x - gap - nameW, right: x + gap, anchor: "end", name },
					];
				})
				.concat({ left: x - gap, right: x + gap, anchor: "", name: "" })
				.filter((span) => span.left >= 0 && span.right <= W);
			const bare = { left: x - gap, right: x + gap, anchor: "", name: "" };
			let fit: { row: number; span: (typeof spans)[number] } | undefined;
			search: for (const span of spans)
				for (let row = 0; row < 3; row++)
					if (span.left > (rowEnds[row] ?? Number.NEGATIVE_INFINITY) + 8) {
						fit = { row, span };
						break search;
					}
			fit ??= { row: rowEnds.indexOf(Math.min(...rowEnds)), span: bare };
			rowEnds[fit.row] = Math.max(rowEnds[fit.row] ?? Number.NEGATIVE_INFINITY, fit.span.right);
			return { x, icon, gap, ...fit };
		});
	const markerRow = (row: number) => 4 + ICON / 2 + row * (ICON + 4); // centre of a marker in that row
	const a = area(chart.gd, X0, 12 + Math.max(2, rowEnds.length) * (ICON + 4), X1, H - 40, scale);
	const ticks = Array.from({ length: Math.floor(minutes / 5) + 1 }, (_, i) => text(a.xs(i * 5), H - 8, String(i * 5), AXIS, 15, "middle")).join("");
	const kills = chart.kills.filter((minute) => plotted(minute, chart.gd)).map((minute) => `<line x1="${a.xs(minute)}" x2="${a.xs(minute)}" y1="${H - 36}" y2="${H - 26}" stroke="${KILL}" stroke-width="2.4"/>`).join("");
	const deaths = chart.deaths.filter((death) => plotted(death.min, chart.gd)).map((death) => cross(a.xs(death.min), a.ys(goldAt(chart.gd, death.min)), deathColor(death), 6)).join("");
	const items = placed
		.map(({ x, icon, gap, row, span }) => {
			const y = markerRow(row);
			const mark = icon
				? `<image href="data:image/png;base64,${icon}" x="${x - ICON / 2}" y="${y - ICON / 2}" width="${ICON}" height="${ICON}"/><rect x="${x - ICON / 2}" y="${y - ICON / 2}" width="${ICON}" height="${ICON}" fill="none" stroke="${ITEM}" stroke-width="1.5"/>`
				: `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" transform="rotate(45 ${x} ${y})" fill="${ITEM}"/>`;
			const label = span.anchor === "start" ? text(x + gap, y + 5, span.name, ITEM, 15) : span.anchor === "end" ? text(x - gap, y + 5, span.name, ITEM, 15, "end") : "";
			return `<line x1="${x}" x2="${x}" y1="${y + gap - 4}" y2="${H - 40}" stroke="${ITEM}" stroke-opacity=".22"/>${mark}${label}`;
		})
		.join("");
	const vs = game.vs ? ` vs ${game.vs}` : "";
	const scaleLabel = text(40, H - 46, `gold${vs} · ±${kFormat(scale).slice(1)}`, LABEL, 15);
	return svg(W, H, `${items}${a.body}${ticks}${kills}${deaths}${scaleLabel}`);
}

/** Where each death happened on the map, numbered by minute. */
export function deathMapSvg(game: ChartGame, M = 200): string {
	const r = M * 0.026;
	const size = M * 0.056;
	const points = located(game.chart?.deaths ?? []).map((death) => ({ death, ...riftPoint(death.x, death.y, M) }));
	const dots = points.map(({ death, x, y }) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${deathColor(death)}" stroke="#0b2228" stroke-width="1.5"/>`).join("");
	// Minute labels right of their dot, else left, above, or below: the first spot clear of every label already placed.
	const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
	const labels = points
		.map(({ death, x, y }) => {
			const body = String(Math.floor(death.min));
			const w = body.length * size * 0.6;
			const spots = [
				{ tx: x + r + 3, ty: y + size * 0.36, anchor: "start" },
				{ tx: x - r - 3, ty: y + size * 0.36, anchor: "end" },
				{ tx: x, ty: y - r - 3, anchor: "middle" },
				{ tx: x, ty: y + r + size, anchor: "middle" },
			].map((spot) => {
				const x0 = spot.anchor === "start" ? spot.tx : spot.anchor === "end" ? spot.tx - w : spot.tx - w / 2;
				return { ...spot, box: { x0, y0: spot.ty - size * 0.8, x1: x0 + w, y1: spot.ty + size * 0.1 } };
			});
			const spot = spots.find(({ box }) => !placed.some((p) => box.x0 < p.x1 && p.x0 < box.x1 && box.y0 < p.y1 && p.y0 < box.y1)) ?? spots[0];
			placed.push(spot.box);
			return text(spot.tx, spot.ty, body, LINE, size, spot.anchor).replace("font-family=", 'font-weight="700" font-family=');
		})
		.join("");
	return svg(M, M, riftBackground(M) + dots + labels);
}

const SCENE_COLS = 6;
const SCENE_GAP = 10;
const SCENE_CAPTION = 76;
/** A champion's place read more than this many seconds from the death is drawn faded: far enough off to have walked across the tile. */
const SCENE_FRESH_SEC = 15;

const clock = (minute: number) => {
	const seconds = Math.round(minute * 60);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Half the width the tiles' map is kept at: the rasterizer draws at 2x, so 1024 px. */
const SCENE_MAP_PX = 512;
let sceneMap: string | undefined;

/**
 * One tile's ground: the square of the Rift `view` names (a viewBox on a map `MAP` units wide), as a picture of its
 * own, `T` units a side at (x, y). Cropped ahead because clipping the whole map inside the chart costs about 70 ms
 * a tile, and a dozen deaths then stall the card for most of a second; a small picture each is a quarter of that.
 * The map it crops is rasterized once at a quarter of the file's pixels, which is still about one map pixel per
 * screen pixel in a tile. Without the rasterizer or the map file, or with no `view` (a death Riot sent no place
 * for), a tile is the void colour alone.
 */
function sceneGround(view: string | undefined, MAP: number, x: number, y: number, T: number): string {
	const full = riftMapHref();
	if (full && !sceneMap) {
		const png = svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${SCENE_MAP_PX}" height="${SCENE_MAP_PX}"><image href="${full}" width="${SCENE_MAP_PX}" height="${SCENE_MAP_PX}"/></svg>`);
		if (png) sceneMap = `data:image/png;base64,${png.toString("base64")}`;
	}
	const crop = sceneMap && view ? svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${T.toFixed(1)}" height="${T.toFixed(1)}" viewBox="${view}"><image href="${sceneMap}" width="${MAP}" height="${MAP}"/></svg>`) : undefined;
	const at = `x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${T.toFixed(1)}" height="${T.toFixed(1)}"`;
	return `<rect ${at} fill="${RIFT_VOID}"/>${crop ? `<image href="data:image/png;base64,${crop.toString("base64")}" ${at}/>` : ""}`;
}

/** How far the others' positions are from a death's instant, in words: "6 s before", "18 s after". */
export function sceneOffsetText(offsetSec: number): string {
	return offsetSec === 0 ? "at the death" : `${Math.abs(offsetSec)} s ${offsetSec < 0 ? "before" : "after"}`;
}

/** The champions the per-death maps of this audit draw, for the portrait prefetch. */
export function sceneChampions(games: ChartGame[]): string[] {
	return [...new Set((worstGame(chartedGames(games))?.chart?.deaths ?? []).flatMap((death) => death.scene?.champions.map((champion) => champion.name) ?? []))];
}

/**
 * One zoomed map per death, in the order they happened: the death exactly where Riot put it, and the other champions
 * where the nearest minute frame put them (teal ring ally, coral ring enemy, faded when that frame is more than
 * SCENE_FRESH_SEC off), as Data Dragon portraits or two letters while a portrait is not cached. Under each: the
 * clock, who killed, the two biggest sources of the killing damage, and how far off the others' positions are.
 */
export function deathScenesSvg(game: ChartGame, W = 1000): string {
	const deaths = game.chart?.deaths ?? [];
	const T = (W - (SCENE_COLS - 1) * SCENE_GAP) / SCENE_COLS;
	const TOP = 24; // legend line
	const MAP = 1000; // the whole Rift, in the units every tile's viewBox crops
	const span = (SCENE_SPAN / MAP_SIZE) * MAP;
	const r = T * 0.09;
	const size = 13;
	const fits = Math.floor(T / (size * 0.6));
	const faces = new Map<string, string>();
	const tiles = deaths
		.map((death, index) => {
			const x0 = (index % SCENE_COLS) * (T + SCENE_GAP);
			const y0 = TOP + Math.floor(index / SCENE_COLS) * (T + SCENE_CAPTION + SCENE_GAP);
			const centre = riftPoint(death.x, death.y, MAP);
			const view = `${(centre.x - span / 2).toFixed(1)} ${(centre.y - span / 2).toFixed(1)} ${span.toFixed(1)} ${span.toFixed(1)}`;
			// No scene means no place to trust (Riot sent none, and the mark sits at the map's corner): an empty tile, never a cross where the death did not happen.
			const map = sceneGround(death.scene ? view : undefined, MAP, x0, y0, T);
			const faded = Math.abs(death.scene?.offsetSec ?? 0) > SCENE_FRESH_SEC;
			// ponytail: portraits standing on each other overlap as drawn; spread them only if a fight reads as one face.
			const marks = (death.scene?.champions ?? [])
				.map((champion) => {
					const point = riftPoint(champion.x, champion.y, MAP);
					// Kept a radius inside the tile, so a champion at its edge is still a whole portrait.
					const cx = x0 + Math.min(T - r, Math.max(r, ((point.x - centre.x) / span + 0.5) * T));
					const cy = y0 + Math.min(T - r, Math.max(r, ((point.y - centre.y) / span + 0.5) * T));
					const ring = champion.ally ? AHEAD : BEHIND;
					const id = champion.name.replace(/[^A-Za-z0-9]/g, "");
					const data = championIconData(champion.name);
					if (data && !faces.has(id)) faces.set(id, `<image id="face-${id}" href="data:image/png;base64,${data}" width="100" height="100" clip-path="url(#face)"/>`);
					const face = data
						? `<use href="#face-${id}" transform="translate(${(cx - r).toFixed(1)} ${(cy - r).toFixed(1)}) scale(${(r / 50).toFixed(4)})"/>`
						: `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="#0b2228"/>${text(cx, cy + r * 0.36, champion.name.slice(0, 2), ring, r, "middle")}`;
					return `<g opacity="${faded ? 0.55 : 1}">${face}<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${ring}" stroke-width="2"/></g>`;
				})
				.join("");
			const mid = { x: x0 + T / 2, y: y0 + T / 2 };
			const died = !death.scene ? "" : cross(mid.x, mid.y, "#0b2228", 8).replace('stroke-width="2.6"', 'stroke-width="6"') + cross(mid.x, mid.y, deathColor(death), 7);
			const when = clock(death.min);
			const killers = death.scene?.killers ?? [];
			const who = !death.scene ? "" : killers.length ? `${killers[0]}${killers.length > 1 ? ` +${killers.length - 1}` : ""}` : "executed";
			// The two biggest sources of the killing damage, the champion's name cut short before the share is.
			const hurt = (death.damage ?? []).slice(0, 2).map((source, line) => {
				const rest = `${source.how ? ` ${source.how}` : ""} ${source.pct}%`;
				return text(x0, y0 + T + 33 + line * 17, `${source.from.slice(0, Math.max(1, fits - rest.length))}${rest}`, LINE, size);
			});
			const caption =
				text(x0, y0 + T + 16, when, deathColor(death), size) +
				text(x0 + (when.length + 1) * size * 0.6, y0 + T + 16, who.slice(0, Math.max(0, fits - when.length - 1)), LINE, size) +
				hurt.join("") +
				text(x0, y0 + T + 67, death.scene ? `others ${sceneOffsetText(death.scene.offsetSec)}` : "no positions sent", LABEL, size);
			return `${map}${marks}${died}<rect x="${x0.toFixed(1)}" y="${y0}" width="${T.toFixed(1)}" height="${T.toFixed(1)}" fill="none" stroke="${AXIS}"/>${caption}`;
		})
		.join("");
	const rows = Math.ceil(deaths.length / SCENE_COLS);
	const H = TOP + rows * (T + SCENE_CAPTION) + Math.max(0, rows - 1) * SCENE_GAP;
	const defs = `<defs><clipPath id="face"><circle cx="50" cy="50" r="50"/></clipPath>${[...faces.values()].join("")}</defs>`;
	const legend = text(0, 16, `cross = where you died · others from the minute's frame, faded past ${SCENE_FRESH_SEC} s · % = share of the damage that killed you`, LABEL, 14);
	return svg(W, H, `${defs}${legend}${tiles}`);
}

/** Timeline and death map side by side, `W` pixels wide: the map keeps its square, the timeline takes the rest. */
export function cardSvg(game: ChartGame, W = 772, H = CARD_HEIGHT): string {
	const inner = (markup: string) => markup.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
	const timelineWidth = W - H - 12;
	return svg(W, H, `${inner(timelineSvg(game, timelineWidth, H))}<g transform="translate(${W - H},0)">${inner(deathMapSvg(game, H))}</g>`);
}

/** Exact-count colour for the death heat map: 1, 2, 3, 4, 5+ deaths in one cell, dark to bright, each step its own hue. */
const HEAT = ["#5b2a86", "#b8327a", "#ee5a4a", "#ffa23a", "#fff07a"];

/**
 * Every death across the audited games on one map: hexagonal cells coloured by how many deaths landed in
 * each, gem-shaded, with the count on cells of 3 or more and a key in the map's empty top-right corner.
 * The map is drawn in dim neutrals on near-black, so the cells carry all the colour.
 */
export function heatSvg(games: ChartGame[], W = 1000): string {
	const deaths = games.flatMap((game) => located(game.chart?.deaths ?? []));
	const R = W * 0.0375;
	const bins = new Map<string, { cx: number; cy: number; n: number }>();
	for (const death of deaths) {
		const { x, y } = riftPoint(death.x, death.y, W);
		const q = Math.round(x / (R * 1.5));
		const off = q % 2 ? R * 0.866 : 0;
		const r = Math.round((y - off) / (R * 1.732));
		const bin = bins.get(`${q},${r}`) ?? { cx: q * R * 1.5, cy: r * R * 1.732 + off, n: 0 };
		bin.n++;
		bins.set(`${q},${r}`, bin);
	}
	const ring = (cx: number, cy: number, r: number, from = 0, to = 5) =>
		Array.from({ length: to - from + 1 }, (_, k) => { const i = from + k; return `${(cx + r * Math.cos((Math.PI / 3) * i - Math.PI / 6)).toFixed(1)},${(cy + r * Math.sin((Math.PI / 3) * i - Math.PI / 6)).toFixed(1)}`; }).join(" ");
	const shade = (c: string, k: number) => `#${[1, 3, 5].map((i) => Math.max(0, Math.min(255, Math.round(parseInt(c.slice(i, i + 2), 16) * k))).toString(16).padStart(2, "0")).join("")}`;
	const ink = (n: number) => (n >= 4 ? "#1a1020" : "#ffffff");
	const cells = [...bins.values()]
		.map((bin) => {
			const c = HEAT[Math.min(HEAT.length, bin.n) - 1];
			const r = R - W * 0.004;
			const inner = r - W * 0.006;
			return `<polygon points="${ring(bin.cx, bin.cy, r)}" fill="${shade(c, 0.7)}"/><polygon points="${ring(bin.cx, bin.cy, inner)}" fill="${c}"/><polygon points="${bin.cx.toFixed(1)},${bin.cy.toFixed(1)} ${ring(bin.cx, bin.cy, inner, 3, 5)}" fill="${shade(c, 1.22)}"/>${bin.n >= 3 ? text(bin.cx, bin.cy + W * 0.0095, String(bin.n), ink(bin.n), W * 0.027, "middle").replace("font-family=", 'font-weight="700" font-family=') : ""}`;
		})
		.join("");
	const chipW = W * 0.075;
	const chipH = W * 0.05;
	const keyX = W - W * 0.02 - HEAT.length * (chipW + W * 0.01);
	const key = `<rect x="${keyX - W * 0.012}" y="${W * 0.02}" width="${HEAT.length * (chipW + W * 0.01) + W * 0.014}" height="${chipH + W * 0.024}" rx="${W * 0.012}" fill="${RIFT_VOID}" fill-opacity=".9"/>` +
		HEAT.map((c, i) => { const x = keyX + i * (chipW + W * 0.01); return `<rect x="${x}" y="${W * 0.032}" width="${chipW}" height="${chipH}" rx="${W * 0.008}" fill="${c}"/>${text(x + chipW / 2, W * 0.032 + chipH * 0.72, i === HEAT.length - 1 ? "5+" : String(i + 1), ink(i + 1), W * 0.028, "middle").replace("font-family=", 'font-weight="700" font-family=')}`; }).join("");
	return svg(W, W, `${riftBackground(W)}${cells}${key}`);
}

/** What the item-timing chart reads from the audit: the player's medians and counts, and the one-trick's minutes. */
export interface ItemTimings {
	games: number;
	mine: Record<string, number>;
	counts: Record<string, number>;
	reference: Record<string, number>;
}

const TRACKS_HEIGHT = 300;

/**
 * Two build tracks on one minute axis: the player's median purchase minute per item and the one-trick's,
 * each item as its Data Dragon icon (a lettered box while the icon is not cached) with the minute under it.
 * Icons alternate above and below the track so neighbours never overlap.
 */
export function tracksSvg(timings: ItemTimings, W = 1000, H = TRACKS_HEIGHT): string {
	const left = W * 0.12;
	const right = W * 0.04;
	const minutes = Math.max(20, Math.ceil(Math.max(...Object.values(timings.mine), ...Object.values(timings.reference), 1) / 5) * 5 + 5);
	const xs = (minute: number) => left + (minute / minutes) * (W - left - right);
	const box = W * 0.034;
	const icon = (name: string, x: number, y: number, stroke: string) => {
		const data = itemIconData(name);
		const id = `i${Math.round(x)}${Math.round(y)}`;
		const frame = `<rect x="${x - box / 2}" y="${y}" width="${box}" height="${box}" rx="${box * 0.18}" fill="#0b2228" stroke="${stroke}" stroke-width="1.5"/>`;
		if (!data) return `${frame}${text(x, y + box * 0.64, esc(name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()), stroke, box * 0.34, "middle")}`;
		return `<defs><clipPath id="${id}"><rect x="${x - box / 2 + 2}" y="${y + 2}" width="${box - 4}" height="${box - 4}" rx="${box * 0.14}"/></clipPath></defs>${frame}<image href="data:image/png;base64,${data}" x="${x - box / 2 + 2}" y="${y + 2}" width="${box - 4}" height="${box - 4}" clip-path="url(#${id})"/>`;
	};
	const track = (label: string, timing: Record<string, number>, color: string, y: number, counts?: Record<string, number>) => {
		let body = text(W * 0.016, y + 5, label, color, 15) + `<line x1="${xs(0)}" x2="${xs(minutes)}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="2" stroke-opacity=".5"/>`;
		Object.entries(timing)
			.sort((a, b) => a[1] - b[1])
			.forEach(([name, minute], k) => {
				const x = xs(minute);
				const above = k % 2 === 0;
				const boxY = above ? y - 14 - box : y + 14;
				body += `<line x1="${x}" x2="${x}" y1="${y - 8}" y2="${y + 8}" stroke="${color}" stroke-width="2"/>${icon(name, x, boxY, color)}`;
				const caption = counts && counts[name] !== undefined ? `${clock(minute)} · ${counts[name]}/${timings.games}` : clock(minute);
				body += text(x, above ? boxY - 6 : boxY + box + 14, caption, LABEL, 11, "middle");
			});
		return body;
	};
	const axis = Array.from({ length: minutes / 5 + 1 }, (_, i) => text(xs(i * 5), H - 10, String(i * 5), AXIS, 12, "middle")).join("");
	return svg(W, H, `${track("you", timings.mine, AHEAD, H * 0.27, timings.counts)}${track("one-trick", timings.reference, EARLY_DEATH, H * 0.7)}${axis}`);
}

// --- rasterize + cache -------------------------------------------------------------

interface CachedChart {
	/** The chart's SVG at a given design width; `chartLines` scales it to the pane. */
	build: (widthPx: number) => string;
	/** Rendered rows per pane width and background. */
	rows: Map<string, string[]>;
	/** Kitty: one image id per chart, so a re-render replaces the placement instead of stacking one. */
	imageId: number;
}

// A long /review session renders one chart per audit; cap so the cache can't grow for the life of the process.
const MAX_CACHED_CHARTS = 12;
const chartCache = new Map<string, CachedChart>();

/** Rendered charts held right now; never above MAX_CACHED_CHARTS. */
export function cachedChartCount(): number {
	return chartCache.size;
}

function cacheChart(key: string, entry: CachedChart): void {
	chartCache.set(key, entry);
	if (chartCache.size > MAX_CACHED_CHARTS) chartCache.delete(chartCache.keys().next().value!);
}

/** Game with the worst gold at 15: the one the expanded card explains. A remake has no gd15 worth explaining, so it never wins. */
export function worstGame(games: ChartGame[]): ChartGame | undefined {
	return [...games].filter((game) => game.chart && !game.remake).sort((a, b) => (a.gd15 ?? 0) - (b.gd15 ?? 0))[0];
}

/** Cache keys the card asks for: one game gets its card; several get the worst game's card when expanded. */
/**
 * The games that get charted: a gold series longer than one minute, and never a remake, whose few minutes of gold
 * diff would otherwise pass the length check. Every chart and every cache key starts from this one list, so the
 * card and the gateway can hand in the raw game list and still agree on keys.
 */
export function chartedGames(games: unknown): ChartGame[] {
	return (Array.isArray(games) ? (games as ChartGame[]) : []).filter((game) => Array.isArray(game?.chart?.gd) && game.chart!.gd.length > 1 && !game.remake);
}

export function chartKeys(games: ChartGame[], timings?: ItemTimings): { card?: string; scenes?: string; heat?: string; tracks?: string } {
	const charted = chartedGames(games);
	const worst = worstGame(charted);
	const ids = charted.map((game) => game.id ?? "?").join(",");
	const tracked = timings && Object.keys(timings.mine).length && Object.keys(timings.reference).length;
	return {
		card: worst ? `card:${worst.id ?? "?"}` : undefined,
		// The card's game, death by death: only when a death carries who stood where.
		scenes: worst?.chart!.deaths.some((death) => death.scene) ? `scenes:${worst.id ?? "?"}` : undefined,
		heat: charted.length > 1 && charted.some((game) => located(game.chart!.deaths).length) ? `heat:${ids}` : undefined,
		tracks: tracked ? `tracks:${timings.games}:${Object.entries(timings.mine).map(([name, minute]) => `${name}@${minute}`).join(",")}` : undefined,
	};
}

/** The audit response's item timings in the shape the tracks chart reads, or undefined when the audit carries none. */
export function itemTimings(data: any): ItemTimings | undefined {
	const mine = data?.summary?.medianItemTimingMin;
	const reference = data?.reference?.itemTimingMin;
	if (!mine || typeof mine !== "object" || !reference || typeof reference !== "object") return undefined;
	return { games: Number(data.summary.games ?? 0), mine, counts: data.summary.itemPurchaseCount ?? {}, reference };
}

/**
 * Get ready to draw the charts `chartKeys` names: load the rasterizer and register each chart's SVG builder.
 * Drawing happens at render time, at the pane's width. Skips all work when the terminal draws no images.
 */
export async function prepareAuditCharts(games: ChartGame[], timings?: ItemTimings): Promise<void> {
	if (!(await loadRasterizer())) return;
	for (const { key, build } of auditCharts(games, timings)) if (!chartCache.has(key)) cacheChart(key, { build, rows: new Map(), imageId: allocateImageId() });
}

/** Every chart an audit gets, in card order, each with its cache key and its SVG builder. The one list of what draws what. */
export function auditCharts(all: ChartGame[], timings?: ItemTimings): Array<{ kind: "card" | "scenes" | "heat" | "tracks"; key: string; build: (widthPx: number) => string }> {
	const games = chartedGames(all);
	const keys = chartKeys(games, timings);
	const worst = worstGame(games);
	return [
		keys.card && worst ? { kind: "card" as const, key: keys.card, build: (widthPx: number) => cardSvg(worst, widthPx) } : undefined,
		keys.scenes && worst ? { kind: "scenes" as const, key: keys.scenes, build: (widthPx: number) => deathScenesSvg(worst, widthPx) } : undefined,
		keys.heat ? { kind: "heat" as const, key: keys.heat, build: (widthPx: number) => heatSvg(games, widthPx) } : undefined,
		keys.tracks && timings ? { kind: "tracks" as const, key: keys.tracks, build: (widthPx: number) => tracksSvg(timings, widthPx) } : undefined,
	].filter((chart) => chart !== undefined);
}

export type RGB = [number, number, number];
/** The ground a Sixel picture is drawn on. Sixel has no alpha channel, so it cannot sit on the terminal's own background the way a Kitty or iTerm2 picture does. */
export const DEFAULT_BACKGROUND: RGB = [11, 34, 40];

/** A chart's SVG at the design width, exactly as the card rasterizes it: on a solid `background` when one is named, else with none, so the PNG keeps its alpha. */
export function chartMarkup(build: (widthPx: number) => string, background?: RGB): string {
	const markup = build(DESIGN_WIDTH);
	return background ? markup.replace(/(<svg[^>]*>)/, `$1<rect width="100%" height="100%" fill="rgb(${background.join(",")})"/>`) : markup;
}

/**
 * Card rows for a prepared chart, scaled to fill `width` cells with its aspect kept, or undefined when this
 * terminal cannot draw it (see terminal-images.ts). Kitty and iTerm2 pictures have no background of their own:
 * the terminal composites their alpha, so the chart sits on whatever the terminal shows. Sixel has no alpha and
 * gets DEFAULT_BACKGROUND; a caller can name another ground.
 */
export function chartLines(key: string | undefined, width: number, background: RGB | undefined = imageProtocol() === "sixel" ? DEFAULT_BACKGROUND : undefined): string[] | undefined {
	const cached = key ? chartCache.get(key) : undefined;
	if (!cached) return undefined;
	const memo = `${drawKey()}:${width}:${background?.join(",") ?? "none"}`;
	const hit = cached.rows.get(memo);
	if (hit) return hit;
	let markup: string;
	try {
		markup = chartMarkup(cached.build, background);
	} catch (error) {
		logEvent("warn", "charts", "chart-markup-failed", { key }, error); // a builder that threw: this chart stays on its text fallback
		return undefined;
	}
	const rows = svgRows(markup, width, cached.imageId);
	if (rows) cached.rows.set(memo, rows);
	return rows;
}

// --- text fallback -------------------------------------------------------------------

const BLOCKS = "▁▂▃▄▅▆▇█";

/** One cell per minute: block height = |gold diff| on the given scale, colored by sign. */
export function goldStrip(fg: (role: string, text: string) => string, gd: number[], scale = Math.max(1, ...gd.map(Math.abs))): string {
	return gd.map((gold) => fg(gold >= 0 ? "accent" : "error", BLOCKS[Math.min(7, Math.floor((Math.abs(gold) / scale) * 8))])).join("");
}

/** Marker row aligned to the strip: `glyph` at each event minute. */
export function markerRow(minutes: number[], length: number, glyph: string): string {
	const row = Array<string>(length).fill(" ");
	for (const minute of minutes) row[Math.min(length - 1, Math.max(0, Math.floor(minute)))] = glyph;
	return row.join("").trimEnd();
}

/** Minute labels every 5 under a strip of `length` cells. */
export function minuteAxis(length: number): string {
	return Array.from({ length: Math.ceil(length / 5) }, (_, i) => String(i * 5).padEnd(5)).join("").slice(0, length + 2).trimEnd();
}
