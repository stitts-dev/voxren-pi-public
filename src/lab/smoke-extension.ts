/**
 * The smoke lab's extension, loaded by smoke-coach.mjs in place of src/index.ts: the same coach, but the model is Pi's faux
 * provider playing a cassette's turns and the research gateway answers from the cassette's tool results. Nothing leaves the
 * machine: every non-loopback fetch or socket is refused and written to VOXREN_SMOKE_NET_LOG.
 *
 *   VOXREN_SMOKE_CASSETTE  the cassette to replay (none: a coach with no model turns, for the /flow stories)
 *   VOXREN_SMOKE_DDRAGON   the Data Dragon cache folder (read only; VOXREN_SMOKE_WARM=1 fills it), VOXREN_SMOKE_ICON_MISS the file a miss is listed in
 *   VOXREN_SMOKE_TPS       streamed tokens per second (default 400)
 */
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COACH_MODELS, DEFAULT_PROVIDER } from "../contracts";
import { installVoxrenCoach } from "../index";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { blockNetwork } from "./offline.ts";
import { createCassetteGateway, readCassette, type Cassette } from "./cassette";

/** One recorded turn as the faux model's reply: thinking, then text, then its tool calls. */
export function turnMessages(cassette: Cassette) {
	return cassette.turns.map((turn) =>
		fauxAssistantMessage([...turn.thinking.map(fauxThinking), ...(turn.text ? [fauxText(turn.text)] : []), ...turn.calls.map((call) => fauxToolCall(call.name, call.args as never))], { stopReason: turn.calls.length ? "toolUse" : "stop" }),
	);
}

/** Champion name to key, recorded once with the cassettes (smoke.ts `record`). */
const CHAMPION_IDS = JSON.parse(readFileSync(new URL("../../data/lab/cassettes/champions.json", import.meta.url), "utf8")) as Record<string, number>;

const DD_HOST = "ddragon.leagueoflegends.com";
const DD_DIR = process.env.VOXREN_SMOKE_DDRAGON;
const realFetch = globalThis.fetch;

/**
 * Data Dragon for a replay, from a read-only cache folder (VOXREN_SMOKE_DDRAGON: the same paths the CDN serves, written only by
 * `just smoke --warm`, VOXREN_SMOKE_WARM=1, which fetches a miss once and keeps it). The coach's own home is never touched.
 * Without a file: the version list and champion list recorded beside the cassettes (names for the draft commands); any other
 * miss (an icon, an item list) answers 404 and is written to VOXREN_SMOKE_ICON_MISS, so the story is marked and never passes silently.
 */
export async function dataDragonCache(url: string): Promise<Response | undefined> {
	const target = new URL(url);
	if (target.hostname !== DD_HOST) return undefined;
	const file = DD_DIR ? join(DD_DIR, normalize(target.pathname).replace(/^(\.\.[/\\])+/, "")) : undefined;
	if (file && existsSync(file)) return new Response(readFileSync(file));
	if (file && process.env.VOXREN_SMOKE_WARM === "1") {
		const live = await realFetch(url);
		if (live.ok) {
			const body = Buffer.from(await live.arrayBuffer());
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, body);
			return new Response(body);
		}
	}
	const fixture = dataDragonFixture(url);
	if (fixture) return fixture;
	if (process.env.VOXREN_SMOKE_ICON_MISS) appendFileSync(process.env.VOXREN_SMOKE_ICON_MISS, `${target.pathname}\n`);
	return new Response("not cached", { status: 404 });
}

/** The recorded fallback: a version list and the champion names, so a draft command reads names with no cache at all. */
export function dataDragonFixture(url: string): Response | undefined {
	if (url.endsWith("/api/versions.json")) return Response.json(["0.0.0"]);
	if (/\/cdn\/[^/]+\/data\/en_US\/champion\.json$/.test(url)) return Response.json({ data: Object.fromEntries(Object.entries(CHAMPION_IDS).map(([name, key]) => [name, { key: String(key), name }])) });
	return undefined;
}

const wait = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((done) => {
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
	});

export default function smokeCoach(pi: ExtensionAPI) {
	blockNetwork(process.env.VOXREN_SMOKE_NET_LOG, dataDragonCache, process.env.VOXREN_SMOKE_WARM !== "1");
	const path = process.env.VOXREN_SMOKE_CASSETTE;
	const cassette: Cassette = path ? readCassette(path) : { id: "none", turns: [], tools: [] };
	// The coach's own provider name and models, so its gates, its tool list, and its footer read as in a live run.
	const faux = fauxProvider({
		provider: DEFAULT_PROVIDER,
		models: COACH_MODELS.map((id) => ({ id, reasoning: true, contextWindow: 272000 })),
		tokensPerSecond: Number(process.env.VOXREN_SMOKE_TPS ?? 400),
	});
	faux.setResponses(turnMessages(cassette));
	pi.registerProvider(faux.provider);
	const gateway = createCassetteGateway(cassette, wait, DD_DIR && existsSync(join(DD_DIR, "api", "versions.json")) ? { version: (JSON.parse(readFileSync(join(DD_DIR, "api", "versions.json"), "utf8")) as string[])[0], base: `https://${DD_HOST}` } : undefined);
	installVoxrenCoach(pi, process.env, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, (() => gateway) as never);
}
