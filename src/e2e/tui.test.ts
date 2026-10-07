// The real coach in Microsoft tui-test's terminal: the canary for the engine behind `just tui` and rung 4 of
// docs/agent-terminal.md. A tui-test bump that breaks typing, reading, or waiting fails here on every CI OS.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { TuiTest } from "@microsoft/tui-test";

// src/e2e/ is two levels under the repository root.
const repo = join(import.meta.dir, "..", "..");

test("the repository root is where the launcher and package.json live", () => {
	expect(existsSync(join(repo, "package.json"))).toBe(true);
	expect(existsSync(join(repo, "bin", "coach.mjs"))).toBe(true);
});
// CI runs `npm ci`, not `npm run setup`, so `pi` is only in node_modules/.bin. The launcher finds it on PATH; Windows spells the variable `Path`.
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const pathWithLocalBin = `${join(repo, "node_modules", ".bin")}${delimiter}${process.env[pathKey] ?? ""}`;

test("/config opens on Enter and closes on Escape in the real TUI", async () => {
	const terminal = TuiTest.ephemeral("voxren-tui-test");
	try {
		// An empty coach home: no player state, the same on CI and on a dev machine.
		const home = mkdtempSync(join(tmpdir(), "voxren-tui-test-"));
		await terminal.run("node", ["bin/coach.mjs"], { cols: 120, rows: 40, cwd: repo, env: { VOXREN_COACH_HOME: home, VOXREN_COACH_TERMINAL: "here", [pathKey]: pathWithLocalBin }, waitReady: false });
		await terminal.getByText("VOXREN COACH").expect({ timeout: 30_000 });
		await terminal.write("/config\r");
		await terminal.getByText("Coach settings").expect();
		expect(await terminal.text()).toMatch(/Theme\s+tidal/);
		await terminal.press("Escape");
		await terminal.getByText("Coach settings").expect({ not: true });
	} finally {
		await terminal.closeQuiet();
	}
}, 60_000);

test("/flow is the startup view: Escape returns the editor, /flow reopens it, Right moves the lens", async () => {
	const terminal = TuiTest.ephemeral("voxren-tui-tree");
	try {
		const home = mkdtempSync(join(tmpdir(), "voxren-tui-tree-"));
		await terminal.run("node", ["bin/coach.mjs"], { cols: 120, rows: 40, cwd: repo, env: { VOXREN_COACH_HOME: home, VOXREN_COACH_TERMINAL: "here", [pathKey]: pathWithLocalBin }, waitReady: false });
		await terminal.getByText("VOXREN COACH").expect({ timeout: 30_000 });
		await terminal.getByText("COMMAND TREE").expect({ timeout: 10_000 });
		expect(await terminal.text()).toContain("[/review]");
		expect(await terminal.text()).toContain("not run this session");
		await terminal.press("Escape");
		await terminal.getByText("COMMAND TREE").expect({ not: true });
		await terminal.write("/flow\r");
		await terminal.getByText("COMMAND TREE").expect();
		await terminal.press("Right");
		await terminal.getByText("[/matchup]").expect();
		expect(await terminal.text()).toMatch(/ \/matchup <enemy> ─+\n {3}Lane plan/); // the description on its own line under the section rule
		await terminal.press("Escape");
		await terminal.getByText("COMMAND TREE").expect({ not: true });
	} finally {
		await terminal.closeQuiet();
	}
}, 60_000);

test("Ctrl+D quits the coach from the /flow panel without Escape first", async () => {
	const terminal = TuiTest.ephemeral("voxren-tui-quit");
	try {
		const home = mkdtempSync(join(tmpdir(), "voxren-tui-quit-"));
		await terminal.run("node", ["bin/coach.mjs"], { cols: 120, rows: 40, cwd: repo, env: { VOXREN_COACH_HOME: home, VOXREN_COACH_TERMINAL: "here", [pathKey]: pathWithLocalBin }, waitReady: false });
		await terminal.getByText("COMMAND TREE").expect({ timeout: 30_000 });
		expect(await terminal.text()).toContain("Ctrl+D quit");
		await terminal.press("Ctrl+D");
		await terminal.waitExit({ timeout: 15_000 });
	} finally {
		await terminal.closeQuiet();
	}
}, 60_000);

test("the tui-test CLI on PATH, when there is one, matches the pinned library", () => {
	const cli = spawnSync("tui-test", ["--version"], { encoding: "utf8" });
	if (cli.error) return; // No CLI here (CI): the library above is the whole check.
	const pinned = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).devDependencies["@microsoft/tui-test"];
	expect(cli.stdout.trim()).toBe(`tui-test ${pinned}`);
});
