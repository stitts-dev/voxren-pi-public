import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadMapZones, parseMapZones, zoneOf } from "./map-zones";

const ZONES = loadMapZones()!;
const BLUE = 100;
const RED = 200;

describe("zoneOf", () => {
	test("the shipped zone table loads", () => {
		expect(ZONES).toBeDefined();
		expect(ZONES.pits.map((pit) => pit.name)).toEqual(["Baron pit", "dragon pit"]);
	});

	test("names lanes, river, jungle, pits, and bases from the blue side", () => {
		// Positions are well-known map features in Riot units.
		expect(zoneOf({ x: 980, y: 10440 }, BLUE, ZONES)).toBe("top lane, own side"); // blue outer top turret
		expect(zoneOf({ x: 4320, y: 13870 }, BLUE, ZONES)).toBe("top lane, enemy side"); // red outer top turret
		expect(zoneOf({ x: 5846, y: 6396 }, BLUE, ZONES)).toBe("mid lane, own side"); // blue outer mid turret
		expect(zoneOf({ x: 10500, y: 1030 }, BLUE, ZONES)).toBe("bot lane, own side"); // blue outer bot turret
		expect(zoneOf({ x: 13870, y: 4505 }, BLUE, ZONES)).toBe("bot lane, enemy side"); // red outer bot turret
		expect(zoneOf({ x: 5000, y: 10400 }, BLUE, ZONES)).toBe("Baron pit");
		expect(zoneOf({ x: 9850, y: 4400 }, BLUE, ZONES)).toBe("dragon pit");
		expect(zoneOf({ x: 6000, y: 9000 }, BLUE, ZONES)).toBe("top river");
		expect(zoneOf({ x: 9000, y: 6000 }, BLUE, ZONES)).toBe("bot river");
		expect(zoneOf({ x: 3800, y: 7900 }, BLUE, ZONES)).toBe("own top jungle"); // blue side's blue buff
		expect(zoneOf({ x: 7770, y: 3900 }, BLUE, ZONES)).toBe("own bot jungle"); // blue side's red buff
		expect(zoneOf({ x: 7100, y: 10900 }, BLUE, ZONES)).toBe("enemy top jungle"); // red side's red buff
		expect(zoneOf({ x: 1550, y: 1650 }, BLUE, ZONES)).toBe("own base");
		expect(zoneOf({ x: 13050, y: 13150 }, BLUE, ZONES)).toBe("enemy base");
	});

	test("own and enemy swap for the red side, and the river keeps its name", () => {
		expect(zoneOf({ x: 980, y: 10440 }, RED, ZONES)).toBe("top lane, enemy side");
		expect(zoneOf({ x: 3800, y: 7900 }, RED, ZONES)).toBe("enemy top jungle");
		expect(zoneOf({ x: 13050, y: 13150 }, RED, ZONES)).toBe("own base");
		expect(zoneOf({ x: 6000, y: 9000 }, RED, ZONES)).toBe("top river");
	});

	test("a missing position, a position off the map, or a missing table reads unknown, never a guess", () => {
		expect(zoneOf(undefined, BLUE, ZONES)).toBe("unknown");
		expect(zoneOf({ x: 100 }, BLUE, ZONES)).toBe("unknown");
		expect(zoneOf({ x: -5, y: 7000 }, BLUE, ZONES)).toBe("unknown");
		expect(zoneOf({ x: 7000, y: 20_000 }, BLUE, ZONES)).toBe("unknown");
		expect(zoneOf({ x: 7000, y: 7000 }, BLUE, undefined)).toBe("unknown");
	});
});

describe("zone table loading", () => {
	test("a table with a missing or non-positive measurement is rejected whole", () => {
		const good = { baseRadius: 5300, laneEdge: 2300, midHalfWidth: 950, riverHalfWidth: 1200, pits: [{ name: "Baron pit", x: 1, y: 1, r: 1 }] };
		expect(parseMapZones(good)).toEqual(good);
		expect(parseMapZones({ ...good, laneEdge: 0 })).toBeUndefined();
		expect(parseMapZones({ ...good, riverHalfWidth: "wide" })).toBeUndefined();
		expect(parseMapZones({ ...good, pits: [{ name: "", x: 1, y: 1, r: 1 }] })).toBeUndefined();
		expect(parseMapZones(null)).toBeUndefined();
	});

	test("a missing or unreadable file loads as undefined instead of throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-zones-"));
		expect(loadMapZones(join(dir, "absent.json"))).toBeUndefined();
		writeFileSync(join(dir, "broken.json"), "{not json");
		expect(loadMapZones(join(dir, "broken.json"))).toBeUndefined();
	});
});
