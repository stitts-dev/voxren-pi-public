/**
 * QA stories: the file format (data/lab/stories/<id>.json), its validator, and `judge`, the deterministic verdict on one
 * story's final screen and exchange log. Pure: no I/O besides `loadStories`. The runner (story-runner.ts) drives the coach.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { COACH_YAML } from "../contracts";
import type { IconEvidence } from "./icon-check.ts";

export const KEYS = ["esc", "enter", "up", "down", "left", "right", "tab", "home", "end", "ctrl+o"] as const;

/** The bytes a `key` step types into the pane. */
export const KEY_BYTES: Record<(typeof KEYS)[number], string> = { esc: "\x1b", enter: "\r", tab: "\t", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F", "ctrl+o": "\x0f" };

export type Step =
	| { send: string }
	/** Characters typed without Enter: a typed "/" must close the /flow panel before any line is sent. */
	| { type: string }
	| { key: (typeof KEYS)[number] }
	| { wait: string; absent?: boolean; timeout?: number }
	/** Wait for the model turn to settle; `optional` lets a quiet turn pass (a run that may or may not fire). */
	| { idle: true; timeout?: number; optional?: boolean }
	/** Quit the coach and start it again in the same coach home: what a setting must survive. */
	| { restart: true };

export interface Gates {
	/** Text that must be on the final screen (scrollback included). */
	expect?: string[];
	/** Text that must not be. */
	absent?: string[];
	/** Text the last model run's answer must not contain (the screen holds earlier answers too). */
	absentInAnswer?: string[];
	/** Names of `jev.storyChecks` questions (coach.yaml) the final answer must answer no to: Jev judges the answer, the runner asks (story-runner.ts). */
	answerNot?: string[];
	/** Tool names that must appear in the exchange log, all of them ok. */
	tools?: string[];
	/** The whole story, seconds; the runner enforces it. Default 120. */
	maxSeconds?: number;
	/** Jev's answer rubric; default true when the story has an idle step. */
	rubric?: boolean;
	/** How many model runs the exchange log holds (optionally only those whose command starts with `command`). */
	runs?: { command?: string; min: number; max: number };
	/** An error-path story: a failed tool is the expected outcome, so the failed-tool gate is off. */
	allowFailedTools?: boolean;
	/** The BUILD strip's icons are really on screen (src/lab/icon-check.ts). `expect: "all"` (the default) wants one placed per name the strip should draw an icon for; `min` wants at least that many. */
	icons?: { min?: number; expect?: "all" };
}

/** A story is in one split. The lab proposes against `train` and runs `holdout` once, after a series is done (docs/superpowers/specs/2026-09-28-session-lab-design.md). */
export const SPLITS = ["train", "holdout"] as const;
/** What `--split` takes: one split, or both. */
export const SPLIT_CHOICES = [...SPLITS, "all"] as const;
export type Split = (typeof SPLITS)[number];
export type SplitChoice = (typeof SPLIT_CHOICES)[number];

/** The player rank a story assumes; the same ladder OP.GG's rank filter has (src/tools.ts), without its "all" and "_plus" groups. */
export const RANK_TIERS = ["iron", "bronze", "silver", "gold", "platinum", "emerald", "diamond", "master", "grandmaster", "challenger"] as const;

export interface Story {
	id: string;
	title: string;
	/** Train or holdout; a story that names none is train, so a file written before the field existed runs under the default. */
	split?: Split;
	/** The player's rank, when the answer should depend on it (tier tagging, coach.yaml calibration). */
	tier?: (typeof RANK_TIERS)[number];
	/** The `jev.doctrine` questions (coach.yaml) this story's answers are graded on, in place of all of them; a name that is no doctrine question fails the validator. None: every question (src/lab/answer-rubric.ts `doctrineQuestionsFor`). */
	applies?: string[];
	steps: Step[];
	/** A draft file (data/lab/drafts/*.json) or a client recording, played as the League client (VOXREN_LCU_REPLAY). */
	replay?: string;
	/** Milliseconds per replay frame (VOXREN_LCU_REPLAY_STEP_MS), as `just tui --step`. */
	replayStepMs?: number;
	env?: Record<string, string>;
	/** The lab home starts with no Jev key, for a story that wants the coach unscreened. */
	noJevKey?: boolean;
	gates: Gates;
}

/** One model run from `exchanges.ndjson`, the fields a gate reads. */
export interface Run {
	command?: string;
	ms?: number;
	model?: { id: string };
	usage?: { input: number; output: number; costUsd: number; turns: number; cacheRead?: number; cacheWrite?: number };
	turns?: { error?: string }[];
	tools: { name: string; ok: boolean; ms?: number; result?: unknown }[];
	answer?: string;
}

export interface Failure {
	gate: string;
	detail: string;
}

/** Failed tool calls, in order, split by whether a later call to the same tool succeeded (the model retried and it worked). */
export function toolFailures(exchange: Run[]): { failed: string[]; recovered: string[] } {
	const tools = exchange.flatMap((run) => run.tools);
	const failed: string[] = [];
	const recovered: string[] = [];
	tools.forEach((tool, index) => {
		if (tool.ok) return;
		(tools.slice(index + 1).some((later) => later.name === tool.name && later.ok) ? recovered : failed).push(tool.name);
	});
	return { failed, recovered };
}

/** The stories a run covers: `train` (the default) takes those marked train and those with no split, `holdout` those marked holdout, `all` every one. */
export const filterBySplit = (stories: Story[], split: SplitChoice = "train") => stories.filter((story) => split === "all" || (story.split ?? "train") === split);

/** What the runner runs. `only` names stories outright, so with no `split` it takes them from every split (`just smoke record <id>` passes `--only` for a holdout story too); with a `split`, both apply. */
export const storiesFor = (stories: Story[], split?: SplitChoice, only?: string[]) =>
	filterBySplit(stories, only ? (split ?? "all") : split).filter((story) => !only || only.includes(story.id));

export const hasIdle = (story: Story) => story.steps.some((step) => "idle" in step);
export const wantsRubric = (story: Story) => story.gates.rubric ?? hasIdle(story);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);

