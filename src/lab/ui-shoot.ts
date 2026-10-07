/**
 * The UI catalogue on screen: every entry of ui-fixtures.ts drawn by the real renderers, no model and no network.
 *
 *   just ui [--only a,b] [--width 100] [--theme tidal] [--watch]      print entries in colour (--only: names or parts of names)
 *   just ui --shoot [--only a,b] [--changed] [--no-critique] [--out <dir>]
 *
 * --shoot opens a WezTerm grid through grid.ts (3x3 of 80x24 when the screen holds it, else 2x2 of 100x30), prints one
 * entry per pane at the pane's width, takes one screenshot per sheet of panes and a PNG per pane, and tiles the sheets into
 * contact.png. --changed shoots and critiques only the entries whose rendered text differs from `main`'s renderers: it renders
 * main's src in a scratch copy under the same entries and caches the hashes by main's commit. Unless --no-critique, three
 * sonnet critics (data/lab/ui-critics.json) read the sheets in parallel and report.md merges what they found by view. The
 * critics advise only and never change the exit code. --out is a tmp dir by default, never inside the repo.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDragonKnown, iconEvidence, imageSize, paneMetrics } from "./icon-check.ts";
import { iconVerdict } from "./stories.ts";
import { loadTheme, themeNames } from "./ui-data.ts";
import { killCritics, runCritics, tierResult } from "./ui-critics.ts";
import { fixtures, gateProblems, iconCount, prepareFixtures, shootInWezTerm, stablePictures, type Fixture } from "./ui-fixtures.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const argv = process.argv.slice(2);
const flag = (name: string) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv.splice(index, 2)[1] : undefined;
};
const has = (name: string) => {
	const index = argv.indexOf(name);
	return index >= 0 && argv.splice(index, 1).length > 0;
};
const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};
const hashesOnly = has("--hashes");
const watchMode = has("--watch");
const shoot = has("--shoot");
const changed = has("--changed");
const noCritique = has("--no-critique");
const only = flag("--only")?.split(",").map((term) => term.trim().toLowerCase()).filter(Boolean);
const printWidth = Number(flag("--width") ?? 100);
const themeName = flag("--theme") ?? "tidal";
const outFlag = flag("--out");
const jsonFlag = flag("--json");
const started = Date.now();
const out = resolve(outFlag ?? (hashesOnly ? tmpdir() : mkdtempSync(join(tmpdir(), "voxren-ui-out-"))));
const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

const pick = (): Fixture[] => {
	const all = fixtures();
	if (!only) return all;
	const chosen = all.filter((fixture) => only.some((term) => fixture.name.toLowerCase() === term || fixture.name.toLowerCase().includes(term)));
	if (!chosen.length) fail(`No entry matches ${only.join(", ")}. Names: ${all.map((fixture) => fixture.name).join("; ")}`);
	return chosen;
};

/** Each entry's raw render (colour included) at two widths in one theme, hashed: a change to what the player sees changes the hash. */
function hashes(): Record<string, string> {
	const theme = loadTheme("tidal");
	return Object.fromEntries(fixtures().map((fixture) => [fixture.name, sha1([80, 100].map((width) => stablePictures(fixture.render(theme, width).join("\n"))).join("\u0001"))]));
}

/** The strict gate on `entries` in every theme (the same one bun test runs); an entry fails when any theme and width does. */
/** Entries whose icons the icon gate found missing, blank, or drawn as text, by name. */
const iconFailures = new Map<string, string>();

function gate(entries: Fixture[]): Set<string> {
	const failed = new Set<string>(iconFailures.keys());
	for (const name of themeNames()) for (const [entry, problems] of gateProblems(loadTheme(name), entries)) if (problems.length) failed.add(entry);
	return failed;
}

