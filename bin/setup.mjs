#!/usr/bin/env node
// One-command setup: verify Node, install/refresh `pi`, and put `coach` on PATH.
// Cross-platform (Windows and macOS): no shell script, only node + npm.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PI_VERSION = "0.87.1";
const PI_PACKAGE = `@earendil-works/pi-coding-agent@${PI_VERSION}`;
const WIN32 = process.platform === "win32";

/**
 * @param {string} command
 * @param {readonly string[]} args
 */
function run(command, args) {
	return spawnSync(command, args, { stdio: "inherit", shell: WIN32 });
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 */
function capture(command, args) {
	return spawnSync(command, args, { encoding: "utf8", shell: WIN32 });
}

/**
 * @param {string} message
 * @param {number} [status]
 */
function fail(message, status = 1) {
	console.error(message);
	process.exitCode = status;
}

/** The Node floor, from the one place it lives: package.json `engines.node` (">=22.19.0"). */
export function nodeFloor() {
	const { engines } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	return String(engines.node).replace(/^>=/, "");
}

/**
 * @param {string} version
 * @param {string} floor
 */
export function nodeSatisfies(version, floor) {
	const have = version.split(".").map(Number);
	const want = floor.split(".").map(Number);
	for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
	return true;
}

/** @param {string} dir */
function canWrite(dir) {
	try {
		accessSync(dir, constants.W_OK);
		return true;
	} catch {
		// A probe, not a failure: a folder that cannot be opened for writing is the answer.
		return false;
	}
}

/**
 * What to tell the player when npm could not write its global folder (EACCES): the cause and a per-user prefix,
 * never sudo. Empty when that folder is writable, so the failure has some other cause.
 * @param {string} prefix
 */
export function prefixFix(prefix) {
	return `npm cannot write to its global folder, ${prefix} (permission denied). Do not use sudo. Give npm a folder of your own:\n  npm config set prefix ~/.npm-global\nthen add ~/.npm-global/bin to your PATH (for zsh: echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc), open a new terminal, and run setup again. A Node manager (nvm, fnm, volta) installs Node into your home and avoids this too.`;
}

export function nodeMajorVersion(versionString = process.versions.node) {
	return Number(versionString.split(".")[0]);
}

/**
 * @param {string | undefined} piVersionOutput
 * @param {string} [wantVersion]
 */
export function needsPiInstall(piVersionOutput, wantVersion = PI_VERSION) {
	return !piVersionOutput || !piVersionOutput.includes(wantVersion);
}

/**
 * The closing message, with the model default read from coach.yaml through bin/coach.mjs. Imported lazily: coach.mjs
 * needs the `yaml` package, which does not exist on a fresh clone until main() has run `npm install`.
 */
export async function setupMessage() {
	const { DEFAULT_MODEL_ID, DEFAULT_PROVIDER } = await import("./coach.mjs");
	return `\nSetup done. Next:\n  coach          open the coach\n  /login         inside the coach, sign in once\n  /riot-key      store your Riot Development key\n\nModel: ${DEFAULT_MODEL_ID} (${DEFAULT_PROVIDER}). Change with VOXREN_COACH_MODEL / VOXREN_COACH_PROVIDER.\n`;
}

/**
 * The coach's own terminal (see ownTerminal in bin/coach.mjs): WezTerm, through winget on Windows and Homebrew on
 * macOS. Never fatal: without it the coach runs in whatever terminal it was started from.
 * @param {{ run?: typeof run, installed?: boolean, platform?: NodeJS.Platform }} [deps]
 */
export async function installTerminal(deps = {}) {
	const { run: runFn = run, platform = process.platform } = deps;
	const installed = deps.installed ?? Boolean((await import("./coach.mjs")).findWezterm(process.env, existsSync, platform));
	if (installed || (platform !== "win32" && platform !== "darwin")) return;
	console.log("Installing WezTerm, the terminal the coach opens in...");
	const result = platform === "win32" ? runFn("winget", ["install", "--id", "wez.wezterm", "-e", "--accept-source-agreements", "--accept-package-agreements"]) : runFn("brew", ["install", "--cask", "wezterm"]);
	if (result.status !== 0) console.error(`Could not install WezTerm${platform === "darwin" ? " (needs Homebrew)" : ""}; the coach will run in the terminal you start it from.`);
}

/**
 * @typedef {object} MainDeps
 * @property {typeof run} [run]
 * @property {typeof capture} [capture]
 * @property {() => unknown} [installTerminal]
 * @property {() => boolean} [hasModules]
 * @property {string} [nodeVersion]
 * @property {(dir: string) => boolean} [writable]
 */

/**
 * `--worktree`: a secondary checkout shares the primary's coach home (keys, sessions, profile.json)
 * so it needs no pi-version check or `npm link`, just its own `node_modules` — installed with `npm ci`
 * (frozen, matches CI) instead of `npm install`. `deps.run`/`deps.capture` mirror piCommand's injectable-
 * dependency pattern so tests assert the exec calls without spawning a real npm/pi.
 *
 * @param {readonly string[]} [argv]
 * @param {MainDeps} [deps]
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
	const runFn = deps.run ?? run;
	const captureFn = deps.capture ?? capture;
	const worktree = argv.includes("--worktree");
	// `just coach`: only what is missing, and no `npm link`, so a worktree never repoints the global `coach`.
	const ifNeeded = argv.includes("--if-needed");
	/** @param {string} message @param {number} status */
	const failGlobal = (message, status) => {
		const prefix = captureFn("npm", ["prefix", "-g"]).stdout?.trim();
		return fail(prefix && !(deps.writable ?? canWrite)(prefix) ? `${message}\n${prefixFix(prefix)}` : message, status);
	};

	const nodeVersion = deps.nodeVersion ?? process.versions.node;
	const floor = nodeFloor();
	if (!nodeSatisfies(nodeVersion, floor)) return fail(`Voxren Coach needs Node ${floor} or later, found ${nodeVersion}.`);

	if (ifNeeded && !needsPiInstall(captureFn("pi", ["--version"]).stdout?.trim()) && (deps.hasModules ?? (() => existsSync(new URL("../node_modules/yaml", import.meta.url))))()) {
		await (deps.installTerminal ?? installTerminal)();
		return;
	}

	if (!worktree) {
		const piVersion = captureFn("pi", ["--version"]).stdout?.trim();
		if (needsPiInstall(piVersion)) {
			console.log(piVersion ? `pi ${piVersion} found; installing ${PI_PACKAGE}...` : `pi not found; installing ${PI_PACKAGE}...`);
			const install = runFn("npm", ["install", "-g", PI_PACKAGE]);
			if (install.status !== 0) return failGlobal(`Failed to install ${PI_PACKAGE}.`, install.status ?? 1);
		}
	}

	// `npm link` only creates the global symlink; it does not install this package's dependencies (npm 10 on Windows).
	const install = runFn("npm", worktree ? ["ci"] : ["install"]);
	if (install.status !== 0) return fail(worktree ? "npm ci failed." : "npm install failed.", install.status ?? 1);

	if (ifNeeded) {
		await (deps.installTerminal ?? installTerminal)();
		return;
	}

	if (worktree) {
		const { checkoutInfo, COACH_DIR } = await import("./coach.mjs");
		const { dir, branch } = checkoutInfo(COACH_DIR);
		console.log(`\nWorktree ready${branch ? ` on ${branch}` : ""} at ${dir}.\nShares its coach home (.env, key store, sessions, profile.json) with every other checkout; run \`coach\` from here.\n`);
		return;
	}

	let link = runFn("npm", ["link"]);
	if (link.status !== 0) {
		console.error("npm link failed; trying npm install -g . instead.");
		link = runFn("npm", ["install", "-g", "."]);
	}
	if (link.status !== 0) return failGlobal("Could not put `coach` on PATH.", link.status ?? 1);
	await (deps.installTerminal ?? installTerminal)();

	console.log(await setupMessage());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
