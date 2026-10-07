/**
 * Draft lab: replays champ selects and live games through the real `/comp` command, so a prompt or composer
 * change is judged on the same drafts every time instead of waiting for the next real game.
 *
 *   bun run src/lab/draft-lab.ts [scenario ...] [--command comp|draft|pick] [--at final|auto|all] [--minutes 5,14,25]
 *                                [--models a,b] [--n 1] [--parallel 3] [--coach <other checkout>/bin/coach.mjs] [--out <dir>]
 *
 * --at auto keeps the draft frames the automatic calls fire on (/pick on a settled hover or lock, /draft once four enemies
 * have locked), found by running the coach's own trigger over the draft, and runs the command that fires there, not --command.
 * Every draft is also written to <out>/timelines/<name>.ndjson: `VOXREN_LCU_REPLAY=<that file> coach` plays it as a
 * fake client, pick by pick, so the footer and auto /draft run exactly as in a real champ select. The setup
 * gate flags a setup-row item with neither an OP.GG citation nor a named threat (coach.yaml's own contract
 * for the row) — an unexplained pick, not merely one OP.GG doesn't mention (F3, docs/comp-lab.md).
 *
 * A scenario is a draft (`data/lab/drafts/*.json`, expanded pick by pick in draft order), a recorded client file
 * (`coach` with VOXREN_LCU_RECORD=<file>), or a Live Client Data dump (one allgamedata per line). No scenario
 * runs every draft in data/lab/drafts. Each run gets its own coach home (keys copied, Pi sign-in shared), so lab
 * sessions never land in the real session picker. Writes <out>/results.ndjson and <out>/report.md.
 * A lab, not a test: never under `bun test`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Exchange } from "../exchange-log";
import { labHome, labRunId } from "./lab-home";
import { championIds, dataDragon, draftFrames, type Draft, type Frame } from "./drafts";
import { runeNames, runeNamesIn, scoredSetupRow } from "./setup-row";
import { setupThreatMismatch } from "./setup-threat";
import { createAutoComp, type AutoCall } from "../index";
import { isBuildFormatLine } from "../build-lines";
import { knownNames, loadKnownNames } from "../icons";
import { pageBacked, setupSwaps, type ResolveName } from "../setup-swaps";
import { computeLcuFooterState, parseFrames, replaySource, settlePick, type LcuFrame, type LcuFooterState } from "../lcu";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const DRAFTS = join(REPO, "data", "lab", "drafts");
const RUN_TIMEOUT_MS = 240_000;

/** Marks the frames the automatic calls fire on, and which command, by running the coach's own footer settling and trigger over them in order, idle throughout. */
async function markAutoFires(frames: Frame[]): Promise<void> {
	let fired: AutoCall | undefined;
	const trigger = createAutoComp((call) => (fired = call));
	let state: LcuFooterState | undefined;
	for (const entry of frames) {
		const source = replaySource(entry.frame);
		state = settlePick(state, await computeLcuFooterState(source.discover, source.makeClient));
		fired = undefined;
		trigger(state, true);
		entry.autoFires = fired;
	}
}

function args() {
	const argv = process.argv.slice(2);
	const flag = (name: string) => {
		const index = argv.indexOf(name);
		return index >= 0 ? argv.splice(index, 2)[1] : undefined;
	};
	const list = (value?: string) => value?.split(",").map((item) => item.trim()).filter(Boolean);
	const parsed = {
		command: flag("--command") ?? "comp",
		at: flag("--at") ?? "final",
		minutes: list(flag("--minutes"))?.map(Number) ?? [5, 14, 25],
		models: list(flag("--models")) ?? [""],
		n: Number(flag("--n") ?? 1),
		parallel: Number(flag("--parallel") ?? 3),
		coach: flag("--coach") ?? join(REPO, "bin", "coach.mjs"),
		out: flag("--out") ?? join(tmpdir(), "voxren-draft-lab", new Date().toISOString().replace(/[:.]/g, "-")),
	};
	const scenarios = argv.length ? argv : readdirSync(DRAFTS).filter((file) => file.endsWith(".json")).map((file) => join(DRAFTS, file));
	return { ...parsed, scenarios };
}

