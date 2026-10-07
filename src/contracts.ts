import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { PromptCard } from "./champion-card";
import type { Composition } from "./lcu";
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "./systemone";

/** A session's reasoning budget: which model and how hard it thinks. Jev's route grade or a command's tier picks one row (agent.tiers in coach.yaml); code owns every threshold. */
export type TierName = "quick" | "standard" | "deep";
export const TIER_NAMES: readonly TierName[] = ["quick", "standard", "deep"];

export const RESEARCH_CONTRACT_VERSION = "research-contract-v1" as const;

/** One coaching rule; the id is stable across rewordings so judge questions and autoresearch diffs can cite it. */
export interface DoctrineRow {
	id: string;
	rule: string;
}

/** The client phases the command router offers choices for (`lcuFooter.read().kind`; "closed" counts as the lobby). */
export const COMMAND_PHASES = ["lobby", "champSelect", "liveGame"] as const;
export type CommandPhase = (typeof COMMAND_PHASES)[number];

/** A doctrine judge question (`jev.doctrine`): a closed check on an answer that names the doctrine rules it enforces, so a failing score points at the rule to edit. A `choice` question names which option the answer fits (tier_fit). */
export type DoctrineQuestion = (NoulQuestion | ChoiceQuestion) & {
	/** Doctrine ids, or `group.*` prefixes, this question enforces; each must match a rule (validateCoachYaml). */
	enforces: string[];
	/** On a noul question: a yes means the rule was broken (generic_copout), not followed. */
	violation?: boolean;
};

const DOCTRINE_ID = /^[a-z]+(\.[a-z0-9-]+)+$/;
const DOCTRINE_GROUPS = new Set(["prime", "role", "lane", "wave", "trade", "tempo", "macro", "vision", "objective", "jungle", "fight", "build", "comp", "state", "soloq", "mental", "calibration", "craft"]);

/** The complete model-visible capability set; a launch may disable some (see index.ts). */
/** Every prompt and agent default. Edit coach.yaml, not this file. */
export interface CoachYaml {
	agent: {
		provider: string;
		model: string;
		theme: string;
		tools: string[];
		/** The only models a session may run; agent.model is the first-turn and fallback model. */
		models: string[];
		/** Jev's route grade (jev.route) or a command's tier picks one row; code owns the thresholds (src/model-router.ts). */
		tiers: Record<TierName, { model: string; thinking: string }>;
	};
	prompts: { system: string; champion: string; riotId: string; learnings: string; mainCard: string; unavailable: string; passageJudge: string; blockedTool: string; shellDenied: string; doctrineBasics: string; doctrineMastery: string; notesVideo: string; notesGuide: string; notesDistil: string; notesMerge: string; notesNames: string; notesGuideQuery: string; cardGuideQuery: string; cardGameIntro: string; cardDistil: string; liveQuestion: string; routedQuestion: string; gameStart: string; debug: string; compResearch: string; compResearchWeb: string; compResearchVideo: string; compFrame: string; frames: string; frameNoPhase: string; frameNotOffered: string };
	commands: Array<{ name: string; args?: string; description: string; needs: string[]; prompt: string; promptOther?: string; tier: TierName; choices?: string[] }>;
	/** The lines the start notice rotates through, one per start (src/update.ts `nextTip`); player-facing, never sent to the model. */
	tips: string[];
	/** `hostedSearch*` are web_search's own: the prompt a worker Pi runs the provider's hosted search with (src/hosted-search.ts). */
	tools: Record<VoxrenToolName, { description: string; searchSystem?: string; hostedSearch?: string; hostedSearchDomains?: string; hostedSearchFreshness?: string; parameters?: Record<string, string> }>;
	/** Model-facing tool-failure text, keyed by SafeErrorCode (src/policy.ts owns that type; kept loose here to avoid importing it). */
	errors: Record<string, string>;
	/** Jev question text; `{{untrusted}}` in any instruction is expanded once at load. */
	jev: {
		untrusted: string;
		/** Grades how much reasoning a message needs; the answer's choice picks a tier. */
		route: ChoiceQuestion;
		/** Picks the command a typed question runs; `phases` names the choices offered in each client phase (src/command-router.ts). */
		command: ChoiceQuestion & { phases: Record<CommandPhase, string[]> };
		passage: Record<"relevant" | "support" | "injection", NoulQuestion>;
		grounding: Record<"supported" | "contradicted", NoulQuestion> & {
			source: { type: "choice"; instructions: string; none: string };
			contradictedBy: { type: "choice"; instructions: string; none: string };
		};
		answerRubric: { quality: ScoreQuestion } & Record<"has_intro_or_closing" | "hedges" | "unsourced_number", NoulQuestion>;
		/** Yes/no questions a story's `answerNot` gate asks of the final answer. */
		storyChecks: Record<"gives_lane_or_matchup_advice", NoulQuestion>;
		/** Doctrine judge questions the lab asks of a final answer (src/lab/answer-rubric.ts `gradeDoctrine`). */
		doctrine: Record<string, DoctrineQuestion>;
	};
	/** Coaching doctrine rendered into the system prompt: basics first, then mastery. */
	doctrine: { basics: DoctrineRow[]; mastery: DoctrineRow[] };
}

