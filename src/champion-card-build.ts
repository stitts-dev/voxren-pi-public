/**
 * Builds the coaching layer of one champion card: damage profile, archetype, lane axis, power spikes, the cooldown to
 * bait, win condition, common mistakes, and comp tags. The same pattern as src/matchup-note-build.ts: guide pages
 * through the research service, a worker distils each source (and the Data Dragon ability text, as `game-1`) into rows
 * that cite their part, and the Jev grounding judge keeps a row only when the part it cites supports it. Unsupported
 * and contradicted rows are dropped and reported, never written.
 */
import { COACH_YAML, fillTemplate } from "./contracts";
import { BAIT_SLOTS, COMP_TAGS, MAX_LIST_ROWS, MAX_ROW_CHARS, championCoachingRows, championPassageText, parseChampionCard, type CardSource, type ChampionCard, type ChampionCoaching } from "./champion-card";
import { citedPassages, grounded, guidePages, plainTitle, screenRows, screenSources, type NoteBuildDeps, type Passage } from "./matchup-note-build";
import { logEvent } from "./coach-log";
import type { PassageJudge } from "./passage-judge";

const MAX_GUIDES = 3;
const DISTIL_TIMEOUT_MS = 180_000;
const GAME_SOURCE = "game-1";
const KINDS = ["damage", "archetype", "axis", "spike", "bait", "win", "mistake", "comp"] as const;
type Kind = (typeof KINDS)[number];
/** Kinds whose line carries a head before the bar: a time, an ability key, a tag. */
const HEADED = new Set<Kind>(["spike", "bait", "comp"]);

export interface CardCandidate {
	kind: Kind;
	head: string;
	text: string;
	cite: string;
}

export interface Dropped {
	kind: Kind;
	text: string;
	reason: string;
}

/** What one build stored and ran: the numbers the pilot report is made of (`sources` and `kept` are the finished card's, not the counts before the caps and the cited-source filter). What it cost is measured at the worker (`measureWorker`, src/pi-worker.ts), which also sees the hosted searches the builder starts. */
export interface CardBuildStats {
	sources: number;
	candidates: number;
	kept: number;
	dropped: Dropped[];
	jevClaims: number;
	/** Pages the Jev passage screen withheld for a planted instruction, and pages dropped because the screen could not run: neither reached a worker. */
	withheldPages: number;
	unscreenedPages: number;
}

export interface CardBuildDeps extends Pick<NoteBuildDeps, "research" | "worker" | "judge" | "hostedSearch" | "log" | "signal" | "now"> {
	/** The Jev passage screen: every page is screened for injection before a worker reads it. */
	screen: Pick<PassageJudge, "judge">;
	/** The model name written into `meta.model`. */
	model: string;
}

const sourceOf = (cite: string) => (cite.startsWith("game-") ? cite : cite.split("-")[0]);

/** "Kind: text [s1-3]" and "Kind: head | text [s1-3]" lines; a line with the wrong shape for its kind, or no part id, is dropped. */
export function parseCardCandidates(answer: string): CardCandidate[] {
	const line = new RegExp(`^\\s*[-*\\d.]*\\s*(${KINDS.join("|")})\\s*:\\s*(?:([^|\\[\\]]{1,60}?)\\s*\\|\\s*)?(.+?)\\s*\\[((?:s\\d+|game)-\\d+)\\]\\s*$`, "i");
	return answer
		.split("\n")
		.map((entry) => line.exec(entry))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => ({ kind: match[1].toLowerCase() as Kind, head: (match[2] ?? "").trim(), text: match[3].trim(), cite: match[4] }))
		.filter((row) => HEADED.has(row.kind) === (row.head !== ""));
}