/** The doctrine questions in coach.yaml: the names a story's `applies` may use. */
const DOCTRINE_QUESTIONS = Object.keys(COACH_YAML.jev.doctrine);

/** Every way a story file breaks the format; empty means valid. `doctrine` is the question names `applies` is checked against (coach.yaml's own, unless a test gives others). */
export function validateStory(raw: unknown, file: string, doctrine: readonly string[] = DOCTRINE_QUESTIONS): string[] {
	const errors: string[] = [];
	const bad = (message: string) => errors.push(`${file}: ${message}`);
	if (!isObject(raw)) return [`${file}: not an object`];
	if (typeof raw.id !== "string" || !/^[a-z0-9-]+$/.test(raw.id)) bad("id must be lowercase letters, digits, dashes");
	else if (`${raw.id}.json` !== file) bad(`id "${raw.id}" must match the file name`);
	if (typeof raw.title !== "string" || !raw.title) bad("title is required");
	if (!Array.isArray(raw.steps) || raw.steps.length === 0) bad("steps must be a non-empty list");
	else
		raw.steps.forEach((step, index) => {
			const at = `steps[${index}]`;
			if (!isObject(step)) return bad(`${at} is not an object`);
			const kinds = ["send", "type", "key", "wait", "idle", "restart"].filter((kind) => kind in step);
			if (kinds.length !== 1) return bad(`${at} must have exactly one of send, type, key, wait, idle, restart`);
			if (kinds[0] === "send" && (typeof step.send !== "string" || !step.send)) bad(`${at}.send must be a non-empty string`);
			if (kinds[0] === "type" && (typeof step.type !== "string" || !step.type)) bad(`${at}.type must be a non-empty string`);
			if (kinds[0] === "key" && !(KEYS as readonly unknown[]).includes(step.key)) bad(`${at}.key must be one of ${KEYS.join(", ")}`);
			if (kinds[0] === "wait" && (typeof step.wait !== "string" || !step.wait)) bad(`${at}.wait must be a non-empty string`);
			if (kinds[0] === "idle" && step.idle !== true) bad(`${at}.idle must be true`);
			if (kinds[0] === "restart" && step.restart !== true) bad(`${at}.restart must be true`);
			if ("timeout" in step && !(typeof step.timeout === "number" && step.timeout > 0)) bad(`${at}.timeout must be a positive number`);
		});
	if (raw.split !== undefined && !(SPLITS as readonly unknown[]).includes(raw.split)) bad(`split must be ${SPLITS.join(" or ")}`);
	if (raw.tier !== undefined && !(RANK_TIERS as readonly unknown[]).includes(raw.tier)) bad(`tier must be one of ${RANK_TIERS.join(", ")}`);
	if (raw.applies !== undefined) {
		if (!strings(raw.applies)) bad("applies must be a list of non-empty strings");
		else for (const name of raw.applies as string[]) if (!doctrine.includes(name)) bad(`applies names "${name}", which is no jev.doctrine question in coach.yaml (${doctrine.join(", ")})`);
	}
	if (raw.replay !== undefined && typeof raw.replay !== "string") bad("replay must be a path");
	if (raw.replayStepMs !== undefined && !(typeof raw.replayStepMs === "number" && raw.replayStepMs > 0)) bad("replayStepMs must be a positive number");
	if (raw.noJevKey !== undefined && typeof raw.noJevKey !== "boolean") bad("noJevKey must be a boolean");
	if (raw.env !== undefined && !(isObject(raw.env) && Object.values(raw.env).every((value) => typeof value === "string"))) bad("env must map names to strings");
	const gates = raw.gates;
	if (!isObject(gates)) bad("gates is required");
	else {
		for (const name of ["expect", "absent", "absentInAnswer", "answerNot", "tools"]) if (gates[name] !== undefined && !strings(gates[name])) bad(`gates.${name} must be a list of non-empty strings`);
		if (gates.maxSeconds !== undefined && !(typeof gates.maxSeconds === "number" && gates.maxSeconds > 0)) bad("gates.maxSeconds must be a positive number");
		if (gates.rubric !== undefined && typeof gates.rubric !== "boolean") bad("gates.rubric must be a boolean");
		if (gates.allowFailedTools !== undefined && typeof gates.allowFailedTools !== "boolean") bad("gates.allowFailedTools must be a boolean");
		const icons = gates.icons;
		if (icons !== undefined && !(isObject(icons) && (icons.min === undefined || (typeof icons.min === "number" && icons.min >= 0)) && (icons.expect === undefined || icons.expect === "all") && Object.keys(icons).every((key) => key === "min" || key === "expect"))) bad('gates.icons must be { min?: number, expect?: "all" }');
		const runs = gates.runs;
		if (runs !== undefined && !(isObject(runs) && typeof runs.min === "number" && typeof runs.max === "number" && runs.min <= runs.max)) bad("gates.runs must be { min, max, command? } with min <= max");
	}
	const known = new Set(["id", "title", "split", "tier", "applies", "steps", "replay", "replayStepMs", "env", "noJevKey", "gates"]);
	for (const key of Object.keys(raw)) if (!known.has(key)) bad(`unknown field "${key}"`);
	return errors;
}

