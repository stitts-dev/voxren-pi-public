import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { logEvent } from "./coach-log";

/**
 * The coach keeps itself current: which commit is running, what is new since the player last ran it, and the
 * newest commits on its branch, pulled and loaded in place by `/update` (Pi's extension reload, no restart).
 * Git does the work; this file only asks it and turns the answers into lines.
 */
export const UPDATE_COMMAND = "update";
export const UPDATE_COMMAND_DESCRIPTION = "Pull the newest coach from its branch and load it in place, with the notes for what changed";
/** The display-only message that lists what is new; it never reaches the model. */
export const WHATS_NEW_MESSAGE_TYPE = "voxren-whats-new";
/** How often the coach looks for new commits on its branch. */
/** The header line that says an update is ready. */
export const UPDATE_NOTICE_ID = "update";
export const UPDATE_CHECK_MS = 10 * 60_000;
/** The newest commits a note lists; more are counted, not listed. */
const MAX_NOTES = 12;
const GIT_TIMEOUT_MS = 20_000;
/** A change to these needs `npm ci`, which a running coach blocks on Windows, so /update stops and says to run `just latest`. */
const INSTALL_FILES = ["package.json", "package-lock.json"];

export type Git = (dir: string, args: string[]) => Promise<string>;

export const runGit: Git = (dir, args) =>
	new Promise((resolve, reject) =>
		execFile("git", ["-C", dir, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))),
	);

export interface Checkout {
	branch: string;
	/** Short commit id. */
	head: string;
}

export async function readCheckout(dir: string, git: Git = runGit): Promise<Checkout | undefined> {
	try {
		const [branch, head] = await Promise.all([git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), git(dir, ["rev-parse", "--short", "HEAD"])]);
		return { branch, head };
	} catch (error) {
		logEvent("info", "update", "not-a-checkout", { dir }, error);
		return undefined;
	}
}

/** `branch@head`, the label the header shows and a bug report quotes. */
export function versionLabel(checkout: Checkout | undefined): string | undefined {
	return checkout ? `${checkout.branch}@${checkout.head}` : undefined;
}

export interface Notes {
	count: number;
	/** `<short id> <subject>`, newest first, at most MAX_NOTES. */
	lines: string[];
}

/** Commits in `to` that are not in `from`; nothing when `from` is unknown to this clone (a rebased or pruned commit). */
export async function commitsBetween(dir: string, from: string, to: string, git: Git = runGit): Promise<Notes> {
	try {
		const count = Number(await git(dir, ["rev-list", "--count", `${from}..${to}`]));
		if (!count) return { count: 0, lines: [] };
		const log = await git(dir, ["log", "--no-merges", `--max-count=${MAX_NOTES}`, "--format=%h %s", `${from}..${to}`]);
		return { count, lines: log ? log.split("\n") : [] };
	} catch (error) {
		logEvent("info", "update", "commits-between-failed", { from, to }, error);
		return { count: 0, lines: [] };
	}
}

/** Fetches the branch and lists what it has that this checkout does not. */
export async function remoteNotes(dir: string, branch: string, git: Git = runGit): Promise<Notes> {
	try {
		await git(dir, ["fetch", "--quiet", "origin", branch]);
	} catch (error) {
		logEvent("warn", "update", "fetch-failed", { branch }, error);
		return { count: 0, lines: [] };
	}
	return commitsBetween(dir, "HEAD", `origin/${branch}`, git);
}

/** The dev worktree's branch: rebuilt in place from main plus open pull requests, never pushed, so there is nothing to fetch. */
export const DEV_BRANCH = "dev";

/** What a reload would bring: on dev, the commits since the head this instance loaded (a rebuild moves HEAD on disk); elsewhere, the branch on origin. */
export async function pendingNotes(dir: string, checkout: Checkout, loadedHead: string | undefined, git: Git = runGit): Promise<Notes> {
	if (checkout.branch !== DEV_BRANCH) return remoteNotes(dir, checkout.branch, git);
	if (!loadedHead || loadedHead === checkout.head) return { count: 0, lines: [] };
	const notes = await commitsBetween(dir, loadedHead, "HEAD", git);
	// A rebuild without new commits (a pull request left out) still changes what is on disk.
	return notes.count ? notes : { count: 1, lines: [`${checkout.head} dev rebuilt`] };
}

export type PullResult = { ok: true; notes: Notes } | { ok: false; reason: string };