/** Every purchasable item on Summoner's Rift: name (longest first, so "Zhonya's Hourglass" wins over a shorter
 * overlap) plus its Data Dragon description, for `setupThreatMismatch` below. */
async function itemCatalog(): Promise<{ names: string[]; descriptions: Map<string, string> }> {
	const data = await dataDragon<{ data: Record<string, { name: string; description: string; gold?: { purchasable?: boolean }; maps?: Record<string, boolean> }> }>("item.json");
	const items = Object.values(data.data).filter((item) => item.gold?.purchasable && item.maps?.["11"]);
	const descriptions = new Map(items.map((item) => [item.name, item.description]));
	const names = [...new Set(items.map((item) => item.name))].sort((a, b) => b.length - a.length);
	return { names, descriptions };
}


/** Every rune name in Data Dragon's runesReforged.json, for `runeNamesIn` (rule 5: no rune-name constants in code). */
async function runeCatalog(): Promise<string[]> {
	return runeNames(await dataDragon<Parameters<typeof runeNames>[0]>("runesReforged.json"));
}

/** Live frames nearest each requested minute; enemies are the champions not on the active player's team. */
function liveFrames(frames: LcuFrame[], minutes: number[]): Frame[] {
	const parsed = frames.map((frame) => ({ frame, json: JSON.parse(frame.body) }));
	return minutes.map((minute) => {
		const nearest = parsed.reduce((best, entry) => (Math.abs((entry.json.gameData?.gameTime ?? 0) - minute * 60) < Math.abs((best.json.gameData?.gameTime ?? 0) - minute * 60) ? entry : best));
		const me = nearest.json.activePlayer?.riotIdGameName;
		const myTeam = nearest.json.allPlayers?.find((player: { riotIdGameName?: string }) => player.riotIdGameName === me)?.team;
		const enemies = (nearest.json.allPlayers ?? []).filter((player: { team?: string }) => player.team !== myTeam).map((player: { championName: string }) => player.championName);
		return { label: `${Math.round((nearest.json.gameData?.gameTime ?? 0) / 60)}m`, frame: nearest.frame, enemies };
	});
}

function runCoach(coach: string, command: string, home: string, framesFile: string, model: string): Promise<Exchange | undefined> {
	const env = { ...process.env, VOXREN_COACH_HOME: home, VOXREN_LCU_REPLAY: framesFile, ...(model ? { VOXREN_COACH_MODEL: model } : {}) };
	return new Promise((resolve) => {
		const child = spawn("node", [coach, "-p", `/${command}`], { env, stdio: ["ignore", "ignore", "pipe"], timeout: RUN_TIMEOUT_MS });
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", () => {
			const log = join(home, "exchanges.ndjson");
			if (!existsSync(log)) {
				console.error(`  no exchange (${stderr.trim().split("\n").at(-1) ?? "no output"})`);
				return resolve(undefined);
			}
			resolve(JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!) as Exchange);
		});
	});
}

// ponytail: string rules, not a judge. They catch the failures seen in real /comp answers (hedged roles, a champ-select
// "no one is ahead" row, enemies never named, leaked evidence ids); quality beyond that is read in report.md, or
// graded by Jev's answer rubric (`just stories`). Row-1-is-a-team-plan and "could a teammate act on row 1" stay human/judge calls.
const ROLE_HEDGES = /unconfirmed|unverified|unknown|not (yet )?(listed|confirmed|known)|no one is ahead|no levels/gi;
// coach.yaml: "never write grounded, unsupported, unverified, or a source id in an answer row" (line 61) plus the
// no-links rule (coach.yaml:31). Bold is no longer a leak: the /comp prompt now asks for it (one word or phrase
// per row) and Pi's TUI markdown renderer turns it into real ANSI bold, not literal asterisks.
const LEAKS = /\[[^\]]+\]\([^)]+\)|⟦[^⟧]*⟧/g;
const EMPHASIS = /\*\*[^*]+\*\*|(?<!\*)\*[^*]+\*(?!\*)/g;
// F3 (docs/comp-lab.md): the /comp prompt's own contract for the setup row is "name the enemy damage
// type or threat it answers", not "cite OP.GG" — a row naming one of these is a counter-pick judgment
// call, verifiable against game_facts item text, not a grounding claim that needs an OP.GG citation.
const THREATS = /magic damage|physical damage|true damage|crowd control|suppress|knock-?up|\bstun|\broot|\bsnare|\bsilence|\bcharm|\bfear|\btaunt|\bblind|polymorph|\bslow|tenacity|cleanse|\bdisable|lockdown|\bburst|\bdive|\bengage/i;
// "one call of 16 words or fewer" (the /comp, /draft, and /pick prompts in coach.yaml): a row with 3+ sentences is
// carrying more than one call, whether or not it starts with a bullet marker.
const LONG_ROW_WORDS = 16;
const sentences = (row: string) => (row.match(/[.!?](?:\s|$)/g) ?? []).length;