function assertPath(condition: unknown, path: string): void {
	if (!condition) throw new Error(`coach.yaml: missing ${path}`);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Whether an `enforces` entry names a doctrine id: the id itself, or a `group.*` prefix of it. */
const enforcesId = (entry: string, id: string): boolean => (entry.endsWith(".*") ? id.startsWith(entry.slice(0, -1)) : id === entry);

/** The doctrine rows (ids, in doctrine order, each once) that a question's `enforces` entries name: what to edit when its score is low. */
export function enforcedDoctrineIds(enforces: readonly string[], doctrine: CoachYaml["doctrine"] = COACH_YAML.doctrine): string[] {
	const ids = [...doctrine.basics, ...doctrine.mastery].map((row) => row.id);
	return ids.filter((id) => enforces.some((entry) => enforcesId(entry, id)));
}

/** The variables each template receives at its call site, so a misspelled `{{name}}` fails at load, not on a player's turn. A prompt not listed takes none. Keep this beside a call site's change. */
const PROMPT_VARS: Record<string, string[]> = {
	champion: ["champion", "lane"],
	riotId: ["riotId"],
	learnings: ["summary"],
	mainCard: ["champion", "built", "version", "rows"],
	unavailable: ["tools"],
	liveQuestion: ["composition", "question"],
	routedQuestion: ["prompt", "question"],
	frames: ["commands"],
	frameNotOffered: ["command"],
	debug: ["note", "bundle", "repo", "runs", "picture", "screen", "newest", "team"],
	compResearch: ["tools"],
	notesVideo: ["title"],
	notesGuide: ["title"],
	notesDistil: ["intro", "champion", "opponent", "example"],
	notesMerge: ["champion", "opponent", "sources"],
	notesNames: ["names"],
	notesGuideQuery: ["champion", "opponent"],
	cardGuideQuery: ["champion"],
	cardGameIntro: ["champion"],
	cardDistil: ["intro", "champion", "tags", "example"],
};
const WEB_SEARCH_VARS: Record<string, string[]> = { hostedSearch: ["scope", "max", "query"], hostedSearchDomains: ["domains"], hostedSearchFreshness: ["days"] };
/** What each command's argument parser returns (ARG_PARSERS), plus the launch slots every command prompt may use. */
const COMMAND_VARS: Record<string, string[]> = {
	review: ["count", "player"],
	matchup: ["mine", "enemy", "lane"],
	build: ["champion", "lane", "into"],
	patch: ["target"],
	otp: ["player", "champion"],
	comp: ["composition", "question"],
	draft: ["composition"],
	pick: ["composition"],
};
const LAUNCH_SLOT_VARS = ["research", "frame"];

function assertPlaceholders(template: unknown, allowed: string[], path: string): void {
	if (typeof template !== "string") return;
	for (const match of template.matchAll(/\{\{(\w+)\}\}/g)) if (!allowed.includes(match[1])) throw new Error(`coach.yaml: ${path} uses {{${match[1]}}}, which its caller does not fill (allowed: ${allowed.length ? allowed.join(", ") : "none"})`);
}

/** A missing or misspelled coach.yaml key fails here, naming the exact dotted path, instead of as a generic TypeError later. */
export function validateCoachYaml(yaml: unknown): CoachYaml {
	assertPath(yaml && typeof yaml === "object", "agent");
	const root = yaml as Record<string, unknown>;

	const agent = root.agent as Record<string, unknown> | undefined;
	assertPath(agent && typeof agent === "object", "agent");
	for (const key of ["provider", "model", "theme"]) assertPath(isNonEmptyString(agent?.[key]), `agent.${key}`);
	assertPath(Array.isArray(agent?.tools), "agent.tools");

	const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	const models = agent?.models;
	assertPath(Array.isArray(models) && models.length > 0 && models.every(isNonEmptyString), "agent.models");
	assertPath((models as string[]).includes(agent?.model as string), "agent.model (must be in agent.models)");
	for (const tier of TIER_NAMES) {
		const row = (agent?.tiers as any)?.[tier];
		assertPath((models as string[]).includes(row?.model), `agent.tiers.${tier}.model (must be in agent.models)`);
		assertPath(THINKING_LEVELS.has(row?.thinking), `agent.tiers.${tier}.thinking`);
	}

	const prompts = root.prompts as Record<string, unknown> | undefined;
	assertPath(prompts && typeof prompts === "object", "prompts");
	for (const key of ["system", "champion", "riotId", "learnings", "mainCard", "unavailable", "passageJudge", "blockedTool", "shellDenied", "doctrineBasics", "doctrineMastery", "notesVideo", "notesGuide", "notesDistil", "notesMerge", "notesNames", "notesGuideQuery", "cardGuideQuery", "cardGameIntro", "cardDistil", "liveQuestion", "routedQuestion", "gameStart", "debug", "compResearch", "compResearchWeb", "compResearchVideo", "compFrame", "frames", "frameNoPhase", "frameNotOffered"]) assertPath(isNonEmptyString(prompts?.[key]), `prompts.${key}`);

	for (const [key, value] of Object.entries(prompts ?? {})) assertPlaceholders(value, PROMPT_VARS[key] ?? [], `prompts.${key}`);

	const errors = root.errors as Record<string, unknown> | undefined;
	assertPath(errors && typeof errors === "object", "errors");
	for (const code of ["CONFIGURATION", "AUTHENTICATION", "VALIDATION", "NOT_FOUND", "UPSTREAM_UNAVAILABLE", "RATE_LIMITED", "MALFORMED_RESPONSE"]) {
		assertPath(isNonEmptyString(errors?.[code]), `errors.${code}`);
	}

	const tools = root.tools as Record<string, unknown> | undefined;
	assertPath(tools && typeof tools === "object", "tools");
	for (const name of (agent?.tools as unknown[]) ?? []) {
		const entry = tools?.[String(name)] as Record<string, unknown> | undefined;
		assertPath(entry && typeof entry === "object", `tools.${String(name)}`);
		assertPath(isNonEmptyString(entry?.description), `tools.${String(name)}.description`);
	}
	if ((agent?.tools as unknown[] | undefined)?.includes("web_search")) {
		for (const key of ["searchSystem", "hostedSearch", "hostedSearchDomains", "hostedSearchFreshness"]) assertPath(isNonEmptyString((tools?.web_search as Record<string, unknown> | undefined)?.[key]), `tools.web_search.${key}`);
		for (const [key, allowed] of Object.entries(WEB_SEARCH_VARS)) assertPlaceholders((tools?.web_search as Record<string, unknown>)[key], allowed, `tools.web_search.${key}`);
	}

	const commands = root.commands;
	assertPath(Array.isArray(commands), "commands");
	const seenCommands = new Set<string>();
	(commands as unknown[]).forEach((command, index) => {
		const entry = command as Record<string, unknown> | undefined;
		assertPath(entry && typeof entry === "object", `commands[${index}]`);
		assertPath(isNonEmptyString(entry?.name), `commands[${index}].name`);
		assertPath(isNonEmptyString(entry?.description), `commands[${index}].description`);
		if (seenCommands.has(entry!.name as string)) throw new Error(`coach.yaml: duplicate command name "${entry!.name}" at commands[${index}]`);
		seenCommands.add(entry!.name as string);
		assertPath(Array.isArray(entry?.needs), `commands[${index}].needs`);
		// A misspelled tool never matches a disabled one, so a launch without the real tool would not refuse the command.
		(entry!.needs as unknown[]).forEach((tool, at) => {
			if (!(agent!.tools as unknown[]).includes(tool)) throw new Error(`coach.yaml: commands[${index}].needs[${at}] names unknown tool ${JSON.stringify(tool)} (not in agent.tools)`);
		});
		// Tools are the model's call on every turn: a per-command list once made /draft refuse when the system prompt asked for a tool the turn lacked.
		if (entry && "tools" in entry) throw new Error(`coach.yaml: commands[${index}].tools is not supported; the launch's tools are available on every turn`);
		assertPath(isNonEmptyString(entry?.prompt), `commands[${index}].prompt`);
		assertPath(TIER_NAMES.includes(entry?.tier as TierName), `commands[${index}].tier`);
		if (entry && "promptOther" in entry) assertPath(isNonEmptyString(entry.promptOther), `commands[${index}].promptOther`);
		// A command with no parser fails at COACH_COMMANDS with its own message.
		const vars = COMMAND_VARS[entry!.name as string];
		if (vars) for (const key of ["prompt", "promptOther"]) assertPlaceholders(entry![key], [...vars, ...LAUNCH_SLOT_VARS], `commands[${index}].${key}`);
		if (entry && "choices" in entry) {
			assertPath(Array.isArray(entry.choices), `commands[${index}].choices`);
			(entry.choices as unknown[]).forEach((choice, at) => assertPath(isNonEmptyString(choice), `commands[${index}].choices[${at}]`));
		}
	});

	const tips = root.tips;
	assertPath(Array.isArray(tips) && tips.length > 0, "tips");
	(tips as unknown[]).forEach((tip, index) => assertPath(isNonEmptyString(tip) && !tip.includes("\n"), `tips[${index}]`));

	const jev = root.jev as Record<string, unknown> | undefined;
	assertPath(jev && typeof jev === "object", "jev");
	assertPath(isNonEmptyString(jev?.untrusted), "jev.untrusted");
	const command = jev?.command as { instructions?: unknown; criteria?: Record<string, unknown>; phases?: Record<string, unknown> } | undefined;
	assertPath(isNonEmptyString(command?.instructions), "jev.command.instructions");
	for (const phase of COMMAND_PHASES) {
		const choices = command?.phases?.[phase];
		assertPath(Array.isArray(choices) && choices.includes("none"), `jev.command.phases.${phase}`);
		for (const name of choices as unknown[]) {
			assertPath(name === "none" || (root.commands as Array<{ name?: unknown }>).some((entry) => entry.name === name), `jev.command.phases.${phase}: ${String(name)} is not a command`);
			assertPath(isNonEmptyString(command?.criteria?.[name as string]), `jev.command.criteria.${String(name)}`);
		}
	}
	const questionGroups: Record<string, string[]> = { passage: ["relevant", "support", "injection"], grounding: ["supported", "contradicted", "source", "contradictedBy"], answerRubric: ["quality", "has_intro_or_closing", "hedges", "unsourced_number"], storyChecks: ["gives_lane_or_matchup_advice"] };
	for (const [group, keys] of Object.entries(questionGroups)) {
		const entries = jev?.[group] as Record<string, unknown> | undefined;
		assertPath(entries && typeof entries === "object", `jev.${group}`);
		for (const key of keys) {
			const question = entries?.[key] as Record<string, unknown> | undefined;
			assertPath(question && typeof question === "object", `jev.${group}.${key}`);
			assertPath(isNonEmptyString(question?.type), `jev.${group}.${key}.type`);
			assertPath(isNonEmptyString(question?.instructions), `jev.${group}.${key}.instructions`);
		}
	}
	assertPath(isNonEmptyString((jev?.grounding as any)?.source?.none), "jev.grounding.source.none");
	assertPath(isNonEmptyString((jev?.grounding as any)?.contradictedBy?.none), "jev.grounding.contradictedBy.none");
	assertPath(Array.isArray((jev?.answerRubric as any)?.quality?.criteria), "jev.answerRubric.quality.criteria");
	assertPath(isNonEmptyString((jev?.route as any)?.instructions), "jev.route.instructions");
	assertPath((jev?.route as any)?.type === "choice" && TIER_NAMES.every((t) => isNonEmptyString((jev?.route as any)?.criteria?.[t])), "jev.route");

	const doctrine = root.doctrine as Record<string, unknown> | undefined;
	assertPath(doctrine && typeof doctrine === "object", "doctrine");
	const seenIds = new Set<string>();
	for (const layer of ["basics", "mastery"]) {
		const rows = doctrine?.[layer];
		assertPath(Array.isArray(rows) && rows.length > 0, `doctrine.${layer}`);
		(rows as unknown[]).forEach((row, index) => {
			const path = `doctrine.${layer}[${index}]`;
			const entry = row as Record<string, unknown> | undefined;
			assertPath(entry && typeof entry === "object", path);
			const id = entry?.id;
			if (typeof id !== "string" || !DOCTRINE_ID.test(id)) throw new Error(`coach.yaml: ${path}.id must be a dotted slug like prime.death-cost (got ${JSON.stringify(id)})`);
			const group = id.split(".")[0];
			if (!DOCTRINE_GROUPS.has(group)) throw new Error(`coach.yaml: ${path}.id has unknown doctrine group "${group}"`);
			if (seenIds.has(id)) throw new Error(`coach.yaml: duplicate doctrine id ${id} at ${path}`);
			seenIds.add(id);
			assertPath(isNonEmptyString(entry?.rule) && !String(entry?.rule).includes("\n"), `${path}.rule`);
			// An unquoted " #" in yaml cuts the rule short and still leaves a valid string; the period is the tripwire.
			if (!String(entry?.rule).endsWith(".")) throw new Error(`coach.yaml: ${path}.rule must end with a period (unquoted " #" truncates a rule; double-quote it)`);
		});
	}

	// Doctrine ids are known only now, so the judge questions that cite them are checked last.
	const judgeQuestions = jev?.doctrine as Record<string, Record<string, unknown>> | undefined;
	assertPath(judgeQuestions && typeof judgeQuestions === "object" && Object.keys(judgeQuestions).length > 0, "jev.doctrine");
	for (const [name, question] of Object.entries(judgeQuestions!)) {
		const path = `jev.doctrine.${name}`;
		assertPath(question && typeof question === "object", path);
		assertPath(question.type === "noul" || question.type === "choice", `${path}.type (noul or choice)`);
		assertPath(isNonEmptyString(question.instructions), `${path}.instructions`);
		const criteria = question.criteria as Record<string, unknown> | undefined;
		if (question.type === "noul") assertPath(criteria && typeof criteria === "object" && isNonEmptyString(criteria.true) && isNonEmptyString(criteria.false), `${path}.criteria (true and false)`);
		else assertPath(criteria && typeof criteria === "object" && Object.keys(criteria).length >= 2 && Object.values(criteria).every(isNonEmptyString), `${path}.criteria (two or more options)`);
		if (question.violation !== undefined && (typeof question.violation !== "boolean" || question.type !== "noul")) throw new Error(`coach.yaml: ${path}.violation must be true or false, on a noul question`);
		assertPath(Array.isArray(question.enforces) && question.enforces.length > 0 && question.enforces.every(isNonEmptyString), `${path}.enforces`);
		(question.enforces as string[]).forEach((entry, index) => {
			if (![...seenIds].some((id) => enforcesId(entry, id))) throw new Error(`coach.yaml: ${path}.enforces[${index}] names no doctrine rule (${JSON.stringify(entry)})`);
		});
	}

	return yaml as CoachYaml;
}

/** `{{untrusted}}` in any jev instruction expands once here; the questions Jev sees carry the full sentence. */
export function expandJevQuestions(yaml: CoachYaml): CoachYaml {
	const fill = (text: string) => fillTemplate(text, { untrusted: yaml.jev.untrusted });
	for (const group of [yaml.jev.passage, yaml.jev.grounding, yaml.jev.answerRubric, yaml.jev.storyChecks, yaml.jev.doctrine] as Array<Record<string, any>>) {
		for (const question of Object.values(group)) if (question && typeof question.instructions === "string") question.instructions = fill(question.instructions);
	}
	yaml.jev.route.instructions = fill(yaml.jev.route.instructions);
	yaml.jev.command.instructions = fill(yaml.jev.command.instructions);
	return yaml;
}

export const COACH_YAML_PATH = fileURLToPath(new URL("../coach.yaml", import.meta.url));
export const COACH_YAML: CoachYaml = expandJevQuestions(validateCoachYaml(parseYaml(readFileSync(COACH_YAML_PATH, "utf8"))));

/** The complete model-visible capability set; a launch may disable some (see index.ts). The type is the contract, the list comes from coach.yaml. */
export type VoxrenToolName = "web_search" | "voxren_video_research" | "voxren_game_facts" | "voxren_meta_research" | "voxren_strategy_frame" | "voxren_player_audit" | "voxren_otp_build" | "voxren_remember" | "voxren_command_frame";
export const VOXREN_TOOLS: readonly VoxrenToolName[] = COACH_YAML.agent.tools as VoxrenToolName[];

export const VOXREN_PLAYER_AUDIT_TOOL = "voxren_player_audit" as const;
export const VOXREN_OTP_BUILD_TOOL = "voxren_otp_build" as const;
export const VOXREN_REMEMBER_TOOL = "voxren_remember" as const;
export const VOXREN_COMMAND_FRAME_TOOL = "voxren_command_frame" as const;

export type GatewayOperation =
	| "research_web_search"
	| "research_video"
	| "gamedata.lookup"
	| "meta.champion_overview"
	| "meta.matchup"
	| "meta.tier_list"
	| "meta.synergy"
	| "meta.top_players"
	| "meta.pro_player_riot_id"
	| "strategy_frame"
	| "player_audit"
	| "otp_build"
	| "remember"
	| "command_frame";

export const DEFAULT_PROVIDER = COACH_YAML.agent.provider;
export const DEFAULT_MODEL_ID = COACH_YAML.agent.model;
export const DEFAULT_THEME = COACH_YAML.agent.theme;
/** The only models a session may run. */
export const COACH_MODELS: readonly string[] = COACH_YAML.agent.models;
/** Per-tier model and thinking level; a route grade or a command's tier picks one row. */
export const COACH_TIERS: Record<TierName, { model: string; thinking: string }> = COACH_YAML.agent.tiers;
/** Grades how much reasoning a message needs; the answer's choice is a TierName. */
export const ROUTE_QUESTION: ChoiceQuestion = COACH_YAML.jev.route;

export const COACH_SYSTEM_PROMPT = COACH_YAML.prompts.system.trimEnd();
const doctrineLayer = (label: string, rows: DoctrineRow[]) => [label, ...rows.map((row) => `- ${row.rule}`)].join("\n");
/** Doctrine rows as the model sees them: a label line, then one "- rule" row each; ids stay out of the prompt. */
export const COACH_DOCTRINE = `${doctrineLayer(COACH_YAML.prompts.doctrineBasics, COACH_YAML.doctrine.basics)}\n\n${doctrineLayer(COACH_YAML.prompts.doctrineMastery, COACH_YAML.doctrine.mastery)}`;
/** Sent to the model when it calls a tool outside the launch's active set. */
export const BLOCKED_TOOL_MESSAGE = COACH_YAML.prompts.blockedTool;
/** Returned as the shell-command result when the coach denies `user_bash`. */
export const SHELL_DENIED_MESSAGE = COACH_YAML.prompts.shellDenied;
/** Appended when the Jev passage screen is on. */
export const PASSAGE_JUDGE_PROMPT_ADDENDUM = `\n\n${COACH_YAML.prompts.passageJudge.trimEnd()}`;

/** What a plain question typed in game is sent as: the live game read for it, then the question (coach.yaml `prompts.liveQuestion`). */
export function liveQuestionPrompt(composition: string, question: string): string {
	return fillTemplate(COACH_YAML.prompts.liveQuestion, { composition, question }).trim();
}

/** A typed question the router sent to a command: the command's prompt, then the question (coach.yaml `prompts.routedQuestion`). */
export function routedQuestionPrompt(prompt: string, question: string): string {
	return fillTemplate(COACH_YAML.prompts.routedQuestion, { prompt: prompt.trimEnd(), question }).trim();
}

/** `{{name}}` → vars[name]; a missing variable is a bug, so it throws. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
		if (!(name in vars)) throw new Error(`coach.yaml template needs "${name}"`);
		return vars[name];
	});
}

export function coachSystemPrompt(options: { accounts: string[]; champion?: string; lane?: string; passageJudge: boolean; disabledTools: string[]; learningsSummary?: string; card?: PromptCard; frames?: Array<{ name: string; description: string }> }): string {
	// The clause vanishes with no lane ("The player's main champion: Fizz.") rather than reading "played .".
	const lane = options.lane ? `, played ${options.lane}` : "";
	const lines = [COACH_SYSTEM_PROMPT, "", COACH_DOCTRINE, ""];
	if (options.champion) lines.push(fillTemplate(COACH_YAML.prompts.champion, { champion: options.champion, lane }));
	// Accounts reach here from profile.json, the environment, and the League client's signed-in name; only a Riot-shaped one goes into a quoted prompt line.
	const riotId = options.accounts.find((account) => RIOT_ID_PATTERN.test(account));
	if (riotId) lines.push(fillTemplate(COACH_YAML.prompts.riotId, { riotId }));
	// learningsSummary arrives normalized to one line by the caller (index.ts normalizeTakeaway), so it cannot open a new prompt line.
	if (options.learningsSummary) lines.push(fillTemplate(COACH_YAML.prompts.learnings, { summary: options.learningsSummary }));
	if (options.card) lines.push(fillTemplate(COACH_YAML.prompts.mainCard, { champion: options.card.name, built: options.card.built, version: options.card.version, rows: options.card.rows.join("\n") }));
	if (options.frames?.length) lines.push(fillTemplate(COACH_YAML.prompts.frames, { commands: options.frames.map((frame) => `- ${frame.name}: ${frame.description}`).join("\n") }));
	if (options.disabledTools.length) lines.push(fillTemplate(COACH_YAML.prompts.unavailable, { tools: options.disabledTools.join(", ") }));
	return `${lines.join("\n")}${options.passageJudge ? PASSAGE_JUDGE_PROMPT_ADDENDUM : ""}`;
}

/** What one launch has on: the Jev screen, and the tools that are off. */
export interface LaunchState {
	passageJudge: boolean;
	disabledTools: readonly string[];
}

/** The prompt slots a launch fills ({{research}}, {{frame}}): text from coach.yaml that names only the tools this launch can call. */
export function launchSlots(launch: LaunchState = { passageJudge: true, disabledTools: [] }): { research: string; frame: string } {
	const prompts = COACH_YAML.prompts;
	const tools = [
		...(launch.disabledTools.includes("web_search") ? [] : [prompts.compResearchWeb]),
		...(launch.disabledTools.includes("voxren_video_research") ? [] : [prompts.compResearchVideo]),
	];
	return {
		research: tools.length ? fillTemplate(prompts.compResearch, { tools: tools.join(" and ") }) : "",
		frame: launch.passageJudge ? prompts.compFrame : "",
	};
}

/** A command template with the launch slots filled and every other {{variable}} left, for reading which tools it orders. */
export function expandLaunchSlots(template: string, launch?: LaunchState): string {
	const slots = launchSlots(launch);
	return template.replace(/\{\{(research|frame)\}\}/g, (_match, name: "research" | "frame") => slots[name]);
}

export interface CoachCommand {
	name: string;
	args?: string;
	description: string;
	/** Tools the prompt cannot do without. */
	needs: readonly VoxrenToolName[];
	/** This command's fixed reasoning tier; Jev's route grade never overrides a command's own tier. */
	tier: TierName;
	/** Derived from the name, not the yaml (index.ts detail, not a prompt): reads live LCU state once before building the prompt. */
	usesComposition: boolean;
	/** Derived from the name, not the yaml: this command's template has a {{lane}} slot to fill. */
	needsLane: boolean;
	/** The player can save a default argument for a bare run in the /flow tree (profile.json `commands`). */
	savesDefault: boolean;
	/** The commands with an auto row: /draft (the champ-select calls), /comp (game start), /review (game end) (AGENTS.md rule 3). */
	autoRuns: boolean;
	/** The fixed list of saved defaults from coach.yaml (/review, /comp); empty when the list comes from data or there is none. */
	choices: readonly string[];
	/** The command's own parser takes `args` with no client state: the check a saved default must pass. */
	acceptsArgs(args: string): boolean;
	/** Shown instead of the generic "Usage: ..." notice when the command's parser returns undefined — e.g. no client detected, or no pick to call. */
	noticeWhenEmpty?(composition?: Composition): string | undefined;
	/** `launch` is what this launch has on; omitted, everything is on. */
	prompt(args: string, context: { champion?: string; accounts: string[]; composition?: Composition; lane?: string; launch?: LaunchState }): string | undefined;
}

export function splitMatchup(args: string, champion: string): { mine: string; enemy: string } | undefined {
	const parts = args.split(/\s+vs\.?\s+/i).map((part) => part.trim()).filter(Boolean);
	if (parts.length === 2) return { mine: parts[0], enemy: parts[1] };
	if (parts.length === 1) return { mine: champion, enemy: parts[0] };
	return undefined;
}

/** A Riot ID: a 3-16 character game name (no #, quote, newline or control character), #, a 3-5 letter or digit tag in any script (KR accounts carry Hangul tags). The one definition: /otp and the tool schema (src/tools.ts, which cannot take \p{..}) restate its parts. */
const RIOT_NAME = String.raw`[^#\r\n"\p{Cc}]{3,16}`;
const RIOT_TAG = String.raw`[\p{L}\p{N}]{3,5}`;
export const RIOT_ID_PATTERN = new RegExp(`^${RIOT_NAME}#${RIOT_TAG}$`, "u");

const OTP_ARGS = new RegExp(String.raw`^(.*?#${RIOT_TAG}|\S+)(?:\s+(.*))?$`, "u");

/** The champion names a typed line spells out (what the player wrote, never the main), for the caller to check against Data Dragon. A Riot ID or link is not one. */
export function typedChampions(command: string, args: string): string[] {
	const text = args.trim();
	if (!text) return [];
	if (command === "matchup") return text.split(/\s+vs\.?\s+/i).map((part) => part.trim()).filter(Boolean);
	if (command === "build") return [text];
	if (command === "otp") return [OTP_ARGS.exec(text)?.[2]?.trim() ?? ""].filter(Boolean);
	return [];
}

/** Per-command argument validation; returns the template variables or undefined for bad input. */
const ARG_PARSERS: Record<string, (args: string, context: { champion?: string; composition?: Composition; lane?: string }) => Record<string, string> | undefined> = {
	// `/review [games] [Name#TAG]`, either order: a lone number at either end is the count, the rest a Riot ID (spaces allowed before the #TAG).
	review: (args): Record<string, string> | undefined => {
		const text = args.trim();
		const first = /^(\d+)(?:\s+(.+))?$/.exec(text);
		const last = first ? undefined : /^(.+?)\s+(\d+)$/.exec(text);
		const count = Number(first?.[1] ?? last?.[2] ?? 10);
		const player = first ? (first[2] ?? "") : last ? last[1] : text;
		if (!Number.isInteger(count) || count < 1 || count > 20) return undefined;
		if (!player) return { count: String(count) };
		return RIOT_ID_PATTERN.test(player) ? { count: String(count), player } : undefined;
	},
	matchup: (args, { champion, composition, lane }) => {
		const mine = args.trim() ? splitMatchup(args, champion || "")?.mine : composition?.enemyLaner ? champion : undefined;
		const enemy = args.trim() ? splitMatchup(args, champion || "")?.enemy : composition?.enemyLaner ? composition.enemyLaner : undefined;
		return mine && enemy ? { mine, enemy, lane: lane ? ` ${lane}` : "" } : undefined;
	},
	build: (args, { champion, composition, lane }) =>
		champion ? { champion, lane: lane ? ` ${lane}` : "", into: args.trim() ? ` into ${args.trim()}` : composition?.enemyLaner ? ` into ${composition.enemyLaner}` : "" } : undefined,
	patch: (args, { champion }) => {
		const target = args.trim() || champion;
		return target ? { target } : undefined;
	},
	comp: (args, { composition }) => (composition ? { composition: composition.text, question: args.trim() ? `${args.trim()}. ` : "" } : undefined),
	draft: (_args, { composition }) => (composition ? { composition: composition.text } : undefined),
	// An open own slot (no hover, no lock) leaves the prompt's "my champion" nothing to point at: refuse rather than spend a model turn.
	pick: (_args, { composition }) => (composition && !composition.selfOpen ? { composition: composition.text } : undefined),
	// `/otp <Riot ID or op.gg link> [champion]`: a Riot ID keeps its spaces up to the #TAG; a link is one token; the rest is the champion, falling back to the main when set.
	otp: (args, { champion }) => {
		const match = OTP_ARGS.exec(args.trim());
		const target = match?.[2]?.trim() || champion;
		return match && target ? { player: match[1], champion: target } : undefined;
	},
};

/** Commands whose parser returns undefined for "no client detected", not "bad args" — shown instead of the generic usage line. */
const EMPTY_NOTICE: Partial<Record<string, string>> = {
	comp: "No League client draft or game detected.",
	draft: "No League client draft or game detected.",
	pick: "No League client draft or game detected.",
};

/** The parser refused a composition that exists: shown instead of the no-client notice. */
const OPEN_SLOT_NOTICE: Partial<Record<string, string>> = {
	pick: "Hover or lock a champion first: /pick needs your own pick.",
};

/** Live LCU state is read once per command call, only for commands whose prompt can use it. A code-level detail, so it's derived here, not stored in the yaml. */
const USES_COMPOSITION = ["comp", "draft", "pick", "matchup", "build"];

/** Commands whose template has a {{lane}} slot — the only two that mention a lane at all. */
const USES_LANE = ["matchup", "build"];

/** Commands a saved default argument can fill when typed bare. /matchup and /build are left out: bare, they read the live enemy laner, which a fixed default would override. */
const SAVES_DEFAULT = ["review", "patch", "otp", "comp"];

/** VOXREN_COACH_AUTO_COMP: true or false when it says so (1/true/on, 0/false/off, trimmed, any case), undefined otherwise. */
export function parseAutoComp(value: string | undefined): boolean | undefined {
	const text = value?.trim().toLowerCase();
	return text && ["1", "true", "on"].includes(text) ? true : text && ["0", "false", "off"].includes(text) ? false : undefined;
}

/** Whether the auto calls run: the env var when it says so, else the /flow row's saved value, else on. */
export function autoOn(forced: boolean | undefined, saved: CommandSettings | undefined): boolean {
	return forced ?? saved?.auto ?? true;
}

/** The command the auto trigger runs, and the only one with an auto setting. */
export const AUTO_COMMAND = "draft";

/** The command each game event runs; its `auto` row in /flow switches the event (src/command-router.ts routeGameEvent). */
export const GAME_EVENT_COMMANDS = { gameStart: "comp", gameEnd: "review" } as const;

/** A stand-in client read and main champion, so a saved default is checked on its own words, never on whether a game is open or a main is set right now. */
const ANY_COMPOSITION: Composition = { text: "" };
const ANY_CHAMPION = "any";

/** One command's settings in the player's profile, saved from the /flow tree. */
export interface CommandSettings {
	/** Sent as the argument when the command is typed bare. */
	args?: string;
	/** The auto calls this command runs (/draft, /comp at game start, /review at game end), saved from the /flow row; absent means the default, on. */
	auto?: boolean;
}

export const COACH_COMMANDS: readonly CoachCommand[] = COACH_YAML.commands.map((entry) => {
	const parse = ARG_PARSERS[entry.name];
	if (!parse) throw new Error(`coach.yaml command "${entry.name}" has no argument parser in contracts.ts`);
	return {
		name: entry.name,
		args: entry.args,
		description: entry.description,
		needs: entry.needs as VoxrenToolName[],
		tier: entry.tier,
		usesComposition: USES_COMPOSITION.includes(entry.name),
		needsLane: USES_LANE.includes(entry.name),
		savesDefault: SAVES_DEFAULT.includes(entry.name),
		choices: entry.choices ?? [],
		autoRuns: entry.name === AUTO_COMMAND || (Object.values(GAME_EVENT_COMMANDS) as string[]).includes(entry.name),
		acceptsArgs: (args) => parse(args, { champion: ANY_CHAMPION, composition: ANY_COMPOSITION }) !== undefined,
		noticeWhenEmpty: (composition) => (composition?.selfOpen ? OPEN_SLOT_NOTICE[entry.name] : undefined) ?? EMPTY_NOTICE[entry.name],
		prompt: (args, context) => {
			const vars = parse(args, context);
			return vars && fillTemplate(vars.player && entry.promptOther ? entry.promptOther : entry.prompt, { ...launchSlots(context.launch), ...vars });
		},
	};
});

export interface EvidenceReference {
	id: string;
	source: "web_search" | "voxren_video_research" | "voxren_game_facts" | "voxren_meta_research" | "voxren_player_audit" | "voxren_otp_build";
	title: string;
	url: string;
	retrievedAt: string;
}

export interface GatewayResponse {
	version: typeof RESEARCH_CONTRACT_VERSION;
	operation: GatewayOperation;
	data: Record<string, unknown>;
	evidence: EvidenceReference[];
}

export interface ResearchGateway {
	call(operation: GatewayOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse>;
	close(): Promise<void>;
	/** The Data Dragon version and CDN base the gateway last loaded, once a call has warmed it; undefined before that. */
	dataDragonInfo?(): { version: string; base: string } | undefined;
	/** The champion's primary lane as a coaching word ("mid", not "middle"); undefined when Data Dragon is unreachable or the name doesn't match. */
	championLane?(name: string): Promise<string | undefined>;
}