/** Writes <out>/tier.json (and --json's file) for the scoring step, and says where. */
function writeTier(entries: Fixture[], extra: { costUsd?: number; findings?: number } = {}) {
	const failed = gate(entries);
	const tier = tierResult({ total: fixtures().length, checked: entries.length, failed: failed.size, seconds: (Date.now() - started) / 1000, ...extra });
	for (const file of [join(out, "tier.json"), ...(jsonFlag ? [resolve(jsonFlag)] : [])]) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(tier)}\n`);
	}
	console.error(`tier.json: ${tier.pass} pass, ${tier.fail} fail, ${tier.skipped} skipped${failed.size ? ` (${[...failed].join(", ")})` : ""} -> ${join(out, "tier.json")}`);
	return tier;
}

if (out === REPO || out.startsWith(`${REPO}/`)) fail("--out must be outside the repo.");
mkdirSync(out, { recursive: true });

if (hashesOnly) {
	// Drawn as the shoot draws (WezTerm, iTerm2 pictures at its cell size): Kitty icons never saw inlineIcon's pixel width.
	shootInWezTerm();
	await prepareFixtures();
	console.log(JSON.stringify(hashes()));
	process.exit(0);
}

// --- print --------------------------------------------------------------------------------------------------------

async function print() {
	await prepareFixtures();
	const theme = loadTheme(themeName);
	for (const fixture of pick()) {
		console.log(`\n\x1b[1;36m▌ ${fixture.name}\x1b[0m \x1b[2m${fixture.state} · ${printWidth} cols\x1b[0m`);
		console.log(fixture.render(theme, printWidth).map((line) => `${line}\x1b[0m`).join("\n"));
	}
}

if (watchMode) {
	const files = ["src/ui.ts", "src/lab/ui-fixtures.ts", "src/lab/ui-data.ts", "src/lab/chart-scenarios.ts", "src/command-tree.ts", "src/config.ts", "src/jev-badge.ts", "src/build-lines.ts"].map((file) => join(REPO, file));
	const rest = process.argv.slice(2).filter((arg) => arg !== "--watch");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const draw = () => {
		process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
		spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...rest], { stdio: "inherit" });
		console.log(`\n\x1b[2mwatching ${files.length} files, Ctrl+C to stop\x1b[0m`);
	};
	draw();
	for (const file of files) if (existsSync(file)) watch(file, () => (clearTimeout(timer), (timer = setTimeout(draw, 80))));
} else if (!shoot) {
	await print();
	process.exit(writeTier(pick()).fail ? 1 : 0);
} else {
	await main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}

// --- main's hashes --------------------------------------------------------------------------------------------------

/**
 * The hashes of every entry as `main`'s renderers draw them. Cheapest way found: main's src, themes, and coach.yaml
 * unpacked from `git archive` into a scratch folder (node_modules linked in), this branch's catalogue files laid over it,
 * and this script run there with --hashes (about a second). The result is cached by main's commit and the catalogue's own
 * files, so a second run in the same state costs a file read. Returns undefined when main cannot be rendered with these entries.
 */
function mainHashes(): { hashes: Record<string, string>; source: string } | undefined {
	const base = ["origin/main", "main"].find((ref) => spawnSync("git", ["rev-parse", "--verify", "-q", ref], { cwd: REPO }).status === 0);
	if (!base) return undefined;
	const commit = spawnSync("git", ["rev-parse", base], { cwd: REPO, encoding: "utf8" }).stdout.trim();
	const labFiles = ["src/lab/ui-fixtures.ts", "src/lab/ui-data.ts", "src/lab/ui-shoot.ts", "src/lab/ui-critics.ts", "data/lab/ui-critics.json", "src/lab/chart-scenarios.ts"];
	const key = sha1(commit + labFiles.map((file) => readFileSync(join(REPO, file), "utf8")).join("\u0002")).slice(0, 16);
	const cache = join(tmpdir(), "voxren-ui-main", `${key}.json`);
	if (existsSync(cache)) return { hashes: JSON.parse(readFileSync(cache, "utf8")), source: `cached for ${base} ${commit.slice(0, 7)}` };
	const scratch = mkdtempSync(join(tmpdir(), "voxren-ui-base-"));
	try {
		const archive = spawnSync("sh", ["-c", `git archive ${commit} src themes coach.yaml data bin package.json | tar -x -C ${JSON.stringify(scratch)}`], { cwd: REPO });
		if (archive.status !== 0) return undefined;
		for (const file of [...labFiles, "src/lab/grid.ts"]) {
			mkdirSync(dirname(join(scratch, file)), { recursive: true });
			writeFileSync(join(scratch, file), readFileSync(join(REPO, file)));
		}
		symlinkSync(join(REPO, "node_modules"), join(scratch, "node_modules"));
		const ran = spawnSync(process.execPath, [join(scratch, "src/lab/ui-shoot.ts"), "--hashes"], { cwd: scratch, encoding: "utf8", timeout: 60_000 });
		if (ran.status !== 0) {
			console.error(`main's renderers could not draw these entries (${ran.stderr.trim().split("\n").pop()}): every entry counts as changed`);
			return undefined;
		}
		const parsed = JSON.parse(ran.stdout.trim().split("\n").pop()!) as Record<string, string>;
		mkdirSync(dirname(cache), { recursive: true });
		writeFileSync(cache, JSON.stringify(parsed));
		return { hashes: parsed, source: `rendered from ${base} ${commit.slice(0, 7)} in a scratch copy` };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

// --- shoot ----------------------------------------------------------------------------------------------------------

async function main() {
	const lap = (label: string) => console.error(`${((Date.now() - started) / 1000).toFixed(1)} s  ${label}`);
	// The shoot draws the real Data Dragon icons (network is fine here, never in bun test); an entry whose icons did not load says so.
	shootInWezTerm();
	await prepareFixtures(true);
	// "call" entries are only a card's first row, which every collapsed card already shows.
	let entries = pick().filter((fixture) => only || !fixture.name.endsWith(" call"));
	let baseline = "";
	if (changed) {
		const main = mainHashes();
		// A child process, drawn the same offline way as main's scratch copy: this process is about to load the real icons, which would change every icon row.
		const current = JSON.parse(spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--hashes"], { encoding: "utf8" }).stdout.trim().split("\n").pop()!) as Record<string, string>;
		baseline = main?.source ?? "main could not be rendered";
		entries = entries.filter((fixture) => !main || main.hashes[fixture.name] !== current[fixture.name]);
		lap(`${entries.length} entries changed against ${baseline}`);
		if (!entries.length) {
			console.log("No entry's rendered text differs from main: nothing to shoot or critique.");
			process.exit(writeTier([]).fail ? 1 : 0);
		}
	}
	const iconNote = new Map<string, string>();
	for (const fixture of entries.filter((entry) => entry.icons)) {
		const drawn = iconCount(fixture, loadTheme(themeName));
		iconNote.set(fixture.name, drawn ? `icons: ${drawn} drawn` : "icons: fallback");
		if (!drawn) console.error(`${fixture.name}: no icon loaded from Data Dragon, the text fallback is what shows (icons: fallback)`);
	}
	const { atPrompt, cli, closeWindow, fail: gridFail, g, initGrid, openWindow, type, viewport, waitScreen, wez } = await import("./grid.ts");
	const { findWezterm } = await import("../../bin/coach.mjs");
	const gui = findWezterm() ?? gridFail("WezTerm is not installed (npm run setup installs it).");
	const scratch = mkdtempSync(join(tmpdir(), "voxren-ui-"));
	initGrid(gui, scratch);
	let note = "";
	g.drawStatus = () => writeFileSync(g.statusFile, `\x1b[1;36mUI\x1b[0m ${note}\x1b[K\x1b[J`);
	const cleanup = () => {
		killCritics();
		closeWindow();
		rmSync(scratch, { recursive: true, force: true });
	};
	process.on("SIGINT", () => (cleanup(), process.exit(130)));
	process.on("SIGTERM", () => (cleanup(), process.exit(143)));
	try {
		openWindow(9);
		lap(`window ${g.windowPid}, ${g.panes.length} panes of ${g.COLS}x${g.ROWS}`);
		const theme = loadTheme(themeName);
		const sheets: { file: string; panes: Array<{ pane: number; fixture: Fixture }> }[] = [];
		const sheetCount = Math.ceil(entries.length / g.panes.length);
		for (let at = 0; at < entries.length; at += g.panes.length) {
			const sheet = sheets.length + 1;
			const batch = entries.slice(at, at + g.panes.length);
			note = `sheet ${sheet}/${sheetCount} · ${themeName} · ${batch.length} views`;
			g.drawStatus();
			const shown: string[] = [];
			for (const [index, fixture] of batch.entries()) {
				const pane = g.panes[index];
				const lines = fixture.render(theme, g.COLS);
				const room = g.ROWS - 1;
				const cut = lines.length > room ? [...lines.slice(0, room - 1), `\x1b[2m… +${lines.length - room + 1} more rows\x1b[0m`] : lines;
				const banner = `▌ ${fixture.name}`.slice(0, g.COLS - 1);
				shown.push(banner);
				const file = join(pane.dir, "view.ans");
				writeFileSync(file, `\x1b[1;36m${banner}\x1b[0m\n${cut.map((line) => `${line}\x1b[0m`).join("\n")}\n`);
				writeFileSync(join(pane.dir, "show.sh"), `clear\ncat '${file}'\nsleep 3600\n`);
			}
			// A pane still on the last sheet's `sleep` goes back to the prompt first (Ctrl+C), then shows its view.
			for (const pane of g.panes) if (!atPrompt(viewport(pane))) type(pane, "\x03");
			for (const pane of g.panes) await waitScreen(pane, atPrompt, 5);
			for (const [index, pane] of g.panes.entries()) type(pane, index < batch.length ? `sh '${join(pane.dir, "show.sh")}'\r` : "clear\r");
			for (const [index, pane] of g.panes.slice(0, batch.length).entries()) if (!(await waitScreen(pane, (text) => text.includes(shown[index].slice(0, 24)), 8))) console.error(`pane ${index + 1} never showed ${batch[index].name}`);
			await new Promise((done) => setTimeout(done, 250));
			const file = join(out, `sheet-${sheet}.png`);
			const taken = wez(["shot", "--pid", String(g.windowPid), file]);
			if (!taken.ok) throw new Error(`no screenshot: ${taken.out.trim().split("\n").pop()}`);
			// The `*-icons` build strips: expected names from the entry's answer, placed icons from the bytes it wrote, pixels from this shot.
			const size = imageSize(file);
			const list = JSON.parse(cli(["list", "--format", "json"]).out || "[]");
			for (const [index, fixture] of batch.entries()) {
				if (!fixture.source) continue;
				const pane = g.panes[index];
				const lines = fixture.render(theme, g.COLS);
				const bytes = lines.slice(0, g.ROWS - 2).map((line) => `${line}\x1b[0m`).join("\r\n");
				const evidence = iconEvidence({ answer: fixture.source, known: await dataDragonKnown(fixture.source), bytes: `\x1b[?2026h${bytes}`, screen: viewport(pane), viewport: cli(["get-text", "--pane-id", String(pane.id), "--start-line", "0", "--end-line", String(g.ROWS - 1)]).out, shot: size ? { png: file, metrics: paneMetrics(list, pane.id, size) } : undefined, supported: true });
				const outcome = iconVerdict({ expect: "all" }, evidence);
				if (iconNote.get(fixture.name) !== "icons: fallback") iconNote.set(fixture.name, `icons: ${evidence.expected} expected / ${evidence.placed} placed / ${evidence.blank} blank`);
				if (outcome.failures.length) iconFailures.set(fixture.name, outcome.failures.map((f) => f.detail).join("; "));
				console.error(`${fixture.name}: icons ${evidence.expected} / ${evidence.placed} / ${evidence.blank}${outcome.failures.length ? ` FAIL ${outcome.failures[0].detail}` : ""}`);
			}
			sheets.push({ file, panes: batch.map((fixture, index) => ({ pane: index + 1, fixture })) });
			lap(`sheet ${sheet}/${sheetCount}`);
		}
		const first = (JSON.parse(cli(["list", "--format", "json"]).out) as { size: { cols: number; rows: number; pixel_width: number; pixel_height: number; dpi: number } }[])[0].size;
		const grid = { cols: g.COLS, rows: g.ROWS, side: g.GRID, cell: { w: first.pixel_width / first.cols, h: first.pixel_height / first.rows, dpi: first.dpi }, stripRows: g.statusRows(g.GRID, g.COLS) };
		cleanup();
		lap("window closed");
		const theme2 = loadTheme(themeName);
		const zooms = new Map<string, string>();
		const crops = cropPanes(sheets, grid, out, (fixture) => (fixture.icons && iconNote.get(fixture.name) !== "icons: fallback" ? fixture.render(theme2, g.COLS).length : 0), zooms);
		const contact = tile(sheets.map((sheet) => sheet.file), out);
		lap(`${crops} pane crops, contact sheet ${contact ? "written" : "skipped"}`);
		const manifest = sheets.map((sheet, index) => `Sheet ${index + 1} (${sheet.file.split("/").pop()}), panes left to right then top to bottom:\n${sheet.panes.map((entry) => `  pane ${entry.pane}: ${entry.fixture.name} (${entry.fixture.state})${iconNote.has(entry.fixture.name) ? ` [${iconNote.get(entry.fixture.name)}]` : ""}`).join("\n")}`).join("\n");
		writeFileSync(join(out, "manifest.txt"), `${manifest}\n`);
		let report = `# UI shoot (${new Date().toISOString()})\n\n${entries.length} views in ${sheets.length} sheet(s), theme ${themeName}${changed ? `, only the entries that differ from main (${baseline})` : ""}. Sheets: ${sheets.map((sheet) => sheet.file).join(", ")}\n\n\`\`\`\n${manifest}\n\`\`\`\n`;
		let costUsd = 0;
		let findings = 0;
		if (!noCritique) {
			const critique = await runCritics(sheets.map((sheet) => sheet.file), manifest, entries.map((fixture) => fixture.name), out, [...zooms].map(([name, file]) => ({ name, file })));
			report += `\n${critique.report}`;
			({ usd: costUsd, findings } = critique);
			lap("critics done");
		}
		writeFileSync(join(out, "report.md"), report);
		console.log(report);
		writeTier(entries, { costUsd, findings });
		console.error(`wall ${((Date.now() - started) / 1000).toFixed(1)} s, out ${out}`);
	} finally {
		cleanup();
	}
}

/** One PNG per pane, cut from its sheet: the panes sit on an even cell grid inside the window's padding (8 px sides, 6 px top; wezterm.lua). */
function cropPanes(sheets: { file: string; panes: Array<{ pane: number; fixture: Fixture }> }[], grid: { cols: number; rows: number; side: number; cell: { w: number; h: number; dpi: number }; stripRows: number }, out: string, zoomRows: (fixture: Fixture) => number, zooms: Map<string, string>): number {
	let count = 0;
	for (const sheet of sheets) {
		const size = pngSize(sheet.file);
		const geometry = paneGeometry(size, grid);
		for (const { pane, fixture } of sheet.panes) {
			const row = Math.floor((pane - 1) / grid.side);
			const column = (pane - 1) % grid.side;
			const x = Math.round(geometry.left + column * (grid.cols + 1) * geometry.cw);
			const y = Math.round(geometry.top + row * (grid.rows + 1) * geometry.ch);
			const file = join(out, `${fixture.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
			const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", sheet.file, "-vf", `crop=${Math.round(grid.cols * geometry.cw)}:${Math.round(grid.rows * geometry.ch)}:${x}:${y}`, file]);
			if (result.status === 0) count++;
			// An icon-bearing entry also gets a zoom: its own rows, twice the size, for the critic that judges icons.
			const rows = zoomRows(fixture);
			if (rows) {
				const zoom = file.replace(/\.png$/, "-zoom.png");
				const height = Math.min(Math.round(grid.rows * geometry.ch), Math.round((rows + 1) * geometry.ch));
				const zoomed = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-vf", `crop=iw:${height}:0:0,scale=iw*2:-1:flags=neighbor`, zoom]);
				if (zoomed.status === 0) zooms.set(fixture.name, zoom);
			}
		}
	}
	return count;
}

function pngSize(file: string): { width: number; height: number } {
	const header = readFileSync(file).subarray(16, 24);
	return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

/**
 * Cell size and the grid's top-left inside a sheet. WezTerm reports a pane's pixels and the window's dpi; the sheet is the
 * same pixels within a fraction (macOS may scale it a little), so the cell width is measured from the sheet's own width
 * between the side paddings (8 pt, wezterm.lua), the height keeps WezTerm's cell ratio, and the grid sits above the bottom
 * padding (6 pt) so the title bar needs no guess.
 */
function paneGeometry(size: { width: number; height: number }, grid: { cols: number; rows: number; side: number; cell: { w: number; h: number; dpi: number }; stripRows: number }) {
	const totalCols = grid.side * grid.cols + grid.side - 1;
	const totalRows = grid.side * grid.rows + grid.side - 1 + grid.stripRows + 1;
	const padX = (8 * grid.cell.dpi) / 72;
	const cw = (size.width - 2 * padX) / totalCols;
	const ch = (cw * grid.cell.h) / grid.cell.w;
	return { cw, ch, left: padX, top: size.height - (6 * grid.cell.dpi) / 72 * (cw / grid.cell.w) - totalRows * ch };
}

/** Every sheet in one picture, scaled down, for a human: ffmpeg's tile filter. */
function tile(files: string[], out: string): boolean {
	if (!files.length) return false;
	const inputs = files.flatMap((file) => ["-i", file]);
	const scaled = files.map((_, index) => `[${index}:v]scale=900:-1[s${index}]`).join(";");
	const columns = Math.min(files.length, 3);
	const filter = files.length === 1 ? "[0:v]scale=900:-1" : `${scaled};${files.map((_, index) => `[s${index}]`).join("")}xstack=inputs=${files.length}:layout=${files.map((_, index) => `${(index % columns) * 900}_${Math.floor(index / columns)}*h0`).join("|")}`;
	return spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-frames:v", "1", join(out, "contact.png")]).status === 0;
}
