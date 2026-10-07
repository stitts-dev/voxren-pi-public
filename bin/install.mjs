#!/usr/bin/env node
// One-line install: `curl -fsSL <raw url> | node` on macOS, `irm <raw url> | node` on Windows.
// Piped into node it runs as CommonJS, so: no import/export syntax, only import().
// Clones the repo into ./voxren-pi (or the directory given as the first argument) and hands
// off to bin/setup.mjs, which does the real work.
const REPO = process.env.VOXREN_REPO || "https://github.com/stitts-dev/voxren-pi-public.git";
const DIR = "voxren-pi";

/** @param {string} message @param {number} status */
function fail(message, status) {
	console.error(message);
	process.exitCode = status;
}

async function main() {
	const { spawnSync } = await import("node:child_process");
	const { existsSync, readFileSync } = await import("node:fs");
	const { resolve } = await import("node:path");
	// No shell: the arguments reach git and node as they are, so a path with a space or an `&` is one argument.
	/** @param {string} command @param {readonly string[]} args @param {string} [cwd] */
	const run = (command, args, cwd) => spawnSync(command, args, { stdio: "inherit", cwd });
	// argv[1] is the script path when run as a file, absent when piped through stdin.
	const dir = resolve(process.argv[process.argv[1] ? 2 : 1] ?? DIR);

	/** @param {string} url */
	const normal = (url) => url.trim().replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
	const isClone = () => {
		try {
			const named = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")).name === "voxren-pi";
			const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8" }).stdout ?? "";
			return named && existsSync(resolve(dir, "bin", "setup.mjs")) && normal(origin) === normal(REPO);
		} catch {
			// A probe, not a failure: no readable package.json means this folder is not the clone.
			return false;
		}
	};

	if (existsSync(dir)) {
		if (!isClone()) return fail(`${dir} is not a voxren-pi clone (no voxren-pi package.json, bin/setup.mjs, and origin ${REPO}).\nRun the installer from another folder, give it another folder as its argument, or delete ${dir}.`, 1);
		console.log(`${dir} exists; updating it to the newest main.`);
		const fetch = run("git", ["fetch", "origin", "main"], dir);
		const merge = fetch.status === 0 ? run("git", ["merge", "--ff-only", "FETCH_HEAD"], dir) : fetch;
		if (merge.status !== 0) return fail(`${dir} could not be updated to the newest main (git's reason is above). Fix that, or delete ${dir} and run the installer again.`, merge.status ?? 1);
	} else {
		const clone = run("git", ["clone", REPO, dir]);
		if (clone.status !== 0) return fail(`git clone failed${clone.error ? `: ${clone.error.message}. Is git installed?` : " (git's reason is above)."}`, clone.status ?? 1);
	}
	// node, not `npm run setup`: npm is npm.cmd on Windows and needs a shell, and it looks for package.json upward.
	const setup = run(process.execPath, ["bin/setup.mjs"], dir);
	if (setup.status !== 0) return fail("setup failed.", setup.status ?? 1);
}

main();
