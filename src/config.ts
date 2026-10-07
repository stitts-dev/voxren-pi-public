import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	SettingsList,
	Text,
	decodeKittyPrintable,
	matchesKey,
	type Component,
	type SettingItem,
} from "@earendil-works/pi-tui";
import { COACH_COMMANDS, DEFAULT_THEME, type CommandSettings } from "./contracts";
import { logEvent, raiseNotice } from "./coach-log";
import { coachHomePath } from "./exchange-log";
import { parseKeySourceTag, resolveKeySource, type KeySourceResult, type KeySourceTag } from "./key-source";
import { loadChampionNames, type ChampionNames } from "./lcu";
import { learningsFilePath, loadLearnings, resetLearnings, summarizeLearnings } from "./learnings-store";
import { RIOT_ID_PATTERN, parseAuditAccounts } from "./live-gateway";
import { ConfirmView, SecretKeyPanel, settingsTheme, type RiotKeyCustodian, type RiotKeyNotice, type RiotKeyState, type SecretId } from "./riot-key";
import { researchServiceMode } from "./research-service";
import { wrapLines, type UiTheme } from "./ui";

/**
 * The persisted coach profile: theme, default champion, and remembered Riot IDs, all otherwise sourced from
 * env vars read once at launch. Plain JSON at `<coach home>/profile.json`; a corrupt or missing file falls
 * back to defaults, never throws (see loadProfile). Sanitization mirrors sanitizeRiotKeyState (src/riot-key.ts).
 */
export type ThemeName = "tidal" | "hextech" | "void" | "signal";
export interface RiotIdsProfile {
	primary?: string;
	known: string[];
}
export interface Profile {
	theme?: ThemeName;
	champion?: string;
	riotIds: RiotIdsProfile;
	/** Global player-learnings memory switch (issue #33 stage 5); undefined/false means on. Off stops stage 2/3 writes and stage 4 recall, but never deletes existing files. */
	learningsOff?: boolean;
	/** Per-command settings saved from the /flow tree, keyed by command name; absent when none is set. */
	commands?: Record<string, CommandSettings>;
}

const THEME_NAMES: readonly ThemeName[] = ["tidal", "hextech", "void", "signal"];
const MAX_CHAMPION_CHARS = 64;
const MAX_RIOT_ID_CHARS = 64;
const MAX_DEFAULT_ARGS_CHARS = 100;
// ponytail: fixed cap, no eviction policy — add trim-oldest only if a real profile is ever seen near it.
const MAX_KNOWN_IDS = 20;
const UNSET_CHAMPION = "detected from game";

/** Permissive per-field sanitizer: an invalid or unknown field is dropped silently, never thrown on. */
export function sanitizeProfile(raw: unknown): Profile {
	const profile: Profile = { riotIds: { known: [] } };
	if (!raw || typeof raw !== "object") return profile;
	const record = raw as Record<string, any>;

	if (THEME_NAMES.includes(record.theme)) profile.theme = record.theme;

	if (typeof record.champion === "string") {
		const champion = record.champion.trim();
		if (champion.length > 0 && champion.length <= MAX_CHAMPION_CHARS) profile.champion = champion;
	}

	const riotIds = record.riotIds && typeof record.riotIds === "object" ? record.riotIds : {};
	if (typeof riotIds.primary === "string" && RIOT_ID_PATTERN.test(riotIds.primary)) profile.riotIds.primary = riotIds.primary;

	const knownRaw = Array.isArray(riotIds.known) ? riotIds.known : [];
	const seen = new Set<string>();
	for (const entry of knownRaw) {
		if (profile.riotIds.known.length >= MAX_KNOWN_IDS) break;
		if (typeof entry !== "string" || !RIOT_ID_PATTERN.test(entry)) continue;
		const key = entry.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		profile.riotIds.known.push(entry);
	}

	if (typeof record.learningsOff === "boolean") profile.learningsOff = record.learningsOff;

	const commands = sanitizeCommandSettings(record.commands);
	if (Object.keys(commands).length) profile.commands = commands;

	return profile;
}

/**
 * The /flow tree's per-command settings: a default argument on a command that saves one and that its own parser takes,
 * auto on /draft. Auto is saved on or off, because absence means the default (on); an empty args setting is absence.
 */
function sanitizeCommandSettings(raw: unknown): Record<string, CommandSettings> {
	const out: Record<string, CommandSettings> = {};
	if (!raw || typeof raw !== "object") return out;
	for (const command of COACH_COMMANDS) {
		const entry = (raw as Record<string, any>)[command.name];
		if (!entry || typeof entry !== "object") continue;
		const settings: CommandSettings = {};
		const args = typeof entry.args === "string" ? entry.args.trim() : "";
		if (command.savesDefault && args && args.length <= MAX_DEFAULT_ARGS_CHARS && !hasControlChars(args) && command.acceptsArgs(args)) settings.args = args;
		if (command.autoRuns && typeof entry.auto === "boolean") settings.auto = entry.auto;
		if (Object.keys(settings).length) out[command.name] = settings;
	}
	return out;
}