/** The instruction and material for one distil run: a guide page's parts, or, for `game-1`, the champion's ability text. */
export function cardDistilRequest(champion: string, source: { kind: "guide" | "game"; title: string }, passages: Passage[]): { prompt: string; material: string } {
	const intro = source.kind === "game" ? fillTemplate(COACH_YAML.prompts.cardGameIntro, { champion }) : fillTemplate(COACH_YAML.prompts.notesGuide, { title: plainTitle(source.title) });
	return {
		prompt: fillTemplate(COACH_YAML.prompts.cardDistil, { intro, champion, tags: COMP_TAGS.join(", "), example: passages[0]?.id ?? "s1-1" }),
		material: passages.map((passage) => `PART ${passage.id}\n${passage.text}`).join("\n\n"),
	};
}

/** Everything a row says: a spike's head ("Level 6") is part of the claim, so Jev reads it with the body. */
const claimOf = (row: CardCandidate) => (row.kind === "spike" ? `${row.head}: ${row.text}` : row.text);

/** Why a candidate cannot stand before Jev reads it, or undefined. */
function malformed(row: CardCandidate): string | undefined {
	if (row.text.length > MAX_ROW_CHARS) return "too long";
	if (row.kind === "comp" && !COMP_TAGS.includes(row.head.toLowerCase())) return "comp tag outside the fixed set";
	if (row.kind === "bait" && !BAIT_SLOTS.some((slot) => slot.toLowerCase() === row.head.toLowerCase())) return "bait names no ability slot";
	return undefined;
}

