import { readFileSync } from "node:fs";
import { logEvent } from "./coach-log";

/**
 * Stat shards by Riot perk id (data/stat-shards.json): match-v5 and OP.GG both report a shard as its id, and a name the
 * coach writes must come from here, never from the model's memory of the ids (it once wrote "Health" for 5001, Health
 * Scaling).
 */
function load(): Record<string, { name: string; icon: string }> {
	try {
		return JSON.parse(readFileSync(new URL("../data/stat-shards.json", import.meta.url), "utf8")).shards ?? {};
	} catch (error) {
		logEvent("warn", "stat-shards", "unreadable", undefined, error);
		return {};
	}
}
const SHARDS = load();

/** A shard id (number or numeric string) as its name; a name passes through; an id the file lacks reads "shard <id>". */
export function statShardName(value: unknown): string {
	if (typeof value === "string" && !/^\d+$/.test(value)) return value;
	return SHARDS[String(value)]?.name ?? `shard ${String(value)}`;
}

/** Shard name -> its icon file under Data Dragon's perk-images/StatMods. */
export const STAT_SHARD_ICONS: Record<string, string> = Object.fromEntries(Object.values(SHARDS).map((shard) => [shard.name, shard.icon]));