/**
 * Saves one command's settings from the /flow tree: re-reads the profile so a /config edit is never lost, and returns
 * every command's settings for the live session, or undefined when the command refuses the value (nothing is written).
 */
export function saveCommandSettings(path: string | undefined, name: string, next: CommandSettings): Record<string, CommandSettings> | undefined {
	let refused = false;
	const { profile } = updateProfile(path, (current) => {
		const commands = sanitizeCommandSettings({ ...current.commands, [name]: next });
		const kept = commands[name];
		if ((next.args?.trim() && kept?.args === undefined) || (next.auto !== undefined && kept?.auto !== next.auto)) {
			refused = true;
			return current;
		}
		const { commands: _old, ...rest } = current;
		return Object.keys(commands).length ? { ...rest, commands } : rest;
	});
	return refused ? undefined : (profile.commands ?? {});
}

/** `<coach home>/profile.json`; undefined outside a launch, same as every other coach-home path. */
export function profilePath(environment: Record<string, string | undefined>): string | undefined {
	return coachHomePath(environment, "profile.json");
}

/**
 * The file's parsed JSON object, or undefined when there is none to read (no path, missing), or null when the file is unreadable and could not be moved aside. A file that is there but
 * is not a JSON object is a hand-edit typo: it is moved aside whole as `<name>.bad-<time>`, so the next save cannot
 * overwrite it, and a header notice says where it went. Never throws.
 */
function readProfileFile(path: string | undefined): Record<string, unknown> | null | undefined {
	if (!path) return undefined;
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		// ENOENT (no profile saved yet) is routine; logged anyway since this runs once per launch, never a poll.
		const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
		logEvent(missing ? "info" : "warn", "config", "profile-load-failed", { path }, error);
		return undefined;
	}
	let parseError: unknown;
	try {
		const raw = JSON.parse(text);
		if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
		parseError = new Error("profile.json is not a JSON object");
	} catch (error) {
		parseError = error;
	}
	return keepUnreadableProfile(path, parseError) ? undefined : null;
}

