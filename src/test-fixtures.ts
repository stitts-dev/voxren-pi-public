import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_WORDS, primaryLane } from "./lcu";

const IDS: Record<string, number> = JSON.parse(readFileSync(join(import.meta.dir, "..", "data", "lab", "fixtures", "champion-ids.json"), "utf8")).ids;

/**
 * `championLane` without Data Dragon: the name maps to an id through the fixture file, and the lane comes from
 * the same `primaryLane` and `LANE_WORDS` the live lookup uses. A name not in the file gets no lane, like a miss.
 */
export async function fixtureLaneLookup(name: string): Promise<string | undefined> {
	const key = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
	const id = Object.entries(IDS).find(([champion]) => champion.toLowerCase() === key)?.[1];
	const lane = id ? primaryLane(id) : undefined;
	return lane ? LANE_WORDS[lane] : undefined;
}

/** Every champion in the fixture file, by id, as `readComposition` wants the names (what Data Dragon's champion.json gives it live). */
export const FIXTURE_CHAMPION_NAMES: ReadonlyMap<number, string> = new Map(Object.entries(IDS).map(([name, id]) => [id, name]));

/** The fixture file's name to id map in the shape the draft lab's `draftFrames` takes. */
export const FIXTURE_CHAMPION_IDS: Map<string, number> = new Map(Object.entries(IDS).map(([name, id]) => [name.toLowerCase(), id]));
