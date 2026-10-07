/**
 * Stored matchup notes: `<coach home>/matchups/<champion>-<opponent>.json`, one per lane matchup, built by
 * `src/matchup-note-build.ts` from matchup videos and written guides the first time the player meets that matchup.
 * Each row is our own sentence, kept only when the Jev grounding judge found it in the source's text, with how many
 * authors say it and links to where. `voxren_meta_research` (matchup) returns the note beside the OP.GG rows, as a
 * passage the frame can judge a claim against.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logEvent } from "./coach-log";

export const NOTE_KINDS = ["trade", "kill", "dodge", "spike", "wave", "build"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const MAX_NOTE_ROWS = 8;
export const MAX_ROW_CHARS = 240;

export interface MatchupNoteRow {
	kind: NoteKind;
	text: string;
	/** How many different authors (video channels, guide writers) say it: the one signal beyond "a source said so". */
	authors: number;
	/** Where it was said: a video link with a start time, or the guide's page. */
	links: string[];
}

export interface NoteSource {
	kind: "video" | "guide";
	title: string;
	author: string;
	url: string;
	published: string;
}

export interface MatchupNote {
	/** The Data Dragon version current when the note was built, and the day it was built. */
	meta: { version: string; generated: string };
	champion: string;
	opponent: string;
	sources: NoteSource[];
	rows: MatchupNoteRow[];
}

/** A note older than this is still served, and rebuilt in the background: patches move items and numbers. */
export const MAX_NOTE_AGE_DAYS = 30;
const DATA_DRAGON_VERSION = /^\d+\.\d+\.\d+$/;

/** A champion name as a file-name part: "Kai'Sa" and "kaisa" are the same champion, and a path-shaped name comes out harmless. */
export const matchupSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

export const matchupNoteFile = (champion: string, opponent: string) => `${matchupSlug(champion)}-${matchupSlug(opponent)}.json`;

function need(condition: unknown, source: string, path: string): void {
	if (!condition) throw new Error(`${source}: ${path} is missing or malformed`);
}

export function parseMatchupNote(value: unknown, source: string): MatchupNote {
	const note = value as Record<string, any> | undefined;
	need(note && typeof note === "object", source, "note");
	need(typeof note?.meta?.version === "string" && DATA_DRAGON_VERSION.test(note.meta.version), source, "meta.version");
	need(typeof note?.meta?.generated === "string" && note.meta.generated.length > 0, source, "meta.generated");
	for (const key of ["champion", "opponent"]) need(typeof note?.[key] === "string" && matchupSlug(note[key]).length > 0, source, key);
	need(Array.isArray(note?.sources) && note.sources.length > 0, source, "sources");
	(note?.sources as any[]).forEach((entry, index) => {
		need(entry?.kind === "video" || entry?.kind === "guide", source, `sources[${index}].kind`);
		for (const key of ["title", "author", "published"]) need(typeof entry?.[key] === "string", source, `sources[${index}].${key}`);
		need(typeof entry?.url === "string" && entry.url.startsWith("https://"), source, `sources[${index}].url`);
	});
	const distinctAuthors = new Set((note?.sources as NoteSource[]).map((entry) => entry.author)).size;
	need(Array.isArray(note?.rows) && note.rows.length > 0 && note.rows.length <= MAX_NOTE_ROWS, source, "rows");
	(note?.rows as any[]).forEach((row, index) => {
		need(NOTE_KINDS.includes(row?.kind), source, `rows[${index}].kind`);
		need(typeof row?.text === "string" && row.text.length > 0 && row.text.length <= MAX_ROW_CHARS && !row.text.includes("\n"), source, `rows[${index}].text`);
		need(Number.isInteger(row?.authors) && row.authors >= 1, source, `rows[${index}].authors`);
		need(Array.isArray(row?.links) && row.links.length > 0 && row.links.every((entry: unknown) => typeof entry === "string" && entry.startsWith("https://")), source, `rows[${index}].links`);
		// What the builder writes: a link is a source's own url or that url with a start time, and a row cannot have more authors than the note has.
		need(row.links.every((link: string) => (note?.sources as NoteSource[]).some((entry) => link === entry.url || link.startsWith(`${entry.url}?t=`))), source, `rows[${index}].links`);
		need(row.authors <= distinctAuthors, source, `rows[${index}].authors`);
	});
	return note as MatchupNote;
}

