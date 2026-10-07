// Hand-written drafts as the League client would show them filling in: shared by the draft lab and the TUI driver.
// Imports carry .ts so node's type stripping can run this file too (src/lab/tui.ts runs under node).
import { readFileSync, writeFileSync } from "node:fs";
import type { LcuFrame } from "../lcu.ts";

const POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] as const;
const PICK_ORDER = ["ally", "enemy", "enemy", "ally", "ally", "enemy", "enemy", "ally", "ally", "enemy"] as const;

/** A draft as written by hand: champion names, the player's position, bans. Picks lock in array order. */
export interface Draft {
	name: string;
	you: (typeof POSITIONS)[number];
	myTeam: Partial<Record<(typeof POSITIONS)[number], string>>;
	theirTeam: string[];
	bans?: { yours?: string[]; theirs?: string[] };
	/** What a good answer has to get right; shown in the report next to the answers. */
	notes?: string;
}

export interface Frame {
	label: string;
	frame: LcuFrame;
	enemies: string[];
	/** Draft frames only: the automatic call that fires here (`--at auto`): /pick on a settled hover or lock, /draft once four enemies have locked. */
	autoFires?: "pick" | "draft";
}

export async function dataDragon<T>(file: string): Promise<T> {
	const versions = (await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json()) as string[];
	return (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/en_US/${file}`)).json()) as T;
}

export async function championIds(): Promise<Map<string, number>> {
	const data = await dataDragon<{ data: Record<string, { key: string; name: string }> }>("champion.json");
	const ids = new Map<string, number>();
	for (const [id, champion] of Object.entries(data.data)) {
		ids.set(id.toLowerCase(), Number(champion.key));
		ids.set(champion.name.toLowerCase(), Number(champion.key));
	}
	return ids;
}

/**
 * One session frame per completed pick, after the bans, the way the client's session endpoint shows a draft filling in.
 * `hover` adds two frames before the player's own lock with the champion hovered, the time a real player spends on it.
 */
export function draftFrames(draft: Draft, ids: Map<string, number>, options: { hover?: boolean } = {}): Frame[] {
	const id = (name: string) => {
		const found = ids.get(name.toLowerCase());
		if (!found) throw new Error(`${draft.name}: unknown champion "${name}"`);
		return found;
	};
	const allies = POSITIONS.filter((position) => draft.myTeam[position]).map((position, index) => ({ cellId: index, position, championId: id(draft.myTeam[position]!) }));
	const enemies = draft.theirTeam.map((name, index) => ({ cellId: 5 + index, championId: id(name) }));
	const self = allies.find((ally) => ally.position === draft.you);
	if (!self) throw new Error(`${draft.name}: no ${draft.you} pick for "you"`);
	const bans = [...(draft.bans?.yours ?? []).map((name) => ({ name, ally: true })), ...(draft.bans?.theirs ?? []).map((name) => ({ name, ally: false }))];
	const banActions = bans.map((ban) => ({ type: "ban", completed: true, championId: id(ban.name), isAllyAction: ban.ally }));
	const frames: Frame[] = [];
	let hovers = 0;
	const queue = { ally: [...allies], enemy: [...enemies] };
	const locked = new Set<number>();
	for (const side of PICK_ORDER) {
		const next = queue[side].shift();
		if (!next) continue;
		const hovering = options.hover && next.cellId === self.cellId;
		if (!hovering) locked.add(next.cellId);
		const session = (hover: boolean) => ({
			localPlayerCellId: self.cellId,
			myTeam: allies.map((ally) => ({ cellId: ally.cellId, assignedPosition: ally.position.toLowerCase(), championId: locked.has(ally.cellId) ? ally.championId : 0, ...(hover && ally.cellId === self.cellId && { championPickIntent: ally.championId }) })),
			theirTeam: enemies.map((enemy) => ({ cellId: enemy.cellId, assignedPosition: "", championId: locked.has(enemy.cellId) ? enemy.championId : 0 })),
			actions: [banActions],
			timer: { phase: locked.size === allies.length + enemies.length ? "FINALIZATION" : "BAN_PICK", adjustedTimeLeftInPhase: 30_000 },
		});
		if (hovering) {
			// Two reads of the same hover, the way two footer polls see it; the lock follows.
			for (let read = 0; read < 2; read++) frames.push({ label: `hover ${++hovers}`, frame: { path: "/lol-champ-select/v1/session", body: JSON.stringify(session(true)) }, enemies: draft.theirTeam.filter((_, index) => locked.has(5 + index)) });
			locked.add(next.cellId);
		}
		const enemiesLocked = draft.theirTeam.filter((_, index) => locked.has(5 + index));
		frames.push({ label: `pick ${locked.size}`, frame: { path: "/lol-champ-select/v1/session", body: JSON.stringify(session(false)) }, enemies: enemiesLocked });
	}
	frames[frames.length - 1].label = "final";
	return frames;
}

/** A hand-written draft file expanded pick by pick, the player's own pick hovered first, into a client replay file (VOXREN_LCU_REPLAY) at `out`; needs Data Dragon for the champion ids. */
export async function writeDraftReplay(draftFile: string, out: string): Promise<string> {
	const frames = draftFrames(JSON.parse(readFileSync(draftFile, "utf8")) as Draft, await championIds(), { hover: true });
	writeFileSync(out, frames.map((frame) => JSON.stringify(frame.frame)).join("\n") + "\n");
	return out;
}
