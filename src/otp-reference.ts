/**
 * Operator-supplied one-trick reference used by voxren_player_audit, loaded from data/reference/<champion>.json.
 *
 * data/reference/fizz.json was transcribed from the player's "Fizz Mid OTP Guide" artifact (394 ranked
 * games of a KR Challenger Fizz one-trick, patch 16.18). A reference is UNTRUSTED material about one
 * player's habits, not a rule set and not live data; the tool labels it as such and the model is told
 * the same. Replacing the file is how a different reference is adopted.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvent } from "./coach-log";
import { setAsideIfDamaged, writeFileAtomic } from "./safe-write";
import { type GameAudit, summarizeAudit } from "./audit-metrics";

export interface OtpMatchupReference {
	opponent: string;
	games: number;
	winRatePct: number;
	goldDiff15: number;
	diesBefore6Pct: number;
	deathsPerGame: number;
	boots: string;
	finish: string[];
	tip: string;
}

/** The passage the frame judges a reference claim against (no title: a saved reference's title is another player's Riot ID, which must not reach Jev): the rules and the per-game numbers the audit compares to. */
export function referencePassageText(reference: OtpReference): string {
	const perGame = Object.entries(reference.perGame).map(([key, value]) => `${key} ${value}`).join(", ");
	const items = Object.entries(reference.itemTimingMin).map(([item, min]) => `${item} at minute ${min}`).join(", ");
	return `${reference.champion} ${reference.position}, ${reference.games} games on patch ${reference.patch}. Per game: ${perGame}. Items: ${items}. Rules: ${reference.rules.join(" ")}`;
}

export interface OtpReference {
	title: string;
	url: string;
	champion: string;
	position: string;
	patch: string;
	games: number;
	rules: string[];
	perGame: Record<string, number>;
	itemTimingMin: Record<string, number>;
	/** deaths by minute 15 -> win % */
	deathsAt15WinPct: Record<string, number>;
	/** total deaths band -> win % */
	deathBandWinPct: Record<string, number>;
	matchups: OtpMatchupReference[];
}

/** Checks a reference file's shape and names the first bad path, so a hand-edited file fails at load, not mid-audit. */
export function parseOtpReference(value: unknown, source = "reference"): OtpReference {
	const fail = (path: string, want: string): never => {
		throw new Error(`${source}: ${path} must be ${want}`);
	};
	const record = (v: unknown, path: string) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(path, "an object"));
	const text = (v: unknown, path: string) => (typeof v === "string" ? v : fail(path, "a string"));
	const count = (v: unknown, path: string) => (typeof v === "number" && Number.isFinite(v) ? v : fail(path, "a number"));
	const numbers = (v: unknown, path: string) => Object.fromEntries(Object.entries(record(v, path)).map(([key, n]) => [key, count(n, `${path}.${key}`)]));
	const list = (v: unknown, path: string) => (Array.isArray(v) ? v : fail(path, "an array"));
	const root = record(value, "(root)");
	return {
		title: text(root.title, "title"),
		url: text(root.url, "url"),
		champion: text(root.champion, "champion"),
		position: text(root.position, "position"),
		patch: text(root.patch, "patch"),
		games: count(root.games, "games"),
		rules: list(root.rules, "rules").map((rule, i) => text(rule, `rules[${i}]`)),
		perGame: numbers(root.perGame, "perGame"),
		itemTimingMin: numbers(root.itemTimingMin, "itemTimingMin"),
		deathsAt15WinPct: numbers(root.deathsAt15WinPct, "deathsAt15WinPct"),
		deathBandWinPct: numbers(root.deathBandWinPct, "deathBandWinPct"),
		matchups: list(root.matchups, "matchups").map((entry, i) => {
			const m = record(entry, `matchups[${i}]`);
			const at = (key: string) => `matchups[${i}].${key}`;
			return {
				opponent: text(m.opponent, at("opponent")),
				games: count(m.games, at("games")),
				winRatePct: count(m.winRatePct, at("winRatePct")),
				goldDiff15: count(m.goldDiff15, at("goldDiff15")),
				diesBefore6Pct: count(m.diesBefore6Pct, at("diesBefore6Pct")),
				deathsPerGame: count(m.deathsPerGame, at("deathsPerGame")),
				boots: text(m.boots, at("boots")),
				finish: list(m.finish, at("finish")).map((item, k) => text(item, `${at("finish")}[${k}]`)),
				tip: text(m.tip, at("tip")),
			};
		}),
	};
}

