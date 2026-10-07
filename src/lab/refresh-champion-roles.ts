/**
 * Champion-roles refresh lab: regenerates data/championRoles.json from two public, no-credential
 * sources — Riot Data Dragon (the current champion list: id + name) and OP.GG's public MCP
 * (`lol_list_lane_meta_champions`, the same tier_list tool src/live-gateway.ts calls), queried once
 * per lane. OP.GG reports each champion's `role_rate`: the share of that champion's games played in
 * that one lane. Taking `role_rate` from whichever of the five lane queries mention a champion is the
 * per-lane play-rate row primaryLane/laneRate read from the checked-in file — no math invented here.
 *
 *   bun run src/lab/refresh-champion-roles.ts
 *
 * Never wired into the coach runtime; run by hand when a patch ships new champions or a real role
 * shift, then commit the regenerated data/championRoles.json. A champion missing from every lane
 * query this run keeps its previous row (reported on stdout as a fallback, not invented); a champion
 * with neither new data nor a previous row is left out of the file (reported as dropped).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { publicPatch } from "../audit-metrics";

const DATA_DRAGON_BASE = "https://ddragon.leagueoflegends.com";
const OPGG_MCP_URL = "https://mcp-api.op.gg/mcp";
const OUT_PATH = fileURLToPath(new URL("../../data/championRoles.json", import.meta.url));

interface LaneRow {
	top: number;
	jungle: number;
	middle: number;
	bottom: number;
	support: number;
}

/** OP.GG's `position` argument and response class name for each championRoles.json lane key (src/lcu.ts's LANE_KEYS, reversed). */
const LANES: ReadonlyArray<{ position: string; className: string; lane: keyof LaneRow }> = [
	{ position: "top", className: "Top", lane: "top" },
	{ position: "jungle", className: "Jungle", lane: "jungle" },
	{ position: "mid", className: "Mid", lane: "middle" },
	{ position: "adc", className: "Adc", lane: "bottom" },
	{ position: "support", className: "Support", lane: "support" },
];

async function fetchChampionList(): Promise<{ version: string; champions: Array<{ id: string; name: string }> }> {
	const versions = (await (await fetch(`${DATA_DRAGON_BASE}/api/versions.json`)).json()) as unknown;
	const version = Array.isArray(versions) ? String(versions[0] ?? "") : "";
	if (!version) throw new Error("Data Dragon /api/versions.json returned no version");
	const payload = (await (await fetch(`${DATA_DRAGON_BASE}/cdn/${version}/data/en_US/champion.json`)).json()) as { data?: Record<string, { key?: string; name?: string }> };
	const entries = Object.values(payload.data ?? {});
	const champions = entries.filter((entry) => entry.key && entry.name).map((entry) => ({ id: String(entry.key), name: String(entry.name) }));
	if (!champions.length) throw new Error("Data Dragon champion.json returned no champions");
	return { version, champions };
}

