/**
 * Builds one matchup note: what recent matchup videos and written guides say about one champion into one lane opponent.
 *
 * Sources come from the research service (YouTube search and transcripts, guide pages as passages) and, for finding
 * guide pages, the hosted web search. A worker Pi distils each source into labelled rows that cite the part they came
 * from; a row is kept only when the Jev grounding judge finds it in that part; a worker merges the kept rows into at
 * most eight; each merged row is judged against the rows it came from; a Build row must name something in the game now.
 *
 * Nothing here knows when to build: the gateway decides that (the first lookup of a matchup with no fresh note).
 */
import { COACH_YAML, fillTemplate } from "./contracts";
import { logEvent } from "./coach-log";
import type { GroundingJudge } from "./grounding-judge";
import { onDomains, type HostedSearch } from "./hosted-search";
import { MAX_NOTE_ROWS, MAX_ROW_CHARS, type MatchupNote, type MatchupNoteRow, NOTE_KINDS, type NoteKind, type NoteSource, parseMatchupNote } from "./matchup-note";
import { MAX_JUDGED_PASSAGES, type PassageJudge } from "./passage-judge";
import type { PiWorker } from "./pi-worker";
import { ResearchServiceError, type ResearchService } from "./research-service";

const MAX_VIDEOS = 4;
const MAX_PER_CHANNEL = 2;
const MAX_VIDEO_ATTEMPTS = 10;
const MAX_GUIDES = 2;
const MIN_TRANSCRIPT_CHARS = 2500;
const MIN_NOTE_ROWS = 3;
/** The distil prompt asks for 10 rows; a worker that prints more is cut here, so one source never costs more than this many Jev calls. */
const MAX_CANDIDATES = 10;
const PART_CHARS = 1200;
/** YouTube says "1 year ago" for 12 to 23 months, so this keeps videos under two years old: two item seasons at most. */
const MAX_AGE_MONTHS = 12;
/** Written guides come from these sites; the hosted search is told to stay on them. */
const GUIDE_DOMAINS = ["mobafire.com"];
/** A guide last touched before this is from another item season. The search is asked to stay inside it. */
const MAX_GUIDE_AGE_DAYS = 365;
const DISTIL_TIMEOUT_MS = 180_000;
/** With a Gemini key the service reads a long video through the Gemini API, which took 10 to 30 s for a 36 minute video when measured on 2026-10-01. This runs in the background, so it can wait much longer. */
const TRANSCRIPT_TIMEOUT_MS = 240_000;
const KIND_PATTERN = NOTE_KINDS.join("|");

export interface Passage {
	id: string;
	/** Start second in a video; 0 in a guide. */
	at: number;
	text: string;
}

export interface LoadedSource {
	source: NoteSource;
	passages: Passage[];
	/** The link for a row that cites a part starting at this second. */
	link: (at: number) => string;
}

export interface Candidate {
	kind: NoteKind;
	text: string;
	cite: string;
}

/** A candidate Jev kept, with who said it, in which source, and the link to that spot. */
export interface KeptRow extends Candidate {
	source: string;
	author: string;
	link: string;
}

export interface NoteBuildDeps {
	research: Pick<ResearchService, "call">;
	worker: PiWorker;
	judge: Pick<GroundingJudge, "judge">;
	/** The Jev passage-injection screen, the one every other third-party text gets: every transcript part and guide page goes through it before a worker reads it, and the finished rows again. Required: nothing is built unscreened. */
	passageJudge: Pick<PassageJudge, "judge">;
	/** Riot IDs scrubbed from what the passage screen reads. */
	accounts?: () => string[];
	/** Finds guide pages; without it a note is built from videos alone. */
	hostedSearch?: HostedSearch;
	/** The Data Dragon version and every current item, rune, and summoner spell name. */
	gameNames: () => Promise<{ version: string; names: string[] }>;
	now?: () => Date;
	log?: (line: string) => void;
	signal?: AbortSignal;
}

interface FoundVideo {
	id: string;
	title: string;
	channel: string;
	published: string;
	url: string;
}

