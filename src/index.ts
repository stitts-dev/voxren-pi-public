import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { AUTO_COMMAND, GAME_EVENT_COMMANDS, autoOn, parseAutoComp, BLOCKED_TOOL_MESSAGE, COACH_COMMANDS, COACH_MODELS, COACH_YAML, DEFAULT_MODEL_ID, DEFAULT_PROVIDER, VOXREN_COMMAND_FRAME_TOOL, VOXREN_OTP_BUILD_TOOL, VOXREN_PLAYER_AUDIT_TOOL, VOXREN_REMEMBER_TOOL, VOXREN_TOOLS, coachSystemPrompt, fillTemplate, liveQuestionPrompt, routedQuestionPrompt, splitMatchup, typedChampions, type CoachCommand, type CommandSettings, type TierName, type VoxrenToolName } from "./contracts";
import { CONFIG_COMMAND, CONFIG_COMMAND_DESCRIPTION, applyLcuSignIn, createConfigSession, loadProfile, profilePath, resolveKnownAccounts, saveCommandSettings, updateProfile, type Profile } from "./config";
import { LANE_WORDS, createLcuFooterState, lcuPlayerName, lcuSourceFromEnv, loadChampionNames, readComposition as readLcuComposition, readLivePanel, readSignedInRiotId, type ChampionNames, type Composition, type LcuFooterHandle, type LcuFooterState, type LivePanelFacts } from "./lcu";
import { savedOneTricks } from "./otp-reference";
import { HOSTED_SEARCH_PROVIDERS } from "./hosted-search";
import { createLiveResearchGateway, hasSearchKey, parseAuditAccounts } from "./live-gateway";
import { createRouteJudge, routePrompt, type Route, type RouteJudge } from "./model-router";
import { commandPhase, createGameEvents, routeCommand, routeEvent, routeGameEvent, type AutoCall, type LockEvent } from "./command-router";
import { createPassageJudge } from "./passage-judge";
import {
	RIOT_KEY_COMMAND,
	RIOT_KEY_COMMAND_DESCRIPTION,
	RIOT_KEY_NO_ARGS_MESSAGE,
	RIOT_KEY_TUI_ONLY_MESSAGE,
	RIOT_KEY_UNAVAILABLE_MESSAGE,
	RiotKeyPanel,
	createRiotKeyCustodian,
	createSecretCustodian,
	renewalWidgetLines,
	riotKeyHeaderLine,
	type RiotKeyCustodian,
	type RiotKeyState,
} from "./riot-key";
import { coachHomePath, createExchangeLog, exchangeLogPath, type ExchangeLog } from "./exchange-log";
import { adoptLaunchSecrets } from "./launch-secrets.mjs";
import { clearNotice, createFileSink, logEvent, noticeLines, raiseNotice, setLogContext, setLogSink, setNoticeHandler } from "./coach-log";
import { createJevBadge, type JevBadgeHandle, type JevBadgeState } from "./jev-badge";
import { parseKeySourceTag, resolveKeySource } from "./key-source";
import { cardForChampion, promptCard } from "./champion-card";
import { type AuditGameResult, foldAuditGames, learningsPath, loadLearnings, saveLearnings, summarizeLearnings } from "./learnings-store";
import { normalizeTakeaway } from "./policy";
import { researchServiceMode } from "./research-service";
import { imageProtocol, keepCursorShown, loadRasterizer, syncPicturesNotice, watchCellSize } from "./terminal-images";
import { SWAP, bareItem, buildIconNames, buildLines, unsourcedBuildNames, withoutBuildLines, type BuildLines } from "./build-lines";
import { championsIn, iconsNotice, isKnownName, loadKnownNames, prefetchChampionIcons, prefetchItemIcons, prefetchRuneIcons } from "./icons";
import { createPanel, hasPanelContent, panelModel, withoutPanelRows, type PanelOptions } from "./panel";
import { createCoachTools, withCommandFrames } from "./tools";
import { DEBUG_COMMAND, DEBUG_COMMAND_DESCRIPTION, REPO_DIR, startDebugSession } from "./debug-handoff";
import { NOTICE_STATE_FILE, UPDATE_CHECK_MS, UPDATE_COMMAND, UPDATE_COMMAND_DESCRIPTION, UPDATE_NOTICE_ID, WHATS_NEW_MESSAGE_TYPE, commitsBetween, nextTip, pendingNotes, pullLatest, readCheckout, readLastSeen, readNoticeState, versionLabel, whatsNewText, writeLastSeen, writeNoticeState } from "./update";
import { REPORT_HINT_ENTRY_TYPE, REPORT_HINT_LINE, createReportHints, lastRunFailed } from "./report-hint";
import { FEEDBACK_COMMAND, FEEDBACK_COMMAND_DESCRIPTION, FEEDBACK_FILE, FEEDBACK_LIST_MESSAGE_TYPE, FEEDBACK_NO_HOME_MESSAGE, FEEDBACK_PROMPT_ENTRY_TYPE, FEEDBACK_PROMPT_LINE, FEEDBACK_USAGE_MESSAGE, appendFeedback, feedbackListText, feedbackPromptOn, feedbackRow, parseFeedbackArgs, promptAfterReview, readFeedback } from "./feedback";
import { TREE_COMMAND, TREE_COMMAND_DESCRIPTION, TREE_NO_ARGS_MESSAGE, TREE_TUI_ONLY_MESSAGE, TreePanel, commandMarks, commandTree, createTreeStats } from "./command-tree";
import { HIDDEN_THINKING_LABEL, SHELL_DENIED_MESSAGE, WINDOW_TITLE, WORKING_MESSAGE, answerMarkdown, coachLabels, createAutoStoppedLine, createBuildStrip, createDimLine, createWhatsNew, createCardMotion, createFooter, createHeader, createRouteRow, panelStatus, parseCardDetail, quoteUserText, routeText, routeWord, thinkingMarkdown, withoutEmphasis, workingMessage, type CardDetail, type CardMotion, type FooterStats, type RouteView, type SurfaceLabels, type UiTheme } from "./ui";

/** `pi` supplies the thinking level; it lives on the extension API, not the event context. `route` is the last turn's route (Task 4's `lastRoute`), for the footer word. */
export function readFooterStats(ctx: any, pi?: any, route?: Route & { command?: string }): FooterStats {
	let inputTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
	for (const entry of entries) {
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		inputTokens += entry.message.usage?.input ?? 0;
		outputTokens += entry.message.usage?.output ?? 0;
		costUsd += entry.message.usage?.cost?.total ?? 0;
	}
	const usage = ctx?.getContextUsage?.();
	return {
		inputTokens,
		outputTokens,
		contextPercent: typeof usage?.percent === "number" ? usage.percent : undefined,
		contextWindow: usage?.contextWindow ?? ctx?.model?.contextWindow ?? 0,
		costUsd,
		// openai-codex is the one plan-billed provider the coach supports; API-key providers report real cost.
		subscription: ctx?.model?.provider === "openai-codex",
		thinking: ctx?.model?.reasoning ? pi?.getThinkingLevel?.() : undefined,
		model: ctx?.model?.id,
		route: routeWord(route),
	};
}

/** The chat row's custom message type: shown once per turn between the prompt and the answer, never sent to the model. */
export const ROUTE_MESSAGE_TYPE = "voxren-route";

/** The quiet line under the red row of an automatic call a typed turn stopped (#383): a session entry, display only, never sent to the model. */
export const AUTO_STOPPED_ENTRY_TYPE = "voxren-auto-stopped";

/** The build strip's session entry: the answer's runes and build drawn with their icons, display only (entries never reach the model). */
export const BUILD_ENTRY_TYPE = "voxren-build";
/** A finished answer drawn as the coach panel (src/panel.ts); it takes the build strip's place for answers from this build on. */
export const PANEL_ENTRY_TYPE = "voxren-panel";
/**
 * The tools that bring data into a turn. The facts lookup and the strategy frame only echo the names the model sent them,
 * and remember stores the player's own words, so a build name found only there is still the coach's own pick.
 */
const SOURCE_TOOLS = new Set<VoxrenToolName>(["web_search", "voxren_meta_research", "voxren_video_research", VOXREN_PLAYER_AUDIT_TOOL, VOXREN_OTP_BUILD_TOOL]);

/** Pi sends a custom message to the model as user text; the route row and the what's-new note are for the player only, so they leave every request. */
const PLAYER_ONLY_MESSAGES = new Set([ROUTE_MESSAGE_TYPE, WHATS_NEW_MESSAGE_TYPE, FEEDBACK_LIST_MESSAGE_TYPE]);
export function withoutRouteRows<T>(messages: T[]): T[] | undefined {
	const kept = messages.filter((message: any) => !(message?.role === "custom" && PLAYER_ONLY_MESSAGES.has(message.customType)));
	return kept.length === messages.length ? undefined : kept;
}

/** Replace Pi's coding-agent chrome with the coach surface. */
export function installCoachSurface(
	ctx: any,
	readRiotKeyLine: (() => string | undefined) | undefined,
	labels: SurfaceLabels,
	readLcuFooter?: () => LcuFooterState,
	pi?: any,
	readJev?: () => JevBadgeState | undefined,
	readRoute?: () => Route | undefined,
	readMarks?: () => ReadonlyMap<string, string> | undefined,
): ((force?: boolean) => void) | undefined {
	if (!ctx?.hasUI || !ctx.ui) return undefined;
	ctx.ui.setTitle?.(WINDOW_TITLE);
	// Pi repaints the header and footer on input and agent events only; the returned repaint lets the LCU poller and the Jev badge trigger one.
	let tui: any;
	ctx.ui.setHeader?.((nextTui: any, theme: any) => {
		tui = nextTui;
		return createHeader(theme, readRiotKeyLine, labels, readLcuFooter, readJev, readMarks);
	});
	ctx.ui.setFooter?.((_tui: unknown, theme: any) => createFooter(theme, () => readFooterStats(ctx, pi, readRoute?.()), labels, readLcuFooter));
	ctx.ui.setWorkingMessage?.(WORKING_MESSAGE);
	ctx.ui.setHiddenThinkingLabel?.(HIDDEN_THINKING_LABEL);
	// A forced repaint also drops every component's cached lines, so an answer whose rows came back (no panel landed) is drawn again.
	return (force?: boolean) => {
		if (force) tui?.invalidate?.();
		tui?.requestRender?.(force);
	};
}

/** Working text follows the running tool; nothing else is added, Pi's pending card already shows the call. */
export function createWorkingText() {
	const running: string[] = [];
	const apply = (ctx: any) => ctx?.hasUI && ctx.ui?.setWorkingMessage?.(running.at(-1) ?? WORKING_MESSAGE);
	return {
		start(event: any, ctx: any) {
			running.push(workingMessage(event.toolName, event.args));
			apply(ctx);
		},
		end(_event: any, ctx: any) {
			running.pop();
			apply(ctx);
		},
		clear(ctx: any) {
			running.length = 0;
			apply(ctx);
		},
	};
}

/** The five coaching lane words (championRoles.json's lane keys, mapped once in lcu.ts): what VOXREN_COACH_LANE is validated against. */
const COACHING_LANES = new Set(Object.values(LANE_WORDS));

