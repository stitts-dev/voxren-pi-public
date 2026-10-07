/**
 * Card demo: plays one fake /matchup turn in the terminal through the real card renderers, so a change to how the
 * coach's tool calls and thinking lines look is judged by eye on the same turn every time. No model and no network.
 *
 *   bun run src/lab/card-demo.ts [--width 100] [--theme tidal] [--speed 1] [--final] [--keyless] [--unread] [--expanded] [--detail full]
 *
 * The turn: the typed command, the route row, a thinking line, four lookups dispatched together that finish at
 * different times, a second thinking line, the check card with one contradicted claim, then the answer: three rows and a line of prose.
 * --final prints the finished screen once with no animation, which is also what a pipe or a file gets; --speed 2 runs the
 * clock twice as fast. --keyless draws the same turn as a session with no judge key sees it (the route row says Jev is off,
 * every card says it was not screened or not checked, the check card shows the warning mark), then a search whose judge timed
 * out, which a keyed session shows when its judge fails. --unread adds a check that cites a source the judge never read,
 * expanded because only the expanded card marks it. --expanded draws every card expanded, as Ctrl+O does, at the claims
 * level: each claim or passage once with what the judge found under it (a card nothing screened, as in --keyless, lists its
 * results in the same shape with no verdicts or scores; the first video quotes four parts, the first too long, so it shows the
 * two-part limit, the cut, and the line that counts the rest). --detail full draws an expanded card at the full
 * level instead, the judge's questions and score bars (VOXREN_COACH_CARD_DETAIL sets the same level in the coach; try
 * --expanded --detail full to see every card that way). --width defaults to the width of the terminal the demo runs in, 100
 * when its output goes to a pipe or a file. Every name, number, and row here is made up: none of it is coaching advice.
 */
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { cardCalls, loadTheme, markdownThemeFor, type Call } from "./ui-data.ts";
import { FRAME_MS, answerMarkdown, createCardMotion, createRouteRow, createToolCall, createToolResult, parseCardDetail, quoteUserText, thinkingMarkdown, type ToolRenderState } from "../ui";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args.splice(at, 2)[1];
};
const final = args.includes("--final") || !process.stdout.isTTY;
const width = Number(flag("--width") ?? process.stdout.columns ?? 100);
const speed = Number(flag("--speed") ?? 1);
const themeName = flag("--theme") ?? "tidal";
const keyless = args.includes("--keyless");
const unread = args.includes("--unread");
const expandedAll = args.includes("--expanded");
const detail = parseCardDetail(flag("--detail"));

const theme = loadTheme(themeName);
const markdownTheme: MarkdownTheme = markdownThemeFor(theme);

// --- the fake turn ----------------------------------------------------------

const CALLS = cardCalls(keyless, unread);

const THINKING = [
	{ at: 700, text: "**Checking fact support**" },
	{ at: 4300, text: "**Restarting matchup lookup**\n\n**Checking level-up notes**" },
];

const ANSWER = [
	"Lane: Charm spent: **trade**, never while it is ready.",
	"Kill: Level 2: **shove the wave**, then back on your own timer; *until then, hold your dash for hers.*",
	"Threat: River dark at 3:00: **ward it**, being caught there loses the lane.",
	"",
	"Skip the guide's rocketbelt line. The lane data does not back it.",
];
const ANSWER_AT = 6300;
const END = ANSWER_AT + ANSWER.length * 150 + 600;

// --- the screen ----------------------------------------------------------------

let clock = 0;
const motion = createCardMotion({ now: () => clock });
motion.enable(!final);
const cards = new Map<Call, ToolRenderState>();
const route = createRouteRow(theme, keyless ? { model: "gpt-6-luna", thinking: "medium", source: "fallback", tier: "standard", failure: "off" } : { model: "gpt-6-luna", thinking: "low", source: "jev", tier: "quick", p: 0.82, ms: 280, by: "jev-1.13.0" }, 1);

/** Pi's markdown for one block: one cell of output padding, the theme's colours. */
const markdown = (text: string, style: ConstructorParameters<typeof Markdown>[4], transform?: (text: string, width: number) => string) =>
	new Markdown(text, 1, 0, markdownTheme, style, transform ? { transform } : {}).render(width);

/** What Pi would draw `t` milliseconds into the turn: the same components, built the way it builds them. */
function screen(t: number): string[] {
	clock = t;
	const lines = ["", ...markdown(quoteUserText("/matchup Ahri"), { color: (text) => theme.fg("userMessageText", text) }), ""];
	if (t >= 250) lines.push(...route.render(width));
	for (const thought of THINKING) if (t >= thought.at) lines.push("", ...markdown(thought.text, { color: (text) => theme.fg("thinkingText", text), italic: true }, thinkingMarkdown));
	for (const call of CALLS) {
		if (t < call.at) continue;
		let context = cards.get(call);
		if (!context) cards.set(call, (context = { state: {}, invalidate() {}, executionStarted: true }));
		// Pi stacks the pending call row and the result row in one box; the call row hides itself once the result is in.
		const rows = createToolCall(theme, call.name, call.args, context, motion).render(width);
		if (t >= call.at + call.takes) rows.push(...createToolResult(theme, call.name, call.args, { response: call.response }, call.expanded ?? expandedAll, context, motion, detail).render(width));
		if (rows.length) lines.push("", ...rows);
	}
	// Through the coach's own answer transformer, which wraps to the width like the cards, so a narrow terminal never reflows a row and throws the repaint's line count off.
	const answer = ANSWER.filter((_, index) => t >= ANSWER_AT + index * 150);
	lines.push("", ...(answer.length ? markdown(answer.join("\n"), undefined, (text, room) => answerMarkdown(text, room, theme)) : []));
	return lines;
}

if (final) {
	// Run the clock through the turn without waiting, so each card records its own start and finish.
	let last: string[] = [];
	for (let t = 0; t <= END; t += 20) last = screen(t);
	console.log(last.join("\n"));
} else {
	let shown = 0;
	const draw = (lines: string[]) => {
		process.stdout.write(`${shown ? `\x1b[${shown}A` : ""}\r\x1b[J${lines.join("\n")}\n`);
		shown = lines.length;
	};
	const finish = () => {
		motion.stop();
		process.stdout.write("\x1b[?25h");
	};
	process.on("SIGINT", () => {
		finish();
		process.exit(130);
	});
	process.stdout.write("\x1b[?25l");
	const began = Date.now();
	const timer = setInterval(() => {
		const t = Math.min(END, (Date.now() - began) * speed);
		draw(screen(t));
		if (t >= END) {
			clearInterval(timer);
			finish();
		}
	}, FRAME_MS);
}
