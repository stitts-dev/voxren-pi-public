import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockedFiles, main, needsInstall } from "./latest.mjs";

/**
 * main() with its commands recorded instead of run; `fails` names the ones that exit 1.
 * @param {{ needsInstall: ReturnType<typeof needsInstall>, locked?: ReturnType<typeof lockedFiles>, fails?: string[] }} options
 */
function latest({ needsInstall, locked = [], fails = [] }) {
	/** @type {string[]} */
	const calls = [];
	const status = main({
		run: (command, args) => {
			calls.push([command, ...args].join(" "));
			return fails.includes(args[0]) ? 1 : 0;
		},
		needsInstall: () => needsInstall,
		lockedFiles: () => locked,
	});
	return { status, calls };
}

const FETCH = "git fetch origin main";
const CAN_FAST_FORWARD = "git merge-base --is-ancestor HEAD FETCH_HEAD";
const MERGE = "git merge --ff-only FETCH_HEAD";
const VERSION = "node bin/coach.mjs --version";

describe("just latest", () => {
	test("unchanged dependency files: pulls and reports the commit, with no install", () => {
		expect(latest({ needsInstall: false })).toEqual({ status: 0, calls: [FETCH, MERGE, VERSION] });
	});

	test("changed dependency files: installs from the lock file after the pull", () => {
		expect(latest({ needsInstall: true })).toEqual({ status: 0, calls: [FETCH, CAN_FAST_FORWARD, MERGE, "npm ci", VERSION] });
	});

	test("an install with a file held open stops before the checkout moves", () => {
		expect(latest({ needsInstall: true, locked: ["node_modules/a.node"] })).toEqual({ status: 1, calls: [FETCH, CAN_FAST_FORWARD] });
	});

	test("a main that cannot be fast-forwarded fails at the merge, not on the file held open", () => {
		expect(latest({ needsInstall: true, locked: ["node_modules/a.node"], fails: ["merge-base", "merge"] })).toEqual({ status: 1, calls: [FETCH, CAN_FAST_FORWARD, MERGE] });
	});
});

/**
 * A committed checkout whose lock file names a@1.0.0 and an optional package for another system, with `installed` (if any) as a's version in node_modules.
 * @param {string} [installed]
 */
function checkout(installed) {
	const dir = mkdtempSync(join(tmpdir(), "latest-"));
	const git = (/** @type {string[]} */ ...args) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir });
	writeFileSync(join(dir, "package.json"), "{}\n");
	writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: { "": {}, "node_modules/a": { version: "1.0.0" }, "node_modules/other-system": { version: "1.0.0", optional: true } } }));
	git("init", "-q");
	git("add", "-A");
	git("commit", "-qm", "base");
	if (installed) {
		mkdirSync(join(dir, "node_modules"));
		writeFileSync(join(dir, "node_modules", ".package-lock.json"), JSON.stringify({ packages: { "node_modules/a": { version: installed } } }));
	}
	return { dir, git };
}

describe("just latest, a failed npm ci", () => {
	test("says main is pulled but dependencies are not installed, and to run it again online", () => {
		/** @type {string[]} */
		const errors = [];
		const original = console.error;
		console.error = (/** @type {string} */ message) => errors.push(message);
		try {
			expect(latest({ needsInstall: true, fails: ["ci"] })).toEqual({ status: 1, calls: [FETCH, CAN_FAST_FORWARD, MERGE, "npm ci"] });
		} finally {
			console.error = original;
		}
		expect(errors.join("\n")).toMatch(/main is pulled.*dependencies are not installed.*just latest.*online/s);
	});
});

describe("needsInstall", () => {
	test("node_modules matching the lock file and no change in the pull: no install", () => {
		const { dir } = checkout("1.0.0");
		expect(needsInstall(dir, "HEAD")).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	test("a pull that changes package.json: install", () => {
		const { dir, git } = checkout("1.0.0");
		git("checkout", "-qb", "next");
		writeFileSync(join(dir, "package.json"), '{ "dependencies": { "b": "1.0.0" } }\n');
		git("commit", "-qam", "add b");
		git("checkout", "-q", "-");
		expect(needsInstall(dir, "next")).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	test("node_modules behind the lock file, from a pull made with no install: install", () => {
		const { dir } = checkout("0.9.0");
		expect(needsInstall(dir, "HEAD")).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	test("no node_modules: install", () => {
		const { dir } = checkout();
		expect(needsInstall(dir, "HEAD")).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("lockedFiles", () => {
	test("reports no file that nothing holds open", () => {
		const dir = mkdtempSync(join(tmpdir(), "latest-"));
		mkdirSync(join(dir, "pkg"));
		writeFileSync(join(dir, "pkg", "addon.node"), "");
		expect(lockedFiles(dir)).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});

	// Only Windows holds a loaded binary against deletion; the resvg binary is the one a running coach has loaded.
	test.skipIf(process.platform !== "win32")("names a binary a running process has loaded, until that process exits", async () => {
		const resvg = join(import.meta.dir, "..", "node_modules", "@resvg");
		const binary = readdirSync(resvg, { recursive: true, encoding: "utf8" }).find((name) => name.endsWith(".node"));
		const dir = mkdtempSync(join(tmpdir(), "latest-"));
		const addon = join(dir, "addon.node");
		copyFileSync(join(resvg, binary ?? ""), addon);
		const holder = spawn("node", ["-e", "require(process.argv[1]); console.log('loaded'); setInterval(() => {}, 1000)", addon], { stdio: ["ignore", "pipe", "inherit"] });
		try {
			await once(holder.stdout, "data");
			expect(lockedFiles(dir)).toEqual([addon]);
		} finally {
			holder.kill();
			await once(holder, "exit");
		}
		expect(lockedFiles(dir)).toEqual([]);
		rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	});
});