/** `facts` is a card from Data Dragon (no coaching yet); the result is that card with its grounded coaching layer, or an error when no row survives. */
export async function buildChampionCoaching(deps: CardBuildDeps, facts: ChampionCard): Promise<{ card: ChampionCard; stats: CardBuildStats }> {
	const log = deps.log ?? (() => {});
	const champion = facts.name;
	const found = await guidePages(deps, { query: fillTemplate(COACH_YAML.prompts.cardGuideQuery, { champion }), readQuery: `${champion} guide`, max: MAX_GUIDES }, 1);
	deps.signal?.throwIfAborted();
	// Fail closed: a page is read by a worker only when the screen judged all of it and withheld none. A source id is its parts' id prefix, fixed at find time, so dropping a page never renumbers the rest.
	const screen = await screenSources({ passageJudge: deps.screen, signal: deps.signal }, `${champion} coaching guide`, found);
	const pages = screen.sources;
	log(`  passage screen: ${screen.withheld} passages withheld, ${screen.unscreened} pages unscreened and dropped`);
	const sources: Array<{ source: CardSource; kind: "guide" | "game"; title: string; passages: Passage[] }> = [
		...pages.map((page) => ({ source: { id: sourceOf(page.passages[0].id), title: page.source.title, url: page.source.url }, kind: "guide" as const, title: page.source.title, passages: page.passages })),
		{
			source: { id: GAME_SOURCE, title: `Riot Data Dragon ${facts.meta.version}`, url: `https://ddragon.leagueoflegends.com/cdn/${facts.meta.version}/data/en_US/champion/${facts.id}.json` },
			kind: "game" as const,
			title: "",
			passages: [{ id: GAME_SOURCE, at: 0, text: championPassageText(champion, facts.facts) }],
		},
	];
	const stats: CardBuildStats = { sources: 0, candidates: 0, kept: 0, dropped: [], jevClaims: 0, withheldPages: screen.withheldSources, unscreenedPages: screen.unscreened };
	sources.forEach(({ source, passages }) => log(`  ${source.id}  ${source.title.slice(0, 70)} (${passages.length} parts)`));

	const distilled = await Promise.all(
		sources.map(async (entry) => {
			const request = cardDistilRequest(champion, entry, entry.passages);
			const answer = await deps.worker({ ...request, tier: "standard", timeoutMs: DISTIL_TIMEOUT_MS, signal: deps.signal }).catch((error) => {
				logEvent("warn", "champion-card-build", "distil-failed", { source: entry.source.id }, error);
				return "";
			});
			return { ...entry, candidates: parseCardCandidates(answer) };
		}),
	);

	const survivors: CardCandidate[] = [];
	for (const { passages, candidates } of distilled) {
		stats.candidates += candidates.length;
		const routes = await Promise.all(
			candidates.map((row) => {
				const reason = malformed(row);
				if (reason) return Promise.resolve(reason);
				stats.jevClaims++;
				// Only the cited part and its neighbours in the same source: a neighbour from another page would be someone else's claim.
				return grounded(deps, claimOf(row), citedPassages(row, passages).filter((part) => sourceOf(part.id) === sourceOf(row.cite)));
			}),
		);
		candidates.forEach((row, index) => {
			if (routes[index] === "grounded") survivors.push(row);
			else {
				stats.dropped.push({ kind: row.kind, text: row.text, reason: routes[index] });
				log(`  drop  ${row.kind}: ${row.text} (${routes[index]})`);
			}
		});
	}
	// The same final screen the note builder gives its rows, over every string that reaches the card (head and body).
	const keptRows = await screenRows({ passageJudge: deps.screen, signal: deps.signal, log }, `${champion} coaching guide`, survivors, (row) => (row.head ? `${row.head}: ${row.text}` : row.text));
	log(`  distilled ${stats.candidates} rows from ${sources.length} sources, Jev kept ${keptRows.length}`);
	if (!keptRows.length) throw new Error("no row survived the source check");

	const of = (kind: Kind) => keptRows.filter((row) => row.kind === kind);
	const one = (kind: Kind) => (of(kind)[0] ? { value: of(kind)[0].text, sources: [sourceOf(of(kind)[0].cite)] } : undefined);
	const capped = <T>(rows: T[], key: (row: T) => string) => rows.filter((row, index) => rows.findIndex((other) => key(other).toLowerCase() === key(row).toLowerCase()) === index).slice(0, MAX_LIST_ROWS);
	const slotOf = (head: string) => BAIT_SLOTS.find((slot) => slot.toLowerCase() === head.toLowerCase()) as string;
	const coaching: ChampionCoaching = {
		...(one("damage") ? { damage: one("damage") } : {}),
		...(one("archetype") ? { archetype: one("archetype") } : {}),
		...(one("axis") ? { axis: one("axis") } : {}),
		...(one("win") ? { winCondition: one("win") } : {}),
		spikes: capped(of("spike").map((row) => ({ at: row.head, why: row.text, sources: [sourceOf(row.cite)] })), (row) => row.why),
		// One bait row per ability slot: the first Jev kept.
		bait: capped(of("bait").map((row) => ({ slot: slotOf(row.head), why: row.text, sources: [sourceOf(row.cite)] })), (row) => row.slot),
		mistakes: capped(of("mistake").map((row) => ({ value: row.text, sources: [sourceOf(row.cite)] })), (row) => row.value),
		comp: { tags: [...new Set(of("comp").map((row) => row.head.toLowerCase()))], sources: [...new Set(of("comp").map((row) => sourceOf(row.cite)))] },
	};
	// The card lists the sources its rows rest on; one that gave nothing is not an author of it.
	const cited = new Set(JSON.stringify(coaching).match(/"(?:s\d+|game-1)"/g)?.map((id) => id.slice(1, -1)));
	const meta = { ...facts.meta, generated: (deps.now ?? (() => new Date()))().toISOString().slice(0, 10), model: deps.model, sources: sources.map((entry) => entry.source).filter((source) => cited.has(source.id)) };
	const card = parseChampionCard({ ...facts, meta, coaching }, `${facts.id} coaching`);
	// The report counts what the file holds: the sources it names and the rows it carries, not the counts before the caps and the filter above.
	stats.sources = meta.sources.length;
	stats.kept = Object.values(championCoachingRows(card) ?? {}).reduce((total, rows) => total + (Array.isArray(rows) ? rows.length : 1), 0);
	return { card, stats };
}