/** Every story in a folder, sorted by id; throws listing every invalid file. */
export function loadStories(dir: string): Story[] {
	const stories: Story[] = [];
	const errors: string[] = [];
	for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
		const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
		const problems = validateStory(raw, file);
		if (problems.length) errors.push(...problems);
		else stories.push(raw as Story);
	}
	if (errors.length) throw new Error(errors.join("\n"));
	return stories;
}

const ENTITY = /&(?:gt|lt|amp|quot);|&#\d+;/;
// A real escape or C0 control character, or one written out as text (\x1b, \u001b, \033, \e[, ^[[).
const ESCAPE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\\x1b|\\u001b|\\033|\\e\[|\^\[\[/i;

/** Terminal columns a line takes: one per code point, two for East Asian wide and emoji blocks. */
function cells(line: string): number {
	let width = 0;
	for (const char of line) {
		const code = char.codePointAt(0)!;
		width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff) ? 2 : 1;
	}
	return width;
}

/** The built-in gates alone, on text: HTML entities, raw escapes or control characters, a line wider than `cols`. The UI catalogue uses them too. */
export function textGates(screen: string, cols: number): Failure[] {
	const failures: Failure[] = [];
	const lines = screen.split("\n");
	const entity = lines.find((line) => ENTITY.test(line));
	if (entity) failures.push({ gate: "entity", detail: `HTML entity on screen: ${entity.trim()}` });
	const escape = lines.find((line) => ESCAPE.test(line));
	if (escape) failures.push({ gate: "escape", detail: `raw escape or control text on screen: ${JSON.stringify(escape.trim())}` });
	const wide = lines.find((line) => cells(line) > cols);
	if (wide) failures.push({ gate: "width", detail: `${cells(wide)} columns in a ${cols}-column pane: ${wide.trim().slice(0, 60)}` });
	return failures;
}

export type IconOutcome = { status: "pass" | "fail" | "skipped"; failures: Failure[] };

/**
 * The icon gate on its evidence. Fails when fewer icons are placed than wanted (`min`, and every expected one unless only
 * `min` is set), when a placed icon's pixels are blank, or when the strip is text inside a terminal that draws images.
 * A terminal that draws none is `skipped`, never a pass.
 */
export function iconVerdict(spec: NonNullable<Gates["icons"]>, evidence: IconEvidence): IconOutcome {
	if (!evidence.supported) return { status: "skipped", failures: [] };
	const failures: Failure[] = [];
	const wanted = Math.max(spec.min ?? 0, spec.expect === "all" || spec.min === undefined ? evidence.expected : 0);
	if (evidence.placed < wanted) failures.push({ gate: "icons", detail: `${evidence.placed} of ${wanted} icons placed` });
	if (evidence.blank) failures.push({ gate: "icons", detail: `${evidence.blank} of ${evidence.placed} placed icons are unpainted: blank or near one colour on screen after waiting for WezTerm to paint` });
	if (evidence.text.length) failures.push({ gate: "icons", detail: `the strip shows the text fallback in a terminal that draws images: ${evidence.text.slice(0, 4).join(", ")}${evidence.text.length > 4 ? ", ..." : ""}` });
	return { status: failures.length ? "fail" : "pass", failures };
}

/** The deterministic verdict: failures of the story's gates and the built-ins on its final screen and exchange log; empty means pass. `icons` is the icon gate's evidence, read only when the story sets `gates.icons`. */
export function judge(story: Story, screen: string, exchange: Run[], paneCols: number, icons?: IconEvidence): Failure[] {
	const failures: Failure[] = [];
	const modelTurn = exchange.length > 0 || hasIdle(story);
	const built = textGates(screen, paneCols);
	failures.push(...built.filter((failure) => modelTurn || failure.gate === "width"));
	const { gates } = story;
	for (const text of gates.expect ?? []) if (!screen.includes(text)) failures.push({ gate: "expect", detail: `missing on screen: ${text}` });
	for (const text of gates.absent ?? []) if (screen.includes(text)) failures.push({ gate: "absent", detail: `on screen but must not be: ${text}` });
	const finalAnswer = exchange.at(-1)?.answer ?? "";
	for (const text of gates.absentInAnswer ?? []) if (finalAnswer.includes(text)) failures.push({ gate: "absentInAnswer", detail: `in the final answer but must not be: ${text}` });
	const tools = exchange.flatMap((run) => run.tools);
	const { failed: unrecovered } = toolFailures(exchange);
	if (!gates.allowFailedTools) {
		const failed = unrecovered;
		if (failed.length) failures.push({ gate: "tool-failed", detail: `failed tool: ${[...new Set(failed)].join(", ")}` });
	}
	for (const name of gates.tools ?? []) {
		const calls = tools.filter((tool) => tool.name === name);
		if (!calls.length) failures.push({ gate: "tools", detail: `tool never called: ${name}` });
		else if (unrecovered.includes(name)) failures.push({ gate: "tools", detail: `tool failed: ${name}` });
	}
	if (gates.runs) {
		const { command, min, max } = gates.runs;
		const count = exchange.filter((run) => !command || (run.command ?? "").startsWith(command)).length;
		if (count < min || count > max) failures.push({ gate: "runs", detail: `${count} runs${command ? ` of ${command}` : ""}, wanted ${min} to ${max}` });
	}
	if (gates.icons && icons) failures.push(...iconVerdict(gates.icons, icons).failures);
	if (hasIdle(story) && exchange.length === 0) failures.push({ gate: "turn", detail: "the story waited on a model turn and the exchange log has none" });
	return failures;
}

/** The `answerNot` gate on Jev's noul per check: a check at 0.5 or more says yes, which fails the story. */
export function answerNotFailures(names: string[], noul: Record<string, number>): Failure[] {
	return names.filter((name) => (noul[name] ?? 1) >= 0.5).map((name) => ({ gate: "answerNot", detail: `Jev says yes to ${name} (${noul[name] ?? "no answer"}) on the final answer` }));
}

/** The rubric's part of a verdict: a score under the mark fails the story. No mark (undefined) means report-only, never a failure. */
export function rubricFailure(quality: number, mark: number | undefined): Failure | undefined {
	return mark !== undefined && quality < mark ? { gate: "rubric", detail: `quality ${quality} is under ${mark}` } : undefined;
}
