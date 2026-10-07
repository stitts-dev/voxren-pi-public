/**
 * Strip preview: the coach's BUILD strip through the real renderer with live Data Dragon icons, so a change to its
 * look is judged at real pixels without a model turn. Prints each sample answer's strip at this terminal's width,
 * then the first one again at a narrow width to show the wrapping; --shot does the same in the coach's own WezTerm
 * window (rung 5, Windows) and captures it.
 *
 *   bun run src/lab/strip-preview.ts --shot strip.png [--answer <file>]   the WezTerm window, real pixels
 *   bun run src/lab/strip-preview.ts [--answer <file>]                    print here, in any terminal with pictures
 *   add --panel to either: the coach panel (src/panel.ts) in the strip's place, portraits and all
 *
 * Three real sample answers by default; --answer renders one answer read from a file. Uses the network, for a live
 * Data Dragon version and its icons. A lab, never under `bun test`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { buildIconNames, buildLines } from "../build-lines";
import { championsIn, prefetchChampionIcons, prefetchItemIcons, prefetchRuneIcons } from "../icons";
import { panelLines, panelModel } from "../panel";
import { buildStripLines } from "../ui";
import { SAMPLES, type Sample } from "./ui-data.ts";

const DDRAGON_BASE = "https://ddragon.leagueoflegends.com";
const NARROW_WIDTH = 52;
/** The last line printed: `--shot` waits for it, so the capture never catches a half-drawn screen. */
const DONE = "strip preview done";

/** Pi's own theme class over the repo's theme file, so the colours are the same ANSI the TUI draws. */
function loadTheme(ThemeCtor: any, name: string): Theme {
	const colors: Record<string, string | number> = JSON.parse(readFileSync(fileURLToPath(new URL(`../../themes/${name}.json`, import.meta.url)), "utf8")).colors;
	const backgrounds = ["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"];
	const pick = (wanted: boolean) => Object.fromEntries(Object.entries(colors).filter(([key]) => backgrounds.includes(key) === wanted)) as any;
	return new ThemeCtor(pick(false), pick(true), "truecolor");
}

/** One `wezterm.ts` call (it runs under node); its stdout, or the reason it failed. */
function wezterm(args: string[]): string {
	const result = spawnSync("node", [fileURLToPath(new URL("./wezterm.ts", import.meta.url)), ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`wezterm.ts ${args[0]}: ${result.stderr || result.stdout || result.error?.message}`);
	return result.stdout;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const flag = (name: string) => {
		const at = args.indexOf(name);
		return at < 0 ? undefined : args.splice(at, 2)[1];
	};
	const shot = flag("--shot");
	const answerFile = flag("--answer");
	const hold = args.includes("--hold");
	const panel = args.includes("--panel");
	const cols = flag("--cols") ?? "120";

	if (shot) {
		// --hold keeps the script running until `close`: WezTerm's exit message, written where ConPTY last left the cursor, lands mid-screen.
		const opened = wezterm(["open", "--wait", DONE, "--cols", cols, "--rows", panel ? "60" : "36", "--", process.execPath, "run", fileURLToPath(import.meta.url), "--hold", ...(panel ? ["--panel"] : []), ...(answerFile ? ["--answer", answerFile] : [])]);
		const pid = /pid (\d+)/.exec(opened)?.[1];
		if (!pid) throw new Error(`no pid from wezterm.ts open: ${opened}`);
		try {
			console.log(wezterm(["shot", "--pid", pid, shot]).trim());
		} finally {
			wezterm(["close", "--pid", pid]);
		}
		return;
	}

	// chalk (under Theme.bold) reads FORCE_COLOR once, at import: set it first so a piped run keeps its styling.
	process.env.FORCE_COLOR = "1";
	const { Theme: ThemeCtor } = await import("@earendil-works/pi-coding-agent");
	const samples: Sample[] = answerFile ? [{ title: basename(answerFile).replace(/\.[^.]+$/, ""), markdown: readFileSync(answerFile, "utf8") }] : SAMPLES;
	const parsed = samples.map((sample) => ({ sample, lines: buildLines(sample.markdown) ?? fail(`"${sample.title}" has neither a Runes nor a Build line`) }));

	// The iTerm2 path every picture terminal the coach targets takes (WezTerm through ConPTY, iTerm2 on macOS).
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
	// Pi learns the cell size from the terminal (CSI 16t); without it an icon is sized from a default cell and draws small.
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		let timer: ReturnType<typeof setTimeout> | undefined;
		process.stdout.write("\x1b[16t");
		const reply = await Promise.race([new Promise<string>((resolve) => process.stdin.once("data", (data) => resolve(String(data)))), new Promise<string>((resolve) => (timer = setTimeout(() => resolve(""), 1500)))]);
		clearTimeout(timer);
		process.stdin.setRawMode(false);
		const cell = /\[6;(\d+);(\d+)t/.exec(reply);
		if (cell) setCellDimensions({ widthPx: Number(cell[2]), heightPx: Number(cell[1]) });
	}
	const version = ((await (await fetch(`${DDRAGON_BASE}/api/versions.json`)).json()) as string[])[0];
	const names = parsed.map(({ lines }) => buildIconNames(lines));
	await Promise.all([
		prefetchItemIcons([...new Set(names.flatMap((name) => name.items))], version, DDRAGON_BASE, fetch, 20_000),
		prefetchRuneIcons([...new Set(names.flatMap((name) => name.runes))], version, DDRAGON_BASE, fetch, 20_000),
	]);

	const theme = loadTheme(ThemeCtor, "tidal");
	const width = process.stdout.columns || 120;
	const champions = panel ? await Promise.all(parsed.map(({ sample }) => championsIn(sample.markdown, version, DDRAGON_BASE))) : [];
	if (panel) await prefetchChampionIcons([...new Set(champions.flat())], version, DDRAGON_BASE, fetch, 20_000);
	const draw = (index: number, w: number) => {
		const { sample, lines } = parsed[index];
		return panel ? panelLines(theme, panelModel(sample.markdown, { champions: champions[index], status: "" }), w, { ownPicks: sample.ownPicks }) : buildStripLines(theme, lines, w, sample.ownPicks);
	};
	const out = parsed.flatMap(({ sample }, index) => [theme.bold(sample.title), ...draw(index, width), ""]);
	out.push(theme.bold(`${parsed[0].sample.title}, ${NARROW_WIDTH} columns`), ...draw(0, NARROW_WIDTH), "");
	out.push(theme.fg("dim", `${DONE} · Data Dragon ${version}`));
	// Each row is cleared first, the way pi-tui writes a changed line: a row that wipes the picture above it shows here too.
	process.stdout.write(`${out.map((line) => `\x1b[2K${line}`).join("\r\n")}\r\n`);
	if (hold) process.stdin.resume();
}

function fail(message: string): never {
	throw new Error(message);
}

if (import.meta.main) await main();
