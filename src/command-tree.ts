import { Container, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type SelectItem } from "@earendil-works/pi-tui";
import { logEvent } from "./coach-log";
import { COACH_COMMANDS, autoOn, COACH_TIERS, COACH_YAML, VOXREN_TOOLS, expandLaunchSlots, type CoachCommand, type CommandSettings, type TierName, type VoxrenToolName } from "./contracts";
import type { Exchange } from "./exchange-log";
import { type CardMotion, type UiTheme, toolShortName, toolVerb } from "./ui";

/**
 * The command tree (a UX spike): what sits behind each slash command, as one ASCII tree per command, with this
 * session's live numbers on it. `/flow` opens it as a keyboard panel (Pi's own `/tree` is its session tree, so
 * the word is taken); left and right move a lens across the commands. Text only, so it reads the same on every
 * terminal. Nothing here reaches the model or the gateway.
 */

export const TREE_COMMAND = "flow";
export const TREE_COMMAND_DESCRIPTION = "The tree behind each command: tier, tools, and this session's numbers (left/right to move)";
export const TREE_TUI_ONLY_MESSAGE = "/flow needs the interactive TUI.";
export const TREE_NO_ARGS_MESSAGE = "/flow takes no arguments. Open it bare and press left or right.";

// --- the static tree -------------------------------------------------------------

export interface CommandNode {
	name: string;
	args?: string;
	description: string;
	tier: TierName;
	model: string;
	thinking: string;
	/** Reads the League client when it runs (AGENTS.md rule 3). */
	readsClient: boolean;
	/** The prompt has a lane slot filled from the client, the env, or Data Dragon. */
	fillsLane: boolean;
	/** Tools the command cannot run without. */
	needs: readonly VoxrenToolName[];
	/** Tools the prompt tells the model to call, in the order it first names them; the `needs` list when it names none. */
	steps: readonly VoxrenToolName[];
	/** Steps whose tool is disabled in this launch (a missing key): the command refuses to run when a needed one is off. */
	off: readonly VoxrenToolName[];
	/** The player can save the argument a bare run sends (the `args` row). */
	savesDefault: boolean;
	/** An automatic call runs this command: /draft at champ select, /comp at game start, /review at game end (the `auto` row). */
	autoRuns: boolean;
	/** The fixed list the args row steps through, from coach.yaml; empty when the list comes from data (TreeSettings.choices). */
	choices: readonly string[];
}

/**
 * The tools a prompt template tells the model to call, in order of first mention. A mention right after "no" is a
 * prohibition (/draft: "no web_search here"), not a step. The tool words are fixed template text, never a filled slot.
 */
export function promptSteps(template: string, needs: readonly VoxrenToolName[]): VoxrenToolName[] {
	const text = template;
	const found: Array<{ at: number; tool: VoxrenToolName }> = [];
	for (const tool of VOXREN_TOOLS) {
		const pattern = new RegExp(`(?:^|[^\\w])(no\\s+)?${tool}(?![\\w])`, "g");
		for (const match of text.matchAll(pattern)) {
			if (match[1]) continue;
			found.push({ at: match.index ?? 0, tool });
			break;
		}
	}
	const steps = found.sort((a, b) => a.at - b.at).map((entry) => entry.tool);
	return steps.length ? steps : [...needs];
}

/** One node per command in coach.yaml order; the template is read from the yaml, the rest from the command contract. `disabled` is this launch's list of tools that are off. */
export function commandTree(commands: readonly CoachCommand[] = COACH_COMMANDS, templates: ReadonlyArray<{ name: string; prompt: string }> = COACH_YAML.commands, disabled: readonly VoxrenToolName[] = []): CommandNode[] {
	return commands.map((command) => {
		const steps = promptSteps(expandLaunchSlots(templates.find((entry) => entry.name === command.name)?.prompt ?? ""), command.needs);
		return {
		name: command.name,
		args: command.args,
		description: command.description,
		tier: command.tier,
		model: COACH_TIERS[command.tier].model,
		thinking: COACH_TIERS[command.tier].thinking,
		readsClient: command.usesComposition,
		fillsLane: command.needsLane,
			needs: command.needs,
			steps,
			off: steps.filter((tool) => disabled.includes(tool)),
			savesDefault: command.savesDefault,
			autoRuns: command.autoRuns,
			choices: command.choices,
		};
	});
}