/** Splits one `Class(...)` argument list on top-level commas; safe here because no field in this response ever contains a quoted comma or paren. */
function splitArgs(raw: string): string[] {
	const parts: string[] = [];
	let current = "";
	let inQuotes = false;
	for (const ch of raw) {
		if (ch === '"') inQuotes = !inQuotes;
		if (ch === "," && !inQuotes) {
			parts.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	parts.push(current.trim());
	return parts;
}

function unquote(value: string): string {
	return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\"/g, '"') : value;
}

/**
 * OP.GG's tier_list tool returns a compact class-literal, not JSON: a `class <Name>: field,field,...`
 * header per level, then `<Name>("champion",play,role_rate)` tuples (field order can vary with the
 * request's desired_output_fields, so it is read from the header rather than assumed).
 */
function laneRoleRates(text: string, className: string): Map<string, number> {
	const header = new RegExp(`class ${className}:\\s*([^\\n]+)`).exec(text);
	if (!header) throw new Error(`OP.GG tier_list response has no "${className}" field list`);
	const fields = header[1].split(",").map((field) => field.trim());
	const championIndex = fields.indexOf("champion");
	const rateIndex = fields.indexOf("role_rate");
	if (championIndex < 0 || rateIndex < 0) throw new Error(`OP.GG tier_list response for ${className} is missing champion/role_rate (got: ${fields.join(", ")})`);
	const rates = new Map<string, number>();
	for (const match of text.matchAll(new RegExp(`${className}\\(([^)]*)\\)`, "g"))) {
		const args = splitArgs(match[1]);
		const name = unquote(args[championIndex] ?? "");
		const rate = Number(args[rateIndex]);
		if (name && Number.isFinite(rate)) rates.set(name, rate);
	}
	return rates;
}

/** One tier_list MCP call: every champion OP.GG lists for this lane, with the share of that champion's games played here. */
async function fetchLaneRoleRates(position: string, className: string): Promise<Map<string, number>> {
	const body = {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: "lol_list_lane_meta_champions", arguments: { lang: "en_US", position, desired_output_fields: [`data.positions.${position}[].{champion,role_rate,play}`] } },
	};
	const res = await fetch(OPGG_MCP_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "voxren-coach/1" }, body: JSON.stringify(body) });
	const raw = (await res.json()) as any;
	if (raw?.error || raw?.result?.isError) throw new Error(`OP.GG tier_list failed for position=${position}: ${JSON.stringify(raw?.error ?? raw?.result)}`);
	const text = (raw?.result?.content as any[] | undefined)?.find((block) => block?.type === "text")?.text;
	if (typeof text !== "string" || !text) throw new Error(`OP.GG tier_list returned no text for position=${position}`);
	return laneRoleRates(text, className);
}

async function main() {
	const previous = JSON.parse(readFileSync(OUT_PATH, "utf8")) as { roles: Record<string, LaneRow> };
	const { version, champions } = await fetchChampionList();

	const byLane = new Map<keyof LaneRow, Map<string, number>>();
	for (const entry of LANES) {
		process.stderr.write(`fetching OP.GG tier_list: position=${entry.position}\n`);
		byLane.set(entry.lane, await fetchLaneRoleRates(entry.position, entry.className));
	}
	// One empty lane would silently zero that lane for every champion; refuse to write rather than ship a hole.
	const emptyLanes = [...byLane.entries()].filter(([, rates]) => rates.size === 0).map(([lane]) => lane);
	if (emptyLanes.length) throw new Error(`OP.GG tier_list returned no usable data for ${emptyLanes.join(", ")}; nothing written`);

	const roles: Record<string, LaneRow> = {};
	const fellBack: string[] = [];
	const dropped: string[] = [];
	for (const champion of champions) {
		const row: LaneRow = { top: 0, jungle: 0, middle: 0, bottom: 0, support: 0 };
		let covered = false;
		for (const entry of LANES) {
			const rate = byLane.get(entry.lane)?.get(champion.name);
			if (rate !== undefined) {
				row[entry.lane] = rate;
				covered = true;
			}
		}
		if (covered) roles[champion.id] = row;
		else if (previous.roles[champion.id]) {
			roles[champion.id] = previous.roles[champion.id];
			fellBack.push(champion.name);
		} else dropped.push(champion.name);
	}

	const meta = {
		patch: publicPatch(version),
		generated: new Date().toISOString().slice(0, 10),
		source: "op.gg tier_list (lol_list_lane_meta_champions via the OP.GG public MCP), one query per lane; champion ids from Riot Data Dragon's champion list",
		format: "all_roles",
	};
	writeFileSync(OUT_PATH, `${JSON.stringify({ meta, roles }, null, "\t")}\n`);

	console.log(`Wrote ${Object.keys(roles).length} of ${champions.length} champions to data/championRoles.json (patch ${meta.patch}, generated ${meta.generated}).`);
	if (fellBack.length) console.log(`Fell back to the previous file's row (no OP.GG lane data this run): ${fellBack.join(", ")}`);
	if (dropped.length) console.log(`Dropped (no OP.GG data and no previous row either): ${dropped.join(", ")}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
