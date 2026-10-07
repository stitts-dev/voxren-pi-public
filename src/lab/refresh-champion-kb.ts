/**
 * Champion card lab: writes data/champions/<id>.json from Riot Data Dragon (the current version's champion/<id>.json),
 * the same endpoint voxren_game_facts reads live. Run by hand when a patch ships, then commit the card:
 *
 *   bun run src/lab/refresh-champion-kb.ts [--coaching] Fizz [Ahri ...]
 *   bun run src/lab/refresh-champion-kb.ts [--coaching] --all [--limit N]
 *
 * With --coaching it also builds the coaching layer (src/champion-card-build.ts): guide pages through the research
 * service, a worker distil, and the Jev grounding gate per row, printing every dropped row and one cost line per
 * champion: the tokens every worker run reported (the hosted searches included) and the dollars when Pi has a price
 * for the model, and Jev's input tokens. Needs `pi`, `node`, and `uv` on PATH, the coach signed in, and TYPESAFE_API_KEY
 * in the coach home .env. Without it, a card's coaching layer is carried over when the patch is unchanged and dropped
 * when it is not.
 *
 * With --all the champions are the ones Data Dragon lists for the current version, never a list here. A champion whose
 * card is already current (built on this patch, and with --coaching holding a coaching layer) is skipped; one that fails
 * is reported and the run goes on; the run ends with each failure and its reason and the usage summed over every card,
 * failed ones too. --limit N stops after N cards have been built or have failed (a skip costs nothing and is not
 * counted), so a small paid trial is possible, and the same command again takes the next N.
 *
 * Never loaded by the coach. A champion the fetch or the validator rejects keeps its previous card and is reported.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAMPION_CARDS_DIR, championFacts, loadChampionCard, parseChampionCard, type ChampionCard } from "../champion-card";
import { buildChampionCoaching, type CardBuildStats } from "../champion-card-build";
import { logEvent } from "../coach-log";
import { GroundingJudge } from "../grounding-judge";
import { PassageJudge } from "../passage-judge";
import { createHostedSearch } from "../hosted-search";
import { addUsage, createPiWorker, measureWorker, noUsage, workerModel, type UsageTotal } from "../pi-worker";
import { createResearchService, findOnPath } from "../research-service";
import { realCoachHome } from "./lab-home";
import { typesafeKey } from "./refresh-matchup-notes";

const DATA_DRAGON_BASE = "https://ddragon.leagueoflegends.com";

export function cardFromDataDragon(detail: unknown, id: string, version: string, generated: string): ChampionCard {
	const full = (detail as any)?.data?.[id];
	if (!full || typeof full !== "object") throw new Error(`Data Dragon has no ${id} in this response`);
	return parseChampionCard({ meta: { version, generated }, id, name: String(full.name ?? id), facts: championFacts(full) }, `${id} from Data Dragon ${version}`);
}

export interface RefreshOptions {
	/** Data Dragon ids named on the command line. */
	ids: string[];
	/** The champions are Data Dragon's own list, and a card that is already current is skipped. */
	all: boolean;
	coaching: boolean;
	limit?: number;
}

/** What the card just handled spent, failed or not: every worker run (a distil or a hosted search) and Jev's input tokens. */
export interface Spent {
	worker: UsageTotal;
	jevTokens: number;
}

export interface RefreshDeps {
	fetch: (url: string) => Promise<Response>;
	load: (id: string) => ChampionCard | undefined;
	save: (card: ChampionCard) => void;
	/** The coaching build of one card; absent when only the facts are refreshed. */
	build?: (card: ChampionCard) => Promise<{ card: ChampionCard; stats: CardBuildStats }>;
	/** Hands over what was spent since the last call. */
	spent: () => Spent;
	log: (line: string) => void;
	now?: () => Date;
}

export interface RefreshReport {
	version: string;
	built: string[];
	skipped: string[];
	failed: Array<{ id: string; reason: string }>;
	/** Champions the limit stopped before. */
	notReached: string[];
	spent: Spent;
}