function score(answer: string, enemies: string[], exchange: Exchange | undefined, items: string[], descriptions: Map<string, string>, runes: string[], command: string, resolve?: ResolveName) {
	const lower = answer.toLowerCase();
	const rows = answer.trim().split(/\n+/).filter(Boolean);
	// The setup row is the one labelled "Setup:": /pick can end on a Dodge row. An answer with no such row has none to score
	// under /pick (its prompt labels every row); /comp and /draft answers are not guaranteed a label, and theirs is the last row.
	// Its items must appear in some OP.GG result the run fetched.
	// Models write curly apostrophes ("Zhonya’s"); Data Dragon and OP.GG write straight ones.
	const setup = scoredSetupRow(rows, command).replaceAll("’", "'");
	const named: string[] = [];
	let rest = setup;
	for (const item of items) {
		if (!rest.includes(item)) continue;
		named.push(item);
		rest = rest.replaceAll(item, "");
	}
	const meta = JSON.stringify((exchange?.tools ?? []).filter((tool) => tool.name === "voxren_meta_research").map((tool) => tool.result));
	// #367: the Setup-row gate (src/setup-swaps.ts) run on a /pick answer's row: each swap's verdict, and whether the kept ones
	// name a target the turn's voxren_meta_research result mentions (measured only; the render gate does not enforce it).
	const swaps = command === "pick" && setup ? setupSwaps(setup.replace(/^[\s\-*•]*\**setup\**\s*:\**\s*/i, ""), resolve) : [];
	return {
		setupSwapVerdicts: swaps.map((swap) => swap.verdict),
		setupSwapsPageBacked: swaps.filter((swap) => swap.verdict === "ok" && pageBacked(swap, meta)).length,
		roleHedges: (answer.match(ROLE_HEDGES) ?? []).length,
		enemiesNamed: enemies.length ? enemies.filter((name) => lower.includes(name.toLowerCase())).length / enemies.length : 1,
		words: answer.split(/\s+/).filter(Boolean).length,
		// Flag only an item with neither an OP.GG citation nor a named threat: that's unexplained, not
		// grounded and not a counter-pick judgment either. A named threat is the prompt's own contract
		// for this row (coach.yaml), so it clears the item even when OP.GG never mentions it (F3).
		setupUngrounded: THREATS.test(setup) ? [] : named.filter((item) => !meta.includes(item)),
		// F1 (docs/comp-lab.md): A1 only checks that a threat is named, never that it's the right one —
		// this catches one concrete, checkable case: a cleanse item claimed to remove a threat its own
		// tooltip excludes (e.g. "Quicksilver Sash removes Wukong's knockup").
		setupThreatMismatch: named.filter((item) => setupThreatMismatch(item, descriptions.get(item) ?? "", setup)),
		// /pick's setup row gives the divergence from the matchup page (one or two changes): a row naming a whole rune page is
		// listing the page. Rune names come from Data Dragon; stat shards are not in that file and are not counted.
		setupRunes: runeNamesIn(setup, runes),
		// A build row names a purchasable item; the rule (coach.yaml, /comp prompt) is at most one. /draft's Build and Swap lines
		// (the build format) are build rows by design.
		buildRows: rows.filter((row) => items.some((item) => row.replaceAll("’", "'").includes(item))).length,
		leaks: (answer.match(LEAKS) ?? []).length,
		rows: rows.length,
		proseRows: rows.filter((row) => sentences(row) >= 3).length,
		// 16 words or fewer per /comp, /draft, and /pick row (their prompts in coach.yaml): a row past 16 is not one call. /draft's
		// build-format lines (Runes, Build, Skills, Swap: coach.yaml <build>) list a whole page and path, so they have no cap.
		longRows: rows.filter((row) => !isBuildFormatLine(row) && row.split(/\s+/).filter(Boolean).length > LONG_ROW_WORDS).length,
		// /draft and /pick rows open with their label ("Lane: ...", "Matchup: ..."): a row without one is off the format.
		unlabelledRows: rows.filter((row) => !/^[^:]{1,24}: \S/.test(row)).length,
		emphasis: (answer.match(EMPHASIS) ?? []).length,
	};
}