export interface CoachConfig {
	tools: VoxrenToolName[];
	disabledTools: VoxrenToolName[];
	/** Why each disabled tool is off and how to turn it on. */
	disabledNotes: Partial<Record<VoxrenToolName, string>>;
	accounts: string[];
	/** Unset until VOXREN_COACH_CHAMPION, a saved profile, or /config names one; commands and the system prompt otherwise detect it live (the composition's own pick, or a command's argument). */
	champion?: string;
	/** VOXREN_COACH_LANE, validated; undefined when unset or not one of the five lane words (ignored, not an error — the simpler of the two options). */
	lane?: string;
	systemPrompt: string;
	/** Every model a session may run; a launch-time override (VOXREN_COACH_MODEL/_PROVIDER) narrows this to just that one. */
	approvedModels: { provider: string; ids: string[] };
	/** True when VOXREN_COACH_MODEL or VOXREN_COACH_PROVIDER was set at launch: the session stays on that single model; the router still picks thinking. */
	pinnedAtLaunch: boolean;
	/** True when VOXREN_COACH_THINKING was set at launch: the router still picks the model but never changes the thinking level. */
	thinkingPinned: boolean;
	labels: SurfaceLabels;
	/** True when the Jev passage screen is on (TYPESAFE_API_KEY present). */
	passageJudge: boolean;
	/** profile.learningsOff (issue #33 stage 5): off stops stage 2's fold and stage 4's recall, and drops voxren_remember from the tool set. Never deletes existing files. */
	learningsOff: boolean;
	/** VOXREN_COACH_TURN_TIMEOUT_MS: wall-clock deadline for one turn. 0, unset, or unparseable falls back to DEFAULT_TURN_TIMEOUT_MS. */
	turnTimeoutMs: number;
	/** VOXREN_COACH_AUTO_COMP: 1/true/on forces the auto calls on, 0/false/off forces them off, whatever the /flow row says; anything else (unset) leaves the row to decide, and its default is on. The calls are /pick on a settled hover or lock, /draft once the player and four enemies have locked, and again on the fifth; the same variable also governs the game start (/comp) and game end (/review) calls. */
	autoComp: boolean | undefined;
	/** The player's per-command settings from the /flow tree (profile.json): saved default arguments, auto /draft. Replaced in place when the tree saves. */
	commands: Record<string, CommandSettings>;
	/** VOXREN_COACH_CARD_DETAIL: the level an expanded tool card opens at (`claims` unless the launch says `full` or `brief`). A session-wide display setting with no panel row: /flow's rows belong to one command and /config's change on Enter. */
	cardDetail: CardDetail;
}

/** Print-mode and TUI both get a turn deadline unless the launch overrides it. */
export const DEFAULT_TURN_TIMEOUT_MS = 180_000;

/** VOXREN_COACH_TURN_TIMEOUT_MS: 0 or unset means the default; anything else must parse as a number. */
function parseTurnTimeoutMs(raw: string | undefined): number {
	const trimmed = raw?.trim();
	if (!trimmed) return DEFAULT_TURN_TIMEOUT_MS;
	const value = Number(trimmed);
	if (!Number.isFinite(value)) throw new Error(`VOXREN_COACH_TURN_TIMEOUT_MS must be a number, got "${raw}"`);
	return value > 0 ? value : DEFAULT_TURN_TIMEOUT_MS;
}

/**
 * A note when bin/coach.mjs's VOXREN_KEY_SOURCE_<NAME> says an env/.env value is shadowing a key
 * already in the store -- resolveKeySource is the single source of truth for this decision, shared
 * with a later stage's /config Keys-row label. Nothing when there's no shadow to report.
 */
function keyShadowNote(label: string, raw: string | undefined): string | undefined {
	const { source, shadowsStore } = resolveKeySource(parseKeySourceTag(raw));
	if (!shadowsStore) return undefined;
	const tier = source === "env" ? "An environment variable" : "The .env file";
	return `${label} key: ${tier} is shadowing a key already in the store; the stored key takes effect once that value is removed.`;
}

/** Everything a launch can do, read once from the environment (plus the persisted profile: theme is Stage 5's, champion and accounts are this stage's). Missing keys disable a tool; they never crash the coach. */
export function resolveCoach(environment: Record<string, string | undefined>, riotKeyAvailable = true, profile: Profile = loadProfile(profilePath(environment))): CoachConfig {
	const provider = environment.VOXREN_COACH_PROVIDER?.trim() || DEFAULT_PROVIDER;
	const id = environment.VOXREN_COACH_MODEL?.trim() || DEFAULT_MODEL_ID;
	const pinnedAtLaunch = Boolean(environment.VOXREN_COACH_MODEL?.trim() || environment.VOXREN_COACH_PROVIDER?.trim());
	const champion = environment.VOXREN_COACH_CHAMPION?.trim() || profile.champion;
	const rawLane = environment.VOXREN_COACH_LANE?.trim().toLowerCase();
	const lane = rawLane && COACHING_LANES.has(rawLane) ? rawLane : undefined;
	// No signedIn at launch: the LCU footer poller hasn't read anything yet: before_agent_start layers it on per turn.
	const accounts = resolveKnownAccounts(undefined, profile, parseAuditAccounts(environment.VOXREN_COACH_ACCOUNTS));
	const passageJudge = createPassageJudge(environment) !== undefined;
	const disabled = new Map<VoxrenToolName, string>();
	// Web search runs through the model provider's own hosted search (no key), or through a keyed provider behind the research service.
	const service = researchServiceMode(environment);
	const hosted = HOSTED_SEARCH_PROVIDERS.has(provider);
	if (!hosted && !(service.kind !== "off" && hasSearchKey(environment))) {
		disabled.set("web_search", `web_search off: ${provider} has no hosted web search; set BRAVE_API_KEY or PERPLEXITY_API_KEY (needs the research service${service.kind === "off" ? `: ${service.reason}` : ""})`);
	}
	if (service.kind === "off") disabled.set("voxren_video_research", `video research off: ${service.reason}`);
	// No account gate: the audit reads the signed-in account from the open League client; VOXREN_COACH_ACCOUNTS only covers a closed client.
	if (!riotKeyAvailable) {
		disabled.set("voxren_player_audit", "player audit off: no Riot key store in this launch (start with coach)");
		disabled.set("voxren_otp_build", "OTP build off: no Riot key store in this launch (start with coach)");
	}
	const learningsOff = profile.learningsOff ?? false;
	if (learningsOff) disabled.set("voxren_remember", "remember off: memory is off in /config's Learnings row");
	const tools = VOXREN_TOOLS.filter((tool) => !disabled.has(tool));
	const disabledTools = [...disabled.keys()];
	const shadowNotes = [
		keyShadowNote("Perplexity", environment.VOXREN_KEY_SOURCE_PERPLEXITY),
		keyShadowNote("Typesafe", environment.VOXREN_KEY_SOURCE_TYPESAFE),
		keyShadowNote("Gemini", environment.VOXREN_KEY_SOURCE_GEMINI),
	].filter((note): note is string => note !== undefined);
	const notes = [...disabled.values(), ...shadowNotes];
	return {
		tools,
		disabledTools,
		disabledNotes: Object.fromEntries(disabled),
		accounts,
		champion,
		lane,
		systemPrompt: coachSystemPrompt({ accounts, champion, lane, passageJudge, disabledTools, card: undefined }),
		approvedModels: { provider, ids: pinnedAtLaunch ? [id] : [...COACH_MODELS] },
		pinnedAtLaunch,
		thinkingPinned: Boolean(environment.VOXREN_COACH_THINKING?.trim()),
		labels: coachLabels(`${provider}/${id}`, accounts, notes),
		passageJudge,
		learningsOff,
		turnTimeoutMs: parseTurnTimeoutMs(environment.VOXREN_COACH_TURN_TIMEOUT_MS),
		autoComp: parseAutoComp(environment.VOXREN_COACH_AUTO_COMP),
		commands: profile.commands ?? {},
		cardDetail: parseCardDetail(environment.VOXREN_COACH_CARD_DETAIL),
	};
}

/**
 * Session-scoped sanitized Riot key state. Launch reads persisted state only;
 * nothing here ever probes on its own, and nothing here ever sees the key.
 */
export function createRiotKeySession(custodian: RiotKeyCustodian | undefined) {
	let state: RiotKeyState | undefined;
	const applyChrome = (ctx: any) => {
		if (!ctx?.hasUI || !ctx.ui) return;
		ctx.ui.setWidget?.(RIOT_KEY_COMMAND, renewalWidgetLines(state));
	};
	return {
		get state() {
			return state;
		},
		headerLine: () => riotKeyHeaderLine(state, custodian !== undefined),
		/** A state read or test from elsewhere (/config's Riot row), so header and widget follow it. */
		sync(next: RiotKeyState, ctx: any) {
			state = next;
			applyChrome(ctx);
		},
		async load(ctx: any) {
			if (!custodian) return;
			state = (await custodian.status()).state;
			applyChrome(ctx);
		},
		async open(args: string, ctx: any) {
			if (args.trim().length > 0) return refuse(ctx, RIOT_KEY_NO_ARGS_MESSAGE);
			if (!custodian) return refuse(ctx, RIOT_KEY_UNAVAILABLE_MESSAGE);
			if (!ctx.hasUI || ctx.mode !== "tui") return refuse(ctx, RIOT_KEY_TUI_ONLY_MESSAGE);
			// Re-read persisted state on every open; this is a status read, never a probe.
			const initial = (await custodian.status()).state;
			state = initial;
			applyChrome(ctx);
			await ctx.ui.custom((tui: any, theme: any, _keybindings: unknown, done: (value: undefined) => void) =>
				new RiotKeyPanel(theme, custodian, initial, {
					onState: (next) => {
						state = next;
						applyChrome(ctx);
					},
					onNotice: (notice) => ctx.ui.notify(notice.text, notice.level),
					requestRender: () => tui?.requestRender?.(),
					done: () => done(undefined),
				}),
			);
		},
	};
}

/** How long the first turn waits for the launch lane before sending the prompt without one. */
export const LANE_WAIT_MS = 2500;
/** How long the input hook waits for a cancelled automatic call to end before the typed question goes on. */
const INPUT_WAIT_MS = 3000;

/**
 * Command-time lane: the client's assigned role (a) beats the launch lane — env (b), or the
 * champion's Data Dragon/championRoles primary lane (c) — beats no lane word at all (d). A
 * `championLane` that throws or is unreachable degrades to (d), never a guessed default.
 */
async function resolveLane(config: CoachConfig, championLane: (name: string) => Promise<string | undefined>, selfLane: string | undefined): Promise<string | undefined> {
	if (selfLane) return selfLane;
	if (config.lane) return config.lane;
	if (!config.champion) return undefined;
	return safeChampionLane(championLane, config.champion);
}

/** `championLane(name)`, degrading a throw or unreachable Data Dragon to undefined (never a guessed default). */
async function safeChampionLane(championLane: (name: string) => Promise<string | undefined>, name: string): Promise<string | undefined> {
	try {
		return await championLane(name);
	} catch (error) {
		logEvent("warn", "index", "champion-lane-failed", { champion: name }, error);
		return undefined;
	}
}

/** The fixed tail of each command's prompt, the text after its last {{variable}}: a user message that ends with one is that command's prompt, not a line the player typed. */
const COMMAND_TAILS = COACH_YAML.commands.map((command: { name: string; prompt: string }) => ({ name: command.name, tail: command.prompt.slice(command.prompt.lastIndexOf("}}") + 2).trim() })).filter((entry) => entry.tail.length >= 40);
const MAX_TYPED_COMMANDS = 32;

/**
 * What the transcript shows in place of a command's prompt: the line the player typed (`typed` maps a sent prompt to it),
 * or the bare command name for a prompt this launch did not send (a resumed session). The model still reads the whole prompt.
 */
export function commandDisplay(markdown: string, typed: Map<string, string>): string | undefined {
	const text = markdown.trim();
	const input = typed.get(text);
	if (input) return input;
	const match = COMMAND_TAILS.find((entry) => text.endsWith(entry.tail));
	return match ? `/${match.name}` : undefined;
}

/** Data Dragon's names, degrading a throw to an empty list (the unknown-champion check is then skipped). */
async function safeChampionNames(load: () => Promise<ChampionNames>): Promise<ChampionNames> {
	try {
		return await load();
	} catch (error) {
		logEvent("warn", "index", "champion-names-failed", undefined, error);
		return new Map();
	}
}

/** "Kai'Sa", "kaisa", and "Kai Sa" are one champion. */
const championKey = (name: string): string => name.replace(/[^a-z0-9]/gi, "").toLowerCase();

/**
 * A command that refuses or stops early. Print mode has no UI, so ctx.ui.notify prints nothing and the run would
 * exit 0: there the message goes to stderr and the run exits 1 (through ctx.setExitCode when a caller injects one, else process.exitCode). Interactive modes keep the error notice.
 */
export function refuse(ctx: { mode?: string; setExitCode?: (code: number) => void; ui: { notify: (message: string, level: "error") => void } }, message: string): void {
	if (ctx.mode === "print") {
		process.stderr.write(`${message}\n`);
		(ctx.setExitCode ?? ((code) => void (process.exitCode = code)))(1);
		return;
	}
	ctx.ui.notify(message, "error");
}