// --- this session's numbers --------------------------------------------------------

export interface ToolTally {
	calls: number;
	failed: number;
	/** Milliseconds over every finished call, for the average. */
	totalMs: number;
}

export interface CommandTally {
	/** Finished runs; 0 while the first is still going. */
	runs: number;
	/** The last finished run: how long it took and the tools it called, in order. */
	lastMs: number;
	lastTools: VoxrenToolName[];
	lastAborted: boolean;
	/** The run before the last, for the comparison; undefined until a second run. */
	previousMs?: number;
	/** This command's own calls of each tool: a meta lookup under /draft never counts for /matchup. */
	tools: Map<VoxrenToolName, ToolTally>;
}

export interface TreeStats {
	/** Keyed by command name; "" holds the typed questions' calls. */
	commands: ReadonlyMap<string, CommandTally>;
	/** Tool calls open right now: which command's turn each belongs to and when it started. */
	running: ReadonlyMap<string, { name: VoxrenToolName; command: string; started: number }>;
	/** The command whose turn is running, if a command sent it; "" for a typed question; undefined while idle. */
	current: string | undefined;
	/** When the open turn started, for the "so far" clock; undefined while idle. */
	currentStarted: number | undefined;
}

export interface TreeStatsHandle {
	read(): TreeStats;
	/** A turn started: `command` is the slash command that composed it, or undefined for a typed question. */
	turnStart(command: string | undefined): void;
	toolStart(event: { toolCallId: string; toolName: string }): void;
	toolEnd(event: { toolCallId: string; isError: boolean }): void;
	/** A finished run as the exchange log recorded it: the per-command tallies come from here, so both agree. */
	run(exchange: Pick<Exchange, "command" | "ms" | "tools" | "aborted">): void;
	/** The turn settled: Pi emits this once per prompt, after every retry or continued run, so this is what closes the turn. */
	turnEnd(): void;
	/** A new, resumed, or forked session: "this session" starts again. */
	reset(): void;
}

/** A live fold of the session's tool calls and runs, for the tree. `onChange` requests a repaint. */
export function createTreeStats(opts: { onChange?: () => void; now?: () => number } = {}): TreeStatsHandle {
	const { onChange = () => {}, now = Date.now } = opts;
	const commands = new Map<string, CommandTally>();
	const running = new Map<string, { name: VoxrenToolName; command: string; started: number }>();
	let current: string | undefined;
	let currentStarted: number | undefined;
	const isTool = (name: string): name is VoxrenToolName => (VOXREN_TOOLS as readonly string[]).includes(name);
	const tallyOf = (command: string) => {
		let tally = commands.get(command);
		if (!tally) commands.set(command, (tally = { runs: 0, lastMs: 0, lastTools: [], lastAborted: false, previousMs: undefined, tools: new Map() }));
		return tally;
	};
	return {
		read: () => ({ commands, running, current, currentStarted }),
		turnStart(command) {
			current = command ?? "";
			currentStarted = now();
			onChange();
		},
		toolStart(event) {
			if (!isTool(event.toolName)) return;
			running.set(event.toolCallId, { name: event.toolName, command: current ?? "", started: now() });
			onChange();
		},
		toolEnd(event) {
			const open = running.get(event.toolCallId);
			if (!open) return;
			running.delete(event.toolCallId);
			const tools = tallyOf(open.command).tools;
			const tally = tools.get(open.name) ?? { calls: 0, failed: 0, totalMs: 0 };
			tally.calls++;
			if (event.isError) tally.failed++;
			tally.totalMs += now() - open.started;
			tools.set(open.name, tally);
			onChange();
		},
		run(exchange) {
			// Pi can continue the same turn after agent_end (a retried provider error, a queued message) with no new
			// before_agent_start, so a run leaves `current` and the open calls alone: agent_settled's turnEnd closes the turn.
			// An auto /draft logs as "draft:auto": the same tree node as a typed /draft.
			const name = exchange.command?.replace(/:auto$/, "");
			if (name) {
				const tally = tallyOf(name);
				if (tally.runs) tally.previousMs = tally.lastMs;
				tally.runs++;
				tally.lastMs = exchange.ms;
				tally.lastTools = exchange.tools.map((tool) => tool.name).filter(isTool);
				tally.lastAborted = Boolean(exchange.aborted);
			}
			onChange();
		},
		turnEnd() {
			current = undefined;
			currentStarted = undefined;
			running.clear();
			onChange();
		},
		reset() {
			commands.clear();
			running.clear();
			current = undefined;
			currentStarted = undefined;
			onChange();
		},
	};
}