async function pool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
	const results: T[] = [];
	let next = 0;
	await Promise.all(Array.from({ length: size }, async () => {
		while (next < tasks.length) {
			const index = next++;
			results[index] = await tasks[index]();
		}
	}));
	return results;
}

async function main() {
	const opts = args();
	mkdirSync(opts.out, { recursive: true });
	const ids = opts.scenarios.some((file) => file.endsWith(".json")) ? await championIds() : new Map<string, number>();
	const { names: items, descriptions } = await itemCatalog();
	const runes = await runeCatalog();
	// The names the render gate resolves against: Data Dragon's runes, summoner spells and items, and data/stat-shards.json.
	const versions = (await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json()) as string[];
	await loadKnownNames(versions[0], "https://ddragon.leagueoflegends.com", fetch, 30_000);
	const resolve = knownNames();
	const cases: { scenario: string; notes?: string; frame: Frame; command?: string }[] = [];
	for (const file of opts.scenarios) {
		const scenario = basename(file).replace(/\.(nd)?json$/, "");
		if (file.endsWith(".json")) {
			const draft = JSON.parse(readFileSync(file, "utf8")) as Draft;
			const frames = draftFrames(draft, ids, { hover: true });
			await markAutoFires(frames);
			// The whole draft as a fake client: VOXREN_LCU_REPLAY=<this file> coach plays it pick by pick.
			mkdirSync(join(opts.out, "timelines"), { recursive: true });
			writeFileSync(join(opts.out, "timelines", `${scenario}.ndjson`), frames.map((frame) => JSON.stringify(frame.frame)).join("\n") + "\n");
			const picked = opts.at === "all" ? frames : opts.at === "auto" ? frames.filter((frame) => frame.autoFires) : frames.slice(-1);
			for (const frame of picked) cases.push({ scenario, notes: draft.notes, frame, ...(opts.at === "auto" && frame.autoFires && { command: frame.autoFires }) });
			continue;
		}
		const frames = parseFrames(readFileSync(file, "utf8"));
		const drafts = frames.filter((frame) => frame.path === "/lol-champ-select/v1/session");
		const live = frames.filter((frame) => frame.path === "/liveclientdata/allgamedata");
		const lastDraft = drafts.at(-1);
		if (lastDraft) for (const frame of opts.at === "all" ? drafts : [lastDraft]) cases.push({ scenario, frame: { label: frame === lastDraft ? "final" : frame.ts ?? "draft", frame, enemies: [] } });
		if (live.length) for (const frame of liveFrames(live, opts.minutes)) cases.push({ scenario, frame });
	}

	const tasks = cases.flatMap((entry, caseIndex) =>
		opts.models.flatMap((model) =>
			Array.from({ length: opts.n }, (_, rep) => async () => {
				const id = labRunId(caseIndex, entry.scenario, entry.frame.label, model, rep);
				const framesFile = join(opts.out, "frames", `${caseIndex}.ndjson`);
				mkdirSync(join(opts.out, "frames"), { recursive: true });
				writeFileSync(framesFile, `${JSON.stringify(entry.frame.frame)}\n`);
				console.error(`run ${id}`);
				const command = entry.command ?? opts.command;
				const exchange = await runCoach(opts.coach, command, labHome(join(opts.out, "homes", id)), framesFile, model);
				const answer = exchange?.answer ?? "";
				return {
					id,
					scenario: entry.scenario,
					at: entry.frame.label,
					model: exchange?.model?.id ?? model,
					notes: entry.notes,
					prompt: exchange?.prompt,
					answer,
					ms: exchange?.ms,
					costUsd: exchange?.usage.costUsd,
					tools: exchange?.tools.map((tool) => tool.name),
					...score(answer, entry.frame.enemies, exchange, items, descriptions, runes, command, resolve),
					command,
				};
			}),
		),
	);
	const results = await pool(tasks, opts.parallel);

	writeFileSync(join(opts.out, "results.ndjson"), results.map((result) => JSON.stringify(result)).join("\n") + "\n");

	// Per-lane means, n>=1 per scenario is noise (issue #30): read this next to the run count per model.
	const byModel = new Map<string, typeof results>();
	for (const result of results) byModel.set(result.model, [...(byModel.get(result.model) ?? []), result]);
	const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
	const summary = ["| model | n | rows | roleHedges | build rows | leaks | prose rows | long rows | unlabelled rows | emphasis | enemies named | setup runes | words | s | $ |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
	for (const [model, runs] of byModel)
		summary.push(
			`| ${model} | ${runs.length} | ${mean(runs.map((r) => r.rows)).toFixed(1)} | ${mean(runs.map((r) => r.roleHedges)).toFixed(1)} | ${mean(runs.map((r) => r.buildRows)).toFixed(1)} | ${mean(runs.map((r) => r.leaks)).toFixed(1)} | ${mean(runs.map((r) => r.proseRows)).toFixed(1)} | ${mean(runs.map((r) => r.longRows)).toFixed(1)} | ${mean(runs.map((r) => r.unlabelledRows)).toFixed(1)} | ${mean(runs.map((r) => r.emphasis)).toFixed(1)} | ${Math.round(mean(runs.map((r) => r.enemiesNamed)) * 100)}% | ${mean(runs.map((r) => r.setupRunes.length)).toFixed(1)} | ${Math.round(mean(runs.map((r) => r.words)))} | ${mean(runs.map((r) => (r.ms ?? 0) / 1000)).toFixed(1)} | ${mean(runs.map((r) => r.costUsd ?? 0)).toFixed(3)} |`,
		);

	const table = ["| scenario | at | command | model | rows | roleHedges | build rows | leaks | prose rows | long rows | unlabelled rows | emphasis | enemies named | setup runes | setup unexplained | setup wrong | words | tools | s | $ |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
	for (const result of results)
		table.push(
			`| ${result.scenario} | ${result.at} | ${result.command} | ${result.model} | ${result.rows} | ${result.roleHedges} | ${result.buildRows} | ${result.leaks} | ${result.proseRows} | ${result.longRows} | ${result.unlabelledRows} | ${result.emphasis} | ${Math.round(result.enemiesNamed * 100)}% | ${result.setupRunes.length} | ${result.setupUngrounded.join(", ") || "-"} | ${result.setupThreatMismatch.join(", ") || "-"} | ${result.words} | ${result.tools?.length ?? 0} | ${((result.ms ?? 0) / 1000).toFixed(1)} | ${(result.costUsd ?? 0).toFixed(3)} |`,
		);
	const answers = results.map((result) => [`## ${result.id}`, result.notes ? `> ${result.notes}` : "", "```", result.prompt ?? "(no run)", "```", result.answer || "(no answer)"].filter(Boolean).join("\n\n"));
	writeFileSync(join(opts.out, "report.md"), [`# Draft lab`, "## By lane", summary.join("\n"), "## By run", table.join("\n"), ...answers].join("\n\n") + "\n");
	const verdicts = results.flatMap((result) => result.setupSwapVerdicts);
	const count = (verdict: string) => verdicts.filter((v) => v === verdict).length;
	if (verdicts.length || results.some((result) => result.command === "pick"))
		console.log(`setup gate: ${results.length} runs, ${results.filter((result) => !result.setupSwapVerdicts.length).length} with no swap row, swaps ok ${count("ok")} / same ${count("same")} / unknown-target ${count("unknown-target")} / unparsed ${count("unparsed")}, ok swaps page-backed ${results.reduce((n, result) => n + result.setupSwapsPageBacked, 0)}\n`);
	console.log(summary.join("\n"));
	console.log(`\n${table.join("\n")}`);
	console.log(`\n${join(opts.out, "report.md")}`);
}

await main();
