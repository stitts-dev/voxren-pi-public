import type { VoxrenToolName } from "./contracts";
import type { JudgeFailureReason } from "./systemone";
import type { UiTheme } from "./ui";

/**
 * The Jev badge: the right end of the header title rule, shown only while the
 * screen is on (TYPESAFE_API_KEY present). It pulses while a screened tool call
 * is in flight, then carries the session tally: how many passages the screen
 * looked at, how many it cut, how many claims it checked and flagged. The tally
 * is folded from tool results in code; nothing here calls Jev.
 */

/** The tools whose results carry a `judgment`: web passages, video transcripts, OP.GG summaries, and the grounding frame. */
export const JEV_TOOLS: ReadonlySet<VoxrenToolName> = new Set<VoxrenToolName>(["web_search", "voxren_video_research", "voxren_meta_research", "voxren_strategy_frame"]);

/** One pulse: hollow, half, full, half. */
export const JEV_FRAMES = ["◇", "◈", "◆", "◈"] as const;
export const JEV_FRAME_MS = 160;

export interface JevTally {
	screened: number;
	cut: number;
	checked: number;
	flagged: number;
}

export interface JevBadgeState {
	/** Screened tool calls in flight. */
	busy: number;
	frame: number;
	tally: JevTally;
	/** The newest screen failure still standing; a tool's failure clears only when that same tool is judged. */
	unavailable?: JudgeFailureReason;
	/** Standing failures, one per tool. */
	failures?: Map<string, JudgeFailureReason>;
}

export interface JevBadgeHandle {
	read(): JevBadgeState;
	start(event: { toolCallId: string; toolName: string }): void;
	end(event: { toolCallId: string; result?: unknown }): void;
	stop(): void;
}

const EMPTY: JevTally = { screened: 0, cut: 0, checked: 0, flagged: 0 };

/** Fold one tool result's `data.judgment` (and frame `claims`) into the tally; anything else is a no-op. */
export function foldJudgment(state: JevBadgeState, result: unknown, tool = ""): void {
	const data = (result as any)?.details?.response?.data;
	const judgment = data?.judgment;
	if (!judgment || typeof judgment !== "object") return;
	if (judgment.status === "unavailable") {
		(state.failures ??= new Map()).delete(tool);
		state.failures.set(tool, judgment.reason);
		state.unavailable = judgment.reason;
		return;
	}
	if (judgment.status !== "judged") return;
	state.failures?.delete(tool);
	state.unavailable = state.failures && [...state.failures.values()].pop();
	if (typeof judgment.checked === "number") {
		state.tally.checked += judgment.checked;
		const claims: any[] = Array.isArray(data.claims) ? data.claims : [];
		state.tally.flagged += claims.filter((claim) => claim?.route === "unsupported" || claim?.route === "contradicted" || claim?.route === "disputed").length;
		return;
	}
	const removed = Array.isArray(judgment.removed) ? judgment.removed.length : 0;
	// The gateway sets `answer` to the route of every answer it judged and blanks it on withheld and off_topic.
	const answerScreened = typeof judgment.answer === "string" ? 1 : 0;
	const answerCut = judgment.answer === "withheld" || judgment.answer === "off_topic" ? 1 : 0;
	state.tally.screened += (typeof judgment.kept === "number" ? judgment.kept : 0) + removed + answerScreened;
	state.tally.cut += removed + answerCut;
}

/** `◆ Jev · 12 screened · 3 cut · 5 checked · 1 flagged`; zero counts are left out, a failure replaces the tally. */
export function jevBadgeText(theme: UiTheme, state: JevBadgeState, withTally = true): string {
	const glyph = state.busy > 0 ? JEV_FRAMES[state.frame % JEV_FRAMES.length] : state.unavailable ? "◇" : "◆";
	const head = `${theme.fg(state.unavailable ? "warning" : "accent", glyph)} ${theme.bold("Jev")}`;
	if (!withTally) return head;
	if (state.unavailable) return `${head} ${theme.fg("warning", `unavailable (${state.unavailable})`)}`;
	const { screened, cut, checked, flagged } = state.tally;
	const parts = [
		...(screened ? [`${screened} screened`] : []),
		...(cut ? [`${cut} cut`] : []),
		...(checked ? [`${checked} checked`] : []),
		...(flagged ? [`${flagged} flagged`] : []),
	];
	return parts.length ? `${head} ${theme.fg("dim", `· ${parts.join(" · ")}`)}` : head;
}

/** Session-scoped badge state; the frame timer runs only while a screened call is in flight. */
export function createJevBadge(opts: { onChange?: () => void; frameMs?: number } = {}): JevBadgeHandle {
	const state: JevBadgeState = { busy: 0, frame: 0, tally: { ...EMPTY } };
	const open = new Map<string, string>();
	let timer: ReturnType<typeof setInterval> | undefined;
	const stopTimer = () => {
		clearInterval(timer);
		timer = undefined;
	};
	return {
		read: () => state,
		start(event) {
			if (!JEV_TOOLS.has(event.toolName as VoxrenToolName)) return;
			open.set(event.toolCallId, event.toolName);
			state.busy = open.size;
			if (!timer) {
				timer = setInterval(() => {
					state.frame = (state.frame + 1) % JEV_FRAMES.length;
					opts.onChange?.();
				}, opts.frameMs ?? JEV_FRAME_MS);
				// Not unref'd: Bun on Windows can skip an unref'd timer (AGENTS.md rule 8), which froze the pulse. It runs only while a call is in flight and stop() clears it.
			}
			opts.onChange?.();
		},
		end(event) {
			const tool = open.get(event.toolCallId);
			if (tool === undefined || !open.delete(event.toolCallId)) return;
			state.busy = open.size;
			if (state.busy === 0) stopTimer();
			foldJudgment(state, event.result, tool);
			opts.onChange?.();
		},
		stop: stopTimer,
	};
}