/** `worker 3 runs 2100 in 410 out, cache 100 read 0 written, $0.0210 at Pi list price, tokens only`: what the runs reported, and the dollars only for the runs Pi priced. The dollars are Pi's catalogue price times the tokens, with no hosted web-search fee, so the line says so: it is an estimate to approve a run by, not a bill. */
export function usageText(usage: UsageTotal): string {
	const cache = usage.cacheRead || usage.cacheWrite ? `, cache ${usage.cacheRead} read ${usage.cacheWrite} written` : "";
	const dollars = usage.cost === undefined ? "cost not given" : `$${usage.cost.toFixed(4)} at Pi list price, tokens only${usage.unpriced ? ` (${usage.unpriced} runs unpriced)` : ""}`;
	const silent = usage.reported < usage.runs ? `, ${usage.runs - usage.reported} runs reported nothing` : "";
	return `worker ${usage.runs} runs ${usage.input} in ${usage.output} out${cache}, ${dollars}${silent}`;
}

export async function refreshChampions(options: RefreshOptions, deps: RefreshDeps): Promise<RefreshReport> {
	const json = async (url: string): Promise<unknown> => {
		const response = await deps.fetch(url);
		if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
		return response.json();
	};
	const versions = (await json(`${DATA_DRAGON_BASE}/api/versions.json`)) as string[];
	const version = versions[0];
	const generated = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
	// Sorted, so "the first N" is the same N on every run.
	const ids = options.all ? Object.keys(((await json(`${DATA_DRAGON_BASE}/cdn/${version}/data/en_US/champion.json`)) as { data?: object })?.data ?? {}).sort() : options.ids;
	if (!ids.length) throw new Error(`Data Dragon ${version} lists no champions`);
	const current = (card: ChampionCard | undefined) => card?.meta.version === version && (!deps.build || card.coaching !== undefined);

	const report: RefreshReport = { version, built: [], skipped: [], failed: [], notReached: [], spent: { worker: noUsage(), jevTokens: 0 } };
	let attempted = 0;
	for (const id of ids) {
		const previous = deps.load(id);
		if (options.all && current(previous)) {
			report.skipped.push(id);
			deps.log(`${id}: skipped, its card is current for ${version}`);
			continue;
		}
		if (options.limit !== undefined && attempted >= options.limit) {
			report.notReached.push(id);
			continue;
		}
		attempted++;
		// Taken once per card, on the way out of a build or a failure: what a failed build spent is spent all the same.
		let taken: Spent | undefined;
		const take = () => (taken ??= deps.spent());
		const started = Date.now();
		try {
			const card = cardFromDataDragon(await json(`${DATA_DRAGON_BASE}/cdn/${version}/data/en_US/champion/${id}.json`), id, version, generated);
			if (deps.build) {
				const { card: built, stats } = await deps.build(card);
				deps.save(built);
				const spent = take();
				deps.log(`${id}: coaching ${stats.kept} kept, ${stats.dropped.length} dropped of ${stats.candidates} (${Math.round((100 * stats.dropped.length) / Math.max(1, stats.candidates))}%), ${stats.sources} sources, ${Math.round((Date.now() - started) / 1000)} s, ${usageText(spent.worker)}, screen withheld ${stats.withheldPages} pages (${stats.unscreenedPages} unscreened), Jev ${stats.jevClaims} claims, ${spent.jevTokens} input tokens incl. screen`);
			} else {
				// A coaching layer built on an older patch is not carried onto newer facts: it is rebuilt with --coaching.
				const carried = previous?.coaching && previous.meta.version === version ? { ...card, meta: { ...card.meta, model: previous.meta.model, sources: previous.meta.sources }, coaching: previous.coaching } : card;
				deps.save(parseChampionCard(carried, id));
				deps.log(`${id}: wrote card for ${version} (${card.facts.spells.length} spells)`);
			}
			report.built.push(id);
		} catch (error) {
			const reason = (error as Error).message;
			logEvent("warn", "refresh-champion-kb", "card-failed", { id }, error);
			report.failed.push({ id, reason });
			const spent = take();
			deps.log(`${id}: kept previous card, ${reason}${spent.worker.runs ? ` (${usageText(spent.worker)})` : ""}`);
		} finally {
			const spent = take();
			report.spent = { worker: addUsage(report.spent.worker, spent.worker), jevTokens: report.spent.jevTokens + spent.jevTokens };
		}
	}

	deps.log(`refreshed on Data Dragon ${version}: ${report.built.length} built, ${report.skipped.length} skipped, ${report.failed.length} failed${report.notReached.length ? `, ${report.notReached.length} not reached (--limit ${options.limit}): ${report.notReached.join(", ")}` : ""}`);
	for (const { id, reason } of report.failed) deps.log(`failed ${id}: ${reason}`);
	if (deps.build) deps.log(`spent by every card, failed ones too: ${usageText(report.spent.worker)}, Jev ${report.spent.jevTokens} input tokens incl. screen`);
	return report;
}

