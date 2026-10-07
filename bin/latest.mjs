#!/usr/bin/env node
// `just latest`: the newest main, its dependencies when they changed, and the commit the checkout now runs.
// Cross-platform (Windows and macOS): no shell script, only node + git + npm.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WIN32 = process.platform === "win32";

/**
 * @param {string} command
 * @param {readonly string[]} args
 */
function run(command, args) {
	return spawnSync(command, args, { stdio: "inherit", shell: WIN32 }).status ?? 1;
}

/**
 * Whether `ref` needs an install: a dependency file differs from HEAD, or node_modules is not what HEAD's lock file
 * names (a pull made by hand with no install after it, or an install that never finished).
 * @param {string} [dir]
 * @param {string} [ref]
 */
export function needsInstall(dir = ".", ref = "FETCH_HEAD") {
	if (spawnSync("git", ["diff", "--quiet", "HEAD", ref, "--", "package.json", "package-lock.json"], { cwd: dir }).status !== 0) return true;
	try {
		const wanted = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")).packages;
		// npm's own record of what it installed, written last.
		const installed = JSON.parse(readFileSync(join(dir, "node_modules/.package-lock.json"), "utf8")).packages;
		// An optional package for another system is in the lock file and rightly absent from node_modules.
		return Object.entries(wanted).some(([path, { version, optional }]) => path !== "" && (installed[path] ? installed[path].version !== version : !optional));
	} catch {
		// A probe, not a failure: no readable record is a checkout with no finished install, which needs one.
		return true;
	}
}

/**
 * Native binaries under node_modules that a running process has loaded. Windows refuses to delete those, and `npm ci`
 * deletes node_modules before it installs, so one of them leaves the checkout with half its packages. Other systems
 * delete an open file without complaint, so there is nothing to look for there.
 * @param {string} [dir]
 * @param {NodeJS.Platform} [platform]
 */
export function lockedFiles(dir = "node_modules", platform = process.platform) {
	if (platform !== "win32" || !existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((name) => /\.(node|exe|dll)$/.test(name))
		.map((name) => join(dir, name))
		.filter((file) => {
			try {
				closeSync(openSync(file, "r+"));
				return false;
			} catch (error) {
				// A probe, not a failure: EBUSY is Windows refusing write access to a binary some process has loaded.
				return /** @type {NodeJS.ErrnoException} */ (error).code === "EBUSY";
			}
		});
}

/**
 * Fetch, decide, and only then move the checkout: a refusal leaves the commit and node_modules as they were, so the
 * same command works once the cause is gone. The one failure after the move is `npm ci` (it deletes node_modules
 * first, so no rollback is possible): main stays pulled, the failure is reported, and running this again installs.
 * @param {{ run?: typeof run, needsInstall?: () => boolean, lockedFiles?: () => string[] }} [deps]
 */
export function main(deps = {}) {
	const { run: runFn = run, needsInstall: needsInstallFn = needsInstall, lockedFiles: lockedFilesFn = lockedFiles } = deps;
	if (runFn("git", ["fetch", "origin", "main"])) return 1;
	const install = needsInstallFn();
	// A main that cannot be fast-forwarded fails at the merge below whatever is open, so that is the cause to show.
	const locked = install && runFn("git", ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]) === 0 ? lockedFilesFn() : [];
	if (locked.length) {
		console.error(`Not updated: the new main needs an install, and a running program has these files open, so Windows will not let npm replace them:\n${locked.map((file) => `  ${file}`).join("\n")}\nThat is a coach started from this checkout. Close the coach windows, then run \`just latest\` again.`);
		return 1;
	}
	if (runFn("git", ["merge", "--ff-only", "FETCH_HEAD"])) return 1;
	if (!install) console.log("node_modules already matches package-lock.json: install skipped.");
	else if (runFn("npm", ["ci"])) {
		console.error("main is pulled but its dependencies are not installed (npm ci failed, and it removes node_modules first), so `coach` will not run yet. Run `just latest` again while online: it sees the missing install and finishes it.");
		return 1;
	}
	return runFn("node", ["bin/coach.mjs", "--version"]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