/**
 * What a command's frame came to for one state. refused: a tool the command needs is off, or Data Dragon does not know a typed
 * champion (always an error). empty: no frame for this state; notice is true when the message is the command's own notice,
 * false for the usage or no-main error. args is what the command ran with, a saved default included.
 */
export type FrameFill = { kind: "framed"; args: string; framed: string } | { kind: "refused"; args: string; message: string } | { kind: "empty"; args: string; message: string; notice: boolean };

export interface FrameDeps {
	config: CoachConfig;
	readComposition: () => Promise<Composition | undefined>;
	championLane: (name: string) => Promise<string | undefined>;
	championNames: () => Promise<ChampionNames>;
}

/** The part of a command that runs before the send: its frame filled from the live client read. Nothing is sent, so a tool can load a frame too. */
export async function fillCommandFrame(command: CoachCommand, args: string, deps: FrameDeps, routed: boolean): Promise<FrameFill> {
	const { config, readComposition, championLane, championNames } = deps;
	const missing = command.needs.find((tool) => config.disabledTools.includes(tool));
	if (missing) return { kind: "refused", args, message: config.disabledNotes[missing] ?? `/${command.name} is unavailable in this launch.` };
	// A bare command sends the default the player saved in /flow; a typed argument always wins.
	if (!args.trim() && command.savesDefault) args = config.commands[command.name]?.args ?? args;
	// A name Data Dragon does not know is reported first, by name, whatever else is missing. A down Data Dragon (an empty list) skips the check.
	const typed = typedChampions(command.name, args);
	if (typed.length) {
		const known = new Set([...(await safeChampionNames(championNames)).values()].map(championKey));
		const unknown = known.size ? typed.find((name) => !known.has(championKey(name))) : undefined;
		if (unknown) return { kind: "refused", args, message: `No champion called '${unknown}'.` };
	}
	const composition = command.usesComposition ? await readComposition() : undefined;
	// /matchup <mine> vs <enemy> names a specific champion to play, not the player's active lane
	// assignment, so a typed `mine` other than the main skips the client/env chain (#20).
	const typedMine = command.name === "matchup" ? splitMatchup(args, config.champion ?? "")?.mine : undefined;
	const lane = command.needsLane
		? typedMine && typedMine.toLowerCase() !== (config.champion ?? "").toLowerCase()
			? await safeChampionLane(championLane, typedMine)
			: await resolveLane(config, championLane, composition?.selfLane)
		: undefined;
	const launch = { passageJudge: config.passageJudge, disabledTools: config.disabledTools };
	// A routed question plans for the champion the client shows (locked, hovered, or in game) before the main.
	const champion = (routed && composition?.selfChampion) || config.champion;
	const framed = command.prompt(args, { champion, accounts: config.accounts, composition, lane, launch });
	if (framed) return { kind: "framed", args, framed };
	const notice = command.noticeWhenEmpty?.(composition);
	if (notice) return { kind: "empty", args, message: notice, notice: true };
	// A prompt that composes once any champion stands in failed only for want of the main: say that, never "Usage" for a line typed right.
	const noMain = !config.champion && Boolean(command.prompt(args, { champion: "your champion", accounts: config.accounts, composition, lane }));
	const usage = noMain
		? `No main champion set: pick one in /config${command.name === "matchup" ? ", or name yours: /matchup <yours> vs <enemy>" : command.name === "otp" ? ", or name the champion: /otp <player> <champion>" : ""}.`
		: `Usage: /${command.name} ${command.args ?? ""}`.trim();
	return { kind: "empty", args, message: usage, notice: false };
}

/** Coach slash commands only compose a user message; the model does the work with its tools. */
export function registerCoachCommands(
	pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage">,
	config: CoachConfig,
	readComposition: () => Promise<Composition | undefined> = readLcuComposition,
	championLane: (name: string) => Promise<string | undefined> = async () => undefined,
	onCommand: (name: string, tier: TierName, text: string, input: string, auto: boolean) => void = () => {},
	championNames: () => Promise<ChampionNames> = () => loadChampionNames(),
	cancelAuto: (ctx: any) => boolean = () => false,
): Record<string, CommandHandler> {
	const handlers: Record<string, CommandHandler> = {};
	for (const command of COACH_COMMANDS) {
		pi.registerCommand(command.name, {
			description: `${command.description}${command.args ? ` (${command.args})` : ""}`,
			// `auto` is the coach's own call (the auto trigger); Pi calls the handler with two arguments, so a typed command is never auto.
			// An auto call may be a function: false once a newer automatic call has replaced this one.
			// `question` is a typed question the command router sent here: it rides under the command's prompt, and a command that cannot run returns "unrouted" silently so the question goes out plain.
			handler: (handlers[command.name] = async (args: string, ctx: any, autoArg: boolean | (() => boolean) = false, question?: string) => {
				const auto = Boolean(autoArg);
				const fill = await fillCommandFrame(command, args, { config, readComposition, championLane, championNames }, question !== undefined);
				args = fill.args;
				if (fill.kind === "refused") return refuse(ctx, fill.message);
				if (fill.kind === "empty") {
					if (question !== undefined) return "unrouted";
					return fill.notice ? (ctx.mode === "print" ? refuse(ctx, fill.message) : ctx.ui.notify(fill.message, "info")) : refuse(ctx, fill.message);
				}
				const text = question !== undefined ? routedQuestionPrompt(fill.framed, question) : fill.framed;
				// A follow-up never fires before_agent_start, so it would run on the previous turn's model and thinking: wait out the busy
				// turn and send the command as its own turn, so its tier applies. Without waitForIdle it still queues as a follow-up.
				let deliverAs: "followUp" | undefined;
				// The player's turn beats an automatic one (#370): stop the automatic turn, then run this one. An automatic call that
				// finds a typed turn already running drops out instead of colliding with it.
				const cancelled = !auto && cancelAuto(ctx);
				// No await from the composition read to the send below: the idle check and the send are one step (#396).
				if (auto && typeof autoArg === "function" && !autoArg()) return "stale";
				if (auto && ctx?.isIdle?.() === false) return "busy";
				if (ctx?.isIdle?.() === false) {
					if (ctx.waitForIdle) await ctx.waitForIdle();
					else deliverAs = "followUp";
				}
				// An automatic turn still starting up (not streaming yet) is cancelled when it starts; a queue slot keeps this send from being refused meanwhile.
				if (cancelled) deliverAs = "followUp";
				// Pi hands the handler only what follows the first space of the submitted line, so the line is rebuilt from it.
				onCommand(command.name, command.tier, text, question ?? `/${command.name}${args ? ` ${args}` : ""}`, auto);
				pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
				// Print mode exits when the handler returns, and pi.sendUserMessage is fire-and-forget.
				// ponytail: poll up to 5s for the turn to start, then wait for it; a Pi API that returns the turn promise would replace this.
				if (ctx?.mode !== "tui" && ctx?.waitForIdle) {
					for (let waited = 0; waited < 5000 && ctx.isIdle?.(); waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
					await ctx.waitForIdle();
				}
				return "sent";
			}),
		});
	}
	return handlers;
}

/**
 * The /flow list for an args row whose values come from data: every Data Dragon champion for /patch, the one-tricks
 * /otp saved for /otp (value "<player> <champion>", what /otp takes). The fixed lists (/review, /comp) live in coach.yaml.
 */
export async function commandChoices(name: string, referenceDir: string | undefined, loadNames: () => Promise<ChampionNames> = () => loadChampionNames()): Promise<{ items: Array<{ value: string; label: string }>; note?: string }> {
	if (name === "patch") {
		try {
			return { items: [...new Set((await loadNames()).values())].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value })) };
		} catch (error) {
			logEvent("warn", "index", "champion-list-failed", undefined, error);
			return { items: [], note: "Data Dragon is unreachable, so there is no champion list right now." };
		}
	}
	if (name === "otp") {
		const items = savedOneTricks(referenceDir).map(({ player, champion }) => ({ value: `${player} ${champion}`, label: `${player} on ${champion}` }));
		return items.length ? { items } : { items: [], note: "No one-tricks saved yet: /otp <player> saves one." };
	}
	return { items: [] };
}

// ponytail: five automatic turns per champ select, pick and team calls together; a fixed cap rather than a setting.
const AUTO_COMP_PER_DRAFT = 5;

export type { AutoCall };

/**
 * How an automatic call ended: sent; busy (a turn was running when it was about to send); typed (that turn was one the player
 * typed, which wins and is not retried, #370); stale (a newer automatic call replaced it).
 */
export type AutoOutcome = "sent" | "busy" | "typed" | "stale";
/** A coach command's handler; "unrouted" is a routed question whose command could not run (no draft read, no main champion). */
export type CommandHandler = (args: string, ctx: any, auto?: boolean | (() => boolean), question?: string) => Promise<AutoOutcome | "unrouted" | void>;

/**
 * Decides, on each footer change, which call to send unasked: the team call for a locked draft not run yet, else the pick
 * call for a settled pick not run yet, while the coach is idle, at most AUTO_COMP_PER_DRAFT turns per champ select between
 * them. When both are due the team call runs and the pick key is marked as seen. Only one call is in flight (reading the
 * composition) at a time: a team call replaces a pick still in flight, anything else waits for it. A call that finds the coach busy
 * with no typed turn behind it gives its key and turn back, so the next poll retries it; one beaten by a typed turn stays spent.
 * Every drop is logged once with its key and reason. Leaving for the lobby or the game starts a fresh budget (a failed read, "closed", does not).
 * Which command a lock runs comes from routeEvent (src/command-router.ts), never from Jev; `route` is injectable for tests.
 * `run` may return a promise of its outcome; anything else counts as sent.
 */
export function createAutoComp(run: (call: AutoCall, wanted: () => boolean) => unknown, route: (event: LockEvent) => AutoCall = routeEvent): (state: LcuFooterState, idle: boolean) => void {
	const seen = new Set<string>();
	let turns = 0;
	let flight: { draft: boolean } | undefined;
	return (state, idle) => {
		if (state.kind === "lobby" || state.kind === "liveGame") {
			seen.clear();
			turns = 0;
		}
		if (state.kind !== "champSelect" || !idle || turns >= AUTO_COMP_PER_DRAFT) return;
		const draft = state.lockedDraft && `draft:${state.lockedDraft}`;
		const pick = state.pickKey && `pick:${state.pickKey}`;
		const draftDue = draft && !seen.has(draft) ? draft : undefined;
		const pickDue = pick && !seen.has(pick) ? pick : undefined;
		if (!draftDue && !pickDue) return;
		const isDraft = Boolean(draftDue);
		// flight tracks the lock's draft flag, not the routed command: the team-call-beats-pick rule is about the lock, whatever the router maps it to.
		if (flight && !(isDraft && !flight.draft)) return;
		if (pickDue) seen.add(pickDue);
		if (draftDue) seen.add(draftDue);
		turns++;
		const call = route({ event: "locked", draft: isDraft });
		const keys = [draftDue, pickDue].filter((key): key is string => Boolean(key));
		const mine = (flight = { draft: isDraft });
		const result = run(call, () => flight === mine);
		if (!(result instanceof Promise)) return flight = undefined;
		void result.then((outcome) => {
			if (flight === mine) flight = undefined;
			if (outcome === "busy" || outcome === "typed" || outcome === "stale") {
				const refunded = outcome === "busy";
				if (refunded) {
					for (const key of keys) seen.delete(key);
					turns--;
				}
				logEvent("info", "index", "auto-call-dropped", { call, key: keys.join(" "), reason: outcome === "busy" ? "the coach was busy" : outcome === "typed" ? "a typed turn is running and wins" : "the team call replaced it", retry: refunded });
			}
		});
	};
}

/**
 * A successful voxren_player_audit result folded into that Riot ID's local learnings file (issue #33 stage 2).
 * `event.result.details.response.data` is the same path exchange-log.ts's resultOf uses to reach a tool's
 * details. Never throws: a filesystem error here must not fail the tool call or the turn.
 */
