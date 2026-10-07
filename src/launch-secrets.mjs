// How the launcher (bin/coach.mjs) hands keys to Pi without putting them in Pi's environment.
// Pi sets its process title, and a process's environment block is readable by every same-user tool
// (ps, Activity Monitor, an agent's process listing), so a key there leaks (issue #209). The launcher
// writes the keys to a 0600 file in the coach home and passes only its path; the extension reads the
// file once at load, deletes it, and keeps the keys in memory.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LAUNCH_SECRETS_VAR = "VOXREN_LAUNCH_SECRETS";
// Keys Pi's provider reads itself, then the coach's own.
export const PROVIDER_KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
export const SECRET_ENV_NAMES = [...PROVIDER_KEY_NAMES, "PERPLEXITY_API_KEY", "BRAVE_API_KEY", "TYPESAFE_API_KEY", "VOXREN_GEMINI_API_KEY", "VOXREN_RESEARCH_TOKEN"];

const FILE_PATTERN = /^launch-secrets-.+\.json$/;
/** A handoff file is read within seconds of its child starting; one this old was left by a launch that died. */
export const STALE_HANDOFF_MS = 10 * 60 * 1000;

/**
 * Deletes handoff files a killed launch left behind (#372). Only inside `dir` when it is the coach's own private
 * directory (owned by this user, mode 0700), and only plain files this user owns that are older than `maxAgeMs`.
 * Not run on Windows, where modes and owners are not the same kind of fact.
 * @param {string} dir
 * @param {number} [maxAgeMs]
 * @param {number} [now]
 */
export function sweepStaleHandoffs(dir, maxAgeMs = STALE_HANDOFF_MS, now = Date.now()) {
	if (process.platform === "win32" || typeof process.getuid !== "function") return;
	try {
		const me = process.getuid();
		const own = lstatSync(dir);
		if (!own.isDirectory() || own.uid !== me || (own.mode & 0o077) !== 0) return;
		for (const name of readdirSync(dir)) {
			if (!FILE_PATTERN.test(name)) continue;
			const path = join(dir, name);
			const info = lstatSync(path);
			if (info.isFile() && info.uid === me && now - info.mtimeMs > maxAgeMs) rmSync(path, { force: true });
		}
	} catch {
		// Best effort: a failed sweep leaves a file for the next launch to try again, and must not stop this launch.
	}
}

/**
 * Writes `secrets` to a fresh 0600 file in `dir`; the child reads it once and deletes it. Returns its path and a cleanup.
 * @param {Record<string, string>} secrets
 * @param {string} dir
 * @returns {{ path: string, cleanup: () => void }}
 */
export function writeHandoff(secrets, dir) {
	const path = join(dir, `launch-secrets-${randomUUID()}.json`);
	writeFileSync(path, JSON.stringify(secrets), { mode: 0o600 });
	return { path, cleanup: () => rmSync(path, { force: true }) };
}

/**
 * The private directory a parent Pi writes a child's handoff file in: the coach's own agent dir, else a fresh 0700 temp one.
 * @param {Record<string, string | undefined>} environment
 */
export function handoffDir(environment) {
	return environment.PI_CODING_AGENT_DIR || mkdtempSync(join(tmpdir(), "voxren-handoff-"));
}

/**
 * Moves the secret names out of `env` into a 0600 file in `dir` (a 0700 directory).
 * @param {Record<string, string | undefined>} env
 * @param {string} dir
 * @returns {{ env: Record<string, string | undefined>, cleanup: () => void }}
 */
export function stashSecrets(env, dir) {
	/** @type {Record<string, string>} */
	const secrets = Object.fromEntries(SECRET_ENV_NAMES.filter((name) => env[name]).map((name) => [name, /** @type {string} */ (env[name])]));
	const rest = { ...env };
	for (const name of SECRET_ENV_NAMES) delete rest[name];
	if (Object.keys(secrets).length === 0) return { env: rest, cleanup: () => {} };
	sweepStaleHandoffs(dir);
	const { path, cleanup } = writeHandoff(secrets, dir);
	return { env: { ...rest, [LAUNCH_SECRETS_VAR]: path }, cleanup };
}

/**
 * Reads and deletes the file the launcher left, then puts its keys into `environment` (this process's own
 * variables, which the operating system's process listing does not show: it reads the block as it was at exec).
 * Returns the error when the file could not be read, so the caller (which has the log) can record it.
 * @param {Record<string, string | undefined>} [environment]
 * @returns {unknown}
 */
export function adoptLaunchSecrets(environment = process.env) {
	const path = environment[LAUNCH_SECRETS_VAR];
	if (!path) return undefined;
	delete environment[LAUNCH_SECRETS_VAR];
	try {
		const secrets = JSON.parse(readFileSync(path, "utf8"));
		for (const name of SECRET_ENV_NAMES) if (typeof secrets[name] === "string") environment[name] = secrets[name];
		return undefined;
	} catch (error) {
		return error;
	} finally {
		rmSync(path, { force: true });
	}
}