export const EMPTY_STATS: TreeStats = { commands: new Map(), running: new Map(), current: undefined, currentStarted: undefined };

// --- the lines ---------------------------------------------------------------------

const MIN_WIDTH = 20;
const GAP = "  ";
/** Rows under a section rule sit this far in, so the rules read as the menu's headings. */
const INDENT = "  ";

/** A section heading under the header's: `TITLE  note ─────` filled to `width` with a light rule, the note dropped before the title is cut. */
export function sectionRule(theme: UiTheme, title: string, width: number, note = ""): string {
	const w = Math.max(MIN_WIDTH, Math.floor(width));
	for (const head of [`${title}${note ? `${GAP}${note}` : ""}`, title]) {
		const room = w - visibleWidth(head) - 1;
		if (room >= 3) return `${head} ${theme.fg("accent", "─".repeat(room))}`;
	}
	return truncateToWidth(title, w);
}

/**
 * The lens strip: every command on one line, the selected one bold and bracketed. A command that ran this session
 * carries its run count, and one with a tool call open right now carries ●, so the strip itself is live. When the
 * commands do not fit, a window around the selection, with `◂` and `▸` where commands are cut off on each side.
 */
export function lensLine(theme: UiTheme, tree: readonly CommandNode[], selected: number, width: number, stats: TreeStats = EMPTY_STATS): string {
	const w = Math.max(MIN_WIDTH, Math.floor(width));
	const open = new Set([...stats.running.values()].map((entry) => entry.command));
	const cells = tree.map((node, index) => {
		const runs = stats.commands.get(node.name)?.runs ?? 0;
		const count = runs ? ` ×${runs}` : "";
		// A command that has run keeps the ● slot (blank when idle), so the strip does not shift when a call opens or closes.
		const live = open.has(node.name);
		const pad = runs && !live ? "  " : "";
		const plain = `${index === selected ? `[/${node.name}${count}${live ? " ●" : ""}]` : `/${node.name}${count}${live ? " ●" : ""}`}${pad}`;
		const painted = `${index === selected ? theme.bold(theme.fg("accent", plain.trimEnd())) : `${theme.fg("dim", `/${node.name}${count}`)}${live ? ` ${theme.fg("accent", "●")}` : ""}`}${pad}`;
		return { plain, painted };
	});
	const fits = (from: number, to: number, arrows: number) => cells.slice(from, to).reduce((sum, cell) => sum + cell.plain.length, 0) + Math.max(0, to - from - 1) * GAP.length + arrows <= w;
	if (fits(0, tree.length, 0)) return cells.map((cell) => cell.painted).join(GAP);
	// Grow the window out from the selection one command at a time, right and left in turn, while it still fits
	// beside its arrows, so the lens stays near the middle as it moves.
	let from = selected;
	let to = selected + 1;
	const arrowCells = (lo: number, hi: number) => (lo > 0 ? 2 : 0) + (hi < tree.length ? 2 : 0);
	for (let side = 0; ; side++) {
		const growRight = to < tree.length && fits(from, to + 1, arrowCells(from, to + 1));
		const growLeft = from > 0 && fits(from - 1, to, arrowCells(from - 1, to));
		if (!growRight && !growLeft) break;
		if (growRight && (side % 2 === 0 || !growLeft)) to++;
		else from--;
	}
	const left = from > 0 ? `${theme.fg("accent", "◂")} ` : "";
	const right = to < tree.length ? ` ${theme.fg("accent", "▸")}` : "";
	return truncateToWidth(`${left}${cells.slice(from, to).map((cell) => cell.painted).join(GAP)}${right}`, w);
}

/**
 * The live marks the header's command bar carries, by command name: the run count this session and ● while a tool
 * call is open under the command. Empty for a command with neither, so a fresh launch's bar is the plain one.
 */