function foldAuditIntoLearnings(environment: Record<string, string | undefined>, event: any): void {
	try {
		const data = event.result?.details?.response?.data;
		if (!data || typeof data.account !== "string" || !Array.isArray(data.games)) return;
		const games: AuditGameResult[] = data.games.map((g: any) => ({
			matchId: g.id,
			playedAt: g.date,
			...(typeof g.playedAtMs === "number" ? { playedAtMs: g.playedAtMs } : {}),
			champion: g.champ,
			win: g.win,
			remake: g.remake,
			diedBefore6: g.d6 > 0,
			aheadAt15ThenDied: g.gd15 > 0 && g.dLate > 0,
		}));
		const path = learningsPath(environment, data.account);
		saveLearnings(path, foldAuditGames(loadLearnings(path), games));
	} catch (error) {
		// never let a filesystem error fail the tool call or the turn.
		logEvent("warn", "index", "learnings-fold-failed", undefined, error);
	}
}

/**
 * The runes, build, and swap names in `lines` that resolved to no item, rune, or summoner spell under `version`,
 * once showBuildStrip's own prefetch has loaded it: likely a model mistake (a misspelled or invented name), not
 * a missing icon. Shards (lines.runes[2]) and the skills line are plain text, never looked up, so never "unknown".
 */
function unknownBuildNames(lines: BuildLines, version: string): string[] {
	const [primary = [], secondary = [], , spells = [], ...extraRunes] = lines.runes;
	const runeNames = [primary, secondary, spells, ...extraRunes].flat();
	const itemNames = [...new Set(lines.build.flat().map(bareItem))];
	const swapNames = lines.swaps.flatMap((swap) => {
		const match = SWAP.exec(swap);
		return match ? [match[1], match[3]] : [];
	});
	const unknownItem = (name: string) => !isKnownName(name, ["item"], version) && !isKnownName(name.replace(/s$/, ""), ["item"], version);
	const unknownRune = (name: string) => !isKnownName(name, ["rune", "summoner"], version);
	return [...new Set([...itemNames.filter(unknownItem), ...runeNames.filter(unknownRune), ...swapNames.filter((name) => unknownItem(name) && unknownRune(name))])];
}

/**
 * Voxren Coach extension. The launcher loads this extension alone with no
 * built-in tools; this extension is the second defensive layer.
 */
