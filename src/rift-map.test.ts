import { describe, expect, test } from "bun:test";
import { deathMapSvg, heatSvg } from "./charts";
import { riftMapHref, riftPoint } from "./rift-map";

const hasResvg = await import("@resvg/resvg-js").then(() => true, () => false);

describe("rift map", () => {
	test.skipIf(!hasResvg)("every map draws the holographic Rift, lined up with Riot coordinates", async () => {
		const { Resvg } = await import("@resvg/resvg-js");
		expect(riftMapHref()).toStartWith("data:image/png;base64,");
		const size = 512;
		// No system font scan: it costs seconds on Windows CI, and this test reads map pixels, not text.
		const { pixels } = new Resvg(heatSvg([], size), { font: { loadSystemFonts: false } }).render();
		const lit = (x: number, y: number) => {
			const i = (Math.round(y) * size + Math.round(x)) * 4;
			return pixels[i] + pixels[i + 1] + pixels[i + 2] > 18 + 19 + 20 + 6; // brighter than the map's void (18, 19, 20)
		};
		let board = 0;
		for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 18 + 19 + 20 + 6) board++;
		expect(board / (size * size)).toBeGreaterThan(0.3); // the board, not an empty square
		// Riot's map centre and both inner lane bends are walkable ground; the two off-board corners are void.
		for (const [x, y] of [[7435, 7435], [2000, 12900], [12900, 2000]]) expect(lit(riftPoint(x, y, size).x, riftPoint(x, y, size).y)).toBe(true);
		expect(lit(4, 4)).toBe(false);
		expect(lit(size - 4, size - 4)).toBe(false);
		// The card's death map and the heat map share the one background and conversion.
		expect(deathMapSvg({ chart: { gd: [0], deaths: [], kills: [], items: [] } }, 280)).toContain(riftMapHref()!);
		expect(riftPoint(0, 0, 100)).toEqual({ x: 0, y: 100 }); // Riot's origin is bottom-left
	});

});
