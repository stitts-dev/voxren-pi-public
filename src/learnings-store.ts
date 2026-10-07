/**
 * Per-Riot-ID player learnings, stored locally in the coach home: a plain JSON file per player under
 * `<coach home>/learnings/<key>.json`, mirroring how src/otp-reference.ts and src/config.ts persist their
 * own state (write-then-rename, permissive sanitizer, never throw on load). Nothing here leaves the machine;
 * this module is pure and does no wiring into the extension (issue #33 stage 1).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { logEvent } from "./coach-log";
import { coachHomePath } from "./exchange-log";
import { setAsideIfDamaged, writeFileAtomic } from "./safe-write";

export interface RecentGame {
	matchId: string;
	playedAt: string;
	/** The game's start as epoch milliseconds. Optional: files written before it existed order by `playedAt` alone. */
	playedAtMs?: number;
	champion: string;
	win: boolean;
	diedBefore6: boolean;
	aheadAt15ThenDied: boolean;
}
export interface ChampionStats {
	games: number;
	wins: number;
	losses: number;
}
export interface Takeaway {
	text: string;
	savedAt: string;
}
export interface LearningsProfile {
	recentGames: RecentGame[];
	perChampion: Record<string, ChampionStats>;
	streaks: { currentWinStreak: number; bestWinStreak: number };
	focusAreas: string[];
	takeaways: Takeaway[];
}

/** A voxren_player_audit result (or any future game review) folded into a profile by foldAuditGames. */
export interface AuditGameResult {
	matchId: string;
	playedAt: string;
	playedAtMs?: number;
	champion: string;
	win: boolean;
	remake: boolean;
	diedBefore6: boolean;
	aheadAt15ThenDied: boolean;
}

export const MAX_RECENT_GAMES = 20;
export const MAX_FOCUS_AREAS = 5;
export const MAX_TAKEAWAYS = 20;
export const MAX_TAKEAWAY_CHARS = 200;

/** A focus area needs at least this many recent games before it can fire at all. */
const MIN_FOCUS_WINDOW = 4;

export function emptyLearnings(): LearningsProfile {
	return { recentGames: [], perChampion: {}, streaks: { currentWinStreak: 0, bestWinStreak: 0 }, focusAreas: [], takeaways: [] };
}

function sanitizeRecentGame(value: unknown): RecentGame | undefined {
	if (!value || typeof value !== "object") return undefined;
	const g = value as Record<string, unknown>;
	if (typeof g.matchId !== "string" || typeof g.playedAt !== "string" || typeof g.champion !== "string") return undefined;
	if (typeof g.win !== "boolean" || typeof g.diedBefore6 !== "boolean" || typeof g.aheadAt15ThenDied !== "boolean") return undefined;
	const game: RecentGame = { matchId: g.matchId, playedAt: g.playedAt, champion: g.champion, win: g.win, diedBefore6: g.diedBefore6, aheadAt15ThenDied: g.aheadAt15ThenDied };
	// An optional field that fails its check is dropped alone, never its game.
	if (isStartTime(g.playedAtMs)) game.playedAtMs = g.playedAtMs;
	return game;
}

function isStartTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Newest first: the game's start time when stored, else its date. A tie (two games on one day with no stored start time) goes to the higher Riot match number, which rises with time. */
function newestFirst(a: RecentGame, b: RecentGame): number {
	const at = (game: RecentGame) => game.playedAtMs ?? Date.parse(game.playedAt);
	const matchNumber = (game: RecentGame) => Number(/_(\d+)$/.exec(game.matchId)?.[1] ?? 0);
	return at(b) - at(a) || matchNumber(b) - matchNumber(a);
}

function sanitizeChampionStats(value: unknown): ChampionStats | undefined {
	if (!value || typeof value !== "object") return undefined;
	const s = value as Record<string, unknown>;
	if (typeof s.games !== "number" || typeof s.wins !== "number" || typeof s.losses !== "number") return undefined;
	return { games: s.games, wins: s.wins, losses: s.losses };
}

function sanitizeTakeaway(value: unknown): Takeaway | undefined {
	if (!value || typeof value !== "object") return undefined;
	const t = value as Record<string, unknown>;
	if (typeof t.text !== "string" || typeof t.savedAt !== "string") return undefined;
	const text = t.text.trim().slice(0, MAX_TAKEAWAY_CHARS);
	if (text.length === 0) return undefined;
	return { text, savedAt: t.savedAt };
}

