import { afterEach, describe, expect, test } from "bun:test";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { inflateSync } from "node:zlib";
import { DEFAULT_BACKGROUND, auditCharts, chartKeys, chartLines, chartMarkup, deathMapSvg, deathScenesSvg, heatSvg, prepareAuditCharts, sceneChampions, sceneOffsetText, timelineSvg, worstGame } from "./charts";
import { CHART_SCENARIOS } from "./lab/chart-scenarios";

const hasResvg = await import("@resvg/resvg-js").then(() => true, () => false);
const hasSixel = await import("sixel").then(() => true, () => false);

/** Item-name labels on a timeline: where each one sits, measured the way the layout measures it. */
function itemLabels(markup: string) {
	return [...markup.matchAll(/<text x="([\d.]+)" y="([\d.]+)" fill="#fbbf24"[^>]*text-anchor="(\w+)">([^<]*)<\/text>/g)].map(([, x, y, anchor, name]) => {
		const width = name.replace(/&amp;/g, "&").length * 8.3;
		const left = anchor === "end" ? Number(x) - width : Number(x);
		return { y, left, right: left + width };
	});
}

describe("audit charts across scenarios", () => {
	afterEach(() => resetCapabilitiesCache());

	test("each scenario gets the charts its card shows, and every one builds", () => {
		const kinds = Object.fromEntries(CHART_SCENARIOS.map((scenario) => [scenario.name, auditCharts(scenario.games, scenario.timings).map((chart) => chart.kind).join(",")]));
		expect(kinds).toEqual({
			"one-loss": "card,scenes",
			"one-stomp": "card", // no deaths: nothing to zoom on
			"one-short": "card", // its death carries no scene
			"one-long": "card,scenes",
			"five-games": "card,scenes,heat,tracks",
			"ten-with-remake": "card,heat",
			"twenty-games": "card,heat",
		});
		for (const scenario of CHART_SCENARIOS)
			for (const chart of auditCharts(scenario.games, scenario.timings)) expect(chart.build(1000)).toStartWith("<svg");
	});

	test("the card finds what the gateway prepared, remakes included in what the gateway handed in", async () => {
		// The gateway prepares from the raw game list; the card asks with keys from the same list. A remake once
		// changed a several-game key on one side only, and the card fell back to text strips.
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const scenario = CHART_SCENARIOS.find((s) => s.name === "ten-with-remake")!;
		expect(auditCharts(scenario.games).map((chart) => chart.key)).not.toContain(expect.stringContaining("remake"));
		expect(chartKeys(scenario.games).heat).toBe(auditCharts(scenario.games).find((chart) => chart.kind === "heat")!.key);
		if (!hasResvg) return;
		await prepareAuditCharts(scenario.games);
		expect(chartLines(chartKeys(scenario.games).heat, 100)).toBeDefined();
	});

	test("item names never overlap, never leave the timeline, in any scenario or a crowded one", () => {
		const crowded = { chart: { gd: Array.from({ length: 26 }, (_, m) => -m * 100), deaths: [], kills: [], items: ["Zhonya's Hourglass", "Rabadon's Deathcap", "Seeker's Armguard", "Blackfire Torch"].map((name, i) => ({ name, min: 20 + i * 0.5 })) } };
		const games = [crowded, ...CHART_SCENARIOS.map((scenario) => worstGame(scenario.games)!)];
		for (const game of games) {
			const labels = itemLabels(timelineSvg(game, 708, 280));
			for (const [i, a] of labels.entries()) {
				expect(a.left).toBeGreaterThanOrEqual(0);
				expect(a.right).toBeLessThanOrEqual(708);
				for (const b of labels.slice(i + 1)) if (a.y === b.y) expect(a.right <= b.left || b.right <= a.left).toBe(true);
			}
		}
		// A 45-minute game with seven items: every one still gets a name, full or its first word.
		expect(itemLabels(timelineSvg(worstGame(CHART_SCENARIOS.find((scenario) => scenario.name === "one-long")!.games)!, 708, 280))).toHaveLength(7);
	});

	test("death minutes on the map move aside instead of printing on each other", () => {
		const near = { chart: { gd: [0, 0], kills: [], items: [], deaths: [{ min: 16, x: 7300, y: 7400, afterAllyDeath: false, traded: false }, { min: 17, x: 7500, y: 7200, afterAllyDeath: false, traded: false }] } };
		const [a, b] = [...deathMapSvg(near, 280).matchAll(/<text x="([\d.]+)" y="([\d.]+)"/g)].map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
		expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeGreaterThan(20);
	});

	test("a death Riot sent no position for is left off the death map and the heat map", () => {
		const mark = { afterAllyDeath: false, traded: false };
		const unplaced = { ...mark, min: 3, x: 0, y: 0 };
		const game = { id: "g", chart: { gd: [0, 0], kills: [], items: [], deaths: [unplaced] } };
		expect(deathMapSvg(game, 200)).not.toContain("<circle");
		expect(heatSvg([game, game])).not.toContain("<polygon");
		expect(chartKeys([game, { ...game, id: "h" }]).heat).toBeUndefined(); // every point missing: no heat map, as with no deaths
		const placed = { ...mark, min: 5, x: 7_000, y: 7_000 };
		const both = { id: "b", chart: { gd: [0, 0], kills: [], items: [], deaths: [unplaced, placed] } };
		expect(deathMapSvg(both, 200).match(/<circle/g)).toHaveLength(1);
		expect(chartKeys([both, { ...both, id: "c" }]).heat).toBe("heat:b,c");
	});

	test("a death or kill past the last plotted minute is dropped from the timeline, not drawn off the canvas", () => {
		const gd = Array.from({ length: 46 }, (_, i) => i * 10);
		const mark = { afterAllyDeath: false, traded: false, x: 7_000, y: 7_000 };
		const game = { id: "long", win: false, vs: "Ahri", gd15: 0, chart: { gd, kills: [10, 52.5], items: [], deaths: [{ ...mark, min: 20 }, { ...mark, min: 52.5 }] } };
		const xs = (markup: string) => [...markup.matchAll(/<path d="M([\d.]+) /g)].map(([, x]) => Number(x));
		expect(xs(timelineSvg(game, 560)).length).toBe(1);
		expect(timelineSvg(game, 560).match(/stroke="#7ce7a2"/g)).toHaveLength(1);
	});

	test("each death gets its own zoomed map: the death at the centre, the others where their frame put them, faded when that frame is far off", () => {
		const mark = { afterAllyDeath: false, traded: false };
		const damage = [{ from: "Hwei", how: "R", pct: 38 }, { from: "AurelionSolTheStarForger", how: "autos", pct: 22 }, { from: "tower", how: "", pct: 15 }];
		const near = { ...mark, min: 6.1, x: 7_000, y: 7_000, damage, scene: { killers: ["Hwei", "LeeSin"], offsetSec: -6, champions: [{ name: "Hwei", ally: false, x: 7_500, y: 7_250 }, { name: "Vi", ally: true, x: 6_000, y: 7_000 }] } };
		const stale = { ...mark, min: 8.7, x: 3_000, y: 11_000, scene: { killers: [], offsetSec: 18, champions: [{ name: "LeeSin", ally: false, x: 3_000, y: 11_000 }] } };
		const bare = { ...mark, min: 20.5, x: 9_000, y: 4_000 };
		const game = { id: "scenes", chart: { gd: [0, 0], kills: [], items: [], deaths: [near, stale, bare] } };
		expect(chartKeys([game]).scenes).toBe("scenes:scenes");
		expect(chartKeys([{ ...game, chart: { ...game.chart, deaths: [bare] } }]).scenes).toBeUndefined(); // no scene on any death: the card's own map is all there is
		expect(sceneChampions([game])).toEqual(["Hwei", "Vi", "LeeSin"]);

		// 1010 wide: six tiles of exactly 160 px with five 10 px gaps.
		const markup = deathScenesSvg(game, 1010);
		expect((markup.match(/fill="none" stroke="#4d7370"\/>/g) ?? []).length).toBe(3); // one framed tile per death
		// Tile 1 starts at (0, 24), 160 px for 5000 units: Hwei 500 right and 250 up of the death, Vi 1000 left of it.
		const rings = [...markup.matchAll(/<g opacity="([\d.]+)">.*?<circle cx="([\d.]+)" cy="([\d.]+)" r="[\d.]+" fill="none" stroke="(#\w+)"/g)].map(([, opacity, cx, cy, stroke]) => ({ opacity: Number(opacity), cx: Number(cx), cy: Number(cy), stroke }));
		expect(rings).toEqual([
			{ opacity: 1, cx: 96, cy: 96, stroke: "#ff7a6b" },
			{ opacity: 1, cx: 48, cy: 104, stroke: "#2dd4bf" },
			{ opacity: 0.55, cx: 250, cy: 104, stroke: "#ff7a6b" }, // tile 2 starts at x 170; 18 s off is past the 15 s mark
		]);
		for (const caption of ["6:06", "Hwei +1", "others 6 s before", "8:42", "executed", "others 18 s after", "20:30", "no positions sent"]) expect(markup).toContain(`>${caption}</text>`);
		// The two biggest damage sources under the killer; a name too long for the tile is cut, its slot and share kept; the third is left to the text rows.
		for (const caption of ["Hwei R 38%", "AurelionSo autos 22%"]) expect(markup).toContain(`>${caption}</text>`);
		expect(markup).not.toContain("tower 15%");
		// The death with no scene gets an empty tile: two crosses for three deaths (each cross is a dark halo and the cross itself).
		expect((markup.match(/<path /g) ?? []).length).toBe(4);
		expect(sceneOffsetText(0)).toBe("at the death");
	});

	for (const protocol of ["kitty", "iterm2", "sixel"] as const)
		test.skipIf(!hasResvg || (protocol === "sixel" && !hasSixel))(`every scenario draws on ${protocol}, sized to the pane at 40, 100, and 200 columns`, async () => {
			const saved = process.env.PI_FORCE_IMAGE_PROTOCOL;
			if (protocol === "sixel") process.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
			setCapabilities({ images: protocol === "sixel" ? null : protocol, trueColor: true, hyperlinks: false });
			try {
				for (const scenario of CHART_SCENARIOS) {
					await prepareAuditCharts(scenario.games, scenario.timings);
					for (const chart of auditCharts(scenario.games, scenario.timings)) {
						const heights = [40, 100, 200].map((width) => {
							const rows = chartLines(chart.key, width);
							expect(rows, `${scenario.name} ${chart.kind} at ${width}`).toBeDefined();
							// Kitty draws from the first row; iTerm2 and Sixel paint up from the last and restore the cursor.
							if (protocol === "kitty") expect(rows![0]).toContain("\x1b_G");
							else expect(rows!.at(-1)).toEndWith("\x1b8");
							return rows!.length;
						});
						expect(heights[0]).toBeLessThan(heights[1]);
						expect(heights[1]).toBeLessThan(heights[2]);
					}
				}
			} finally {
				if (saved === undefined) delete process.env.PI_FORCE_IMAGE_PROTOCOL;
				else process.env.PI_FORCE_IMAGE_PROTOCOL = saved;
			}
		}, 60_000); // rasterizes every chart three times; Sixel encoding alone takes seconds, about 27 on a Windows CI runner with the per-death maps
});

/** The RGBA of the top-left pixel of the PNG a Kitty or iTerm2 row carries: the first scanline's first pixel is stored raw whatever its filter. */
function firstPixel(rows: string[]): number[] {
	const base64 = (rows.join("").match(/[;:][A-Za-z0-9+/=]{16,}(?:\x1b\\|\x07)/g) ?? []).map((chunk) => chunk.slice(1).replace(/(?:\x1b\\|\x07)$/, "")).join("");
	const png = Buffer.from(base64, "base64");
	const data: Buffer[] = [];
	for (let at = 8; at < png.length; ) {
		const length = png.readUInt32BE(at);
		if (png.toString("latin1", at + 4, at + 8) === "IDAT") data.push(png.subarray(at + 8, at + 8 + length));
		at += 12 + length;
	}
	return [...inflateSync(Buffer.concat(data)).subarray(1, 5)];
}

describe("the ground a chart is drawn on", () => {
	afterEach(() => resetCapabilitiesCache());
	const scenario = CHART_SCENARIOS.find((entry) => entry.name === "five-games")!;

	test("a chart's markup has a background rectangle only when one is named", () => {
		const build = auditCharts(scenario.games, scenario.timings)[0].build;
		expect(chartMarkup(build)).not.toContain('<rect width="100%"');
		expect(chartMarkup(build, [1, 2, 3])).toContain('<rect width="100%" height="100%" fill="rgb(1,2,3)"/>');
	});

	for (const protocol of ["kitty", "iterm2"] as const)
		test.skipIf(!hasResvg)(`on ${protocol} every chart without its own map keeps its alpha, so the terminal's own background shows through`, async () => {
			setCapabilities({ images: protocol, trueColor: true, hyperlinks: false });
			await prepareAuditCharts(scenario.games, scenario.timings);
			const charts = auditCharts(scenario.games, scenario.timings).filter((chart) => chart.kind !== "heat"); // the death map draws the Rift
			expect(charts.length).toBeGreaterThanOrEqual(3);
			for (const chart of charts) expect(firstPixel(chartLines(chart.key, 100)!), chart.kind).toEqual([0, 0, 0, 0]);
			// A caller that names a ground still gets it.
			expect(firstPixel(chartLines(charts[0].key, 100, [11, 34, 40])!)).toEqual([11, 34, 40, 255]);
		});

	test.skipIf(!hasResvg || !hasSixel)("on Sixel, which has no alpha, a chart keeps a solid ground", async () => {
		const saved = process.env.PI_FORCE_IMAGE_PROTOCOL;
		process.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		try {
			await prepareAuditCharts(scenario.games, scenario.timings);
			const [card] = auditCharts(scenario.games, scenario.timings).filter((chart) => chart.kind === "card");
			expect(chartLines(card.key, 100)).toEqual(chartLines(card.key, 100, DEFAULT_BACKGROUND));
			expect(chartLines(card.key, 100)).not.toEqual(chartLines(card.key, 100, [255, 0, 255]));
		} finally {
			if (saved === undefined) delete process.env.PI_FORCE_IMAGE_PROTOCOL;
			else process.env.PI_FORCE_IMAGE_PROTOCOL = saved;
		}
	}, 30_000);
});