/** True when the file is out of the way; false when it is still there, unreadable (a save must then refuse). */
function keepUnreadableProfile(path: string, error: unknown): boolean {
	const kept = `${path}.bad-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	try {
		renameSync(path, kept);
		raiseNotice("profile-unreadable", "warn", `${basename(path)} could not be read, so defaults are in use. Your file is kept as ${basename(kept)}.`, "config", "profile-unreadable", { path, kept }, error);
		return true;
	} catch (renameError) {
		raiseNotice("profile-unreadable", "warn", `${basename(path)} could not be read and could not be moved aside. Fix or remove it by hand.`, "config", "profile-unreadable", { path }, renameError);
		return false;
	}
}

/** Never throws: an undefined path, a missing file, or unparsable JSON all yield the same sanitized default. */
export function loadProfile(path: string | undefined): Profile {
	return sanitizeProfile(readProfileFile(path) ?? undefined);
}

export interface ProfileUpdate {
	/** What the file holds after the update, or what it held if the write failed. */
	profile: Profile;
	/** Why the write failed; absent when nothing needed writing or the write landed. */
	failure?: string;
}

const OWNED_FIELDS = ["theme", "champion", "riotIds", "learningsOff"] as const;
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The one way to change the profile (panel, LCU sign-in, /flow): re-reads the file now, applies `change` to what is
 * there, and writes back only the fields and commands `change` altered. Every other byte-level field stays as the file
 * has it, so an edit from another window, or a field a newer version wrote, is never lost. Writes nothing when
 * `change` altered nothing.
 */
export function updateProfile(path: string | undefined, change: (profile: Profile) => Profile): ProfileUpdate {
	const read = readProfileFile(path);
	const raw = read ?? {};
	const fresh = sanitizeProfile(raw);
	const next = change(fresh);
	if (!path) return { profile: next };
	if (read === null) return { profile: fresh, failure: "profile.json is unreadable and could not be moved aside" };
	const out: Record<string, unknown> = { ...raw };
	let changed = false;
	for (const key of OWNED_FIELDS) {
		if (sameValue(fresh[key], next[key])) continue;
		changed = true;
		if (next[key] === undefined) delete out[key];
		else out[key] = next[key];
	}
	if (!sameValue(fresh.commands, next.commands)) {
		changed = true;
		const commands: Record<string, unknown> = raw.commands && typeof raw.commands === "object" ? { ...(raw.commands as object) } : {};
		for (const { name } of COACH_COMMANDS) {
			if (sameValue(fresh.commands?.[name], next.commands?.[name])) continue;
			if (next.commands?.[name]) commands[name] = next.commands[name];
			else delete commands[name];
		}
		if (Object.keys(commands).length) out.commands = commands;
		else delete out.commands;
	}
	if (!changed) return { profile: fresh };
	const failure = writeProfileFile(path, out);
	return failure ? { profile: fresh, failure } : { profile: sanitizeProfile(out) };
}

/**
 * Undefined path is a silent no-op. Otherwise write-then-rename through a temp name no other window shares (pid plus
 * random), like saveOtpReference (src/otp-reference.ts). Never throws: returns undefined on success, the reason otherwise,
 * so a caller never shows a value as saved when the write failed.
 */
export function saveProfile(path: string | undefined, profile: Profile): string | undefined {
	return writeProfileFile(path, profile);
}

function writeProfileFile(path: string | undefined, profile: object): string | undefined {
	if (!path) return undefined;
	const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temp, `${JSON.stringify(profile, null, "\t")}\n`);
		renameSync(temp, path);
		return undefined;
	} catch (error) {
		logEvent("warn", "config", "profile-save-failed", { path }, error);
		try {
			rmSync(temp, { force: true });
		} catch (cleanupError) {
			logEvent("warn", "config", "profile-temp-cleanup-failed", { temp }, cleanupError);
		}
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * The one function every accounts-list consumer calls, so LCU > primary > known > env precedence can't drift
 * between call sites. Case-insensitively deduped, keeping the first (highest-precedence) occurrence.
 */
export function resolveKnownAccounts(signedIn: string | undefined, profile: Profile, envAccounts: string[]): string[] {
	const candidates = [signedIn, profile.riotIds.primary, ...profile.riotIds.known, ...envAccounts];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const key = candidate.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(candidate);
	}
	return result;
}

/**
 * Records a Riot ID the LCU reported as signed in. Pure and case-insensitive: a no-op (undefined) if the id is
 * already known, otherwise appends it and sets primary only if this is the first known id.
 */
export function applyLcuSignIn(profile: Profile, riotId: string): Profile | undefined {
	const known = profile.riotIds.known;
	if (known.some((id) => id.toLowerCase() === riotId.toLowerCase())) return undefined;
	return {
		...profile,
		riotIds: {
			primary: profile.riotIds.primary ?? riotId,
			known: [...known, riotId],
		},
	};
}

/** Marks an already-known id primary; a no-op copy otherwise (the panel only ever offers this for a known id). */
export function setPrimaryRiotId(profile: Profile, id: string): Profile {
	if (!profile.riotIds.known.includes(id)) return profile;
	return { ...profile, riotIds: { ...profile.riotIds, primary: id } };
}

/**
 * Removes a known id. Removing the current primary promotes the next known entry (array order,
 * i.e. the oldest remaining); removing the last known id clears primary.
 */
export function removeRiotId(profile: Profile, id: string): Profile {
	const known = profile.riotIds.known.filter((entry) => entry !== id);
	const primary = profile.riotIds.primary === id ? known[0] : profile.riotIds.primary;
	return { ...profile, riotIds: { primary, known } };
}

/** The live config fields a /config panel save touches; a structural subset of CoachConfig so this module never imports src/index.ts. */
export interface ProfileConfigTarget {
	champion?: string;
	accounts: string[];
	labels: { accounts: string[] };
	learningsOff: boolean;
}

/**
 * Applies a /config panel change to the profile as it is now on disk and updates the live config in place, so every setting except theme's
 * next-launch default takes effect with no restart. `config.labels` is mutated, never reassigned: installCoachSurface's
 * header/footer closures captured that object reference at session_start. `invalidateLane` runs only when the
 * champion actually changed, so an unrelated save (theme, a Riot ID) never restarts an in-flight lane lookup.
 */
export function applyProfileChange(config: ProfileConfigTarget, invalidateLane: () => void, environment: Record<string, string | undefined>, change: (profile: Profile) => Profile): ProfileUpdate {
	const update = updateProfile(profilePath(environment), change);
	if (update.failure) return update;
	const next = update.profile;
	const champion = environment.VOXREN_COACH_CHAMPION?.trim() || next.champion;
	const championChanged = champion !== config.champion;
	config.champion = champion;
	config.accounts = resolveKnownAccounts(undefined, next, parseAuditAccounts(environment.VOXREN_COACH_ACCOUNTS));
	config.labels.accounts = config.accounts;
	config.learningsOff = next.learningsOff ?? false;
	if (championChanged) invalidateLane();
	return update;
}

// --- /config panel: theme (live preview) and champion --------------------------

export const CONFIG_COMMAND = "config";
export const CONFIG_COMMAND_DESCRIPTION = "Coach settings: theme (live preview), default champion, Riot IDs, and API keys, saved to your profile and the system key store";
export const CONFIG_NO_ARGS_MESSAGE = "/config takes no arguments. Open it bare and use the panel.";
export const CONFIG_TUI_ONLY_MESSAGE = "/config needs the interactive TUI.";

/** VOXREN_COACH_THEME (env) > the saved profile's theme > coach.yaml's default — the same precedence bin/coach.mjs applies at launch. */
function activeTheme(environment: Record<string, string | undefined>, profile: Profile): ThemeName {
	const envTheme = environment.VOXREN_COACH_THEME?.trim();
	if (THEME_NAMES.includes(envTheme as ThemeName)) return envTheme as ThemeName;
	return profile.theme ?? (DEFAULT_THEME as ThemeName);
}

/** The Riot IDs row's one-line summary: the primary (if any) plus a count, or "none". */
function riotIdsSummary(profile: Profile): string {
	const count = profile.riotIds.known.length;
	if (count === 0) return "none";
	return profile.riotIds.primary ? `${profile.riotIds.primary} · ${count} known` : `${count} known`;
}

/** The Learnings row's one-line value: "on" unless the player turned memory off. */
function learningsRowValue(profile: Profile): string {
	return profile.learningsOff ? "off" : "on";
}

// --- Keys row: Riot / Perplexity / Typesafe / Gemini, generalized from RiotKeyPanel (src/riot-key.ts) -----

/** One row's fixed identity: only Perplexity/Typesafe/Gemini have an env/`.env` tier (see src/key-source.ts's module doc). */
interface SecretRowSpec {
	id: SecretId;
	label: string;
	envSourceVar?: string;
}
const SECRET_ROWS: readonly SecretRowSpec[] = [
	{ id: "riot", label: "Riot" },
	{ id: "perplexity", label: "Perplexity", envSourceVar: "VOXREN_KEY_SOURCE_PERPLEXITY" },
	{ id: "typesafe", label: "Typesafe", envSourceVar: "VOXREN_KEY_SOURCE_TYPESAFE" },
	{ id: "gemini", label: "Gemini", envSourceVar: "VOXREN_KEY_SOURCE_GEMINI" },
];

/**
 * One row's live data: `envTag` is read once from `VOXREN_KEY_SOURCE_<NAME>` by createConfigSession
 * (the only place environment lives), `custodian`/`state` come from createSecretCustodian and its
 * `status()` the same way createRiotKeySession already does for /riot-key. `state` mutates in place
 * as the Keys submenu runs actions, matching riotIdsSubmenu's exit-to-top convention below.
 */
export interface SecretRowInit {
	id: SecretId;
	label: string;
	custodian?: RiotKeyCustodian;
	state: RiotKeyState;
	envTag?: KeySourceTag;
	/** Why this launch never reads a stored key (Perplexity and Gemini reach only the research service the coach starts); undefined when it is read. */
	unused?: string;
}

function keySourceResultFor(row: SecretRowInit): KeySourceResult {
	return resolveKeySource({ envTag: row.envTag, stored: row.state.stored });
}

/** The Keys submenu's one-clause-per-row label: the same four states index.ts's header shadow note names. */
function keySourceLabel(row: SecretRowInit): string {
	const { source, active, shadowsStore } = keySourceResultFor(row);
	if (!active) return "not stored";
	const used = source === "store" ? "stored" : shadowsStore ? `${source === "env" ? "env" : ".env"} (shadowing a stored key)` : source === "env" ? "env" : ".env";
	return row.unused ? `${used}, unused: ${row.unused}` : used;
}

/** The top-level Keys row's summary: how many of the secrets have a usable value anywhere. */
function keysSummary(secrets: readonly SecretRowInit[]): string {
	const active = secrets.filter((row) => keySourceResultFor(row).active && !row.unused).length;
	return `${active} of ${secrets.length} active`;
}

function keyStoreUnavailableMessage(label: string): string {
	return `${label} key store is unavailable in this launch (no key store configured).`;
}

/** A static-lines dead-end for a secret with no custodian, mirroring riot-key.ts's own (unexported) LinesView. */
class MessageView implements Component {
	constructor(
		private readonly theme: UiTheme,
		private readonly lines: string[],
		private readonly close: () => void,
	) {}
	handleInput(data: string): void {
		if (matchesKey(data, "return") || matchesKey(data, "escape") || data === "\n" || data === "\r") this.close();
	}
	invalidate(): void {}
	render(width: number): string[] {
		return wrapLines([...this.lines, this.theme.fg("dim", "Enter/Esc back")], width, "  ");
	}
}

function hasControlChars(text: string): boolean {
	return [...text].some((ch) => {
		const code = ch.charCodeAt(0);
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
	});
}

/**
 * Unmasked sibling of MaskedKeyInput (src/riot-key.ts): identical key handling (paste, backspace,
 * ctrl+u, decodeKittyPrintable), a visible buffer instead of a mask. Empty-Enter (after trimming)
 * is a no-op that keeps the field open, matching MaskedKeyInput's own guard. The one typed field left in
 * /config, because a Riot ID has no list to pick from.
 */
export class TextFieldInput implements Component {
	private buffer: string;
	private pasteBuffer = "";
	private inPaste = false;
	onSubmit?: (value: string) => void;
	onCancel?: () => void;

	constructor(
		private readonly theme: UiTheme,
		private readonly label: string,
		initialValue = "",
		private readonly maxChars = MAX_RIOT_ID_CHARS,
	) {
		this.buffer = initialValue.slice(0, maxChars);
	}

	handleInput(data: string): void {
		if (data.includes("\x1b[200~")) {
			this.inPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}
		if (this.inPaste) {
			this.pasteBuffer += data;
			const end = this.pasteBuffer.indexOf("\x1b[201~");
			if (end === -1) return;
			this.append(this.pasteBuffer.slice(0, end));
			const remaining = this.pasteBuffer.slice(end + 6);
			this.inPaste = false;
			this.pasteBuffer = "";
			if (remaining) this.handleInput(remaining);
			return;
		}
		if (matchesKey(data, "escape")) {
			this.onCancel?.();
			return;
		}
		if (matchesKey(data, "return") || data === "\n" || data === "\r") {
			if (this.buffer.trim().length === 0) return;
			this.onSubmit?.(this.buffer.trim());
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.buffer = this.buffer.slice(0, -1);
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			this.buffer = "";
			return;
		}
		const kitty = decodeKittyPrintable(data);
		if (kitty !== undefined) {
			this.append(kitty);
			return;
		}
		if (!hasControlChars(data)) this.append(data);
	}

	private append(text: string): void {
		const clean = [...text.replace(/\r\n|\r|\n|\t/g, "")].filter((ch) => !hasControlChars(ch)).join("");
		this.buffer = (this.buffer + clean).slice(0, this.maxChars);
	}

	hasValue(): boolean {
		return this.buffer.length > 0;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const field = this.hasValue() ? t.fg("accent", this.buffer) : t.fg("dim", `type a ${this.label}`);
		return wrapLines([t.bold(t.fg("accent", this.label)), `${t.fg("accent", "> ")}${field}`, t.fg("dim", "Enter save · Esc cancel · ctrl+u clear")], width, "  ");
	}
}

/**
 * The Riot IDs row's list. Up/Down move between the known ids and a last "+ Add Riot ID" row. Right marks the id under
 * the cursor primary. Left twice removes it (the first Left arms it and says so, any other key disarms): removing the
 * primary promotes the next id. Enter on the last row opens the one typed field in /config, since an id has no list to
 * pick from; it must match Name#TAG or it stays open with the reason. Esc goes back. Every change saves at once.
 */
class RiotIdsView implements Component {
	private selected = 0;
	private armed: string | undefined;
	private adding: TextFieldInput | undefined;
	private error: string | undefined;

	constructor(
		private readonly theme: UiTheme,
		private readonly read: () => Profile,
		private readonly commit: (change: (profile: Profile) => Profile) => boolean,
		private readonly close: () => void,
	) {}

	handleInput(data: string): void {
		if (this.adding) return this.adding.handleInput(data);
		const known = this.read().riotIds.known;
		const id = known[this.selected];
		const armed = this.armed;
		this.armed = undefined;
		if (matchesKey(data, "escape")) return this.close();
		if (matchesKey(data, "up")) this.selected = (this.selected + known.length) % (known.length + 1);
		else if (matchesKey(data, "down")) this.selected = (this.selected + 1) % (known.length + 1);
		else if (matchesKey(data, "right") && id) this.commit((p) => setPrimaryRiotId(p, id));
		else if (matchesKey(data, "left") && id) {
			if (armed === id) this.commit((p) => removeRiotId(p, id));
			else this.armed = id;
			this.selected = Math.min(this.selected, this.read().riotIds.known.length);
		} else if (!id && (matchesKey(data, "return") || data === "\n" || data === "\r")) this.startAdd();
	}

	private startAdd(): void {
		const field = new TextFieldInput(this.theme, "Riot ID");
		field.onCancel = () => {
			this.adding = undefined;
			this.error = undefined;
		};
		field.onSubmit = (value) => {
			if (!RIOT_ID_PATTERN.test(value)) {
				this.error = "Not a Riot ID: it is a name, a #, and a tag, like Name#TAG.";
				return;
			}
			if (this.commit((p) => applyLcuSignIn(p, value) ?? p)) {
				this.adding = undefined;
				this.error = undefined;
				this.selected = Math.max(0, this.read().riotIds.known.findIndex((known) => known.toLowerCase() === value.toLowerCase()));
			}
		};
		this.adding = field;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		if (this.adding) return [...this.adding.render(width), ...(this.error ? wrapLines([t.fg("error", this.error)], width, "  ") : [])];
		const { known, primary } = this.read().riotIds;
		const rows = known.map((id, index) => {
			const value = this.armed === id ? t.fg("warning", "Left again to remove") : id === primary ? t.fg("accent", "primary") : t.fg("dim", "known");
			return `${index === this.selected ? t.fg("accent", "> ") : "  "}${id}  ${value}`;
		});
		rows.push(`${this.selected === known.length ? t.fg("accent", "> ") : "  "}+ Add Riot ID`);
		return wrapLines([t.bold(t.fg("accent", "Riot IDs")), ...rows, "", t.fg("dim", "Up/Down move · Right primary · Left twice remove · Enter adds · Esc back")], width, "  ");
	}
}

export interface ConfigPanelHooks {
	setTheme(name: ThemeName): void;
	/** Applies a change to the profile as it is on disk now; the result says what the file holds and why a write failed. */
	onSave(change: (profile: Profile) => Profile): ProfileUpdate;
	/** Every Data Dragon champion name, fetched the first time the champion row is stepped. Absent: the row cannot be stepped. */
	loadChampions?(): Promise<string[]>;
	requestRender(): void;
	done(): void;
	/** A Keys-row store/test/remove notice (SecretKeyPanel's own hook shape); optional so every
	 * pre-Keys caller (this file's own panelHarness-style tests included) needs no change. */
	onNotice?(notice: RiotKeyNotice): void;
	/** A Keys-row state change, so session chrome outside the panel (the Riot header and renewal widget) follows it. */
	onSecretState?(id: SecretId, state: RiotKeyState): void;
}

/**
 * `/config`: a Pi-settings-style panel for the persisted profile. The theme, champion and Riot IDs rows change with
 * arrows only (Left/Right step the value and save at once); Up/Down move between rows. The champion row shows the live
 * resolved champion (`initialChampion`, `config.champion`: env > profile > coach.yaml default), not the raw
 * `profile.champion` field, which is often unset.
 */
export class ConfigPanel extends Container {
	private readonly list: SettingsList;
	private profile: Profile;
	private champion: string | undefined;
	private themeNow: ThemeName;
	private championNames: string[] | undefined;
	private loadingChampions = false;
	private readonly status = new Text("", 1, 0);
	private readonly secrets: SecretRowInit[];

	constructor(
		private readonly theme: UiTheme,
		initialProfile: Profile,
		initialTheme: ThemeName,
		initialChampion: string | undefined,
		private readonly hooks: ConfigPanelHooks,
		// Defaults to every secret unavailable (no key store), so every existing caller that
		// predates the Keys row -- this file's own panelHarness included -- needs no change.
		initialSecrets: SecretRowInit[] = SECRET_ROWS.map((row) => ({ id: row.id, label: row.label, state: { stored: false } })),
		// The learnings directory ("<coach home>/learnings"), resolved once by createConfigSession the
		// same way it resolves everything else from environment; undefined for every pre-Learnings-row
		// caller (this file's own panelHarness included), which just means every id's file path is
		// undefined too, and loadLearnings/resetLearnings already treat that as a no-op.
		private readonly learningsDir?: string,
		// Accounts the coach uses this launch (signed-in, profile, VOXREN_COACH_ACCOUNTS): an audit writes learnings
		// for any of them, so each needs a Learnings row even when the profile never saved it.
		private readonly learningsAccounts: string[] = [],
	) {
		super();
		this.profile = initialProfile;
		this.champion = initialChampion;
		this.themeNow = initialTheme;
		this.secrets = initialSecrets;
		const items: SettingItem[] = [
			{
				id: "theme",
				label: "Theme",
				description: "Left/Right changes it, previews it live, and saves it at once for future launches.",
				currentValue: initialTheme,
			},
			{
				id: "champion",
				label: "Champion",
				description: "Left/Right picks the default champion for every command and the system prompt, saved at once. \"detected from game\" detects it from the live game or your question instead.",
				currentValue: this.champion ?? UNSET_CHAMPION,
			},
			{
				id: "riotIds",
				label: "Riot IDs",
				description: "Enter opens the list: Right marks an id primary, Left twice removes it, and the last row types a new Name#TAG. The League client's signed-in account is added on its own.",
				currentValue: riotIdsSummary(this.profile),
				submenu: (_current, done) => this.riotIdsSubmenu(done),
			},
			{
				id: "keys",
				label: "Keys",
				description: "Riot, Perplexity, Typesafe, Gemini: store (hidden input), live test, status, or remove each key.",
				currentValue: keysSummary(this.secrets),
				submenu: (_current, done) => this.keysSubmenu(done),
			},
			{
				id: "learnings",
				label: "Learnings",
				description: "Memory on/off, plus a per-Riot-ID summary and reset. Off stops new writes and recall; it never deletes what's already saved.",
				currentValue: learningsRowValue(this.profile),
				submenu: (_current, done) => this.learningsSubmenu(done),
			},
		];
		this.list = new SettingsList(items, items.length, settingsTheme(theme), () => {}, () => hooks.done());
		const accent = (text: string) => theme.fg("accent", text);
		this.addChild(new DynamicBorder(accent));
		this.addChild(new Text(`${theme.bold(accent("Coach settings"))} ${theme.fg("muted", "· /config")}`, 1, 0));
		this.addChild(this.list);
		this.addChild(this.status);
		this.addChild(new DynamicBorder(accent));
	}

	/**
	 * Left/Right on the theme and champion rows step their values; nothing else on those rows does anything (no Enter, no
	 * typing). The row under the cursor is read from SettingsList, which has no accessor for it: a private field, so a
	 * pi-tui change that renames it makes the arrows do nothing and the panel tests fail.
	 */
	handleInput(data: string): void {
		const list = this.list as unknown as { selectedIndex: number; submenuComponent: unknown };
		const step = matchesKey(data, "right") ? 1 : matchesKey(data, "left") ? -1 : 0;
		if (step && !list.submenuComponent) {
			if (list.selectedIndex === 0) return this.stepTheme(step);
			if (list.selectedIndex === 1) return this.stepChampion(step);
		}
		this.list.handleInput(data);
	}

	private commit(change: (profile: Profile) => Profile, id: string, valueOf: (profile: Profile) => string): boolean {
		const { profile, failure } = this.hooks.onSave(change);
		if (failure) {
			const text = `Not saved: ${failure}`;
			this.status.setText(this.theme.fg("error", text));
			this.hooks.onNotice?.({ level: "error", text });
		} else {
			this.profile = profile;
			this.list.updateValue(id, valueOf(profile));
			this.status.setText("");
		}
		this.hooks.requestRender();
		return !failure;
	}

	/** One step through the four themes, wrapping: previewed through setTheme, saved at once, and put back if the save fails. */
	private stepTheme(step: number): void {
		const previous = this.themeNow;
		const name = THEME_NAMES[(Math.max(0, THEME_NAMES.indexOf(previous)) + step + THEME_NAMES.length) % THEME_NAMES.length];
		this.hooks.setTheme(name);
		if (this.commit((p) => ({ ...p, theme: name }), "theme", () => name)) this.themeNow = name;
		else this.hooks.setTheme(previous);
	}

	/**
	 * One step through "detected from game" and every Data Dragon champion, alphabetical, wrapping through the unset
	 * state. The list loads on the first step, which lands once it arrives; a typo cannot be saved because nothing is typed.
	 */
	private stepChampion(step: number): void {
		const names = this.championNames;
		if (!names) {
			if (this.loadingChampions) return;
			if (!this.hooks.loadChampions) return this.status.setText(this.theme.fg("error", "No champion list is available."));
			this.loadingChampions = true;
			this.status.setText(this.theme.fg("dim", "Loading champions..."));
			this.hooks.requestRender();
			void this.hooks
				.loadChampions()
				.then((list) => {
					this.championNames = [...new Set(list)].sort((a, b) => a.localeCompare(b));
					this.status.setText("");
				})
				.catch((error) => {
					logEvent("warn", "config", "champion-list-failed", undefined, error);
					this.status.setText(this.theme.fg("error", "Could not load the champion list. Data Dragon is unreachable."));
				})
				.then(() => {
					this.loadingChampions = false;
					if (this.championNames?.length) this.stepChampion(step);
					else this.hooks.requestRender();
				});
			return;
		}
		const cycle = ["", ...names];
		const at = Math.max(0, cycle.indexOf(this.champion ?? ""));
		const champion = cycle[(at + step + cycle.length) % cycle.length] || undefined;
		if (this.commit((p) => ({ ...p, champion }), "champion", () => champion ?? UNSET_CHAMPION)) this.champion = champion;
	}

	private commitRiotIds(change: (profile: Profile) => Profile): boolean {
		return this.commit(change, "riotIds", riotIdsSummary);
	}

	/** The Riot IDs list: arrows change primary and remove an id, and only a new id is typed. `exit` is the top-level list's own done. */
	private riotIdsSubmenu(exit: () => void): Component {
		return new RiotIdsView(
			this.theme,
			() => this.profile,
			(change) => this.commitRiotIds(change),
			() => exit(),
		);
	}

	/**
	 * A nested SettingsList, one row per secret (Riot, Perplexity, Typesafe, Gemini), each opening
	 * SecretKeyPanel's own four-action submenu (src/riot-key.ts) via secretRowSubmenu. `exit` is the
	 * top-level list's own done, same convention as riotIdsSubmenu above: a store/test/remove changes
	 * this row's label, so returning straight to the top row -- rebuilt fresh next open -- is simpler
	 * than threading a live update through nested lists and can never show a stale label.
	 */
	private keysSubmenu(exit: () => void): Component {
		const items: SettingItem[] = this.secrets.map((row): SettingItem => ({
			id: `key:${row.id}`,
			label: row.label,
			currentValue: keySourceLabel(row),
			submenu: () => this.secretRowSubmenu(row, exit),
		}));
		return new SettingsList(items, items.length, settingsTheme(this.theme), () => {}, () => exit());
	}

	/** One secret's four-action panel, or a dead-end message when no key store is configured. */
	private secretRowSubmenu(row: SecretRowInit, exit: () => void): Component {
		if (!row.custodian) {
			return new MessageView(this.theme, [this.theme.fg("warning", keyStoreUnavailableMessage(row.label))], () => exit());
		}
		return new SecretKeyPanel(this.theme, row.id, row.label, row.custodian, row.state, {
			onState: (next) => {
				row.state = next;
				this.list.updateValue("keys", keysSummary(this.secrets));
				this.hooks.onSecretState?.(row.id, next);
			},
			onNotice: (notice) => this.hooks.onNotice?.(notice),
			requestRender: () => this.hooks.requestRender(),
			done: () => exit(),
			unusedReason: row.unused,
		});
	}

	private commitLearnings(change: (profile: Profile) => Profile): void {
		this.commit(change, "learnings", learningsRowValue);
	}

	/**
	 * A nested SettingsList, mirroring riotIdsSubmenu: a top "Memory" row that cycles on/off in
	 * place (pi-tui's `values` cycling, same idiom as a plain toggle -- no submenu needed for a
	 * two-state flip), then one row per known Riot ID opening View summary / Reset. `exit` is the
	 * top-level list's own done, threaded straight through every leaf below, same convention as
	 * riotIdsSubmenu: every mutation here (on/off, or a reset) returns to the top row list rather
	 * than threading an update through nested lists.
	 */
	private learningsSubmenu(exit: () => void): Component {
		const items: SettingItem[] = [
			{
				id: "learnings-memory",
				label: "Memory",
				description: "On folds audit results into a local file and recalls them in the system prompt. Off stops both at once; it never deletes what's already saved. Turning it back on brings the remember tool back at the next launch.",
				currentValue: learningsRowValue(this.profile),
				values: ["on", "off"],
			},
			...[...new Set([...this.profile.riotIds.known, ...this.learningsAccounts])].map((id): SettingItem => ({
				id: `learnings-id:${id}`,
				label: id,
				currentValue: "",
				submenu: () => this.learningsIdActionsSubmenu(id, exit),
			})),
		];
		return new SettingsList(
			items,
			items.length,
			settingsTheme(this.theme),
			(id, value) => {
				if (id === "learnings-memory") this.commitLearnings((p) => ({ ...p, learningsOff: value === "off" }));
			},
			() => exit(),
		);
	}

	/** "View summary" (read-only) / "Reset" (behind a ConfirmView) for one known Riot ID's learnings file. */
	private learningsIdActionsSubmenu(id: string, exit: () => void): Component {
		const items: SettingItem[] = [
			{
				id: "view-summary",
				label: "View summary",
				currentValue: "",
				submenu: () => this.learningsSummaryView(id, exit),
			},
			{
				id: "reset",
				label: "Reset",
				currentValue: "",
				submenu: () =>
					new ConfirmView(this.theme, `Reset ${id}'s learnings? This deletes everything remembered for them.`, async () => resetLearnings(learningsFilePath(this.learningsDir, id)), exit),
			},
		];
		return new SettingsList(items, items.length, settingsTheme(this.theme), () => {}, () => exit());
	}

	/** Read-only dead end (MessageView, same as secretRowSubmenu's no-custodian branch): never TextFieldInput, which always renders an editable "Enter save" hint that would misrepresent this view. */
	private learningsSummaryView(id: string, exit: () => void): Component {
		const summary = summarizeLearnings(loadLearnings(learningsFilePath(this.learningsDir, id)));
		return new MessageView(this.theme, [summary || "Nothing remembered yet."], () => exit());
	}
}