const SHIPPED_DIR = fileURLToPath(new URL("../data/reference/", import.meta.url));

/** File key for a champion: Riot's championName, letters and digits only, lowercase (`TwistedFate` -> `twistedfate`). */
export function referenceKey(champion: string): string {
	return champion.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export const OTP_REFERENCE = parseOtpReference(JSON.parse(readFileSync(join(SHIPPED_DIR, "fizz.json"), "utf8")), "data/reference/fizz.json");
export const OTP_REFERENCE_URL = OTP_REFERENCE.url;
export const OTP_REFERENCE_TITLE = OTP_REFERENCE.title;

export function otpMatchup(opponent: string, reference: OtpReference = OTP_REFERENCE): OtpMatchupReference | undefined {
	const key = referenceKey(opponent);
	return reference.matchups.find((entry) => referenceKey(entry.opponent) === key);
}

/** A saved reference needs this many games on the champion; fewer is an anecdote, not a baseline. */
export const MIN_REFERENCE_GAMES = 3;
/** Items a saved reference tracks: the most common finished items, at most this many. */
const MAX_REFERENCE_ITEMS = 8;

const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

function topValues(values: string[], limit: number): string[] {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value]) => value);
}

/**
 * A reference in the shipped file's shape, built from one player's games on one champion (what /otp read).
 * No curated rules, tips, or win-rate bands: those come only from a hand-written file.
 */
export function buildOtpReference(games: GameAudit[], source: { player: string; url: string }, finishedItems?: Set<string>): OtpReference {
	const champion = games[0].champion;
	// Finished items bought in at least two games (or the only game), most common first, capped. The build order also keeps
	// components still held at the end, so `finishedItems` (Data Dragon's finished set) drops those when given.
	const itemGames = new Map<string, number>();
	for (const game of games) {
		for (const name of new Set(game.build.itemOrder.map((item) => item.name))) if (!finishedItems || finishedItems.has(name)) itemGames.set(name, (itemGames.get(name) ?? 0) + 1);
	}
	const tracked = [...itemGames.entries()].filter(([, n]) => n >= Math.min(2, games.length)).sort((a, b) => b[1] - a[1]).slice(0, MAX_REFERENCE_ITEMS).map(([name]) => name);
	const summary = summarizeAudit(games, tracked);
	const perGame: Record<string, number> = {
		kills: summary.avgKills,
		deaths: summary.avgDeaths,
		assists: summary.avgAssists,
		kda: round((summary.avgKills + summary.avgAssists) / Math.max(1, summary.avgDeaths), 2),
		durationMin: summary.avgDurationMin,
		killsAt15: summary.avgKillsAt15,
		deathsAt15: summary.avgDeathsAt15,
	};
	const optional = { csAt10: summary.avgCsAt10, csAt15: summary.avgCsAt15, goldDiffAt10: summary.avgGoldDiffAt10, goldDiffAt15: summary.avgGoldDiffAt15, level6Min: summary.avgLevel6Min, firstBackMin: summary.avgFirstBackMin };
	for (const [key, value] of Object.entries(optional)) if (typeof value === "number") perGame[key] = value;
	const byOpponent = new Map<string, GameAudit[]>();
	for (const game of games) byOpponent.set(game.opponent, [...(byOpponent.get(game.opponent) ?? []), game]);
	const matchups: OtpMatchupReference[] = [];
	for (const [opponent, group] of byOpponent) {
		const gold = group.map((game) => game.goldDiffAt15).filter((value): value is number => typeof value === "number");
		// The card compares gold at 15 per matchup; a matchup with no gold reading has nothing to compare.
		if (!opponent || !gold.length) continue;
		matchups.push({
			opponent,
			games: group.length,
			winRatePct: Math.round((100 * group.filter((game) => game.win).length) / group.length),
			goldDiff15: Math.round(gold.reduce((a, b) => a + b, 0) / gold.length),
			diesBefore6Pct: Math.round((100 * group.filter((game) => game.deathsBefore6 > 0).length) / group.length),
			deathsPerGame: round(group.reduce((sum, game) => sum + game.deaths, 0) / group.length, 2),
			boots: "",
			finish: topValues(group.flatMap((game) => game.finalItems).filter((name) => !finishedItems || finishedItems.has(name)), 2),
			tip: "",
		});
	}
	const patch = topValues(games.map((game) => game.patch), 1)[0] ?? "";
	return parseOtpReference({
		title: `${source.player} on ${champion} (saved from /otp: ${games.length} ranked games, patch ${patch})`,
		url: source.url,
		champion,
		position: topValues(games.map((game) => game.position), 1)[0] ?? "",
		patch,
		games: games.length,
		rules: [],
		perGame,
		itemTimingMin: summary.medianItemTimingMin,
		deathsAt15WinPct: {},
		deathBandWinPct: {},
		matchups,
	}, "saved reference");
}