const USAGE = "usage: bun run src/lab/refresh-champion-kb.ts [--coaching] [--limit N] (--all | <DataDragonId> [...])";

export function parseRefreshArgs(args: string[]): RefreshOptions {
	const options: RefreshOptions = { ids: [], all: false, coaching: false };
	for (let at = 0; at < args.length; at++) {
		const arg = args[at];
		if (arg === "--coaching") options.coaching = true;
		else if (arg === "--all") options.all = true;
		else if (arg === "--limit" || arg.startsWith("--limit=")) {
			const raw = arg === "--limit" ? args[++at] : arg.slice("--limit=".length);
			const limit = Number(raw);
			if (!raw || !Number.isInteger(limit) || limit < 1) throw new Error(`--limit takes a whole number of champions, 1 or more (got ${raw ?? "nothing"})\n${USAGE}`);
			options.limit = limit;
		} else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}\n${USAGE}`);
		else options.ids.push(arg);
	}
	if (options.all && options.ids.length) throw new Error(`--all takes the list from Data Dragon: do not name champions as well\n${USAGE}`);
	if (!options.all && !options.ids.length) throw new Error(USAGE);
	return options;
}

async function main() {
	const options = parseRefreshArgs(process.argv.slice(2));
	let build: RefreshDeps["build"];
	let research: ReturnType<typeof createResearchService>;
	let measured: ReturnType<typeof measureWorker> | undefined;
	// Jev's input tokens since the last `spent` call: the judge's and the screen's.
	let jevTokens = 0;
	if (options.coaching) {
		const agentDir = join(realCoachHome(), "pi-agent");
		const environment = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
		const worker = createPiWorker({ ...environment, HOME: join(agentDir, "home") }, { entry: findOnPath("pi", process.env.PATH), execPath: findOnPath("node", process.env.PATH) });
		research = createResearchService(environment);
		if (!worker || !research) throw new Error("--coaching needs pi, node, and uv on PATH (or VOXREN_RESEARCH_URL for the research service)");
		// One counting worker for the whole run: the builder's distils and the hosted searches it starts go through it alike.
		const counted = (measured = measureWorker(worker));
		const real = new GroundingJudge({ apiKey: typesafeKey() });
		const judge = { async judge(...call: Parameters<GroundingJudge["judge"]>) { const result = await real.judge(...call); if (result.status === "judged") jevTokens += result.inputTokens; return result; } };
		const realScreen = new PassageJudge({ apiKey: typesafeKey() });
		const screen = { async judge(...call: Parameters<PassageJudge["judge"]>) { const result = await realScreen.judge(...call); if (result.status === "judged") jevTokens += result.inputTokens; return result; } };
		const model = workerModel(environment, "standard").model;
		build = (card) => buildChampionCoaching({ research: research!, worker: counted.worker, judge, screen, hostedSearch: createHostedSearch(counted.worker), model, log: (line) => console.log(line) }, card);
	}
	try {
		await refreshChampions(options, {
			fetch: (url) => fetch(url),
			load: (id) => loadChampionCard(id),
			save: (card) => writeFileSync(join(CHAMPION_CARDS_DIR, `${card.id}.json`), `${JSON.stringify(card, null, "\t")}\n`),
			build,
			spent: () => {
				const spent = { worker: measured?.take() ?? noUsage(), jevTokens };
				jevTokens = 0;
				return spent;
			},
			log: (line) => console.log(line),
		});
	} finally {
		await research?.close();
	}
}

if (import.meta.main) await main();
