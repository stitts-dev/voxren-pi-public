/**
 * Tree demo: the /flow panel in any terminal, with made-up session numbers, so the left/right lens over a live tree
 * can be judged by eye without a model, a key, or the League client. Text only: the same on every terminal.
 *
 *   bun run src/lab/tree-demo.ts [--width 100] [--theme tidal] [--at matchup] [--final]
 *
 * Interactive: ← → move the lens, Home/End jump, q or Esc quits. --final prints the panel once for --at (default
 * every command in turn) with no key reading, which is also what a pipe or a file gets. The numbers are invented:
 * two /matchup runs, one /review run, a /comp run with a failed search, and a meta call open right now.
 */
import { matchesKey } from "@earendil-works/pi-tui";
import { TreePanel, commandTree, panelLines } from "../command-tree";
import { loadTheme, madeUpFlow } from "./ui-data.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args.splice(at, 2)[1];
};
const final = args.includes("--final") || !process.stdin.isTTY || !process.stdout.isTTY;
const width = Number(flag("--width") ?? process.stdout.columns ?? 100);
const themeName = flag("--theme") ?? "tidal";
const at = flag("--at");

const { stats, opened, setClock } = madeUpFlow();

const theme = loadTheme(themeName);
const tree = commandTree();

if (final) {
	const nodes = at ? tree.filter((node) => node.name === at) : tree;
	if (!nodes.length) throw new Error(`--at ${at}: no such command`);
	setClock(opened + 2300);
	for (const node of nodes) console.log(`${panelLines(theme, tree, tree.indexOf(node), stats.read(), width, opened + 2300).join("\n")}\n`);
} else {
	let shown = 0;
	const draw = (lines: string[]) => {
		process.stdout.write(`${shown ? `\x1b[${shown}A` : ""}\r\x1b[J${lines.join("\n")}\n`);
		shown = lines.length;
	};
	const began = Date.now();
	const motion = { now: () => opened + (Date.now() - began), watch: (repaint: () => void) => {
		const timer = setInterval(repaint, 250);
		return () => clearInterval(timer);
	} };
	const finish = () => {
		panel.dispose();
		process.stdin.setRawMode?.(false);
		process.stdin.pause();
		process.stdout.write("\x1b[?25h");
	};
	const panel = new TreePanel(theme, tree, () => stats.read(), { requestRender: () => draw(panel.render(width)), done: finish }, motion);
	// One key per press: matchesKey reads a single sequence, never a run of them.
	for (let step = 0; step < tree.findIndex((node) => node.name === at); step++) panel.handleInput("\x1b[C");
	process.stdout.write("\x1b[?25l");
	process.stdin.setRawMode?.(true);
	process.stdin.resume();
	process.stdin.setEncoding("utf8");
	// A burst of keys (a held arrow, tmux send-keys) arrives as one chunk; matchesKey reads one sequence, so split on each escape.
	process.stdin.on("data", (chunk: string) => {
		for (const data of chunk.split(/(?=\x1b)/).filter(Boolean)) {
			if (data === "q" || data === "\x03" || matchesKey(data, "escape")) return finish();
			panel.handleInput(data);
		}
	});
	draw(panel.render(width));
}
