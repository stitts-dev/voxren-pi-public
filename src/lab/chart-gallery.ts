/**
 * Chart gallery: draws every audit chart for every scenario in chart-scenarios.ts to PNG, through the same
 * builders and rasterizer the coach uses, so a chart change is looked at on the same shapes every time.
 *
 *   bun run src/lab/chart-gallery.ts [scenario ...] [--out <dir>] [--no-icons]
 *
 * Writes <out>/<scenario>-<chart>.png (default out: a temp folder) and prints each path. Item icons and champion
 * portraits come from Data Dragon unless --no-icons. A lab, not a test: never under `bun test`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCapabilities } from "@earendil-works/pi-tui";
import { DEFAULT_BACKGROUND, auditCharts, chartMarkup, sceneChampions } from "../charts";
import { prefetchChampionIcons, prefetchItemIcons } from "../icons";
import { loadRasterizer, svgToPng } from "../terminal-images";
import { CHART_SCENARIOS } from "./chart-scenarios";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args.splice(at, 2)[1];
};
const out = flag("--out") ?? join(tmpdir(), "voxren-chart-gallery");
const icons = !args.includes("--no-icons");
const names = args.filter((arg) => !arg.startsWith("--"));
const scenarios = names.length ? CHART_SCENARIOS.filter((scenario) => names.includes(scenario.name)) : CHART_SCENARIOS;
if (!scenarios.length) throw new Error(`no scenario named ${names.join(", ")}; have ${CHART_SCENARIOS.map((scenario) => scenario.name).join(", ")}`);

setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false }); // draw as a Kitty terminal would
if (!(await loadRasterizer())) throw new Error("@resvg/resvg-js is not installed: run npm install");
if (icons) {
	const version = ((await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json()) as string[])[0];
	const items = new Set(scenarios.flatMap((scenario) => [...scenario.games.flatMap((game) => game.chart?.items.map((item) => item.name) ?? []), ...Object.keys(scenario.timings?.mine ?? {}), ...Object.keys(scenario.timings?.reference ?? {})]));
	await prefetchItemIcons([...items], version, "https://ddragon.leagueoflegends.com", fetch, 20_000);
	await prefetchChampionIcons([...new Set(scenarios.flatMap((scenario) => sceneChampions(scenario.games)))], version, "https://ddragon.leagueoflegends.com", fetch, 20_000);
}

mkdirSync(out, { recursive: true });
for (const scenario of scenarios) {
	console.log(`${scenario.name}: ${scenario.about}`);
	for (const chart of auditCharts(scenario.games, scenario.timings)) {
		const png = svgToPng(chartMarkup(chart.build, DEFAULT_BACKGROUND)); // on a ground, so a viewer that paints transparency white or black still shows it
		if (!png) throw new Error(`${scenario.name} ${chart.kind}: the SVG did not rasterize`);
		const path = join(out, `${scenario.name}-${chart.kind}.png`);
		writeFileSync(path, png);
		console.log(`  ${chart.kind.padEnd(6)} ${path}`);
	}
}