/** Fast-forwards the checkout to its branch on origin, or says why it will not. */
export async function pullLatest(dir: string, git: Git = runGit): Promise<PullResult> {
	const checkout = await readCheckout(dir, git);
	if (!checkout || checkout.branch === "HEAD") return { ok: false, reason: "This coach is not running from a branch, so there is nothing to pull." };
	// dev's newest build is already on disk: /update only reloads it.
	if (checkout.branch === DEV_BRANCH) return { ok: true, notes: { count: 0, lines: [] } };
	const notes = await remoteNotes(dir, checkout.branch, git);
	if (!notes.count) return { ok: true, notes };
	try {
		if (await git(dir, ["status", "--porcelain", "--untracked-files=no"])) return { ok: false, reason: `This checkout has local changes; commit or drop them, then /update again.` };
		const changed = (await git(dir, ["diff", "--name-only", `HEAD..origin/${checkout.branch}`, "--", ...INSTALL_FILES])).trim();
		if (changed) return { ok: false, reason: `The update changes ${changed.split("\n").join(" and ")}: close the coach, run \`just latest\`, and start it again.` };
		await git(dir, ["merge", "--ff-only", "--quiet", `origin/${checkout.branch}`]);
	} catch (error) {
		logEvent("warn", "update", "pull-failed", { branch: checkout.branch }, error);
		return { ok: false, reason: "The pull did not fast-forward; `just latest` says why." };
	}
	return { ok: true, notes };
}

/** The commit the player last ran, kept in the coach home; undefined on a first run. */
export function readLastSeen(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch (error) {
		// A first run has no file yet: routine, but on record.
		logEvent("info", "update", "no-last-seen", { path }, error);
		return undefined;
	}
}

export function writeLastSeen(path: string, head: string): void {
	try {
		writeFileSync(path, `${head}\n`);
	} catch (error) {
		logEvent("warn", "update", "last-seen-write-failed", { path }, error);
	}
}

/**
 * The startup note: the running build, then what is new since the last run (nothing new: the build line alone), then
 * `trailing`, the lines drawn dim under the rows (the tip, a /report hint), each indented like a row.
 */
export function whatsNewText(version: string, notes: Notes, trailing: readonly string[] = []): string {
	const after = trailing.map((line) => `  ${line}`);
	if (!notes.count) return [`Coach ${version}`, ...after].join("\n");
	const more = notes.count > notes.lines.length ? [`…and ${notes.count - notes.lines.length} more`] : [];
	return [`Coach ${version} · new since your last run (${notes.count}):`, ...notes.lines.map((line) => `  ${line}`), ...more, ...after].join("\n");
}

/** The file beside profile.json that remembers which tip the notice showed last and how many reviews have run (src/feedback.ts). */
export const NOTICE_STATE_FILE = "notice-state.json";

export interface NoticeState {
	/** The index in coach.yaml's `tips` of the tip shown last. */
	tip?: number;
	/** Post-game reviews run so far, for the feedback prompt's cadence. */
	reviews?: number;
}

/** Never throws: a missing file is a first run, an unreadable one starts over, both on record. */
export function readNoticeState(path: string): NoticeState {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (!raw || typeof raw !== "object") return {};
		const state: NoticeState = {};
		if (Number.isInteger(raw.tip) && raw.tip >= 0) state.tip = raw.tip;
		if (Number.isInteger(raw.reviews) && raw.reviews >= 0) state.reviews = raw.reviews;
		return state;
	} catch (error) {
		logEvent("info", "update", "no-notice-state", { path }, error);
		return {};
	}
}

export function writeNoticeState(path: string, state: NoticeState): void {
	try {
		writeFileSync(path, `${JSON.stringify(state)}\n`);
	} catch (error) {
		logEvent("warn", "update", "notice-state-write-failed", { path }, error);
	}
}

/**
 * The tip for this start: the one after `last` in the list, wrapping, so two starts in a row never show the same one
 * (a list of one repeats, there being nothing else). The first start, or a `last` the list no longer has, starts at the top.
 */
export function nextTip(tips: readonly string[], last: number | undefined): { index: number; text: string } | undefined {
	if (!tips.length) return undefined;
	const index = last === undefined || !Number.isInteger(last) || last < 0 || last >= tips.length ? 0 : (last + 1) % tips.length;
	return { index, text: tips[index] };
}
