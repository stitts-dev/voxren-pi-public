import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAP_SIZE } from "./map-zones";
import { logEvent } from "./coach-log";

/**
 * Summoner's Rift for every map overlay the coach draws (the audit card's death map, the death heat map, and
 * any later one). One background, one coordinate conversion: overlays place marks with `riftPoint` and draw
 * `riftBackground` under them, so every map in the app lines up the same way.
 *
 * The background is data/map-backgrounds/holographic.png: the 512 px Data Dragon minimap (map-dd.png, kept
 * beside it for regenerating) restyled at 2048 px, see docs/maps/. It keeps the minimap's geometry: the board
 * fills the whole square, so Riot coordinates map straight onto it (checked in rift-map.test.ts).
 */

const MAP_PATH = fileURLToPath(new URL("../data/map-backgrounds/holographic.png", import.meta.url));
/** The background's own void colour: overlays drawn on a square of it blend into the map's edges. */
export const RIFT_VOID = "#121314";
const OUTLINE = "#4d7370";

let href: string | undefined;

/** The map as a data URI for SVG `<image href>`, read once; undefined when the file is missing. */
export function riftMapHref(): string | undefined {
	try {
		href ??= `data:image/png;base64,${readFileSync(MAP_PATH).toString("base64")}`;
		return href;
	} catch (error) {
		logEvent("warn", "rift-map", "map-read-failed", { path: MAP_PATH }, error); // file missing: riftBackground draws an outline instead
		return undefined;
	}
}

/** Riot map units (0..MAP_SIZE, origin bottom-left) to pixels on a `size`-pixel square (origin top-left). */
export function riftPoint(x: number, y: number, size: number): { x: number; y: number } {
	return { x: (x / MAP_SIZE) * size, y: (1 - y / MAP_SIZE) * size };
}

/** SVG for the map filling a `size`-pixel square at the origin: the picture, or an outline and mid lane without it. */
export function riftBackground(size: number): string {
	const map = riftMapHref();
	return map
		? `<rect width="${size}" height="${size}" fill="${RIFT_VOID}"/><image href="${map}" width="${size}" height="${size}"/>`
		: `<rect x="1" y="1" width="${size - 2}" height="${size - 2}" fill="none" stroke="${OUTLINE}"/><line x1="0" y1="${size}" x2="${size}" y2="0" stroke="${OUTLINE}" stroke-dasharray="3 3"/>`;
}