/** Each video once, titles that name my champion first ahead of the rest: those are usually played from my side, and rows restated from the other side rarely survive the source check. */
export function orderVideos(videos: FoundVideo[], champion: string, opponent: string): FoundVideo[] {
	const seen = new Set<string>();
	const unique = videos.filter((video) => !seen.has(video.id) && Boolean(seen.add(video.id)));
	// Whole names, not substrings: "Vi" is not in "Viego". "Kai'Sa" and "kai sa" read the same.
	const words = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
	const mine = words(champion);
	const theirs = words(opponent);
	const mySide = (video: FoundVideo) => {
		const title = words(video.title);
		if (!title.includes(mine) || !title.includes(theirs)) return false;
		// "beat X as Y" names the opponent first and is played as Y.
		if (title.includes(` as${mine}`)) return true;
		if (title.includes(` as${theirs}`)) return false;
		return title.indexOf(mine) < title.indexOf(theirs);
	};
	return [...unique.filter(mySide), ...unique.filter((video) => !mySide(video))];
}

/** A title is the uploader's text and it rides in the instruction, so it is cut down to plain words first. */
export function plainTitle(title: string): string {
	return title.replace(/[^\p{L}\p{N} .,:'|()&/-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** The material a distil worker reads, and the instruction it follows: rows only from the parts, each citing its part. */
export function distilRequest(champion: string, opponent: string, source: NoteSource, passages: Passage[]): { prompt: string; material: string } {
	const title = plainTitle(source.title);
	const intro = fillTemplate(source.kind === "video" ? COACH_YAML.prompts.notesVideo : COACH_YAML.prompts.notesGuide, { title });
	return {
		prompt: fillTemplate(COACH_YAML.prompts.notesDistil, { intro, champion, opponent, example: passages[0]?.id ?? "s1-1" }),
		material: passages.map((passage) => `PART ${passage.id}\n${passage.text}`).join("\n\n"),
	};
}

/** "Kind: text [s1-3]" lines from the model's answer; anything else is dropped. */
export function parseCandidates(answer: string): Candidate[] {
	return answer
		.split("\n")
		.map((line) => new RegExp(`^\\s*[-*\\d.]*\\s*(${KIND_PATTERN})\\s*:\\s*(.+?)\\s*\\[(s\\d+-\\d+)\\]\\s*$`, "i").exec(line))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => ({ kind: match[1].toLowerCase() as NoteKind, text: match[2].trim(), cite: match[3] }));
}

/** What Jev reads for one row: the cited part and the part on each side, since a point often runs across a cut. */
export function citedPassages<T extends { cite: string }>(candidate: T, passages: Passage[]): Passage[] {
	const index = passages.findIndex((passage) => passage.id === candidate.cite);
	return index < 0 ? [] : passages.slice(Math.max(0, index - 1), index + 2);
}

export function mergeRequest(champion: string, opponent: string, rows: KeptRow[], names: string[]): { prompt: string; material: string } {
	return {
		prompt: fillTemplate(COACH_YAML.prompts.notesMerge, { champion, opponent, sources: String(new Set(rows.map((row) => row.source)).size) }),
		material: [fillTemplate(COACH_YAML.prompts.notesNames, { names: names.join(", ") }), rows.map((row, index) => `${index + 1}. ${row.kind}: ${row.text}`).join("\n")].join("\n\n"),
	};
}

const FUNCTION_WORDS = new Set("a an and are as at be before but by for from her his if in into is it its of on or she so than that the their them then they this to until when while with you your".split(" "));

/** The words that carry a row's meaning: no function words, and none of the names every row of the matchup shares. */
function contentWords(text: string, ignore: Set<string>): Set<string> {
	// Single letters stay only when they are ability keys: "E" is half of what "Hold E for Charm" says.
	return new Set(flat(text).split(" ").filter((word) => (word.length > 1 || /^[qwer]$/.test(word)) && !FUNCTION_WORDS.has(word) && !ignore.has(word)));
}

// ponytail: one shared word, not meaning. It stops a merged row from claiming authors whose rows are about something
// else entirely; two rows that share only a common word ("wave") still count. A paraphrase with no word in common is
// dropped from the count, which errs toward fewer authors. Judge each cited row with Jev if the count proves inflated.
/** True when the kept row has something to do with what the merged row says: they share a content word. */
export function supports(merged: string, kept: string, ignore: Set<string>): boolean {
	const words = contentWords(merged, ignore);
	for (const word of contentWords(kept, ignore)) if (words.has(word)) return true;
	return false;
}

/**
 * Merged rows with the kept rows each came from, most-agreed first. The merge model names the rows it used; a named row
 * that does not share content with the merged row is not counted, so citing extra rows cannot raise the author count.
 * A merged row left with no row behind it is dropped. `names` are the two champions: every row has them, so they count for nothing.
 */
export function parseMerged(answer: string, rows: KeptRow[], names: string[] = []): Array<MatchupNoteRow & { from: KeptRow[] }> {
	const ignore = new Set(names.flatMap((name) => flat(name).split(" ")));
	return answer
		.split("\n")
		.map((line) => new RegExp(`^\\s*[-*\\d.]*\\s*(${KIND_PATTERN})\\s*:\\s*(.+?)\\s*\\[([\\d,\\s]+)\\]\\s*$`, "i").exec(line))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => {
			const text = match[2].trim();
			const from = [...new Set(match[3].split(",").map((part) => rows[Number(part.trim()) - 1]).filter((row): row is KeptRow => row !== undefined))].filter((row) => supports(text, row.text, ignore));
			return { kind: match[1].toLowerCase() as NoteKind, text, authors: new Set(from.map((row) => row.author)).size, links: [...new Set(from.map((row) => row.link))], from };
		})
		.filter((row) => row.from.length > 0)
		.sort((a, b) => b.authors - a.authors)
		.slice(0, MAX_NOTE_ROWS);
}

/** Every item buyable on Summoner's Rift, every rune and rune tree, every summoner spell, by name, from the gateway's Data Dragon maps. */
export function currentNames(items: Record<number, any>, runes: Record<number, string>, summoners: Record<number, string>): string[] {
	const names = new Set<string>();
	for (const item of Object.values(items)) if (item?.maps?.["11"] && item?.gold?.purchasable && typeof item.name === "string") names.add(item.name.replace(/<[^>]+>/g, "").trim());
	for (const name of [...Object.values(runes), ...Object.values(summoners)]) names.add(name);
	names.delete("");
	return [...names];
}


// ponytail: a row naming one current item and one removed item still passes; the age cut and the merge prompt carry that case.
/** A Build row stands only when it names something in the game now; every other kind has nothing to check here. */
export function namesCurrentThing(row: { kind: NoteKind; text: string }, names: string[]): boolean {
	if (row.kind !== "build") return true;
	// Whole words: "Heal" must not be found inside "health", nor "Mark" inside "remark".
	const text = ` ${flat(row.text)} `;
	return names.some((name) => text.includes(` ${flat(name)} `));
}

/** Lowercase letters, digits, and single spaces: "Zhonya's Hourglass" and "zhonyas  hourglass" read the same. */
function flat(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

const rateLimited = (error: unknown) => error instanceof ResearchServiceError && error.serviceCode === "rate_limited";

/** Recent matchup videos with a transcript, two per channel at most. */
async function videoSources(deps: NoteBuildDeps, champion: string, opponent: string): Promise<LoadedSource[]> {
	const queries = [`${champion} vs ${opponent} matchup guide`, `${opponent} vs ${champion} matchup guide`];
	const found = await Promise.all(queries.map((query) => deps.research.call("/youtube/search", { query, title_terms: [champion, opponent], max_age_months: MAX_AGE_MONTHS, min_seconds: 180, max_seconds: 2700, max_results: 12 }, deps.signal)));
	const videos = orderVideos(found.flatMap((answer) => (Array.isArray(answer?.videos) ? (answer.videos as FoundVideo[]) : [])), champion, opponent);
	const loaded: LoadedSource[] = [];
	let limited = false;
	for (const video of videos.slice(0, MAX_VIDEO_ATTEMPTS)) {
		if (loaded.length >= MAX_VIDEOS) break;
		if (loaded.filter((entry) => entry.source.author === video.channel).length >= MAX_PER_CHANNEL) continue;
		let transcript: any;
		try {
			transcript = await deps.research.call("/youtube/transcript", { video_id: video.id, part_chars: PART_CHARS }, deps.signal, TRANSCRIPT_TIMEOUT_MS);
		} catch (error) {
			// A rate limit does not end the walk: the service remembers it, so a later video costs YouTube nothing and one already cached still comes back.
			logEvent("warn", "matchup-note-build", "video-transcript-failed", { videoId: video.id }, error);
			if (rateLimited(error) && !limited) deps.log?.("  YouTube is rate limiting transcripts; using the ones already fetched");
			limited ||= rateLimited(error);
			continue;
		}
		// A short transcript is a skip; so is a body with no numeric length or no parts (an error body, a malformed answer), which would otherwise load as an empty source.
		const chars = Number(transcript?.chars);
		const hasParts = Array.isArray(transcript?.passages) && transcript.passages.length > 0;
		if (!(chars >= MIN_TRANSCRIPT_CHARS) || !hasParts) {
			logEvent("warn", "matchup-note-build", "video-transcript-unusable", { videoId: video.id, chars: transcript?.chars ?? null, parts: hasParts });
			continue;
		}
		const index = loaded.length + 1;
		const passages: Passage[] = (Array.isArray(transcript?.passages) ? (transcript.passages as any[]) : []).map((part, position) => ({ id: `s${index}-${position + 1}`, at: Number(part?.at) || 0, text: String(part?.text ?? "") }));
		loaded.push({ source: { kind: "video", title: video.title, author: video.channel, url: video.url, published: video.published }, passages, link: (at) => (at ? `${video.url}?t=${at}` : video.url) });
	}
	return loaded;
}

/** Written guides for the matchup: the hosted search finds the pages, the research service reads them. A page the service cannot read still contributes the sentences the search quoted from it. */
function guideSources(deps: NoteBuildDeps, champion: string, opponent: string, first: number): Promise<LoadedSource[]> {
	return guidePages(deps, { query: fillTemplate(COACH_YAML.prompts.notesGuideQuery, { champion, opponent }), readQuery: `${opponent} ${champion}`, max: MAX_GUIDES }, first);
}

/** Guide pages for one search: found by the hosted search, read by the research service into numbered parts, ids from `s<first>`. The champion card builder reads its guides the same way. */
export async function guidePages(deps: Pick<NoteBuildDeps, "research" | "hostedSearch" | "signal" | "now">, { query, readQuery, max }: { query: string; readQuery: string; max: number }, first: number): Promise<LoadedSource[]> {
	if (!deps.hostedSearch) return [];
	let hits: Awaited<ReturnType<HostedSearch>>["hits"];
	try {
		hits = (await deps.hostedSearch({ query, domains: GUIDE_DOMAINS, freshnessDays: MAX_GUIDE_AGE_DAYS, maxResults: max + 1 }, deps.signal)).hits;
	} catch (error) {
		logEvent("warn", "matchup-note-build", "guide-search-failed", { query }, error);
		return [];
	}
	const loaded: LoadedSource[] = [];
	const seen = new Set<string>();
	for (const hit of hits) {
		if (loaded.length >= max) break;
		// Checked here too, not only asked of the search: a guide comes from a guide site, over https.
		if (!hit.url.startsWith("https://") || !onDomains(hit.url, GUIDE_DOMAINS)) continue;
		// The search spells one page several ways (with and without "www.", a trailing dot on the host, a trailing slash, a cache-busting query), and each spelling would be a source of its own. The stored url keeps its host and loses only the query.
		const parsed = new URL(hit.url);
		parsed.search = "";
		const url = parsed.href;
		const key = `${parsed.hostname.replace(/\.$/, "").replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`;
		if (seen.has(key)) continue;
		// The search is only asked to stay inside the age cut; a live hit dated before it is a guide for another item season, as an old archive copy is. A date that does not parse cannot be judged and stays.
		const age = ((deps.now ?? (() => new Date()))().getTime() - Date.parse(hit.date)) / 86_400_000;
		if (age > MAX_GUIDE_AGE_DAYS) {
			logEvent("warn", "matchup-note-build", "guide-too-old", { url: hit.url, date: hit.date });
			continue;
		}
		const index = first + loaded.length;
		let texts: string[];
		let published = hit.date;
		try {
			const page = await deps.research.call("/web/read", { url, query: readQuery, max_passages: 5, part_chars: PART_CHARS }, deps.signal);
			// An archive copy from before the cut is a guide for another item season, however recent the live page is.
			if (page?.source === "archive" && Number(page.snapshot_age_days) > MAX_GUIDE_AGE_DAYS) continue;
			// Ranked parts come back best first; a distiller reads them in page order.
			const parts = (Array.isArray(page?.passages) ? (page.passages as any[]) : []).sort((a, b) => Number(String(a?.id).slice(1)) - Number(String(b?.id).slice(1)));
			texts = parts.map((part) => String(part?.text ?? "")).filter(Boolean);
			if (page?.source === "archive" && typeof page.snapshot_timestamp === "string") published = `archived ${page.snapshot_timestamp.slice(0, 4)}-${page.snapshot_timestamp.slice(4, 6)}-${page.snapshot_timestamp.slice(6, 8)}`;
		} catch (error) {
			logEvent("warn", "matchup-note-build", "guide-page-read-failed", { url }, error);
			texts = [];
		}
		if (!texts.length && hit.snippet) texts = [hit.snippet];
		if (!texts.length) continue;
		const title = hit.title || url;
		seen.add(key);
		loaded.push({ source: { kind: "guide", title, author: title, url, published }, passages: texts.map((text, position) => ({ id: `s${index}-${position + 1}`, at: 0, text })), link: () => url });
	}
	return loaded;
}

export interface ScreenedSources<T> {
	sources: T[];
	/** Parts the screen withheld for a planted instruction; their whole source is dropped. */
	withheld: number;
	/** Sources dropped for a withheld part. */
	withheldSources: number;
	/** Sources dropped because the screen could not run: fail closed. */
	unscreened: number;
}

/**
 * The injection screen for research text, shared by every builder that hands third-party passages to a worker (the matchup
 * note builder here, the champion card builder). Every part of every source is judged, in batches of the screen's cap;
 * a source is kept only when the screen judged all of it and withheld none. A video's parts are judged under youtube.com,
 * a page's under its own host.
 */
export async function screenSources<T extends { source: { title: string; url: string }; passages: Passage[] }>(
	deps: Pick<NoteBuildDeps, "passageJudge" | "accounts" | "signal">,
	query: string,
	sources: T[],
): Promise<ScreenedSources<T>> {
	const out: ScreenedSources<T> = { sources: [], withheld: 0, withheldSources: 0, unscreened: 0 };
	const results = await Promise.all(
		sources.map(async (entry) => {
			const domain = new URL(entry.source.url).hostname;
			const batches: Passage[][] = [];
			for (let i = 0; i < entry.passages.length; i += MAX_JUDGED_PASSAGES) batches.push(entry.passages.slice(i, i + MAX_JUDGED_PASSAGES));
			const judged = await Promise.all(batches.map((batch) => deps.passageJudge.judge(query, { accounts: deps.accounts?.() ?? [] }, batch.map((part) => ({ id: part.id, title: entry.source.title, domain, text: part.text })), deps.signal)));
			return { entry, judged };
		}),
	);
	for (const { entry, judged } of results) {
		deps.signal?.throwIfAborted();
		const down = judged.some((result) => result.status !== "judged");
		const withheld = judged.reduce((sum, result) => sum + (result.status === "judged" ? result.verdicts.filter((verdict) => verdict.route === "withheld").length : 0), 0);
		if (down) out.unscreened++;
		else if (withheld) {
			out.withheld += withheld;
			out.withheldSources++;
		}
		else out.sources.push(entry);
	}
	return out;
}

export async function grounded(deps: Pick<NoteBuildDeps, "judge" | "signal">, claim: string, passages: Array<{ id: string; text: string }>): Promise<string> {
	deps.signal?.throwIfAborted();
	if (!passages.length) return "no source";
	const result = await deps.judge.judge([claim], passages, [], deps.signal);
	return result.status === "judged" ? result.verdicts[0].route : `jev ${result.reason}`;
}

/**
 * Transcript and guide text reaches the coach as finished rows (note rows, card rows), so they get the same injection screen as a search result: a withheld row is dropped, a screen that is down fails the build.
 * Shared by the note builder and the champion card builder. Judged in batches of the screen's cap; `textOf` is every string of the row that reaches the coach.
 */
export async function screenRows<T extends { kind: string; text: string }>(
	deps: Pick<NoteBuildDeps, "passageJudge" | "accounts" | "signal" | "log">,
	query: string,
	rows: T[],
	textOf: (row: T) => string = (row) => row.text,
): Promise<T[]> {
	if (!rows.length) return rows;
	deps.signal?.throwIfAborted();
	const withheld = new Set<string>();
	for (let from = 0; from < rows.length; from += MAX_JUDGED_PASSAGES) {
		const batch = rows.slice(from, from + MAX_JUDGED_PASSAGES);
		const result = await deps.passageJudge.judge(query, { accounts: deps.accounts?.() ?? [] }, batch.map((row, index) => ({ id: `row-${from + index + 1}`, title: "finished row", domain: "notes", text: textOf(row) })), deps.signal);
		if (result.status !== "judged") throw new Error(`passage screen unavailable: ${result.reason}`);
		for (const verdict of result.verdicts) if (verdict.route === "withheld") withheld.add(verdict.id);
	}
	return rows.filter((row, index) => {
		const drop = withheld.has(`row-${index + 1}`);
		if (drop) deps.log?.(`  drop  ${row.kind}: ${textOf(row)} (passage screen withheld it)`);
		return !drop;
	});
}

export async function buildMatchupNote(deps: NoteBuildDeps, champion: string, opponent: string): Promise<MatchupNote> {
	const log = deps.log ?? (() => {});
	const videos = await videoSources(deps, champion, opponent);
	const found = [...videos, ...(await guideSources(deps, champion, opponent, videos.length + 1))];
	// Nothing a worker reads has skipped the screen: a source with a withheld part, or one the screen could not judge, is dropped.
	const screen = await screenSources(deps, `${champion} vs ${opponent} matchup`, found);
	const sources = screen.sources;
	log(`  passage screen: ${screen.withheld} passages withheld, ${screen.unscreened} sources unscreened and dropped, ${sources.length} of ${found.length} sources kept`);
	// A closed session stops the build at the next stage: no worker, no Jev call, and no file after that.
	deps.signal?.throwIfAborted();
	if (!sources.length) throw new Error("no recent video with a transcript and no readable guide");
	sources.forEach(({ source, passages }) => log(`  ${passages[0]?.id.split("-")[0]}  ${source.kind} · ${source.author.slice(0, 40)}: ${source.title.slice(0, 70)} (${source.published}, ${passages.length} parts)`));

	const distilled = await Promise.all(
		sources.map(async (entry) => ({
			...entry,
			candidates: parseCandidates(
				await deps
					.worker({ ...distilRequest(champion, opponent, entry.source, entry.passages), tier: "standard", timeoutMs: DISTIL_TIMEOUT_MS, signal: deps.signal })
					.catch((error) => {
						logEvent("warn", "matchup-note-build", "distil-failed", { source: entry.source.title }, error);
						return "";
					}),
			).slice(0, MAX_CANDIDATES),
		})),
	);
	const kept: KeptRow[] = [];
	let candidates = 0;
	for (const { source, passages, link, candidates: rows } of distilled) {
		candidates += rows.length;
		const routes = await Promise.all(rows.map((row) => grounded(deps, row.text, citedPassages(row, passages))));
		rows.forEach((row, index) => {
			if (routes[index] === "grounded") kept.push({ ...row, source: source.url, author: source.author, link: link(passages.find((passage) => passage.id === row.cite)?.at ?? 0) });
			else log(`  drop  ${row.kind}: ${row.text} (${routes[index]})`);
		});
	}
	log(`  distilled ${candidates} rows from ${sources.length} sources, Jev kept ${kept.length}`);
	if (!kept.length) throw new Error("no row survived the source check");

	deps.signal?.throwIfAborted();
	const { version, names } = await deps.gameNames();
	const merged = parseMerged(await deps.worker({ ...mergeRequest(champion, opponent, kept, names), tier: "standard", timeoutMs: DISTIL_TIMEOUT_MS, signal: deps.signal }), kept, [champion, opponent]);
	// One passage: a merged row joins several notes, and Jev reads a claim no single passage covers as unsupported.
	const routes = await Promise.all(merged.map((row) => grounded(deps, row.text, [{ id: "notes", text: row.from.map((from) => from.text).join(" ") }])));
	const rows: MatchupNoteRow[] = [];
	merged.forEach((row, index) => {
		const reason = routes[index] !== "grounded" ? routes[index] : row.text.length > MAX_ROW_CHARS ? "too long" : namesCurrentThing(row, names) ? undefined : "names nothing in the current game";
		if (reason) log(`  drop  ${row.kind}: ${row.text} (merged row, ${reason}; from: ${row.from.map((from) => from.text).join(" | ")})`);
		else rows.push({ kind: row.kind, text: row.text, authors: row.authors, links: row.links });
	});
	const screened = await screenRows(deps, `${champion} vs ${opponent} matchup`, rows);
	if (screened.length < MIN_NOTE_ROWS) throw new Error(`only ${screened.length} merged rows survived`);
	deps.signal?.throwIfAborted();
	// The note names the sources its rows rest on. One that gave nothing (a failed distil, rows Jev refused) is not an author of it.
	const used = sources.map((entry) => entry.source).filter((source) => screened.some((row) => row.links.some((link) => link === source.url || link.startsWith(`${source.url}?t=`))));
	return parseMatchupNote({ meta: { version, generated: (deps.now ?? (() => new Date()))().toISOString().slice(0, 10) }, champion, opponent, sources: used, rows: screened }, `${champion} into ${opponent}`);
}