export function installVoxrenCoach(
	pi: Pick<ExtensionAPI, "on" | "registerTool" | "setActiveTools" | "registerCommand" | "registerMessageRenderer" | "registerMarkdownTransformer" | "sendUserMessage" | "sendMessage" | "getThinkingLevel" | "setModel" | "setThinkingLevel"> & Partial<Pick<ExtensionAPI, "registerEntryRenderer" | "appendEntry">>,
	environment: Record<string, string | undefined> = process.env,
	custodian: RiotKeyCustodian | undefined = createRiotKeyCustodian(environment),
	readComposition?: () => Promise<Composition | undefined>,
	readRiotId: () => Promise<string | undefined> = readSignedInRiotId,
	createFooter?: (onChange: () => void) => LcuFooterHandle,
	lookupLane?: (name: string) => Promise<string | undefined>,
	exchangeLog: ExchangeLog = createExchangeLog(exchangeLogPath(environment)),
	// The Keys row's other custodians (src/config.ts): same createSecretCustodian, same
	// VOXREN_RIOT_KEY_STATE_DIR gate as `custodian` above, injectable for tests the same way it is.
	perplexityCustodian: RiotKeyCustodian | undefined = createSecretCustodian(environment, "perplexity"),
	typesafeCustodian: RiotKeyCustodian | undefined = createSecretCustodian(environment, "typesafe"),
	routeJudge: RouteJudge | undefined = createRouteJudge(environment),
	// Another Keys row custodian, after routeJudge so a caller passing routeJudge by position is unchanged.
	geminiCustodian: RiotKeyCustodian | undefined = createSecretCustodian(environment, "gemini"),
	// The pending cards' spinner and clock: on only while a UI is attached, stopped when a turn ends and at shutdown.
	motion: CardMotion = createCardMotion(),
	// Where the research gateway comes from; the smoke lab (src/lab/smoke-extension.ts) hands in one that answers from a cassette.
	makeGateway: typeof createLiveResearchGateway = createLiveResearchGateway,
	// Data Dragon's champion names for /config's champion row; a test hands in a fixed list.
	configChampionNames: () => Promise<ChampionNames> = () => loadChampionNames(),
	// The panel's one live read at a turn's end (clock and owned items); a test hands in a fixed game.
	readLiveFacts?: () => Promise<LivePanelFacts | undefined>,
) {
	const config = resolveCoach(environment, custodian !== undefined);
	// coach.log.ndjson beside exchanges.ndjson; undefined outside a launch turns logging off, same rule as the exchange log.
	setLogSink(createFileSink(coachHomePath(environment, "coach.log.ndjson")));
	// One source for the command read and the footer, so a recording holds each draft change once.
	const lcuSource = lcuSourceFromEnv(environment);
	readComposition ??= () => readLcuComposition(lcuSource.discover, lcuSource.makeClient);
	readLiveFacts ??= () => readLivePanel(lcuSource.makeClient);
	createFooter ??= (onChange) => createLcuFooterState({ onChange, ...lcuSource });
	const gateway = makeGateway(environment, custodian, { readSignedInRiotId: readRiotId, auditAccounts: () => config.accounts });
	lookupLane ??= (name: string) => gateway.championLane?.(name) ?? Promise.resolve(undefined);
	// One lookup per champion per session: a down Data Dragon costs one attempt, not one per turn or command.
	const laneMemo = new Map<string, Promise<string | undefined>>();
	const championLane = (name: string) => {
		let pending = laneMemo.get(name);
		if (!pending) laneMemo.set(name, (pending = lookupLane(name)));
		return pending;
	};
	// Started now so Data Dragon is usually warm by the first turn. Reassigned by a /config champion
	// save (invalidateLane below), otherwise the {{lane}} clause keeps describing the pre-edit champion.
	let launchLane = resolveLane(config, championLane, undefined);
	// The model's own load of another frame (voxren_command_frame): the footer's phase decides which names load, the live client read fills the frame, nothing is sent.
	const loadFrame = async (name: string): Promise<Record<string, unknown>> => {
		const phase = commandPhase(lcuFooter?.read());
		if (!phase) return { command: name, unavailable: COACH_YAML.prompts.frameNoPhase };
		const command = COACH_COMMANDS.find((entry) => entry.name === name);
		if (!command || !COACH_YAML.jev.command.phases[phase].includes(name)) return { command: name, unavailable: fillTemplate(COACH_YAML.prompts.frameNotOffered, { command: name }) };
		const fill = await fillCommandFrame(command, "", { config, readComposition: readComposition!, championLane, championNames: () => loadChampionNames() }, true);
		return fill.kind === "framed" ? { command: name, frame: fill.framed } : { command: name, unavailable: fill.message };
	};
	for (const coachTool of createCoachTools(withCommandFrames(gateway, loadFrame), motion, config.cardDetail)) {
		if (config.tools.includes(coachTool.name)) pi.registerTool(coachTool as any);
	}
	const riotKey = createRiotKeySession(custodian);
	// A zero-argument settings-style command: it never creates an LLM turn.
	pi.registerCommand(RIOT_KEY_COMMAND, {
		description: RIOT_KEY_COMMAND_DESCRIPTION,
		handler: async (args: string, ctx: any) => riotKey.open(args, ctx),
	});
	const configSession = createConfigSession(
		environment,
		config,
		() => {
			launchLane = resolveLane(config, championLane, undefined);
		},
		{ riot: custodian, perplexity: perplexityCustodian, typesafe: typesafeCustodian, gemini: geminiCustodian },
		(id, state, ctx) => {
			if (id === "riot") riotKey.sync(state, ctx);
		},
		undefined,
		configChampionNames,
	);
	// Same shape: a zero-argument settings-style command that never creates an LLM turn.
	pi.registerCommand(CONFIG_COMMAND, {
		description: CONFIG_COMMAND_DESCRIPTION,
		handler: async (args: string, ctx: any) => configSession.open(args, ctx),
	});
	// Model routing: a player's own model pick pins the model and their thinking pick pins thinking, each on its own; the router's picks (made while `routing`) never do.
	let modelPinned = config.pinnedAtLaunch;
	let thinkingPinned = config.thinkingPinned;
	let routing = false;
	// Recorded at session_start, since the markdown transformer gets no ctx: the one predicate deciding whether a
	// strip can be drawn at all, so the transformer (which strips the lines) and agent_end (which appends the
	// strip) never disagree -- print mode used to drop the lines with no strip to show for them.
	let hasUI = false;
	const stripGateOn = () => hasUI && imageProtocol();
	// The session's UI, kept for the same reason: the answer's rows take their colours from its theme, read at each draw so a
	// theme switch shows. Print mode has none, and its answer stays the text the model wrote.
	let sessionUi: { theme?: UiTheme } | undefined;
	// Answers on a resumed branch that came before the panel: they keep their rows, since no panel draws them.
	const unpanelled = new Set<string>();
	/** What the answer's Markdown keeps: the finished answer gives its calls and build to the panel where pictures draw; streaming, only the build lines go. */
	const answerShown = (markdown: string, streaming: boolean) => {
		if (!stripGateOn()) return markdown;
		if (!streaming && hasPanelContent(markdown) && !unpanelled.has(markdown.trim())) return withoutPanelRows(markdown);
		return withoutBuildLines(markdown);
	};
	const answerText = (markdown: string, width: number, streaming: boolean) => (sessionUi?.theme ? answerMarkdown(markdown, width, sessionUi.theme, streaming) : markdown);
	// Set by a command that sent its prompt. The next before_agent_start clears it, and applies its tier only when that turn's prompt is
	// this command's text: a command queued as a follow-up while Pi is busy never starts its own turn, and a typed prompt must never inherit its tier.
	let pendingCommand: { name: string; tier: TierName; text: string; routed: boolean } | undefined;
	// The automatic turn sent and not yet settled; `cancelled` once a typed turn has taken its place (#370).
	let autoTurn: { text: string; cancelled: boolean } | undefined;
	// Set when a typed question cancelled an automatic call: no automatic call starts until that question's turn does (#412), or
	// LANE_WAIT_MS passes, so a typed input that never becomes a turn cannot stop automatic calls for the rest of a champ select. A plain (ref'd) timer: an unref'd one may never fire on Windows Bun (AGENTS.md rule 8).
	let typedPending: ReturnType<typeof setTimeout> | undefined;
	const releaseTyped = (backstop = false) => {
		if (!typedPending) return;
		clearTimeout(typedPending);
		typedPending = undefined;
		if (backstop) {
			logEvent("warn", "index", "typed-gate-timeout", { waitedMs: INPUT_WAIT_MS + LANE_WAIT_MS });
			setTimeout(() => checkAuto?.(), 0);
		}
	};
	// Turns that started and were not the automatic one: an automatic call that found the coach busy tells a typed turn from other busy by this.
	let typedTurns = 0;
	// The last turn's route, for the footer (read through readFooterStats).
	let lastRoute: (Route & { command?: string; modelPinned?: boolean; thinkingPinned?: boolean }) | undefined;
	// Each command prompt this launch sent, keyed to the line the transcript shows for it (commandDisplay).
	const typedCommands = new Map<string, string>();
	const showTyped = (sent: string, typed: string) => {
		typedCommands.set(sent.trim(), typed);
		while (typedCommands.size > MAX_TYPED_COMMANDS) typedCommands.delete(typedCommands.keys().next().value as string);
	};
	// Set at session start while Data Dragon's names load; the first turn waits for it (bounded) so a display-name main finds its card.
	let namesReady: Promise<unknown> | undefined;
	// Set by the input hook when a plain question went out with the live game above it: the router grades the question, never the roster.
	let liveQuestion: { text: string; question: string } | undefined;
	// The tier grade starts beside the command router, so a plain question waits one Jev deadline, not two.
	let earlyGrade: { question: string; route: Promise<Route | undefined> } | undefined;
	const currentRouting = (ctx: any) => ({ model: ctx?.model?.id ?? (config.approvedModels.ids.includes(DEFAULT_MODEL_ID) ? DEFAULT_MODEL_ID : config.approvedModels.ids[0]), thinking: pi.getThinkingLevel() });
	/** The player typed a turn: stop the automatic turn still in flight (or starting) so theirs runs. True when there was one. */
	const cancelAuto = (ctx: any): boolean => {
		if (!autoTurn) return false;
		autoTurn.cancelled = true;
		if (ctx?.isIdle?.() === false) {
			turnAbortReason = "cancelled: the player typed a turn";
			ctx.abort?.();
		}
		return true;
	};
	// The draft this turn's command read, kept for the panel's header (who I am up against, my lane); cleared at every agent_end, panel or not.
	let turnComposition: Composition | undefined;
	const readKept = async () => (turnComposition = await readComposition!());
	const commands = registerCoachCommands(pi, config, readKept, championLane, (name, tier, text, input, auto) => {
		// An auto run was not typed, so it logs no input and tells "draft:auto" from a typed /draft.
		exchangeLog.command(auto ? `${name}:auto` : name, text, auto ? undefined : input);
		pendingCommand = { name, tier, text, routed: !auto && !input.startsWith("/") };
		if (auto) autoTurn = { text, cancelled: false };
		showTyped(text, auto ? `/${name} (auto)` : input);
	}, undefined, cancelAuto);
	// A command's prompt is instructions for the model: the transcript shows the line the player typed instead. Pi paints no band for
	// either kind of line any more, so the player's line takes a quote's bar and the thinking summaries collapse to one bar-and-label line.
	// Where the terminal draws pictures, an answer's build lines give way to the build strip, which draws them with their icons.
	pi.registerMarkdownTransformer?.((markdown, context) =>
		context.messageType === "user"
			? quoteUserText(commandDisplay(markdown, typedCommands) ?? markdown)
			: context.messageType === "assistant-thinking"
				? thinkingMarkdown(markdown, context.availableWidth)
				: answerText(answerShown(markdown, context.isStreaming), context.availableWidth, context.isStreaming),
	);
	pi.registerEntryRenderer?.<{ answer?: unknown; champions?: unknown; live?: unknown; status?: unknown; header?: unknown; ownPicks?: unknown }>(PANEL_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (typeof data?.answer !== "string") return undefined;
		const strings = (value: unknown) => (Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : []);
		const live = data.live as LivePanelFacts | undefined;
		const model = panelModel(data.answer, { champions: strings(data.champions), status: typeof data.status === "string" ? data.status : "", ...(live && typeof live.gameTimeSec === "number" && { live: { gameTimeSec: live.gameTimeSec, ownedItems: strings(live.ownedItems) } }) });
		return createPanel(theme, model, { header: data.header as PanelOptions["header"], ownPicks: strings(data.ownPicks) });
	});
	pi.registerEntryRenderer?.<{ source?: unknown; ownPicks?: unknown }>(BUILD_ENTRY_TYPE, (entry, _options, theme) =>
		typeof entry.data?.source === "string" ? createBuildStrip(theme, entry.data.source, Array.isArray(entry.data.ownPicks) ? entry.data.ownPicks.filter((name): name is string => typeof name === "string") : []) : undefined,
	);
	pi.registerEntryRenderer?.(AUTO_STOPPED_ENTRY_TYPE, (_entry, _options, theme) => createAutoStoppedLine(theme));
	pi.registerEntryRenderer?.(REPORT_HINT_ENTRY_TYPE, (_entry, _options, theme) => createDimLine(theme, REPORT_HINT_LINE));
	pi.registerEntryRenderer?.(FEEDBACK_PROMPT_ENTRY_TYPE, (_entry, _options, theme) => createDimLine(theme, FEEDBACK_PROMPT_LINE));
	pi.registerMessageRenderer(WHATS_NEW_MESSAGE_TYPE, (message, _options, theme) => (typeof message.content === "string" ? createWhatsNew(theme, message.content) : undefined));
	pi.registerMessageRenderer(FEEDBACK_LIST_MESSAGE_TYPE, (message, _options, theme) => (typeof message.content === "string" ? createWhatsNew(theme, message.content) : undefined));
	// Where the strip's icons come from: Data Dragon's version and CDN, loaded here when no call has needed it yet (a session
	// whose first answer is a build, with no main champion to warm it at launch). Unreachable, the strip draws names and a notice says why.
	const iconSource = async () => {
		try {
			return await gateway.loadDataDragonInfo();
		} catch (error) {
			iconsNotice("data-dragon-load-failed", error);
			return undefined;
		}
	};
	// The panel goes in under the answer once its icons are fetched (bounded); names stand in for any icon that does not land,
	// and a failed live read only leaves out the clock and the owned items, so a turn with calls never loses them.
	const showPanel = async (messages: any[], composition: Composition | undefined) => {
		const turn = turnStarts;
		const answer = [...messages].reverse().find((message) => message?.role === "assistant");
		const text = (Array.isArray(answer?.content) ? answer.content : [])
			.filter((part: any) => part?.type === "text")
			.map((part: any) => String(part.text))
			.join("\n")
			.trim();
		if (!hasPanelContent(text)) return false;
		const lines = buildLines(text);
		const swaps = panelModel(text, { champions: [], status: "" }).swaps.flatMap((swap) => [swap.from, swap.to]);
		const dd = await iconSource();
		let champions: string[] = [];
		if (dd) {
			const names = lines ? buildIconNames(lines) : { items: [], runes: [] };
			champions = await championsIn(text, dd.version, dd.base);
			const portraits = [...champions, ...(composition?.enemyLaner ? [composition.enemyLaner] : []), ...(composition?.selfChampion ? [composition.selfChampion] : [])];
			await Promise.all([prefetchItemIcons([...names.items, ...swaps], dd.version, dd.base), prefetchRuneIcons([...names.runes, ...swaps], dd.version, dd.base), prefetchChampionIcons(portraits, dd.version, dd.base)]);
			// Prefetched, so a name that still resolved to no item, rune, or summoner spell is likely the model's mistake, not a missing icon.
			const unknown = lines ? unknownBuildNames(lines, dd.version) : [];
			if (unknown.length) logEvent("warn", "index", "build-strip-unknown-names", { names: unknown });
		}
		// The names this turn's data never mentioned are the coach's own picks: the panel names them, so the player can weigh them.
		const sources = messages
			.filter((message) => message?.role === "toolResult" && !message.isError && SOURCE_TOOLS.has(message.toolName))
			.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
			.filter((part: any) => part?.type === "text")
			.map((part: any) => String(part.text))
			.join("\n");
		const ownPicks = lines ? unsourcedBuildNames(lines, sources) : [];
		if (ownPicks.length) logEvent("info", "index", "build-strip-own-picks", { names: ownPicks });
		let live: LivePanelFacts | undefined;
		if (lcuFooter?.read().kind === "liveGame") {
			live = await readLiveFacts!();
			if (!live) logEvent("warn", "index", "panel-live-read-failed", { reason: "the live client gave no game state at the turn's end" });
		}
		const header = composition && (composition.enemyLaner || composition.selfLane || composition.selfChampion) ? { ...(composition.selfChampion && { self: composition.selfChampion }), ...(composition.enemyLaner && { opponent: composition.enemyLaner }), detail: composition.selfLane ?? "" } : undefined;
		if (turn !== turnStarts) {
			logEvent("info", "index", "panel-skipped", { reason: "a new turn started before the panel was ready, so the answer keeps its rows" });
			return false;
		}
		if (!pi.appendEntry) return false;
		pi.appendEntry(PANEL_ENTRY_TYPE, { answer: text, ...(lines && { source: lines.source }), ...(ownPicks.length ? { ownPicks } : {}), champions, ...(live && { live }), status: panelStatus(lastRoute, messages), ...(header && { header }) });
		return true;
	};
	/** Each text part of an assistant message, as Pi hands them to the transformer one by one. */
	const textParts = (message: any): string[] => (Array.isArray(message?.content) ? message.content : []).filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => String(part.text).trim());
	/** Rows hidden for a panel that never landed come back: the texts join `unpanelled` and every cached line is redrawn. */
	const restoreRows = (texts: string[]) => {
		for (const text of texts) unpanelled.add(text);
		repaint?.(true);
	};
	// False from before_agent_start until this run's agent_end; agent_settled restores the last answer's rows when it stayed false (an aborted run).
	let runEnded = true;
	// Counts turns started: a panel built across a new turn's start is dropped, so it never lands under the next prompt.
	let turnStarts = 0;
	const working = createWorkingText();
	// The /flow panel (a UX spike): the tree behind each command with this session's numbers, fed by the same events
	// the exchange log records. A zero-argument panel, TUI only, never a model turn; it repaints through the surface.
	let repaint: ((force?: boolean) => void) | undefined;
	let stopCellWatch: (() => void) | undefined;
	let stopCursorFilter: (() => void) | undefined;
	// Notices raised after launch (an icon fetch failing, the cell-size query timing out) fold into the same
	// header line the launch-time notes already draw, and ask for a repaint so a late one shows with no restart.
	const launchNotes = config.labels.notes;
	setNoticeHandler(() => {
		config.labels.notes = [...launchNotes, ...noticeLines()];
		repaint?.(true);
	});
	const treeStats = createTreeStats({ onChange: () => repaint?.() });
	const tree = commandTree(COACH_COMMANDS, COACH_YAML.commands, config.disabledTools);
	// The panel takes the editor's place while open: Escape or Enter gives the editor back, and a typed character closes it
	// and lands in the editor, so a player who starts typing a command never notices the panel had the keys.
	const openFlow = (ctx: any) =>
		ctx.ui.custom((tui: any, theme: any, _keybindings: unknown, done: (value: undefined) => void) =>
			new TreePanel(
				theme,
				tree,
				() => treeStats.read(),
				{
					requestRender: () => tui?.requestRender?.(),
					done: () => done(undefined),
					quit: () => ctx.shutdown?.(),
					onType: (text) => ctx.ui.setEditorText?.(`${ctx.ui.getEditorText?.() ?? ""}${text}`),
					settings: {
						read: () => config.commands,
						autoForced: config.autoComp,
						save: (name, next) => {
							const saved = saveCommandSettings(profilePath(environment), name, next);
							if (!saved) {
								const command = COACH_COMMANDS.find((entry) => entry.name === name);
								ctx.ui.notify(`"${next.args}" is not an argument /${name} takes. Usage: /${name} ${command?.args ?? ""}`.trim(), "error");
								return false;
							}
							config.commands = saved;
							checkAuto?.();
							return true;
						},
						choices: (name) => commandChoices(name, coachHomePath(environment, "references")),
					},
				},
				motion,
			),
		);
	pi.registerCommand(TREE_COMMAND, {
		description: TREE_COMMAND_DESCRIPTION,
		handler: async (args: string, ctx: any) => {
			if (args.trim().length > 0) return refuse(ctx, TREE_NO_ARGS_MESSAGE);
			if (!ctx.hasUI || ctx.mode !== "tui") return refuse(ctx, TREE_TUI_ONLY_MESSAGE);
			await openFlow(ctx);
		},
	});
	// /update: pull the newest coach on its branch and reload the extension in place (Pi's reload: same session, fresh modules).
	// The commit this extension instance was loaded from: a reload re-imports this file, so it is read again then.
	const loadedCheckout = readCheckout(REPO_DIR);
	pi.registerCommand(UPDATE_COMMAND, {
		description: UPDATE_COMMAND_DESCRIPTION,
		handler: async (args: string, ctx: any) => {
			if (args.trim()) return refuse(ctx, "/update takes no arguments.");
			if (ctx.isIdle?.() === false) return refuse(ctx, "/update waits for this run to end; type it again then.");
			const pulled = await pullLatest(REPO_DIR);
			if (!pulled.ok) return refuse(ctx, pulled.reason);
			const [loaded, now] = await Promise.all([loadedCheckout, readCheckout(REPO_DIR)]);
			if (loaded?.head === now?.head) return ctx.ui?.notify?.(`Already the newest: ${versionLabel(now) ?? "this checkout"}.`, "info");
			clearNotice(UPDATE_NOTICE_ID);
			logEvent("info", "update", "reloading", { from: loaded?.head, to: now?.head });
			// The reloaded extension's session_start shows what changed; the old ctx is stale after this.
			await ctx.reload?.();
		},
	});
	// The /report hint (src/report-hint.ts): once per cause in a session. The live read failing is noted by the input hook and said after that turn's answer.
	const reportHints = createReportHints();
	let liveReadFailed = false;
	// The last finished run's command, for a /feedback row: a typed question is "question", an auto run ends in ":auto".
	let lastRunCommand: string | undefined;
	// /report [note]: this session's runs and log lines, handed to a Claude Code session that starts at once. Never a model turn.
	let debugAfterRun: (() => void) | undefined;
	pi.registerCommand(DEBUG_COMMAND, {
		description: DEBUG_COMMAND_DESCRIPTION,
		handler: async (args: string, ctx: any) => {
			// Never rejects: after a run it is called with nothing awaiting it, so a failure is logged and said, not thrown.
			const start = async () => {
				try {
					const started = await startDebugSession(environment, { note: args.trim(), sessionId: ctx?.sessionManager?.getSessionId?.(), state: { lcu: lcuFooter?.read(), notices: config.labels.notes, route: lastRoute } });
					if (!started.ok) return refuse(ctx, started.message);
					say(`Debug session ${started.id} is working on it. Open it: claude attach ${started.id}`);
					// The session still starts without the picture; the player hears why it has only the text.
					if (started.noPicture) ctx.ui?.notify?.(`It has no picture of this window: ${started.noPicture}.`, "warning");
				} catch (error) {
					logEvent("error", "debug-handoff", "command-failed", undefined, error);
					refuse(ctx, "/report failed before it could start a session; `just logs` has the cause.");
				}
			};
			// Print mode has no UI to notify: the session id goes to stdout, where a caller can read it.
			const say = (message: string) => (ctx.mode === "print" ? void process.stdout.write(`${message}\n`) : ctx.ui?.notify?.(message, "info"));
			// A run still going has no line in exchanges.ndjson yet: the handoff waits for it, so the bundle holds the run on screen.
			if (ctx.isIdle?.() !== false) return start();
			// One per run: a second /report would bundle the same run, so it is told the first is waiting, not queued in its place.
			if (debugAfterRun) return say("A debug session is already waiting for this run to end.");
			debugAfterRun = () => void start();
			ctx.ui.notify("The debug session starts when this run ends, with the run in it.", "info");
		},
	});
	// /feedback good|meh|bad [note], /feedback list: one JSON line per mark in the coach home, read back by list. Never a model turn.
	pi.registerCommand(FEEDBACK_COMMAND, {
		description: FEEDBACK_COMMAND_DESCRIPTION,
		handler: async (args: string, ctx: any) => {
			const parsed = parseFeedbackArgs(args);
			if (parsed.kind === "usage") return refuse(ctx, FEEDBACK_USAGE_MESSAGE);
			const path = coachHomePath(environment, FEEDBACK_FILE);
			if (!path) return refuse(ctx, FEEDBACK_NO_HOME_MESSAGE);
			if (parsed.kind === "list") {
				const text = feedbackListText(readFeedback(path));
				// Print mode has no transcript to draw in: the rows go to stdout, where a caller can read them.
				if (ctx.mode === "print") return void process.stdout.write(`${text}\n`);
				return pi.sendMessage({ customType: FEEDBACK_LIST_MESSAGE_TYPE, content: text, display: true });
			}
			const row = feedbackRow({ build: config.labels.version, command: lastRunCommand, mark: parsed.mark, note: parsed.note });
			const failure = appendFeedback(path, row);
			if (failure) return refuse(ctx, `/feedback could not write ${path}: ${failure}`);
			logEvent("info", "feedback", "marked", { mark: row.mark, command: row.command });
			const said = `Noted ${row.mark} for ${row.command === "question" ? "your question" : `/${row.command}`}${row.note ? ` (${row.note})` : ""}; feedback.jsonl stays on this machine.`;
			if (ctx.mode === "print") return void process.stdout.write(`${said}\n`);
			ctx.ui?.notify?.(said, "info");
		},
	});

	const exactTools = [...config.tools];
	const activateExactTools = () => pi.setActiveTools([...exactTools]);
	let lcuFooter: LcuFooterHandle | undefined;
	let stopUpdateCheck: (() => void) | undefined;
	// The header's build label and, once per new commit, what changed since the player last ran the coach.
	// Then a look for newer commits every UPDATE_CHECK_MS: loaded at once while the player is between games
	// (VOXREN_COACH_AUTO_UPDATE=0 turns that off), otherwise a header line saying /update is ready.
	const startUpdateCheck = (ctx: any) => {
		const lastSeenPath = coachHomePath(environment, "last-seen-commit");
		void (async () => {
			const checkout = await readCheckout(REPO_DIR);
			config.labels.version = versionLabel(checkout);
			repaint?.(true);
			if (!checkout || !lastSeenPath) return;
			const lastSeen = readLastSeen(lastSeenPath);
			const notes = lastSeen && lastSeen !== checkout.head ? await commitsBetween(REPO_DIR, lastSeen, "HEAD") : { count: 0, lines: [] };
			if (lastSeen !== checkout.head) writeLastSeen(lastSeenPath, checkout.head);
			// Under the rows: the next tip from coach.yaml, remembered beside profile.json so two starts never show the same one,
			// then the /report hint when the log the player left ends on an error.
			const statePath = coachHomePath(environment, NOTICE_STATE_FILE)!;
			const state = readNoticeState(statePath);
			const tip = nextTip(COACH_YAML.tips, state.tip);
			if (tip) writeNoticeState(statePath, { ...state, tip: tip.index });
			const trailing = tip ? [`tip: ${tip.text}`] : [];
			if (lastRunFailed(coachHomePath(environment, "coach.log.ndjson"), ctx?.sessionManager?.getSessionId?.()) && reportHints.note("last-run-error")) trailing.push(REPORT_HINT_LINE);
			if (notes.count || trailing.length) pi.sendMessage({ customType: WHATS_NEW_MESSAGE_TYPE, content: whatsNewText(versionLabel(checkout)!, notes, trailing), display: true });
		})().catch((error) => logEvent("warn", "update", "startup-note-failed", undefined, error));
		const check = async () => {
			const checkout = await readCheckout(REPO_DIR);
			if (!checkout || checkout.branch === "HEAD") return;
			const notes = await pendingNotes(REPO_DIR, checkout, (await loadedCheckout)?.head);
			if (!notes.count) return clearNotice(UPDATE_NOTICE_ID);
			const between = ["closed", "lobby"].includes(lcuFooter?.read().kind ?? "closed");
			if (environment.VOXREN_COACH_AUTO_UPDATE?.trim() !== "0" && between && ctx.isIdle?.() !== false) {
				logEvent("info", "update", "auto-update", { count: notes.count });
				return pi.sendUserMessage(`/${UPDATE_COMMAND}`, { expandPromptTemplates: true });
			}
			raiseNotice(UPDATE_NOTICE_ID, "info", `Update ready: ${notes.count} new commit${notes.count === 1 ? "" : "s"} on ${checkout.branch}; type /${UPDATE_COMMAND} to load it in place.`, "update", "update-ready", { count: notes.count });
		};
		const run = () => void check().catch((error) => logEvent("warn", "update", "check-failed", undefined, error));
		const timer = setInterval(run, UPDATE_CHECK_MS);
		// Housekeeping nothing awaits (AGENTS.md rule 8).
		timer.unref?.();
		run();
		return () => clearInterval(timer);
	};
	// The header's Jev badge: only while the screen is on, so a launch without the key shows no trace of it.
	let jevBadge: JevBadgeHandle | undefined;
	// One deadline per turn: before_agent_start arms it, agent_settled disarms it (a turn always
	// settles, aborted or not -- see the idle-marker comment below). ctx.abort() only stops the
	// stuck turn, never the session, so nothing extra is needed to keep the TUI open afterward.
	let turnTimer: ReturnType<typeof setTimeout> | undefined;
	let turnAbortReason: string | undefined;
	// Auto /draft checks on every footer change and again whenever a run settles: a draft that locked while the coach
	// was busy runs as soon as it is free, even when the client has nothing new to report.
	let checkAuto: (() => void) | undefined;
	// A resumed session's BUILD_ENTRY_TYPE entries (session_start, below) carry no cached icons: gather every one's
	// names once and prefetch them together, then repaint so they draw as icons instead of text.
	const resumeBuildIcons = async (ctx: any): Promise<void> => {
		const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
		const panels = entries.filter((entry) => entry?.type === "custom" && entry.customType === PANEL_ENTRY_TYPE);
		const portraits = panels.flatMap((entry) => [...(Array.isArray(entry.data?.champions) ? entry.data.champions : []), ...(typeof entry.data?.header?.opponent === "string" ? [entry.data.header.opponent] : [])]).filter((name: unknown): name is string => typeof name === "string");
		const sources = entries
			.filter((entry) => entry?.type === "custom" && (entry.customType === BUILD_ENTRY_TYPE || entry.customType === PANEL_ENTRY_TYPE))
			.map((entry) => entry.data?.source)
			.filter((source: unknown): source is string => typeof source === "string");
		if (!sources.length && !portraits.length) return;
		const dd = await iconSource();
		if (!dd) return;
		const items = new Set<string>();
		const runes = new Set<string>();
		for (const source of sources) {
			const lines = buildLines(source);
			if (!lines) continue;
			const names = buildIconNames(lines);
			names.items.forEach((name) => items.add(name));
			names.runes.forEach((name) => runes.add(name));
		}
		await Promise.all([prefetchItemIcons([...items], dd.version, dd.base), prefetchRuneIcons([...runes], dd.version, dd.base), prefetchChampionIcons(portraits, dd.version, dd.base)]);
		repaint?.(true);
	};
	pi.on("session_start", async (_event: any, ctx?: any) => {
		setLogContext({ sessionId: ctx?.sessionManager?.getSessionId?.() });
		stopUpdateCheck?.();
		stopUpdateCheck = ctx?.hasUI ? startUpdateCheck(ctx) : undefined;
		modelPinned = config.pinnedAtLaunch;
		thinkingPinned = config.thinkingPinned;
		pendingCommand = undefined;
		lastRoute = undefined;
		treeStats.reset();
		activateExactTools();
		lcuFooter?.stop();
		jevBadge?.stop();
		// Cards animate only with a player at the terminal; print mode and a headless run keep their static lines.
		motion.enable(Boolean(ctx?.hasUI));
		// The markdown transformer gets no ctx, so this is the one place stripGateOn's hasUI is ever set.
		hasUI = Boolean(ctx?.hasUI);
		sessionUi = hasUI ? ctx.ui : undefined;
		repaint = undefined;
		// On from the env var or the /flow row, read live: a toggle in the tree takes effect on the next check.
		const runAuto = async (name: string, args: string, wanted: () => boolean) => {
			const typedBefore = typedTurns;
			try {
				const outcome = await commands[name]?.(args, ctx, wanted);
				return outcome === "busy" && typedTurns !== typedBefore ? "typed" : outcome;
			} catch (error) {
				logEvent("warn", "index", `auto-${name}-failed`, undefined, error);
			}
		};
		const autoComp = createAutoComp((call, wanted) => runAuto(call, "", wanted));
		// Game start and end: each event is switched by the auto row of the command it runs.
		const gameEvents = createGameEvents(
			(event) => {
				const { command, args } = routeGameEvent(event);
				// A command whose tool is off would raise an error toast after every game; the header already says that tool is off.
				const missing = COACH_COMMANDS.find((entry) => entry.name === command)?.needs.find((tool) => config.disabledTools.includes(tool));
				if (missing) {
					logEvent("info", "index", "game-event-skipped", { event: event.event, command, reason: `${missing} is off in this launch` });
					return undefined;
				}
				return runAuto(command, args, () => true);
			},
			(event) => autoOn(config.autoComp, config.commands[GAME_EVENT_COMMANDS[event]]),
		);
		releaseTyped();
		checkAuto = () => {
			if (typedPending || !lcuFooter) return;
			const state = lcuFooter.read();
			const idle = ctx.isIdle?.() !== false;
			if (autoOn(config.autoComp, config.commands[AUTO_COMMAND])) autoComp(state, idle);
			gameEvents(state, idle);
		};
		lcuFooter = ctx?.hasUI
			? createFooter(() => {
					repaint?.();
					checkAuto?.();
				})
			: undefined;
		jevBadge = ctx?.hasUI && config.passageJudge ? createJevBadge({ onChange: () => repaint?.() }) : undefined;
		repaint = installCoachSurface(ctx, riotKey.headerLine, config.labels, () => lcuFooter?.read() ?? { kind: "closed" }, pi, () => jevBadge?.read(), () => lastRoute, () => commandMarks(treeStats.read()));
		// Never awaited: session_start must not wait on the network for this.
		// A resumed answer with calls and no panel entry came before the panel: it keeps its rows (answerShown).
		unpanelled.clear();
		const branch: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
		const panelled = new Set(branch.filter((entry) => entry?.type === "custom" && entry.customType === PANEL_ENTRY_TYPE).map((entry) => entry.data?.answer));
		for (const entry of branch) {
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
			// The panel keeps the message's parts joined; Pi transforms them one by one, so a panelled message panels every part.
			const parts = textParts(entry.message);
			if (!panelled.has(parts.join("\n").trim())) for (const part of parts) unpanelled.add(part);
		}
		if (stripGateOn()) void resumeBuildIcons(ctx).catch((error) => logEvent("warn", "index", "resume-build-icons-failed", undefined, error));
		// The Setup-row gate (#367) needs the rune, summoner spell, and item tables, which otherwise load only on an image terminal after a prefetch. Only a player at the terminal sees a Setup row. Never awaited: the first paint must not wait on the network.
		// The same load fills the champion list that maps a display name (Wukong) to its card, so the first turn waits for it (bounded, below).
		namesReady = ctx?.hasUI
			? gateway
					.loadDataDragonInfo()
					.then((dd) => loadKnownNames(dd.version, dd.base))
					.catch((error) => logEvent("warn", "index", "known-names-load-failed", undefined, error))
			: undefined;
		// Pictures off is worth a notice only with a player at the terminal to read it.
		if (ctx?.hasUI) syncPicturesNotice("startup", environment);
		// Known only after a real draw otherwise (the first chart or icon); start it now, unawaited, so a missing rasterizer still reports at startup.
		if (ctx?.hasUI && imageProtocol()) void loadRasterizer();
		// WezTerm under ConPTY places nothing right while the cursor is hidden (see keepCursorShown).
		if (ctx?.hasUI && ctx.mode === "tui") {
			stopCursorFilter?.();
			stopCursorFilter = keepCursorShown();
		}
		// xterm.js pictures are drawn at the terminal's exact cell size: a new size redraws the whole screen.
		stopCellWatch?.();
		stopCellWatch = ctx?.hasUI && ctx.mode === "tui" && ctx.ui?.onTerminalInput
			? watchCellSize(
					(handler) => ctx.ui.onTerminalInput(handler),
					(text) => process.stdout.write(text),
					() => repaint?.(true),
					() => syncPicturesNotice("cell-size-timeout", environment),
				)
			: undefined;
		// The flow tree is the startup view: it opens where the editor sits and Escape (or typing) brings the editor back.
		if (ctx?.hasUI && ctx.mode === "tui" && ctx.ui?.custom) openFlow(ctx).catch((error: unknown) => logEvent("warn", "index", "flow-open-failed", undefined, error));
		// With a player at the terminal the research service starts now, so the first video or search call does not wait for it. A print-mode run starts it only if a tool asks.
		if (ctx?.hasUI) {
			gateway.warmResearch();
			gateway.enableNoteBuilds();
		}
		await riotKey.load(ctx);
	});
	// AGENTS.md rule 3: a plain question typed in game is sent with the live game read for it, the way /comp reads it. The footer's last
	// state says whether a game is on, so nothing is read outside one; with no footer (print mode) the read itself answers. A command
	// line and a command's own prompt (source "extension") pass untouched, and so does the question when the read finds no game.
	pi.on("input", async (event: any, ctx?: any) => {
		const question = String(event?.text ?? "").trim();
		// A grade left by an earlier question (a command answered it) must never meet a later turn with the same text.
		earlyGrade = undefined;
		// A plain question typed while an automatic turn runs would be steered into it: stop that turn and let the question start its own.
		if (event?.source !== "extension" && question && !question.startsWith("/") && cancelAuto(ctx)) {
			releaseTyped();
			typedPending = setTimeout(() => releaseTyped(true), INPUT_WAIT_MS + LANE_WAIT_MS);
			for (let waited = 0; waited < INPUT_WAIT_MS && ctx?.isIdle?.() === false; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const footer = lcuFooter?.read();
		if (event?.source === "extension" || !question || question.startsWith("/")) return { action: "continue" as const };
		// The command router: Jev picks the command that fits the question and the client phase, and that command answers it in its frame.
		// No pick, a failed Jev, or a command that cannot run (no draft read) sends the question plain, as before the router.
		const phase = commandPhase(footer);
		if (phase && !event?.images?.length) {
			if (!(modelPinned && thinkingPinned)) {
				try {
					earlyGrade = {
						question,
						route: routePrompt({ prompt: question, pinned: false, accounts: config.accounts, current: currentRouting(ctx) }, routeJudge).catch((error: unknown) => {
							logEvent("warn", "index", "early-route-failed", undefined, error);
							return undefined;
						}),
					};
				} catch (error) {
					logEvent("warn", "index", "early-route-failed", undefined, error);
				}
			}
			const routed = await routeCommand({ text: question, phase, accounts: config.accounts }, routeJudge);
			logEvent("info", "index", "route-command", { phase, command: routed.command ?? "none", p: routed.p, ms: routed.ms, failure: routed.failure });
			if (routed.command && (await commands[routed.command]("", ctx, false, question)) !== "unrouted") return { action: "handled" as const };
		}
		if (footer && footer.kind !== "liveGame") return { action: "continue" as const };
		let composition: Composition | undefined;
		try {
			composition = await readComposition?.();
		} catch (error) {
			// The question still goes out as typed: the system prompt then sends the player to /comp, and the /report hint follows the answer.
			logEvent("warn", "index", "live-question-read-failed", undefined, error);
			liveReadFailed = true;
		}
		if (!composition?.inGame) return { action: "continue" as const };
		const text = liveQuestionPrompt(composition.text, question);
		liveQuestion = { text, question };
		showTyped(text, question);
		return { action: "transform" as const, text, images: event.images };
	});
	pi.on("before_agent_start", async (event: any, ctx: any) => {
		turnStarts++;
		runEnded = false;
		activateExactTools();
		clearTimeout(turnTimer);
		turnAbortReason = undefined;
		turnTimer = setTimeout(() => {
			turnAbortReason = "timeout";
			ctx?.abort?.();
			// Print mode has no UI: Pi's own nonzero exit on an aborted final message is the signal there.
			if (ctx?.hasUI) ctx.ui?.notify?.(`Turn exceeded ${config.turnTimeoutMs}ms (VOXREN_COACH_TURN_TIMEOUT_MS); aborted.`, "error");
		}, config.turnTimeoutMs);
		turnTimer.unref?.();
		// A turn that is not the automatic one sent has taken its place; an automatic one already given up on stops as it starts.
		if (autoTurn && event.prompt !== autoTurn.text) autoTurn = undefined;
		if (!autoTurn) typedTurns++;
		// The typed turn has started (not the cancelled automatic one, which may still be starting): automatic calls may run again.
		if (!autoTurn?.cancelled) releaseTyped();
		if (autoTurn?.cancelled) {
			turnAbortReason = "cancelled: the player typed a turn";
			ctx?.abort?.();
		}
		// The signed-in account (from the footer poller's last state, no fresh client read) names the player; the env-built prompt stands while the client is closed.
		const signedIn = lcuPlayerName(lcuFooter?.read());
		// Recorded before routing, so a newly signed-in account is scrubbed from the prompt Jev grades on this very turn.
		// A newly-seen signed-in account is remembered in the profile so it survives the client closing later. Still
		// turn-triggered off the footer's last state (AGENTS.md rule 3: never the poll itself), and idempotent: the
		// profile is re-read fresh each turn, so an already-known id is a no-op and writes only once per new name.
		if (signedIn) {
			// A failed write (a locked or read-only coach home) must not cost the turn its coach prompt below.
			try {
				const { profile } = updateProfile(profilePath(environment), (current) => applyLcuSignIn(current, signedIn) ?? current);
				config.accounts = resolveKnownAccounts(undefined, profile, parseAuditAccounts(environment.VOXREN_COACH_ACCOUNTS));
			} catch (error) {
				logEvent("warn", "index", "profile-save-failed", undefined, error);
			}
		}
		const command = pendingCommand?.text === event.prompt ? pendingCommand : undefined;
		pendingCommand = undefined;
		const asked = liveQuestion && liveQuestion.text === event.prompt ? liveQuestion.question : (event.prompt ?? "");
		liveQuestion = undefined;
		const early = earlyGrade?.question === asked.trim() ? earlyGrade : undefined;
		earlyGrade = undefined;
		treeStats.turnStart(command?.name);
		// The launch lane (env, else the main champion's primary lane) has no client to consult; a client-assigned lane only ever reaches the command prompt, not this one.
		// A slow or unreachable Data Dragon must not hold the turn: after LANE_WAIT_MS the prompt goes out without a lane word and later turns pick it up.
		// A plain timer cleared after the race, not an unref'd one: Bun never fires an unref'd timer when nothing else is pending, so a hung lookup hung the turn.
		// The lane and the names are each waited for within the one LANE_WAIT_MS: a lane that resolved in time survives a names timeout.
		// Names that miss it are not waited for again (only the first turn pays), and one line says so.
		const timedOut = Symbol("timed out");
		let laneTimer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<typeof timedOut>((resolve) => (laneTimer = setTimeout(resolve, LANE_WAIT_MS, timedOut)));
		const [found, names] = await Promise.all([Promise.race([launchLane, deadline]), Promise.race([namesReady, deadline])]).finally(() => clearTimeout(laneTimer));
		const lane = found === timedOut ? undefined : found;
		if (names === timedOut) {
			namesReady = undefined;
			logEvent("warn", "index", "known-names-slow", { waitedMs: LANE_WAIT_MS });
		}
		// The same Riot ID the riotId prompt line names: signed-in first, else the first configured account. loadLearnings never throws, so a missing or corrupt file just yields "".
		// learningsOff (issue #33 stage 5) stops recall without touching the file on disk.
		const activeRiotId = signedIn ?? config.accounts[0];
		const learningsSummary = !config.learningsOff && activeRiotId ? normalizeTakeaway(summarizeLearnings(loadLearnings(learningsPath(environment, activeRiotId)))) : "";
		// A routed question runs one frame already; the phase's other commands are offered by name for the model to load (voxren_command_frame). Typed commands, automatic calls and plain turns are offered none.
		const framePhase = commandPhase(lcuFooter?.read());
		const frames =
			command?.routed && framePhase && config.tools.includes(VOXREN_COMMAND_FRAME_TOOL)
				? COACH_YAML.jev.command.phases[framePhase].flatMap((name) => {
						const entry = COACH_COMMANDS.find((candidate) => candidate.name === name);
						return entry && entry.name !== command.name ? [{ name, description: entry.description }] : [];
					})
				: [];
		const systemPrompt = coachSystemPrompt({
			accounts: signedIn ? [signedIn, ...config.accounts] : config.accounts,
			champion: config.champion,
			lane,
			passageJudge: config.passageJudge,
			disabledTools: config.disabledTools,
			learningsSummary,
			card: config.champion ? promptCard(cardForChampion(config.champion), gateway.dataDragonInfo?.()?.version) : undefined,
			frames,
		});
		// Started before routing below, so a routing failure's own log line still carries this turn's run id rather than the previous turn's (or none, on the session's first turn).
		const runId = exchangeLog.start(event.prompt ?? "", { systemPrompt, toolsAvailable: [...exactTools] });
		setLogContext({ sessionId: ctx?.sessionManager?.getSessionId?.(), runId });
		// Pi applies a model switched here to this same turn. A routing failure must never hold the turn: it keeps the current model.
		try {
			const current = currentRouting(ctx);
			const currentModel = current.model;
			// The early grade saw the model and thinking at input time; a pick the player made since is applied below (the pins win), so it is not regraded.
			const graded = await early?.route;
			const route = modelPinned && thinkingPinned ? undefined : (graded ?? (await routePrompt({ prompt: asked, commandTier: command?.tier, pinned: false, accounts: config.accounts, current }, routeJudge)));
			// The player may pick a model or thinking level while Jev grades (up to ROUTE_DEADLINE_MS): the flags are read again here, so their pick wins.
			if (!route || (modelPinned && thinkingPinned)) {
				lastRoute = { ...current, source: "pinned" };
			} else {
				lastRoute = {
					...route,
					...(command && { command: command.routed ? `${command.name} (routed)` : command.name }),
					...(modelPinned && { model: currentModel, modelPinned }),
					...(thinkingPinned && { thinking: pi.getThinkingLevel(), thinkingPinned }),
				};
				routing = true;
				try {
					if (!modelPinned) {
						let applied = route.model === ctx?.model?.id;
						const target = applied ? undefined : ctx?.modelRegistry?.find(config.approvedModels.provider, route.model);
						// Pi's setModel resets thinking to the new model's default: put a pinned level back, still inside `routing` so it never pins.
						const playerThinking = pi.getThinkingLevel();
						if (target) applied = (await pi.setModel(target)) !== false; // false = provider not signed in: keep the current model
						if (thinkingPinned && pi.getThinkingLevel() !== playerThinking) pi.setThinkingLevel(playerThinking);
						// A Jev pick whose model never took over leaves the current one held; a command or fallback keeps its own word.
						if (!applied) lastRoute = { ...lastRoute, model: currentModel, ...(route.source === "jev" && { source: "held" as const }) };
					}
					if (!thinkingPinned) pi.setThinkingLevel(route.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
				} finally {
					routing = false;
				}
			}
		} catch (error) {
			logEvent("warn", "index", "route-failed", undefined, error);
			lastRoute = undefined;
		}
		// Clear mutable composition inputs and force the complete prompt, rather
		// than appending a policy to host context.
		event.systemPromptOptions.forceSystemPrompt = systemPrompt;
		event.systemPromptOptions.customPrompt = undefined;
		event.systemPromptOptions.appendSystemPrompt = "";
		event.systemPromptOptions.contextFiles = [];
		event.systemPromptOptions.skills = [];
		event.systemPromptOptions.selectedTools = [...exactTools];
		// The route row: TUI only, so print mode's output and a headless session carry no extra message.
		if (!ctx?.hasUI || !lastRoute) return { systemPrompt };
		return { systemPrompt, message: { customType: ROUTE_MESSAGE_TYPE, content: routeText(lastRoute), display: true, details: lastRoute } };
	});
	pi.registerMessageRenderer<RouteView>(ROUTE_MESSAGE_TYPE, (message, options, theme) =>
		typeof message.details?.source === "string" && typeof message.details.model === "string" ? createRouteRow(theme, message.details, options.outputPad) : undefined,
	);
	pi.on("context", (event) => {
		const messages = withoutRouteRows(event.messages);
		return messages ? { messages } : undefined;
	});
	pi.on("model_select", async (event: any, ctx: any) => {
		if (event.model?.provider === config.approvedModels.provider && config.approvedModels.ids.includes(event.model?.id)) {
			// A restore replays a saved session's model: not a player choice.
			if (!routing && event.source !== "restore") modelPinned = true;
			return;
		}
		// Pi's --models limits cycling only; a direct model selection must end
		// the session before an unapproved model can receive a prompt.
		ctx?.abort?.();
		ctx?.shutdown?.();
	});
	pi.on("thinking_level_select", async () => {
		if (!routing) thinkingPinned = true;
	});
	pi.on("tool_call", async (event: any) => {
		// learningsOff (issue #33 stage 5) can flip mid-session via /config's Learnings row (config.ts's
		// applyProfileChange mutates this same `config` object in place), but `exactTools` is a snapshot
		// taken at install/turn-start. Only a fresh read of config.learningsOff here actually stops
		// voxren_remember from writing for the rest of the running session, with no restart.
		if (event.toolName === VOXREN_REMEMBER_TOOL && config.learningsOff) return { block: true, reason: BLOCKED_TOOL_MESSAGE, terminate: true };
		if (!exactTools.includes(event.toolName)) return { block: true, reason: BLOCKED_TOOL_MESSAGE, terminate: true };
		return undefined;
	});
	pi.on("tool_execution_start", async (event: any, ctx: any) => {
		motion.callStarted(event.toolCallId);
		exchangeLog.toolStart(event);
		treeStats.toolStart(event);
		working.start(event, ctx);
		jevBadge?.start(event);
	});
	pi.on("tool_execution_end", async (event: any, ctx: any) => {
		motion.callEnded(event.toolCallId);
		exchangeLog.toolEnd(event);
		treeStats.toolEnd(event);
		working.end(event, ctx);
		jevBadge?.end(event);
		// A rejected Riot call is recorded by the custodian; re-read so the header and renewal notice follow it.
		if ((event.toolName === VOXREN_PLAYER_AUDIT_TOOL || event.toolName === VOXREN_OTP_BUILD_TOOL) && event.isError) await riotKey.load(ctx);
		// learningsOff (issue #33 stage 5) stops the fold without touching an existing file.
		if (event.toolName === VOXREN_PLAYER_AUDIT_TOOL && !event.isError && !config.learningsOff) foldAuditIntoLearnings(environment, event);
	});
	// Print mode writes the finished answer's text as it is, with no Markdown to draw it: the emphasis marks go, the words stay.
	pi.on("message_end", async (event: any) => {
		const message = event?.message;
		if (hasUI || message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
		const content = message.content.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? { ...part, text: withoutEmphasis(part.text) } : part));
		return content.some((part: any, index: number) => part.text !== message.content[index].text) ? { message: { ...message, content } } : undefined;
	});
	pi.on("agent_end", async (event: any, ctx: any) => {
		working.clear(ctx);
		motion.stop();
		const composition = turnComposition;
		turnComposition = undefined;
		const exchange = exchangeLog.end(event?.messages ?? [], ctx, pi.getThinkingLevel?.(), turnAbortReason);
		if (exchange) treeStats.run(exchange);
		// Pi paints a turn that ended "aborted" or "error" as a red row it gives the extension no way to change (#383), and a provider's
		// cancelled request comes back as "error" ("This operation was aborted"). A typed turn that cancelled the automatic one gets one
		// quiet line under that row. Here, after the row and before the run settles, it lands ahead of the typed turn, which starts once the run is idle.
		const ended = [...(event?.messages ?? [])].reverse().find((message: any) => message?.role === "assistant")?.stopReason;
		const cancelled = Boolean(autoTurn?.cancelled) && (ended === "aborted" || ended === "error");
		if (cancelled) {
			pi.appendEntry?.(AUTO_STOPPED_ENTRY_TYPE);
			logEvent("info", "index", "auto-call-stopped", { reason: "the player typed a turn", ended });
		}
		// One quiet line naming /report under an answer whose model call failed, or whose live read failed before it; each cause once a session.
		const failedRead = liveReadFailed;
		liveReadFailed = false;
		const modelFailed = ended === "error" && !cancelled && reportHints.note("model-call");
		const readFailed = failedRead && reportHints.note("live-read");
		if (modelFailed || readFailed) pi.appendEntry?.(REPORT_HINT_ENTRY_TYPE);
		if (exchange) lastRunCommand = exchange.command ?? "question";
		// After a post-game review, the one-line feedback ask: the first review, then every third, counted across sessions beside profile.json; off with VOXREN_COACH_FEEDBACK=0.
		if (exchange?.command === "review" && feedbackPromptOn(environment)) {
			const statePath = coachHomePath(environment, NOTICE_STATE_FILE);
			if (statePath) {
				const state = readNoticeState(statePath);
				const reviews = (state.reviews ?? 0) + 1;
				writeNoticeState(statePath, { ...state, reviews });
				if (promptAfterReview(reviews)) pi.appendEntry?.(FEEDBACK_PROMPT_ENTRY_TYPE);
			}
		}
		// Only where a strip can actually be drawn: elsewhere the answer keeps its build lines as text.
		runEnded = true;
		if (stripGateOn()) {
			const answers = (event?.messages ?? []).filter((message: any) => message?.role === "assistant");
			// Only the run's last answer gets a panel: text it wrote before (ahead of a tool call) keeps its rows.
			for (const message of answers.slice(0, -1)) for (const text of textParts(message)) unpanelled.add(text);
			const last = textParts(answers.at(-1));
			void showPanel(event?.messages ?? [], composition)
				.then((landed) => {
					if (!landed) restoreRows(last);
					else {
						// The panel now owns these texts' rows, even where an older resumed answer had the same text (the transformer gets no message id).
						for (const text of last) unpanelled.delete(text);
						repaint?.(true);
					}
				})
				.catch((error) => {
					logEvent("warn", "index", "panel-failed", undefined, error);
					restoreRows(last);
				});
		}
	});
	pi.on("agent_settled", async (_event: any, ctx: any) => {
		clearTimeout(turnTimer);
		if (!runEnded && stripGateOn()) {
			const branch: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
			const last = [...branch].reverse().find((entry) => entry?.type === "message" && entry.message?.role === "assistant");
			restoreRows(textParts(last?.message));
			logEvent("info", "index", "panel-skipped", { reason: "the run settled without agent_end, so its answer keeps its rows" });
		}
		runEnded = true;
		autoTurn = undefined;
		// An aborted turn may never emit agent_end; settled always fires.
		motion.stop();
		// Belt and suspenders: if agent_end already wrote this run, exchangeLog.end() below is a no-op
		// (createExchangeLog() only appends while a run is open). Covers a stalled provider whose
		// abort never produces a low-level agent_end, only the always-fired agent_settled.
		if (turnAbortReason) {
			const exchange = exchangeLog.end([], ctx, pi.getThinkingLevel?.(), turnAbortReason);
			if (exchange) treeStats.run(exchange);
		}
		// Settled always fires: a turn that never reached agent_end still leaves the tree idle.
		treeStats.turnEnd();
		turnAbortReason = undefined;
		// A /report typed during this run was waiting for its line in the exchange log, written just above or at agent_end.
		debugAfterRun?.();
		debugAfterRun = undefined;
		// Next tick: settled fires from Pi's finally block, before the session reports idle.
		setTimeout(() => checkAuto?.(), 0);
	});
	// Idle marker for an agent driving this TUI from outside (docs/agent-terminal.md): touched each time a run settles,
	// which Pi emits from a finally block, so an abort or a failed turn marks idle too. Nothing is written without the variable.
	const idleFile = environment.VOXREN_COACH_IDLE_FILE?.trim();
	if (idleFile) {
		pi.on("agent_settled", async () => {
			try {
				writeFileSync(idleFile, `${Date.now()}\n`);
			} catch (error) {
				logEvent("warn", "index", "idle-file-write-failed", { path: idleFile }, error);
			}
		});
	}
	pi.on("user_bash", async () => ({
		result: { output: SHELL_DENIED_MESSAGE, exitCode: 126, cancelled: false, truncated: false },
	}));
	pi.on("session_shutdown", async () => {
		stopUpdateCheck?.();
		// A /report still waiting on a run that never ended here: the coach is closing, so it is dropped, on record.
		if (debugAfterRun) logEvent("warn", "debug-handoff", "dropped-at-shutdown");
		debugAfterRun = undefined;
		stopCellWatch?.();
		stopCursorFilter?.();
		lcuFooter?.stop();
		jevBadge?.stop();
		motion.enable(false);
		await gateway.close();
	});
	return gateway;
}

export default function voxrenCoach(pi: ExtensionAPI) {
	const unreadable = adoptLaunchSecrets();
	installVoxrenCoach(pi);
	// Raised after the install, which sets the notice handler that folds it into the header. Same event name as the worker's.
	if (unreadable) raiseNotice("launch-secrets", "error", "Keys did not load: the handoff file was unreadable. Close this window and start `coach` again.", "launch-secrets", "launch_secrets_unreadable", undefined, unreadable);
}