export function commandMarks(stats: TreeStats): Map<string, string> {
	const open = new Set([...stats.running.values()].map((entry) => entry.command));
	const marks = new Map<string, string>();
	// A command that has run keeps the ● slot, blank while idle, so the bar's other commands do not move when a call opens or closes.
	for (const [name, tally] of stats.commands) if (tally.runs) marks.set(name, ` ×${tally.runs}  `);
	for (const name of open) marks.set(name, `${marks.get(name)?.trimEnd() ?? ""} ●`);
	return marks;
}

function seconds(ms: number): string {
	return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

const THINKING_ROLE: Record<string, string> = { low: "thinkingLow", medium: "thinkingMedium", high: "thinkingHigh" };

/** One tool's live row under one command: what it is doing now for that command, else its tally there, else nothing yet. */
function toolStatus(theme: UiTheme, node: CommandNode, tool: VoxrenToolName, stats: TreeStats, now: number): string {
	const command = node.name;
	if (node.off.includes(tool)) return theme.fg("error", "off this launch");
	const open = [...stats.running.values()].filter((entry) => entry.name === tool && entry.command === command);
	if (open.length) return theme.fg("accent", `running ${seconds(now - Math.min(...open.map((entry) => entry.started)))}`);
	const tally = stats.commands.get(command)?.tools.get(tool);
	if (!tally) return theme.fg("dim", "not called yet");
	const avg = `${tally.calls} ${tally.calls === 1 ? "call" : "calls"} · ${seconds(tally.totalMs / tally.calls)} avg`;
	return tally.failed ? `${avg} · ${theme.fg("error", `${tally.failed} failed`)}` : `${avg} · ${theme.fg("success", "all ok")}`;
}

/**
 * The tree for one command. Each row names the decision it changes: the tier row says how long and how deep the
 * answer will be (the tier's default model; a model the player pinned wins, and the route row shows it); the reads
 * row says whether to have the League client open; the step rows say what runs, what is off in this launch, and how
 * each call is going; the runs row says what the last run of this command cost in time against the one before, and,
 * while this command's turn is open, how long it has run so far against the last one.
 */
// --- the player's settings for a command ------------------------------------------------

export type SettingRow = "auto" | "args";

/** A command's setting rows, in the order the tree draws them. */
export function settingRows(node: CommandNode): SettingRow[] {
	return [...(node.savesDefault ? (["args"] as const) : []), ...(node.autoRuns ? (["auto"] as const) : [])];
}

/** What the setting rows show: this command's saved settings, whether the env var forces auto on, the focused row, and a data list still loading or empty (with why). */
export interface SettingsView {
	settings: CommandSettings;
	autoForced?: boolean;
	focus?: SettingRow;
	loading?: boolean;
	note?: string;
}

/** What each auto row does, shown beside it. */
const AUTO_NOTE: Record<string, string> = { draft: "calls your pick when it settles, the draft once four enemies lock", comp: "plans your game when it starts", review: "reviews your last ranked game when a game ends" };

/** One row of the Settings group. The focused value sits in ‹ › so it reads as something left and right change. */
function settingLine(theme: UiTheme, node: CommandNode, row: SettingRow, view: SettingsView, label: (text: string) => string, branch: string): string {
	const dot = theme.fg("dim", " · ");
	const focused = view.focus === row;
	const shown = (text: string, role: string) => (focused ? theme.bold(theme.fg("accent", `‹ ${text} ›`)) : theme.fg(role, text));
	if (row === "auto") {
		const on = autoOn(view.autoForced, view.settings);
		return `${branch} ${label("auto")} ${shown(on ? "on" : "off", on ? "success" : "dim")}${dot}${theme.fg("muted", view.autoForced !== undefined ? "VOXREN_COACH_AUTO_COMP" : AUTO_NOTE[node.name] ?? "")}`;
	}
	const args = view.settings.args;
	const value = view.loading ? shown("loading…", "dim") : args ? shown(args, "text") : shown("none", "dim");
	return `${branch} ${label("args")} ${value}${dot}${theme.fg("muted", view.note ?? `what a bare /${node.name} sends`)}`;
}

export function treeLines(theme: UiTheme, node: CommandNode, stats: TreeStats = EMPTY_STATS, width = 80, now = Date.now(), view?: SettingsView): string[] {
	const w = Math.max(MIN_WIDTH, Math.floor(width));
	const label = (text: string) => theme.fg("accent", text.padEnd(6));
	const dot = theme.fg("dim", " · ");
	const title = `${theme.bold(theme.fg("accent", `/${node.name}`))}${node.args ? ` ${theme.fg("dim", node.args)}` : ""}`;
	const tier = `${theme.fg(THINKING_ROLE[node.thinking] ?? "text", node.tier)}${dot}default ${node.model}${dot}thinking ${node.thinking}`;
	const reads = [node.readsClient ? "League client" : undefined, node.fillsLane ? "your lane" : undefined].filter(Boolean).join(", ") || theme.fg("dim", "no client read");
	const settingList = view ? settingRows(node) : [];
	const settings = settingList.map((row, index) => settingLine(theme, node, row, view!, label, index === settingList.length - 1 ? "└─" : "├─"));
	const rows = [...wrapTextWithAnsi(node.description, w - INDENT.length), `├─ ${label("tier")} ${tier}`, `├─ ${label("reads")} ${reads}`, `├─ ${theme.fg("accent", "steps")}`];
	// The planned steps, then any tool this command's runs called that the prompt never named (the system prompt or
	// the model's own call), marked "+" instead of a number: the gap between the plan and what ran.
	const tally = stats.commands.get(node.name);
	const extra = [...(tally?.tools.keys() ?? []), ...[...stats.running.values()].filter((entry) => entry.command === node.name).map((entry) => entry.name)].filter((tool, index, all) => !node.steps.includes(tool) && all.indexOf(tool) === index);
	const branch = [...node.steps.map((tool, index) => ({ tool, mark: String(index + 1) })), ...extra.map((tool) => ({ tool, mark: "+" }))];
	branch.forEach(({ tool, mark }, index) => {
		const last = index === branch.length - 1;
		const head = `│  ${last ? "└─" : "├─"} ${theme.fg("dim", mark)} ${theme.bold(toolShortName(tool).padEnd(8))} ${toolVerb(tool)}`;
		rows.push(`${head}${dot}${toolStatus(theme, node, tool, stats, now)}`);
	});
	if (!branch.length) rows.push(`│  └─ ${theme.fg("dim", "no tool: the model answers from the prompt alone")}`);
	const before = tally?.previousMs === undefined ? "" : ` vs ${seconds(tally.previousMs)} before`;
	const live = stats.current === node.name && stats.currentStarted !== undefined;
	const runs = live
		? `${theme.fg("accent", "now")} ${seconds(now - (stats.currentStarted ?? now))} so far${tally?.runs ? ` vs ${seconds(tally.lastMs)} last` : ""}`
		: tally?.runs
		? `${tally.runs} ${tally.runs === 1 ? "run" : "runs"} this session${dot}last ${seconds(tally.lastMs)}${tally.lastAborted ? ` ${theme.fg("error", "aborted")}` : ""}${before}${dot}called ${tally.lastTools.length ? tally.lastTools.map((tool) => toolShortName(tool)).join(", ") : "nothing"}`
		: theme.fg("dim", "not run this session");
	rows.push(`└─ ${label("runs")} ${runs}`);
	// What the player can change sits apart from what the tree reports, under its own heading.
	const fit = (row: string) => (visibleWidth(row) > w ? truncateToWidth(row, w) : row);
	const indented = (list: string[]) => list.map((row) => fit(`${INDENT}${row}`.trimEnd()));
	return [
		sectionRule(theme, title, w),
		...indented(rows),
		...(settings.length ? ["", sectionRule(theme, theme.bold(theme.fg("accent", "SETTINGS")), w), ...indented(settings)] : []),
	];
}

const HINT = "← → move · Home/End ends · Esc close · Ctrl+D quit";

/** The keys of the current focus: the lens (with ↓ when the command has a setting), or the focused setting row. */
function hint(node: CommandNode | undefined, view?: SettingsView): string {
	if (view?.focus === "auto") return view.autoForced !== undefined ? "↑ ↓ row · set by VOXREN_COACH_AUTO_COMP · Esc back" : "↑ ↓ row · ← → change · Esc back";
	if (view?.focus === "args") return "↑ ↓ row · ← → change · Esc back";
	return view && node && settingRows(node).length ? "← → move · ↓ settings · Home/End ends · Esc close · Ctrl+D quit" : HINT;
}

/** The whole panel: the title rule over the lens strip, one blank row, the selected command's tree, and the key hint. Every row fits the width: pi-tui stops the screen on a line that does not. */
export function panelLines(theme: UiTheme, tree: readonly CommandNode[], selected: number, stats: TreeStats, width: number, now = Date.now(), view?: SettingsView): string[] {
	const w = Math.max(MIN_WIDTH, Math.floor(width));
	const node = tree[selected];
	const inner = Math.max(MIN_WIDTH, w - INDENT.length);
	return [
		sectionRule(theme, theme.bold(theme.fg("accent", "COMMAND TREE")), w, theme.fg("dim", "what runs behind each command, live")),
		truncateToWidth(`${INDENT}${lensLine(theme, tree, selected, inner, stats)}`, w),
		"",
		...(node ? treeLines(theme, node, stats, w, now, view) : []),
		"",
		truncateToWidth(`${INDENT}${theme.fg("dim", hint(node, view))}`, w),
	];
}

// --- the panel -----------------------------------------------------------------------

export interface TreePanelHooks {
	requestRender(): void;
	done(): void;
	/** Ctrl+D: Pi's quit, the same as on an empty editor. The panel closes first. */
	quit?(): void;
	/** A printable key while the panel is open: it closes and the text goes to the editor, so typing a command just works. */
	onType?(text: string): void;
	/** The player's per-command settings; without it the tree shows no setting rows (the demo). */
	settings?: TreeSettings;
}

export interface TreeSettings {
	read(): Readonly<Record<string, CommandSettings>>;
	/** VOXREN_COACH_AUTO_COMP says on or off: the auto row shows that and does not toggle. */
	autoForced?: boolean;
	/** Saves one command's settings; false when refused (the hook has told the player why). */
	save(name: string, next: CommandSettings): boolean;
	/** The list an args row steps through when it comes from data (/patch: Data Dragon champions, /otp: saved one-tricks), with a note when it is empty. */
	choices(name: string): Promise<{ items: SelectItem[]; note?: string }>;
}

/** The `/flow` panel: a keyboard-focused component in the editor's place, the way /config and /riot-key open. */
export class TreePanel extends Container {
	private selected = 0;
	/** The focused setting row of the selected command; undefined while the lens has the keys. */
	private row: number | undefined;
	/** Data lists loaded this panel, by command; the one loading now; why a list came back empty. */
	private readonly lists = new Map<string, readonly string[]>();
	private loading: string | undefined;
	private readonly notes = new Map<string, string>();
	private readonly body: Component;
	/** Set while a call is open: the card clock repaints the panel every frame so the running time ticks. */
	private unwatch: (() => void) | undefined;
	/** One function for the whole panel: motion keeps watchers in a set, so watching again while still watched adds nothing. */
	private readonly repaint = () => this.hooks.requestRender();

	constructor(
		private readonly theme: UiTheme,
		private readonly tree: readonly CommandNode[],
		private readonly readStats: () => TreeStats,
		private readonly hooks: TreePanelHooks,
		private readonly motion: Pick<CardMotion, "now" | "watch"> = { now: Date.now, watch: () => () => {} },
	) {
		super();
		this.body = {
			render: (width) => {
				const stats = this.readStats();
				// Watch on every render while a call is open: motion.stop() (agent_end) drops watchers without telling us, and Pi can continue the turn.
				if (stats.running.size) this.unwatch = this.motion.watch(this.repaint);
				if (!stats.running.size && this.unwatch) this.dispose();
				const w = Math.max(MIN_WIDTH, width - 2);
				return panelLines(this.theme, this.tree, this.selected, stats, w, this.motion.now(), this.view()).map((line) => ` ${line}`);
			},
			invalidate() {},
		};
		this.addChild(this.body);
	}

	dispose(): void {
		this.unwatch?.();
		this.unwatch = undefined;
	}

	get selection(): number {
		return this.selected;
	}

	private get node(): CommandNode | undefined {
		return this.tree[this.selected];
	}

	private view(): SettingsView | undefined {
		const store = this.hooks.settings;
		const node = this.node;
		if (!store || !node) return undefined;
		return {
			settings: store.read()[node.name] ?? {},
			autoForced: store.autoForced,
			focus: this.row === undefined ? undefined : settingRows(node)[this.row],
			loading: this.loading === node.name,
			note: this.notes.get(node.name),
		};
	}

	/**
	 * Left and right move the lens (no wrap: the ends are the ends), Home and End jump, Escape or Enter closes, Down steps
	 * into the command's setting rows. On a row, left and right change its value, Del clears args, and only Ctrl+D and typed text fall back to the lens.
	 */
	handleInput(data: string): void {
		if (this.row !== undefined) return this.rowInput(data);
		const last = this.tree.length - 1;
		if (matchesKey(data, "right") || matchesKey(data, "tab")) this.selected = Math.min(last, this.selected + 1);
		else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "home")) this.selected = 0;
		else if (matchesKey(data, "end")) this.selected = last;
		else if (matchesKey(data, "ctrl+d") && this.hooks.quit) {
			this.hooks.done();
			return this.hooks.quit();
		} else if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "\r" || data === "\n") return this.hooks.done();
		else if (matchesKey(data, "down") && this.view() && this.node && settingRows(this.node).length) this.row = 0;
		else if (this.hooks.onType && data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
			this.hooks.done();
			return this.hooks.onType(data);
		} else return;
		this.hooks.requestRender();
	}

	private rowInput(data: string): void {
		const node = this.node;
		const store = this.hooks.settings;
		const rows = node ? settingRows(node) : [];
		const row = rows[this.row ?? 0];
		if (!node || !store || !row) {
			this.row = undefined;
			return this.handleInput(data);
		}
		const current = store.read()[node.name] ?? {};
		const step = matchesKey(data, "right") ? 1 : matchesKey(data, "left") ? -1 : 0;
		if (matchesKey(data, "up")) this.row = this.row ? this.row - 1 : undefined;
		else if (matchesKey(data, "down")) this.row = Math.min(rows.length - 1, (this.row ?? 0) + 1);
		else if (matchesKey(data, "escape")) this.row = undefined;
		else if (step && row === "auto") {
			if (store.autoForced === undefined) store.save(node.name, { ...current, auto: !autoOn(undefined, current) });
		} else if (step && row === "args") this.stepArgs(node, store, step);
		else if (row === "args" && (matchesKey(data, "backspace") || matchesKey(data, "delete"))) store.save(node.name, { ...current, args: undefined });
		else if (matchesKey(data, "ctrl+d") || (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data))) {
			// Only Ctrl+D (quit) and a typed character (closes the panel, text goes to the editor) leave the row. Home, End, Tab and Enter do nothing here.
			this.row = undefined;
			return this.handleInput(data);
		} else return;
		this.hooks.requestRender();
	}

	/**
	 * One step through an args row's list, none sitting between the last and the first: the fixed list from coach.yaml,
	 * or a data list loaded on the first step (that step lands once it arrives).
	 */
	private stepArgs(node: CommandNode, store: TreeSettings, step: number): void {
		const values = node.choices.length ? node.choices : this.lists.get(node.name);
		if (!values) {
			if (this.loading === node.name) return;
			this.loading = node.name;
			void store
				.choices(node.name)
				.catch((error) => {
					logEvent("warn", "command-tree", "choices-failed", { node: node.name }, error);
					return { items: [], note: "Could not load the list." };
				})
				.then(({ items, note }) => {
					if (this.loading === node.name) this.loading = undefined;
					this.lists.set(node.name, items.map((item) => item.value));
					if (note) this.notes.set(node.name, note);
					// The step lands only if the player is still on this command's args row: after Esc nothing is saved, and the list waits for the next try.
					const row = this.row === undefined ? undefined : settingRows(node)[this.row];
					if (items.length && this.node === node && row === "args") this.stepArgs(node, store, step);
					this.hooks.requestRender();
				});
			return;
		}
		if (!values.length) return;
		const current = store.read()[node.name] ?? {};
		const cycle = ["", ...values];
		const at = Math.max(0, cycle.indexOf(current.args ?? ""));
		const next = cycle[(at + step + cycle.length) % cycle.length];
		store.save(node.name, { ...current, args: next || undefined });
	}
}
