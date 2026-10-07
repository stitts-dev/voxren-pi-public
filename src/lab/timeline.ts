/**
 * Deterministic gates on a story's text timeline: the pane's text sampled while the story ran (smoke.ts). They catch what
 * only shows mid-run, which `judge` on the final screen cannot: a spinner that sticks, a row drawn twice, a clock that
 * runs backwards, markup that leaks for a few frames, a screen that is still repainting at the end.
 */
import { createHash } from "node:crypto";
import { textGates, type Failure } from "./stories.ts";

export interface Frame {
	/** Milliseconds since the story started. */
	t: number;
	/** The pane's text at that moment. */
	text: string;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** A pending card's row: the spinner glyph and the running time (`0.4s`, `1m05s`) the card draws after its label (ui.ts `statusCell`). */
const RUNNING = new RegExp(`[${SPINNER}]\\s+(\\d+(?:\\.\\d)?s|\\d+m\\d\\ds)(?=\\s|$)`);

/** The running rows of a frame: the row with its spinner and time blanked out (its identity) and the time in seconds. */
export function runningRows(text: string): { key: string; seconds: number }[] {
	return text.split("\n").flatMap((line) => {
		const match = RUNNING.exec(line);
		if (!match) return [];
		const time = match[1];
		const seconds = time.includes("m") ? Number(time.split("m")[0]) * 60 + Number(time.slice(time.indexOf("m") + 1, -1)) : Number(time.slice(0, -1));
		return [{ key: line.replace(RUNNING, "@").trim(), seconds }];
	});
}

const same = (a: string, b: string) => a.trimEnd() === b.trimEnd();
const normal = (text: string) => text.split("\n").map((line) => line.trimEnd()).join("\n").trim();

/**
 * The five timeline gates. `expectRunning`: the story calls a tool, so some frame must show a running row.
 * `finalScreen`: the pane's text read at the end, which the last frame must equal. `bannerId`: the story id frame 1 must show.
 */
export function timelineGates(frames: Frame[], finalScreen: string, cols: number, expectRunning: boolean, bannerId?: string): Failure[] {
	const failures: Failure[] = [];
	if (!frames.length) return [{ gate: "timeline", detail: "no frames were sampled" }];
	// 0. Frame 1 is this story's: the pane was cleared and shows its banner, not the last story's screen.
	if (bannerId && !frames[0].text.includes(bannerId)) failures.push({ gate: "first-frame", detail: `frame 1 does not show the story's banner ${bannerId}: the pane still held the last story` });
	const at = (index: number) => `frame ${index + 1} (${(frames[index].t / 1000).toFixed(1)} s)`;
	// 1. A running row shows while a tool runs, and is gone at the end.
	const running = frames.map((frame) => runningRows(frame.text).length > 0);
	if (expectRunning && !running.some(Boolean)) failures.push({ gate: "running", detail: "no frame shows a spinner and clock row while a tool ran" });
	if (running.at(-1)) failures.push({ gate: "running", detail: `a spinner and clock row is still on screen in the last frame: ${runningRows(frames.at(-1)!.text)[0].key.slice(0, 60)}` });
	// 2. No row twice in one frame (blank lines, rules, and short fragments excepted). A card's sub-row (the bar, then an indent) may repeat
	// from card to card, as "not screened · no key" does under each card nothing screened; a card drawn twice still repeats its first row.
	for (const [index, frame] of frames.entries()) {
		const seen = new Set<string>();
		const twice = frame.text.split("\n").map((line) => line.trim()).find((line) => {
			if ((line.match(/[\p{L}\p{N}]/gu) ?? []).length < 8 || /^│ {3}/.test(line)) return false;
			if (seen.has(line)) return true;
			seen.add(line);
			return false;
		});
		if (twice) {
			failures.push({ gate: "duplicate-row", detail: `${at(index)} draws a row twice: ${twice.slice(0, 60)}` });
			break;
		}
	}
	// 3. The clock of one running row never goes backwards.
	const last = new Map<string, number>();
	clock: for (const [index, frame] of frames.entries())
		for (const row of runningRows(frame.text)) {
			const before = last.get(row.key);
			if (before !== undefined && row.seconds < before) {
				failures.push({ gate: "clock-backwards", detail: `${at(index)}: ${before}s then ${row.seconds}s on ${row.key.slice(0, 50)}` });
				break clock;
			}
			last.set(row.key, row.seconds);
		}
	// 4. No frame shows an HTML entity or escape text. Raw markdown bold is a failure when a line with ** holds still for two frames or is
	// on the last one: a half-written bold in a streaming answer changes each frame and closes itself, so it is not raw.
	const starred = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line.includes("**"));
	for (const [index, frame] of frames.entries()) {
		const held = starred(frame.text).find((line) => index === frames.length - 1 || starred(frames[index + 1].text).includes(line));
		const bad = held ? { gate: "raw-markup", detail: `raw ** on screen: ${held.slice(0, 60)}` } : textGates(frame.text, cols).find((failure) => failure.gate === "entity" || failure.gate === "escape");
		if (bad) {
			failures.push({ gate: bad.gate, detail: `${at(index)}: ${bad.detail}` });
			break;
		}
	}
	// 5. The last frame is the final screen.
	if (!same(normal(frames.at(-1)!.text), normal(finalScreen))) failures.push({ gate: "last-frame", detail: "the last frame differs from the final screen: the screen was still repainting" });
	return failures;
}

/**
 * A story's look, as a hash: its final screen and the set of running rows it showed, with the spinner glyphs, the seconds, and the
 * milliseconds blanked, so a run that looks the same hashes the same however its timing fell. A changed hash is a changed look.
 */
export function timelineHash(frames: Frame[], finalScreen: string): string {
	const blank = (text: string) => text.replace(new RegExp(`[${SPINNER}]`, "g"), "*").replace(/\b\d+m\d\ds\b|\b\d+(?:\.\d)?s\b/g, "T").replace(/\b\d+ ms\b/g, "N ms");
	const rows = [...new Set(frames.flatMap((frame) => runningRows(frame.text).map((row) => blank(row.key))))].sort();
	return createHash("sha1").update(blank(normal(finalScreen))).update("\0").update(rows.join("\n")).digest("hex");
}