/** Writes a saved reference for its champion, replacing any earlier one: a per-process temp file renamed over it, and a damaged earlier file is set aside as `.corrupt-<time>` first (the save throws if it cannot be). */
export function saveOtpReference(dir: string, reference: OtpReference): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${referenceKey(reference.champion)}.json`);
	if (!setAsideIfDamaged(path, "otp-reference")) throw new Error(`${path} is damaged and could not be set aside, so the reference was not saved`);
	writeFileAtomic(path, `${JSON.stringify(reference, null, "\t")}\n`, "otp-reference");
	return path;
}

/**
 * The reference an audit compares against for one champion: the one the player saved with /otp, else the
 * shipped file, else none. A saved file that no longer parses is skipped, never fatal to the audit.
 */
export function loadOtpReference(champion: string, savedDir?: string): OtpReference | undefined {
	const file = `${referenceKey(champion)}.json`;
	for (const dir of savedDir ? [savedDir, SHIPPED_DIR] : [SHIPPED_DIR]) {
		const path = join(dir, file);
		if (!existsSync(path)) continue;
		try {
			return parseOtpReference(JSON.parse(readFileSync(path, "utf8")), path);
		} catch (error) {
			logEvent("warn", "otp-reference", "load-failed", { path }, error);
			continue;
		}
	}
	return undefined;
}

/**
 * The one-tricks /otp saved, for the /otp menu in /flow: each saved reference's player (read back from the title
 * buildOtpReference writes, "<player> on <champion> (saved from /otp: ...)") and champion. A shipped-style reference
 * with no player in its title, or a file that no longer parses, is skipped.
 */
export function savedOneTricks(dir: string | undefined): Array<{ player: string; champion: string }> {
	if (!dir || !existsSync(dir)) return [];
	const found: Array<{ player: string; champion: string }> = [];
	for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
		try {
			const reference = parseOtpReference(JSON.parse(readFileSync(join(dir, file), "utf8")), file);
			const end = reference.title.indexOf(` on ${reference.champion} (saved from /otp`);
			if (end > 0) found.push({ player: reference.title.slice(0, end), champion: reference.champion });
		} catch (error) {
			logEvent("warn", "otp-reference", "list-entry-failed", { file }, error);
			continue;
		}
	}
	return found;
}