/** The stored note for a lane matchup, or undefined: no file, or a note that no longer parses, is skipped, never fatal. */
export function loadMatchupNote(champion: string, opponent: string, dir: string): MatchupNote | undefined {
	if (!matchupSlug(champion) || !matchupSlug(opponent)) return undefined;
	const path = join(dir, matchupNoteFile(champion, opponent));
	if (!existsSync(path)) return undefined;
	try {
		return parseMatchupNote(JSON.parse(readFileSync(path, "utf8")), path);
	} catch (error) {
		logEvent("warn", "matchup-note", "load-failed", { path }, error);
		return undefined;
	}
}

/**
 * Written to a temp file of its own and renamed, so a lookup never reads half a note and two writers never share a temp file.
 * With `keepFreshAt` (the live build, not a deliberate refresh), a note already on disk that is fresh at that time (another window finished first) is kept: the save is skipped and its path returned.
 */
export function saveMatchupNote(dir: string, note: MatchupNote, keepFreshAt?: Date): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, matchupNoteFile(note.champion, note.opponent));
	const text = `${JSON.stringify(parseMatchupNote(note, path), null, "\t")}\n`;
	const existing = keepFreshAt && loadMatchupNote(note.champion, note.opponent, dir);
	if (existing && keepFreshAt && noteAgeDays(existing, keepFreshAt) <= MAX_NOTE_AGE_DAYS) return path;
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, text);
		// Windows refuses a rename onto a file another process has open for a moment (EPERM, EBUSY, EACCES): wait and retry.
		for (let attempt = 0; ; attempt++) {
			try {
				renameSync(temp, path);
				break;
			} catch (error) {
				if (attempt >= 100 || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + attempt);
			}
		}
	} finally {
		rmSync(temp, { force: true });
	}
	return path;
}

/** A build lock older than this is a crashed window's: a build takes a few minutes. */
const BUILD_LOCK_STALE_MS = 20 * 60_000;

/**
 * Claims the right to build one matchup's note across windows (processes sharing the coach home): the lock file is
 * created exclusively. Returns a release function, or undefined when another window holds a live lock; the caller then
 * builds nothing and finds the other window's note on a later lookup.
 */
export function claimMatchupBuild(dir: string, champion: string, opponent: string, now: Date = new Date()): (() => void) | undefined {
	mkdirSync(dir, { recursive: true });
	const lock = join(dir, `${matchupNoteFile(champion, opponent)}.lock`);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			return () => rmSync(lock, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let age = 0;
			try {
				age = now.getTime() - statSync(lock).mtimeMs;
			} catch {
				continue; // released between the two calls: take it
			}
			if (age <= BUILD_LOCK_STALE_MS) return undefined;
			rmSync(lock, { force: true });
		}
	}
	return undefined;
}

/** Whole days since the note was built; a date that does not parse reads as too old. */
export function noteAgeDays(note: MatchupNote, now: Date): number {
	const built = Date.parse(note.meta.generated);
	return Number.isNaN(built) ? Number.POSITIVE_INFINITY : Math.floor((now.getTime() - built) / 86_400_000);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "4 matchup videos and 1 written guide by 4 authors". */
function provenance(note: MatchupNote): string {
	const videos = note.sources.filter((entry) => entry.kind === "video").length;
	const guides = note.sources.length - videos;
	const parts = [videos ? plural(videos, "matchup video") : "", guides ? plural(guides, "written guide") : ""].filter(Boolean);
	return `${parts.join(" and ")} by ${plural(new Set(note.sources.map((entry) => entry.author)).size, "author")}`;
}

/** The note as the model reads it: where it came from and how old it is, then each row with its agreement count. */
export function matchupNoteRows(note: MatchupNote) {
	return {
		source: `${provenance(note)}; third-party, not reviewed`,
		built: note.meta.generated,
		dataDragonVersion: note.meta.version,
		rows: note.rows.map((row) => ({ kind: row.kind, text: row.text, authors: row.authors })),
	};
}

/** The passage the frame judges a claim against: every row, with the counts the model reads. */
export function matchupNoteText(note: MatchupNote): string {
	const rows = note.rows.map((row) => `${row.kind[0].toUpperCase()}${row.kind.slice(1)}: ${row.text} (${plural(row.authors, "author")})`);
	return [`Matchup notes for ${note.champion} against ${note.opponent}, from ${provenance(note)}, built ${note.meta.generated}.`, ...rows].join(" ");
}
