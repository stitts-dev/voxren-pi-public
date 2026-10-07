import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER } from "./coach.mjs";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installTerminal, main, needsPiInstall, nodeFloor, nodeMajorVersion, nodeSatisfies, setupMessage } from "./setup.mjs";

/**
 * A partial SpawnSyncReturns: setup.mjs reads only `status` and `stdout`, so a mock carries just those.
 * @param {{ status?: number, stdout?: string }} partial
 * @returns {any} explicit any: the mock cannot supply the other SpawnSyncReturns fields, and the two deps want different stdout types
 */
const spawned = (partial) => partial;

/** @typedef {NonNullable<Parameters<typeof main>[1]>} MainDeps */

describe("setup helpers", () => {
	test("nodeMajorVersion reads the leading version component", () => {
		expect(nodeMajorVersion("20.11.0")).toBe(20);
		expect(nodeMajorVersion("18.0.0")).toBe(18);
	});

	test("the Node floor is package.json engines, at least what the locked pi packages need, and the README says it", () => {
		const read = (/** @type {string} */ path) => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
		const floor = nodeFloor();
		for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
			const need = read("../package-lock.json").packages[`node_modules/${name}`].engines.node.replace(/^>=/, "");
			expect(nodeSatisfies(floor, need)).toBe(true);
		}
		// A stale root entry makes npm rewrite the lockfile on every fresh install, so a clean clone reports `-dirty`.
		expect(read("../package-lock.json").packages[""].engines.node).toBe(read("../package.json").engines.node);
		const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
		expect(readme).toContain(`Node ${floor}+`);
		expect(readme).toContain(`node-${floor}%2B`);
	});

	test("nodeSatisfies compares major, minor, patch", () => {
		expect(nodeSatisfies("20.11.0", "22.19.0")).toBe(false);
		expect(nodeSatisfies("22.18.9", "22.19.0")).toBe(false);
		expect(nodeSatisfies("22.19.0", "22.19.0")).toBe(true);
		expect(nodeSatisfies("24.0.1", "22.19.0")).toBe(true);
	});

	test("setup refuses a Node below the floor and names the found and required versions", async () => {
		/** @type {unknown[]} */
		const calls = [];
		/** @type {string[]} */
		const errors = [];
		const original = console.error;
		console.error = (/** @type {string} */ message) => errors.push(message);
		const code = process.exitCode;
		try {
			await main([], { nodeVersion: "20.11.0", run: (command, args) => (calls.push([command, args]), spawned({ status: 0 })), capture: () => spawned({ stdout: "" }) });
		} finally {
			console.error = original;
			process.exitCode = code ?? 0;
		}
		expect(calls).toEqual([]);
		expect(errors.join("\n")).toContain(`needs Node ${nodeFloor()} or later, found 20.11.0`);
	});

	test("a failed global install into a folder the user cannot write prints the per-user prefix fix, never sudo", async () => {
		/** @type {string[]} */
		const errors = [];
		const original = console.error;
		console.error = (/** @type {string} */ message) => errors.push(message);
		const code = process.exitCode;
		try {
			await main([], {
				nodeVersion: "99.0.0",
				run: (_command, args) => spawned({ status: args[0] === "install" && args[1] === "-g" ? 243 : 0 }),
				capture: (_command, args) => spawned({ stdout: args[0] === "prefix" ? "/usr/local\n" : "" }),
				writable: () => false,
			});
		} finally {
			console.error = original;
			process.exitCode = code ?? 0;
		}
		const text = errors.join("\n");
		expect(text).toContain("/usr/local");
		expect(text).toContain("npm config set prefix");
		expect(text).toContain("PATH");
		expect(text).not.toContain("sudo npm");
	});

	test("a failed global install into a writable folder keeps the plain message", async () => {
		/** @type {string[]} */
		const errors = [];
		const original = console.error;
		console.error = (/** @type {string} */ message) => errors.push(message);
		const code = process.exitCode;
		try {
			await main([], {
				nodeVersion: "99.0.0",
				run: (_command, args) => spawned({ status: args[0] === "install" && args[1] === "-g" ? 1 : 0 }),
				capture: () => spawned({ stdout: "" }),
				writable: () => true,
			});
		} finally {
			console.error = original;
			process.exitCode = code ?? 0;
		}
		expect(errors.join("\n")).not.toContain("npm config set prefix");
	});

	test("needsPiInstall is true when pi is missing or a different version", () => {
		expect(needsPiInstall(undefined)).toBe(true);
		expect(needsPiInstall("")).toBe(true);
		expect(needsPiInstall("0.80.0")).toBe(true);
		expect(needsPiInstall("0.87.1")).toBe(false);
		expect(needsPiInstall("pi 0.87.1")).toBe(false);
	});

	test("setupMessage names the default model, provider, and the env vars to change them", async () => {
		const message = await setupMessage();
		expect(message).toContain(`${DEFAULT_MODEL_ID} (${DEFAULT_PROVIDER})`);
		expect(message).toContain("VOXREN_COACH_MODEL");
		expect(message).toContain("VOXREN_COACH_PROVIDER");
	});

	test("--worktree runs npm ci and skips the pi-install and npm-link calls", async () => {
		/** @type {[string, readonly string[]][]} */
		const runCalls = [];
		/** @type {[string, readonly string[]][]} */
		const captureCalls = [];
		/** @type {NonNullable<MainDeps["run"]>} */
		const run = (command, args) => {
			runCalls.push([command, args]);
			return spawned({ status: 0 });
		};
		/** @type {NonNullable<MainDeps["capture"]>} */
		const capture = (command, args) => {
			captureCalls.push([command, args]);
			return spawned({ stdout: "" });
		};
		await main(["--worktree"], { run, capture });
		expect(captureCalls).toEqual([]); // no `pi --version` check
		expect(runCalls).toEqual([["npm", ["ci"]]]); // no pi install, no npm link
	});

	test("without --worktree, still installs pi if needed and links coach onto PATH", async () => {
		/** @type {[string, readonly string[]][]} */
		const runCalls = [];
		/** @type {NonNullable<MainDeps["run"]>} */
		const run = (command, args) => {
			runCalls.push([command, args]);
			return spawned({ status: 0 });
		};
		const capture = () => spawned({ stdout: "" }); // pi missing
		let terminal = 0;
		await main([], { run, capture, installTerminal: () => terminal++ });
		expect(runCalls).toEqual([["npm", ["install", "-g", `@earendil-works/pi-coding-agent@0.87.1`]], ["npm", ["install"]], ["npm", ["link"]]]);
		expect(terminal).toBe(1);
	});

	test("--if-needed does nothing but check the terminal when pi and node_modules are current", async () => {
		/** @type {[string, readonly string[]][]} */
		const runCalls = [];
		let terminal = 0;
		await main(["--if-needed"], { run: (command, args) => (runCalls.push([command, args]), spawned({ status: 0 })), capture: () => spawned({ stdout: "0.87.1" }), hasModules: () => true, installTerminal: () => terminal++ });
		expect(runCalls).toEqual([]);
		expect(terminal).toBe(1);
	});

	test("--if-needed installs what is missing and never runs npm link", async () => {
		/** @type {[string, readonly string[]][]} */
		const runCalls = [];
		await main(["--if-needed"], { run: (command, args) => (runCalls.push([command, args]), spawned({ status: 0 })), capture: () => spawned({ stdout: "" }), hasModules: () => false, installTerminal: () => {} });
		expect(runCalls).toEqual([["npm", ["install", "-g", `@earendil-works/pi-coding-agent@0.87.1`]], ["npm", ["install"]]]);
	});

	test("the coach's terminal: WezTerm through winget on Windows and Homebrew on macOS, only when it is missing", async () => {
		/** @type {[NodeJS.Platform, boolean, [string, string[]][]][]} */
		const cases = [
			["win32", false, [["winget", ["install", "--id", "wez.wezterm", "-e", "--accept-source-agreements", "--accept-package-agreements"]]]],
			["darwin", false, [["brew", ["install", "--cask", "wezterm"]]]],
			["win32", true, []],
			["darwin", true, []],
			["linux", false, []],
		];
		for (const [platform, installed, want] of cases) {
			/** @type {[string, readonly string[]][]} */
			const calls = [];
			await installTerminal({ platform, installed, run: (command, args) => (calls.push([command, args]), spawned({ status: 0 })) });
			expect(calls).toEqual(want);
		}
	});

	test("setup.mjs loads on a fresh clone, before npm install has put any package in place", () => {
		// A copy of bin/ in a directory with no node_modules above it: importing setup.mjs must not reach `yaml` (bin/coach.mjs needs it).
		const dir = mkdtempSync(join(tmpdir(), "voxren-setup-"));
		try {
			mkdirSync(join(dir, "bin"));
			for (const name of ["setup.mjs", "coach.mjs"]) copyFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), join(dir, "bin", name));
			const load = spawnSync(process.execPath, ["--input-type=module", "-e", `import("${join(dir, "bin", "setup.mjs").replaceAll("\\", "/")}").then(() => console.log("loaded"))`], { encoding: "utf8" });
			expect(load.stdout.trim()).toBe("loaded");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
