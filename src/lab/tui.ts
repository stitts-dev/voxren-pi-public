/**
 * Headless TUI driver: runs the real coach in Microsoft tui-test's pseudo-terminal (ConPTY on Windows) and prints
 * what a player would see. The scripted side of rung 4 on every OS; `tui-test` on the command line is the interactive side.
 *
 *   node src/lab/tui.ts [--replay <timeline.ndjson>] [--auto] [--step <ms>] [--send "<keys>@<seconds>"]...
 *                       [--runs <n>] [--for <seconds>] [--every <seconds>] [--real-home] [--cols 100] [--rows 45]
 *
 * --replay plays a draft (data/lab/drafts/*.json), a recorded client file, or a Live Client Data dump as a fake League
 * client (VOXREN_LCU_REPLAY; --step sets milliseconds per frame, default 3000), --auto forces the automatic calls on (a lab home saves them off).
 * --send types a line into the composer and presses Enter that many seconds after the header draws: --send "/draft@3".
 * --runs stops once that many model
 * runs have finished (read from the run's exchange log), else --for (default 60) seconds. --every prints the screen
 * every N seconds (0: only at the end). Runs in a throwaway coach home unless --real-home. At the end: the screen,
 * then every model run as command, seconds, tools, and answer.
 *
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TuiTest } from "@microsoft/tui-test";
import { writeDraftReplay } from "./drafts.ts";
import { labHome } from "./lab-home.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv.splice(index, 2)[1] : undefined;
};
const has = (name: string) => {
	const index = argv.indexOf(name);
	return index >= 0 && argv.splice(index, 1).length > 0;
};
const sends: string[] = [];
for (let send = flag("--send"); send !== undefined; send = flag("--send")) sends.push(send);
let replay = flag("--replay");
const step = flag("--step");
const runs = Number(flag("--runs") ?? 0);
const seconds = Number(flag("--for") ?? 60);
const every = Number(flag("--every") ?? 0);
const cols = Number(flag("--cols") ?? 100);
const rows = Number(flag("--rows") ?? 45);
const auto = has("--auto");
const scratch = mkdtempSync(join(tmpdir(), "voxren-tui-"));
const home = has("--real-home") ? undefined : labHome(join(scratch, "home"));
if (replay?.endsWith(".json")) {
	// A hand-written draft: expand it pick by pick into a client file first.
	replay = await writeDraftReplay(replay, join(scratch, "draft.ndjson"));
}

const env: Record<string, string> = { VOXREN_COACH_TERMINAL: "here", ...(home && { VOXREN_COACH_HOME: home }), ...(replay && { VOXREN_LCU_REPLAY: replay }), ...(step && { VOXREN_LCU_REPLAY_STEP_MS: step }), ...(auto && { VOXREN_COACH_AUTO_COMP: "1" }) };
const coach = fileURLToPath(new URL("../../bin/coach.mjs", import.meta.url));
const terminal = TuiTest.ephemeral("voxren-tui");
await terminal.run(process.execPath, [coach], { cols, rows, cwd: fileURLToPath(new URL("../..", import.meta.url)), env, waitReady: false });
// Keys typed before the first paint land in the raw terminal, not the composer: wait for the header first.
await terminal.getByText("VOXREN COACH").expect({ timeout: 30_000 });

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);
const screen = async (full: boolean) =>
	(await terminal.text({ full }))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
const exchanges = () => {
	const log = join(home ?? "", "exchanges.ndjson");
	return home && existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};

for (const send of sends) {
	const at = send.lastIndexOf("@");
	setTimeout(() => terminal.write(`${send.slice(0, at)}\r`), Number(send.slice(at + 1)) * 1000);
}
const snapshots = every > 0 ? setInterval(async () => console.log(`\n===== ${elapsed()}s =====\n${await screen(false)}`), every * 1000) : undefined;

let finished = false;
const finish = async () => {
	if (finished) return;
	finished = true;
	clearInterval(snapshots);
	clearInterval(watch);
	await terminal.waitIdle().catch(() => {});
	console.log(`\n===== screen at ${elapsed()}s (scrollback) =====\n${await screen(true)}`);
	for (const run of exchanges()) console.log(`\n===== run: /${run.command ?? "(typed)"} · ${(run.ms / 1000).toFixed(1)} s · tools ${run.tools.map((tool: { name: string }) => tool.name).join(", ") || "none"} =====\n${run.answer}`);
	await terminal.closeQuiet();
	process.exit(0);
};
// Only a throwaway home has an exchange log of its own to count; --real-home runs stop on --for.
// No pending waitExit(): a tui-test wait holds the session, so keys sent while it runs are not delivered until it ends.
const watch = setInterval(async () => {
	if ((runs > 0 && exchanges().length >= runs) || Date.now() - t0 >= seconds * 1000 || (await terminal.state()).exited !== null) finish();
}, 500);