/** The custodians backing the Keys row, one per secret; undefined for a secret with no key store configured in this launch. */
export type SecretCustodians = Partial<Record<SecretId, RiotKeyCustodian>>;

/**
 * Session-scoped /config: gated exactly like /riot-key's open() (src/index.ts) — non-empty args
 * or a non-TUI launch both refuse before the panel ever opens. No unavailable gate: /config has no
 * external dependency that can be missing (a missing custodian only disables that one Keys row).
 */
export function createConfigSession(
	environment: Record<string, string | undefined>,
	config: ProfileConfigTarget,
	invalidateLane: () => void,
	custodians: SecretCustodians = {},
	onSecretState?: (id: SecretId, state: RiotKeyState, ctx: any) => void,
	/** The platform the research service decision is made for; a test names one so it holds on every host. */
	platform: NodeJS.Platform = process.platform,
	/** Data Dragon's champion names, for the champion row; a test injects its own. */
	loadNames: () => Promise<ChampionNames> = () => loadChampionNames(),
) {
	return {
		async open(args: string, ctx: any): Promise<void> {
			if (args.trim().length > 0) return ctx.ui.notify(CONFIG_NO_ARGS_MESSAGE, "error");
			if (!ctx.hasUI || ctx.mode !== "tui") return ctx.ui.notify(CONFIG_TUI_ONLY_MESSAGE, "error");
			const initial = loadProfile(profilePath(environment));
			const initialTheme = activeTheme(environment, initial);
			// Re-read persisted state on every open, same as /riot-key's own open(): a status read, never a probe.
			// Only the research service the coach starts is handed the Perplexity and Gemini keys; none, or one you run, never sees them.
			const service = researchServiceMode(environment, platform);
			const serviceUnused = service.kind === "off" ? service.reason : service.kind === "remote" ? "a research service you run holds its own keys" : undefined;
			const secrets: SecretRowInit[] = await Promise.all(
				SECRET_ROWS.map(async (row): Promise<SecretRowInit> => {
					const custodian = custodians[row.id];
					const state = custodian ? (await custodian.status()).state : { stored: false };
					const envTag = row.envSourceVar ? parseKeySourceTag(environment[row.envSourceVar]).envTag : undefined;
					if (custodian) onSecretState?.(row.id, state, ctx);
					return { id: row.id, label: row.label, custodian, state, envTag, unused: row.id === "perplexity" || row.id === "gemini" ? serviceUnused : undefined };
				}),
			);
			await ctx.ui.custom((tui: any, theme: any, _keybindings: unknown, done: (value: undefined) => void) =>
				new ConfigPanel(
					theme,
					initial,
					initialTheme,
					config.champion,
					{
						setTheme: (name) => ctx.ui.setTheme?.(name),
						onSave: (change) => applyProfileChange(config, invalidateLane, environment, change),
						loadChampions: async () => [...(await loadNames()).values()],
						requestRender: () => tui?.requestRender?.(),
						done: () => done(undefined),
						onNotice: (notice) => ctx.ui.notify(notice.text, notice.level),
						onSecretState: (id, state) => onSecretState?.(id, state, ctx),
					},
					secrets,
					coachHomePath(environment, "learnings"),
					config.accounts,
				),
			);
		},
	};
}
