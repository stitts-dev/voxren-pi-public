/**
 * The named area of Summoner's Rift a map position falls in, relative to the player's side: "top river",
 * "enemy bot jungle", "mid lane, own side". The measurements are game data, so they live in
 * data/map-zones.json (AGENTS rule 5) and this module only applies them. A missing or malformed file, or a
 * position off the map, reads "unknown": a zone is never guessed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logEvent } from "./coach-log";

/** Summoner's Rift coordinate extent (both axes) as timeline positions report it. */
export const MAP_SIZE = 14_870;

export interface MapZones {
	/** Radius of each base, measured from its map corner. */
	baseRadius: number;
	/** How far top and bot lane reach in from the map edges they run along. */
	laneEdge: number;
	/** Half the width of the mid lane, measured across it. */
	midHalfWidth: number;
	/** Half the width of the river, measured across it. */
	riverHalfWidth: number;
	pits: Array<{ name: string; x: number; y: number; r: number }>;
}

const MAP_ZONES_PATH = fileURLToPath(new URL("../data/map-zones.json", import.meta.url));
/** Riot's team id for the side whose base sits at the map origin. */
const BLUE_TEAM = 100;
export const UNKNOWN_ZONE = "unknown";

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** The zone table, or undefined when any measurement is missing or not a positive number. */
export function parseMapZones(raw: unknown): MapZones | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	if (!positive(record.baseRadius) || !positive(record.laneEdge) || !positive(record.midHalfWidth) || !positive(record.riverHalfWidth) || !Array.isArray(record.pits)) return undefined;
	const pits: MapZones["pits"] = [];
	for (const pit of record.pits) {
		if (typeof pit?.name !== "string" || !pit.name.trim() || !positive(pit.x) || !positive(pit.y) || !positive(pit.r)) return undefined;
		pits.push({ name: pit.name, x: pit.x, y: pit.y, r: pit.r });
	}
	return { baseRadius: record.baseRadius, laneEdge: record.laneEdge, midHalfWidth: record.midHalfWidth, riverHalfWidth: record.riverHalfWidth, pits };
}

/** Reads the zone table; undefined when the file is missing or malformed, so callers fall back to "unknown". */
export function loadMapZones(path: string = MAP_ZONES_PATH): MapZones | undefined {
	try {
		const zones = parseMapZones(JSON.parse(readFileSync(path, "utf8")));
		if (!zones) logEvent("warn", "map-zones", "malformed", { path });
		return zones;
	} catch (error) {
		logEvent("warn", "map-zones", "load-failed", { path }, error);
		return undefined;
	}
}

/** The lane word `zoneOf` uses ("mid" in "mid lane, own side") for a Riot team position; undefined for a jungler or no position. */
export function laneOf(teamPosition: string): "top" | "mid" | "bot" | undefined {
	return ({ TOP: "top", MIDDLE: "mid", BOTTOM: "bot", UTILITY: "bot" } as const)[teamPosition as "TOP"];
}

/** The area a position is in, named from the side of the team `teamId`. */
export function zoneOf(position: unknown, teamId: number, zones: MapZones | undefined): string {
	const point = position as { x?: unknown; y?: unknown } | undefined;
	const x = point?.x;
	const y = point?.y;
	if (!zones || typeof x !== "number" || typeof y !== "number" || !(x >= 0 && x <= MAP_SIZE && y >= 0 && y <= MAP_SIZE)) return UNKNOWN_ZONE;

	// The river runs along x + y = MAP_SIZE: below it is the blue half, above it the red half.
	const blueHalf = x + y < MAP_SIZE;
	const side = blueHalf === (teamId === BLUE_TEAM) ? "own" : "enemy";
	// Mid lane runs along y = x: above it is the top side of the map.
	const half = y > x ? "top" : "bot";

	const pit = zones.pits.find((candidate) => Math.hypot(x - candidate.x, y - candidate.y) <= candidate.r);
	if (pit) return pit.name;
	if (Math.hypot(x, y) <= zones.baseRadius || Math.hypot(MAP_SIZE - x, MAP_SIZE - y) <= zones.baseRadius) return `${side} base`;
	if (x <= zones.laneEdge || y >= MAP_SIZE - zones.laneEdge) return `top lane, ${side} side`;
	if (y <= zones.laneEdge || x >= MAP_SIZE - zones.laneEdge) return `bot lane, ${side} side`;
	if (Math.abs(y - x) / Math.SQRT2 <= zones.midHalfWidth) return `mid lane, ${side} side`;
	if (Math.abs(x + y - MAP_SIZE) / Math.SQRT2 <= zones.riverHalfWidth) return `${half} river`;
	return `${side} ${half} jungle`;
}