function nonNegativeInt(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Permissive per-field sanitizer, same contract as sanitizeProfile (src/config.ts): drop anything malformed, cap every array, never throw. */
export function sanitizeLearnings(raw: unknown): LearningsProfile {
	const profile = emptyLearnings();
	if (!raw || typeof raw !== "object") return profile;
	const record = raw as Record<string, any>;

	const gamesRaw = Array.isArray(record.recentGames) ? record.recentGames : [];
	for (const entry of gamesRaw) {
		if (profile.recentGames.length >= MAX_RECENT_GAMES) break;
		const game = sanitizeRecentGame(entry);
		if (game) profile.recentGames.push(game);
	}

	const perChampionRaw = record.perChampion && typeof record.perChampion === "object" ? record.perChampion : {};
	for (const [champion, stats] of Object.entries(perChampionRaw)) {
		const parsed = sanitizeChampionStats(stats);
		if (parsed) profile.perChampion[champion] = parsed;
	}

	const streaksRaw = record.streaks && typeof record.streaks === "object" ? record.streaks : {};
	profile.streaks = { currentWinStreak: nonNegativeInt(streaksRaw.currentWinStreak), bestWinStreak: nonNegativeInt(streaksRaw.bestWinStreak) };

	const focusRaw = Array.isArray(record.focusAreas) ? record.focusAreas : [];
	for (const entry of focusRaw) {
		if (profile.focusAreas.length >= MAX_FOCUS_AREAS) break;
		if (typeof entry === "string" && entry.trim().length > 0) profile.focusAreas.push(entry);
	}

	const takeawaysRaw = Array.isArray(record.takeaways) ? record.takeaways : [];
	for (const entry of takeawaysRaw) {
		if (profile.takeaways.length >= MAX_TAKEAWAYS) break;
		const takeaway = sanitizeTakeaway(entry);
		if (takeaway) profile.takeaways.push(takeaway);
	}

	return profile;
}

/** The pre-#340 key: a readable slug only, so different IDs could share it and a symbol-only ID gave "". Kept to find files written before the hash. */
function legacyKey(riotId: string): string {
	return riotId
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
}

/** A readable slug plus 8 hex of the exact lowercased Riot ID: distinct IDs never share a file, the key is never empty, and it holds only letters, digits, and dashes (Windows-safe). Unicode-aware: Riot IDs can carry non-Latin tags (e.g. KR accounts with Hangul tags, see live-gateway.ts's RIOT_TAG). */
export function learningsKey(riotId: string): string {
	const slug = legacyKey(riotId).slice(0, 40).replace(/-+$/, "") || "player";
	return `${slug}-${createHash("sha256").update(riotId.toLowerCase()).digest("hex").slice(0, 8)}`;
}

/**
 * The player's file, moving a file written under the old key (#340) to the new name first when the new one is absent.
 * The old file stored no Riot ID, so if two IDs once shared it, the first to read it keeps it and the other starts fresh.
 */
export function learningsFilePath(dir: string | undefined, riotId: string): string | undefined {
	if (!dir) return undefined;
	const path = join(dir, `${learningsKey(riotId)}.json`);
	const old = legacyKey(riotId);
	const legacy = old ? join(dir, `${old}.json`) : undefined;
	if (legacy && !existsSync(path) && existsSync(legacy)) {
		try {
			renameSync(legacy, path);
			logEvent("info", "learnings-store", "legacy-file-migrated", { from: legacy, to: path });
		} catch (error) {
			logEvent("warn", "learnings-store", "legacy-migration-failed", { from: legacy, to: path }, error);
		}
	}
	return path;
}

/** `<coach home>/learnings/<key>.json`; undefined outside a launch, same as every other coach-home path. */
export function learningsPath(environment: Record<string, string | undefined>, riotId: string): string | undefined {
	return learningsFilePath(coachHomePath(environment, "learnings"), riotId);
}

/** Never throws: an undefined path, a missing file, or unparsable JSON all yield the same sanitized default. */
export function loadLearnings(path: string | undefined): LearningsProfile {
	if (!path) return sanitizeLearnings(undefined);
	try {
		return sanitizeLearnings(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		// No file yet is a player with no learnings, routine like config.ts's missing profile; a file that will not read is a warning.
		logEvent((error as NodeJS.ErrnoException).code === "ENOENT" ? "info" : "warn", "learnings-store", "load-failed", { path }, error);
		return sanitizeLearnings(undefined);
	}
}

/** Undefined path is a silent no-op. A file that exists but will not parse is set aside first (never overwritten); if that fails the save is skipped. Write-then-rename through a per-process temp file, flushed before the rename. */
export function saveLearnings(path: string | undefined, profile: LearningsProfile): void {
	if (!path) return;
	mkdirSync(dirname(path), { recursive: true });
	if (!setAsideIfDamaged(path, "learnings-store")) return;
	writeFileAtomic(path, `${JSON.stringify(profile, null, "\t")}\n`, "learnings-store");
}

/** Deletes the file if it exists; a missing file or an undefined path are both silent no-ops, never throws. */
export function resetLearnings(path: string | undefined): void {
	if (!path) return;
	try {
		if (existsSync(path)) rmSync(path);
	} catch (error) {
		// never throw: a reset is best-effort cleanup, not a critical path.
		logEvent("warn", "learnings-store", "reset-failed", { path }, error);
	}
}

function isFocusArea(games: readonly RecentGame[], flag: (game: RecentGame) => boolean): boolean {
	if (games.length < MIN_FOCUS_WINDOW) return false;
	return games.filter(flag).length / games.length >= 0.5;
}

/**
 * Folds new audit results into a profile: merges by matchId (a re-added match replaces the stored one,
 * so replaying the same audit is idempotent), drops remakes, sorts newest-first (by start time, so several
 * games on one day keep the order they were played in), caps at MAX_RECENT_GAMES.
 * perChampion, streaks, and focusAreas are all recomputed fresh from the resulting recentGames, never
 * accumulated separately, so a dropped or replaced game can never leave stale numbers behind.
 */
export function foldAuditGames(profile: LearningsProfile, games: readonly AuditGameResult[]): LearningsProfile {
	const byMatchId = new Map<string, RecentGame>();
	for (const game of profile.recentGames) byMatchId.set(game.matchId, game);
	for (const game of games) {
		if (game.remake) continue;
		byMatchId.set(game.matchId, {
			matchId: game.matchId,
			playedAt: game.playedAt,
			...(isStartTime(game.playedAtMs) ? { playedAtMs: game.playedAtMs } : {}),
			champion: game.champion,
			win: game.win,
			diedBefore6: game.diedBefore6,
			aheadAt15ThenDied: game.aheadAt15ThenDied,
		});
	}
	const recentGames = [...byMatchId.values()].sort(newestFirst).slice(0, MAX_RECENT_GAMES);

	const perChampion: Record<string, ChampionStats> = {};
	for (const game of recentGames) {
		const stats = perChampion[game.champion] ?? { games: 0, wins: 0, losses: 0 };
		stats.games += 1;
		if (game.win) stats.wins += 1;
		else stats.losses += 1;
		perChampion[game.champion] = stats;
	}

	let currentWinStreak = 0;
	for (const game of recentGames) {
		if (!game.win) break;
		currentWinStreak += 1;
	}
	let bestWinStreak = 0;
	let run = 0;
	for (const game of recentGames) {
		run = game.win ? run + 1 : 0;
		bestWinStreak = Math.max(bestWinStreak, run);
	}

	const focusAreas: string[] = [];
	if (isFocusArea(recentGames, (g) => g.diedBefore6)) focusAreas.push("dying before minute 6");
	if (isFocusArea(recentGames, (g) => g.aheadAt15ThenDied)) focusAreas.push("dying after being ahead at 15");

	return { recentGames, perChampion, streaks: { currentWinStreak, bestWinStreak }, focusAreas: focusAreas.slice(0, MAX_FOCUS_AREAS), takeaways: profile.takeaways };
}

/** Prepends a new takeaway (most recent first), trimmed and capped to MAX_TAKEAWAY_CHARS; the list itself caps at MAX_TAKEAWAYS, oldest dropped. */
export function addTakeaway(profile: LearningsProfile, text: string, savedAt: string): LearningsProfile {
	const trimmed = text.trim().slice(0, MAX_TAKEAWAY_CHARS);
	const takeaways = [{ text: trimmed, savedAt }, ...profile.takeaways].slice(0, MAX_TAKEAWAYS);
	return { ...profile, takeaways };
}

/** Removes the takeaway at `index`; an out-of-range index (including negative) is a no-op. */
export function deleteTakeaway(profile: LearningsProfile, index: number): LearningsProfile {
	if (index < 0 || index >= profile.takeaways.length) return profile;
	return { ...profile, takeaways: profile.takeaways.filter((_, i) => i !== index) };
}

function topChampion(perChampion: Record<string, ChampionStats>): [string, ChampionStats] | undefined {
	let best: [string, ChampionStats] | undefined;
	for (const entry of Object.entries(perChampion)) if (!best || entry[1].games > best[1].games) best = entry;
	return best;
}

/** One deterministic sentence for the system prompt: recent form, top champion, streaks, focus areas, latest takeaways; "" for an empty profile. */
export function summarizeLearnings(profile: LearningsProfile, maxChars = 400): string {
	if (profile.recentGames.length === 0 && profile.takeaways.length === 0) return "";

	const parts: string[] = [];
	const wins = profile.recentGames.filter((g) => g.win).length;
	const losses = profile.recentGames.length - wins;
	if (profile.recentGames.length > 0) parts.push(`Recent form ${wins}-${losses} over the last ${profile.recentGames.length} game${profile.recentGames.length === 1 ? "" : "s"}`);

	const top = topChampion(profile.perChampion);
	if (top) parts.push(`most played ${top[0]} (${top[1].games}g, ${top[1].wins}-${top[1].losses})`);

	if (profile.streaks.currentWinStreak > 0 || profile.streaks.bestWinStreak > 0) parts.push(`${profile.streaks.currentWinStreak}-game win streak, best ${profile.streaks.bestWinStreak}`);

	if (profile.focusAreas.length > 0) parts.push(`focus: ${profile.focusAreas.join("; ")}`);

	if (profile.takeaways.length > 0) parts.push(`remembers: ${profile.takeaways.slice(0, 2).map((t) => t.text).join("; ")}`);

	const sentence = `${parts.join(". ")}.`;
	return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 1)}…` : sentence;
}
