import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SECRETS } from "../riot-key-helper.mjs";

export const JEV_KEY_ENV = "TYPESAFE_API_KEY";

/** The player's coach home, where the launcher keeps keys, sessions, and Pi's sign-in. */
export function realCoachHome(): string {
	const set = process.env.VOXREN_COACH_HOME?.trim();
	if (set) return set;
	if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? "", "voxren-coach");
	if (process.platform === "linux") return join(process.env.XDG_DATA_HOME?.trim() || join(process.env.HOME ?? "", ".local", "share"), "voxren-coach");
	return join(process.env.HOME ?? "", "Library", "Application Support", "voxren-coach");
}

/**
 * A throwaway coach home for a lab run: keys and profile copied, Pi's sign-in dir linked so a token refresh lands in
 * the real one. Sessions and the exchange log stay in `dir`, so lab runs never reach the player's session picker.
 * The lab profile saves the three auto rows (draft, comp, review) OFF (the product default is on): a lab window would otherwise answer the
 * player's live champ select with a model run nobody asked for. A lab that wants them sets VOXREN_COACH_AUTO_COMP=1
 * (tui.ts --auto, a story's `env`), which beats the saved row; a story may also switch the /flow row on.
 * withoutJevKey drops the Jev key from the copy (the .env line and the typesafe store files), so the coach starts unscreened.
 */
export function labHome(dir: string, freshFlow = false, withoutJevKey = false): string {
	const real = realCoachHome();
	mkdirSync(dir, { recursive: true });
	for (const file of readdirSync(real)) if (file === ".env" || file === "profile.json" || /\.(dpapi|json)$/.test(file)) copyFileSync(join(real, file), join(dir, file));
	if (withoutJevKey) {
		const env = join(dir, ".env");
		// The same line shape bin/coach.mjs parseEnvFile reads.
		if (existsSync(env)) writeFileSync(env, readFileSync(env, "utf8").split("\n").filter((line) => !new RegExp(`^\\s*(?:export\\s+)?${JEV_KEY_ENV}\\s*=`).test(line)).join("\n"));
		for (const name of [SECRETS.typesafe.dpapiFileName, SECRETS.typesafe.stateFileName]) rmSync(join(dir, name), { force: true });
	}
	const profile = join(dir, "profile.json");
	const saved = existsSync(profile) ? JSON.parse(readFileSync(profile, "utf8")) : {};
	// "draft", "comp" and "review" are the commands with an auto row (contracts.ts AUTO_COMMAND, GAME_EVENT_COMMANDS); not imported, because tui.ts runs this file under plain node.
	// freshFlow drops the player's saved /flow settings first, so a story starts from the defaults (auto still off).
	const base = freshFlow ? {} : (saved.commands ?? {});
	saved.commands = { ...base, draft: { ...base.draft, auto: false }, comp: { ...base.comp, auto: false }, review: { ...base.review, auto: false } };
	writeFileSync(profile, `${JSON.stringify(saved, null, "\t")}\n`);
	// A repeat call on the same dir reuses it: the link is made once, not recreated (a raw EEXIST helps nobody).
	const link = join(dir, "pi-agent");
	if (!lstatSync(link, { throwIfNoEntry: false })) symlinkSync(join(real, "pi-agent"), link, "junction");
	return dir;
}

/** A run's home name. The case index keeps it unique: a live dump can map several asked minutes onto one frame, so scenario and label repeat. */
export function labRunId(caseIndex: number, scenario: string, label: string, model: string, rep: number): string {
	return `${caseIndex}-${scenario}-${label}-${model || "default"}-${rep}`.replace(/[^\w.-]+/g, "_");
}
