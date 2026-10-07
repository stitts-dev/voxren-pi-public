/**
 * Matchup note lab: builds notes by hand, outside a coach session, and prints every source and every dropped row with
 * its reason. The coach builds the same notes itself the first time a matchup is looked up (src/live-gateway.ts); this
 * is for looking at what a build keeps and why.
 *
 *   bun run src/lab/refresh-matchup-notes.ts Fizz Ahri [Zed ...] [--out <dir>]
 *
 * Writes <coach home>/matchups/<champion>-<opponent>.json, or into --out. Needs `pi`, `node`, and `uv` on PATH, the
 * coach signed in, and TYPESAFE_API_KEY in the coach home .env (read by name, never printed). Never loaded by the coach.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GroundingJudge } from "../grounding-judge";
import { PassageJudge } from "../passage-judge";
import { createHostedSearch } from "../hosted-search";
import { matchupNoteFile, saveMatchupNote } from "../matchup-note";
import { buildMatchupNote, currentNames } from "../matchup-note-build";
import { createPiWorker } from "../pi-worker";
import { createResearchService, findOnPath } from "../research-service";
import { realCoachHome } from "./lab-home";

const DATA_DRAGON_BASE = "https://ddragon.leagueoflegends.com";

export function typesafeKey(): string {
	const line = readFileSync(join(realCoachHome(), ".env"), "utf8").split("\n").find((entry) => entry.startsWith("TYPESAFE_API_KEY="));
	const key = line?.slice("TYPESAFE_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
	if (!key) throw new Error("TYPESAFE_API_KEY is not in the coach home .env");
	return key;
}

async function json(url: string): Promise<any> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	return response.json();
}

/** Data Dragon's current names, in the shape the gateway's own loader hands the builder. */
export async function gameNames(): Promise<{ version: string; names: string[] }> {
	const version = ((await json(`${DATA_DRAGON_BASE}/api/versions.json`)) as string[])[0];
	const locale = `${DATA_DRAGON_BASE}/cdn/${version}/data/en_US`;
	const [items, runes, summoners] = await Promise.all([json(`${locale}/item.json`), json(`${locale}/runesReforged.json`), json(`${locale}/summoner.json`)]);
	const runeNames: Record<number, string> = {};
	for (const tree of Array.isArray(runes) ? runes : []) {
		runeNames[tree.id] = String(tree.name);
		for (const slot of tree.slots ?? []) for (const rune of slot.runes ?? []) runeNames[rune.id] = String(rune.name);
	}
	const summonerNames: Record<number, string> = {};
	for (const spell of Object.values(summoners?.data ?? {}) as any[]) summonerNames[Number(spell.key)] = String(spell.name);
	return { version, names: currentNames(items?.data ?? {}, runeNames, summonerNames) };
}

async function main() {
	const args = process.argv.slice(2);
	const out = args.includes("--out") ? args.splice(args.indexOf("--out"), 2)[1] : join(realCoachHome(), "matchups");
	const [champion, ...opponents] = args;
	if (!champion || !opponents.length || !out) throw new Error("usage: bun run src/lab/refresh-matchup-notes.ts <Champion> <Opponent> [<Opponent> ...] [--out <dir>]");
	// The lab is not a Pi run: it names Pi and Node itself, and points the worker and the service at the coach's own home.
	const agentDir = join(realCoachHome(), "pi-agent");
	const environment = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
	const worker = createPiWorker({ ...environment, HOME: join(agentDir, "home") }, { entry: findOnPath("pi", process.env.PATH), execPath: findOnPath("node", process.env.PATH) });
	const research = createResearchService(environment);
	if (!worker || !research) throw new Error("the lab needs pi, node, and uv on PATH (or VOXREN_RESEARCH_URL for the research service)");
	const apiKey = typesafeKey();
	const judge = new GroundingJudge({ apiKey });
	const passageJudge = new PassageJudge({ apiKey });
	const names = await gameNames();
	try {
		for (const opponent of opponents) {
			const started = Date.now();
			console.log(`${champion} into ${opponent}`);
			try {
				const note = await buildMatchupNote({ research, worker, judge, passageJudge, hostedSearch: createHostedSearch(worker), gameNames: async () => names, log: (line) => console.log(line) }, champion, opponent);
				saveMatchupNote(out, note);
				const authors = new Set(note.sources.map((entry) => entry.author)).size;
				for (const row of note.rows) console.log(`  ${row.authors} of ${authors}  ${row.kind.padEnd(5)} ${row.text}`);
				console.log(`  wrote ${join(out, matchupNoteFile(champion, opponent))}: ${note.rows.length} rows from ${note.sources.length} sources (${Math.round((Date.now() - started) / 1000)} s)`);
			} catch (error) {
				console.log(`  no note written, ${(error as Error).message.slice(0, 200)}`);
			}
		}
	} finally {
		await research.close();
	}
}

if (import.meta.main) await main();
