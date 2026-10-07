import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { iconLine, prefetchChampionIcons, prefetchItemIcons, prefetchRuneIcons, resetIcons } from "./icons";
import { hasPanelContent, panelLines, panelModel, withoutPanelRows } from "./panel";
import { fitInlineIcons, greyIcon, INLINE_ICON, loadRasterizer } from "./terminal-images";

const theme = { fg: (_style: string, text: string) => text, bold: (text: string) => text } as any;

const ANSWER = [
	"Lane: Q shield up: hold abilities, then E his Q.",
	"Kill: Q missed and low: all-in.",
	"Threat: Viego enters melee range: save E for his engage.",
	"Fights: Sona uses Crescendo: burst Caitlyn before she free-hits.",
	"Runes: Electrocute, Sudden Impact, Grisly Mementos, Ultimate Hunter; Transcendence, Gathering Storm; Adaptive Force, Adaptive Force, Health; Flash, Ignite",
	"Build: Doran's Ring → Lich Bane → Sorcerer's Shoes → Zhonya's Hourglass",
	"Swap: Health instead of Health Scaling, into Viego and Sona engage",
].join("\n");
const CHAMPIONS = ["Viego", "Sona", "Caitlyn"];
const boxes = (model: ReturnType<typeof panelModel>) => model.boxes.map((box) => [box.title, box.rows.map((row) => row.label)]);

describe("panel model", () => {
	test("outside a game the lane calls are now and the fights come later", () => {
		expect(boxes(panelModel(ANSWER, { champions: CHAMPIONS, status: "" }))).toEqual([
			["NOW", ["Lane", "Kill", "Threat"]],
			["LATER", ["Fights"]],
		]);
	});

	test("past 14:00 the fights are now and the lane calls fold into a quiet laning box", () => {
		const model = panelModel(ANSWER, { champions: CHAMPIONS, status: "", live: { gameTimeSec: 1820, ownedItems: ["Doran's Ring", "Lich Bane", "Sorcerer's Shoes"] } });
		expect(boxes(model)).toEqual([
			["NOW · 30:20", ["Threat", "Fights"]],
			["LANING", ["Lane", "Kill"]],
		]);
		expect(model.boxes.map((box) => box.quiet)).toEqual([false, true]);
		expect(model.clock).toBe("30:20");
		expect(model.owned).toEqual(["Doran's Ring", "Lich Bane", "Sorcerer's Shoes"]);
		expect(model.next).toBe("Zhonya's Hourglass");
	});

	test("a call splits into its cue and its action, and keeps the champions it names", () => {
		const fights = panelModel(ANSWER, { champions: CHAMPIONS, status: "" }).boxes[1].rows[0];
		expect(fights).toEqual({ label: "Fights", cue: "Sona uses Crescendo", action: "burst Caitlyn before she free-hits.", champions: ["Sona", "Caitlyn"] });
	});

	test("a champion every call names is the player: no row keys on them", () => {
		const own = "Lane: Kassadin Q used: Fizz trades in.\nThreat: Viego missing: Fizz holds E.\nFights: Sona ults: Fizz dives Caitlyn.";
		const rows = panelModel(own, { champions: ["Fizz", "Kassadin", "Viego", "Sona", "Caitlyn"], status: "" }).boxes.flatMap((box) => box.rows);
		expect(rows.map((row) => row.champions)).toEqual([["Kassadin"], ["Viego"], ["Sona", "Caitlyn"]]);
	});

	test("a build swap and a pick setup swap both become old, new, and the reason", () => {
		expect(panelModel(ANSWER, { champions: [], status: "" }).swaps).toEqual([{ from: "Health Scaling", to: "Health", how: "instead of", reason: "Viego and Sona engage" }]);
		expect(panelModel("Matchup: Charm thrown: E through it.\nSetup: Health Scaling shard to Health, because Viego engages.", { champions: [], status: "" }).swaps).toEqual([
			{ from: "Health Scaling", to: "Health", how: "instead of", reason: "Viego engages." },
		]);
	});

	test("a swap that moves an item earlier keeps its order word", () => {
		expect(panelModel("Build: Lich Bane → Zhonya's Hourglass\nSwap: Zhonya's Hourglass before Lich Bane, into Zed", { champions: [], status: "" }).swaps).toEqual([{ from: "Lich Bane", to: "Zhonya's Hourglass", how: "before", reason: "Zed" }]);
	});

	test("a prose answer has nothing for the panel", () => {
		const model = panelModel("Fizz is strong into Kassadin before six.\nPlay for level 3.", { champions: [], status: "" });
		expect(model.boxes).toEqual([]);
		expect(model.build).toBeUndefined();
		expect(model.swaps).toEqual([]);
	});

	test("an answer with calls or a build has something for the panel, and without them keeps only its prose", () => {
		expect(hasPanelContent(ANSWER)).toBe(true);
		expect(hasPanelContent("Fizz is strong before six.")).toBe(false);
		expect(withoutPanelRows(["Play for level 3.", ...ANSWER.split("\n"), "Ask /build for the full page."].join("\n"))).toBe("Play for level 3.\nAsk /build for the full page.");
	});

	test("the direct answer and a buy call are calls for now", () => {
		expect(boxes(panelModel("Answer: Yes, rush Zhonya's.\nBuy: Zhonya's next back.", { champions: [], status: "" }))).toEqual([["NOW", ["Answer", "Buy"]]]);
	});

	test("a Skills or Swap line with no Runes or Build line is not the panel's: the answer keeps it", () => {
		for (const answer of ["Skills: Q, E, W, then max Q > E > W", "Swap: Zhonya's Hourglass instead of Banshee's Veil, into Viego"]) {
			expect(hasPanelContent(answer)).toBe(false);
			expect(withoutPanelRows(answer)).toBe(answer);
		}
	});

	test("a labelled line that is not one of the coach's calls stays in the prose, where it was written", () => {
		const prose = "No: Kassadin does not outscale Fizz before 16.\nPlay for level 3.\nNote: his Q shield blocks your E damage.";
		expect(hasPanelContent(prose)).toBe(false);
		expect(withoutPanelRows(`${prose}\nLane: Q shield up: hold.`)).toBe(prose);
	});

	test("an in-game Now or Next call is for now, even before 14:00", () => {
		expect(boxes(panelModel("Now: Kassadin is 6: back off.\nNext: Dragon at 9:00: shove first.\nFights: Sona ults: go.", { champions: [], status: "", live: { gameTimeSec: 480, ownedItems: [] } }))).toEqual([
			["NOW · 8:00", ["Now", "Next"]],
			["LATER", ["Fights"]],
		]);
	});

	test("in a live game the next buy comes after the last item bought, so a sold starter and drunk potions are behind it", () => {
		const model = panelModel("Build: Doran's Ring + 2 Health Potions → Lich Bane → Sorcerer's Shoes → Zhonya's Hourglass", { champions: [], status: "", live: { gameTimeSec: 1500, ownedItems: ["Lich Bane", "Sorcerer's Shoes", "Health Potion"] } });
		expect(model.next).toBe("Zhonya's Hourglass");
		expect(model.owned).toEqual(["Doran's Ring", "Health Potions", "Lich Bane", "Sorcerer's Shoes"]);
	});
});

describe("panel drawing", () => {
	const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
	const VERSION = "14.19.1-panel";
	const fetchImpl = (async (url: string) => {
		if (url.endsWith("/champion.json")) return { json: async () => ({ data: Object.fromEntries(CHAMPIONS.map((name) => [name, { id: name, name, image: { full: `${name}.png` } }])) }) } as Response;
		if (url.endsWith("/item.json")) return { json: async () => ({ data: { 1056: { name: "Doran's Ring" }, 3100: { name: "Lich Bane" }, 3020: { name: "Sorcerer's Shoes" }, 3157: { name: "Zhonya's Hourglass" } } }) } as Response;
		if (url.endsWith("/runesReforged.json")) return { json: async () => [{ slots: [{ runes: [{ name: "Electrocute", icon: "perk-images/Electrocute.png" }] }] }] } as Response;
		if (url.endsWith("/summoner.json")) return { json: async () => ({ data: {} }) } as Response;
		return { arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) } as Response;
	}) as typeof fetch;
	const live = { gameTimeSec: 1820, ownedItems: ["Doran's Ring", "Lich Bane", "Sorcerer's Shoes"] };
	const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b7.*?\x1b8\x1b\[\d+C/g, "▣");
	let program: string | undefined;
	const draw = (width: number, answer = ANSWER) => panelLines(theme, panelModel(answer, { champions: CHAMPIONS, live, status: "/draft · quick" }), width);

	beforeAll(async () => {
		program = process.env.TERM_PROGRAM;
		process.env.TERM_PROGRAM = "WezTerm";
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		await prefetchChampionIcons(CHAMPIONS, VERSION, "https://ddragon.example", fetchImpl);
		await prefetchItemIcons(["Doran's Ring", "Lich Bane", "Sorcerer's Shoes", "Zhonya's Hourglass"], VERSION, "https://ddragon.example", fetchImpl);
		await prefetchRuneIcons(["Electrocute"], VERSION, "https://ddragon.example", fetchImpl);
	});
	afterAll(() => {
		resetCapabilitiesCache();
		resetIcons();
		if (program === undefined) delete process.env.TERM_PROGRAM;
		else process.env.TERM_PROGRAM = program;
	});

	test("a wide pane sets this phase's box beside the other phase's; a narrower one stacks them, now first", () => {
		expect(draw(150).some((line) => plain(line).includes("┏━ NOW · 30:20") && plain(line).includes("┏━ LANING"))).toBe(true);
		const narrow = draw(100).map(plain);
		expect(narrow.some((line) => line.includes("┏━ NOW") && line.includes("┏━ LANING"))).toBe(false);
		expect(narrow.findIndex((line) => line.includes("┏━ NOW"))).toBeLessThan(narrow.findIndex((line) => line.includes("┏━ LANING")));
	});

	test("no line is wider than the pane, at any width", () => {
		for (const width of [150, 100, 60, 36]) {
			for (const line of draw(width)) {
				expect(fitInlineIcons(line, width)).toBe(line);
				expect(plain(line)).not.toContain("…");
			}
		}
	});

	test("a call naming four champions keeps room for its words: portraits give way first, and none draw below 40 columns", () => {
		const crowded = "Fights: Sona ults: burst Caitlyn, Viego and Sona before Caitlyn can free-hit.";
		const champions = ["Sona", "Caitlyn", "Viego", "Sona"];
		for (const width of [60, 39, 30]) {
			const lines = panelLines(theme, panelModel(crowded, { champions: [...new Set(champions)], status: "" }), width).map(plain);
			expect(lines.some((line) => line.includes("…"))).toBe(false);
			expect(lines.join(" ")).toContain("burst");
		}
		expect(panelLines(theme, panelModel(crowded, { champions: ["Sona", "Caitlyn", "Viego"], status: "" }), 39).join("")).not.toContain("1337;File=");
	});

	test("a rune group whose names draw as words wraps between its names instead of being cut", () => {
		const lines = draw(60).map(plain);
		expect(lines.some((line) => line.includes("…"))).toBe(false);
		expect(lines.some((line) => line.includes("Ultimate Hunter"))).toBe(true);
	});

	test("a call's action reads first with the champion it names underlined, the cue under it, the portraits standing on the cue line", () => {
		const lines = draw(150);
		const at = lines.findIndex((line) => line.includes("burst"));
		expect(lines[at]).toContain("\x1b[4mCaitlyn");
		expect(plain(lines[at + 1])).toContain("when Sona uses Crescendo");
		expect(lines[at + 1]).toContain("1337;File=");
		expect(lines[at + 1]).toContain("\x1b[1A");
	});

	test("an ability key is a key cap that never splits, and no colour runs past a line", () => {
		for (let width = 40; width <= 90; width += 1) {
			for (const line of draw(width)) {
				expect(line.endsWith("\x1b[0m")).toBe(true);
				expect(line.split("\x1b[48;2;").length).toBe(line.split("\x1b[49m").length);
			}
		}
		expect(draw(150).some((line) => line.includes("\u00a0E\u00a0"))).toBe(true);
	});

	test("a box with no rows draws no title", () => {
		const lines = draw(150, ["Runes: Electrocute; Flash, Ignite", "Build: Doran's Ring → Zhonya's Hourglass"].join("\n")).map(plain);
		expect(lines.some((line) => line.includes("BUILD"))).toBe(true);
		expect(lines.some((line) => line.includes("NOW"))).toBe(false);
	});

	test("the swap box gives the reason, and the rune page marks the piece swapped in", () => {
		const lines = draw(150).map(plain);
		expect(lines.some((line) => line.includes("Viego and Sona engage"))).toBe(true);
		expect(lines.some((line) => line.includes("↻") && !line.includes("SWAP"))).toBe(true);
	});

	// The rasterizer is module state another test file may have loaded first, so each case reads which one this run has.
	test("an owned item draws grey with the rasterizer and with a check after it without one, and the next buy follows a marker", async () => {
		const items = () => draw(150).map(plain).find((line) => line.includes("▸"))!;
		if (greyIcon(PNG.toString("base64"), { widthPx: 1, heightPx: 1 }, 2) === undefined) expect(items().split("✓").length - 1).toBe(3);
		if (!(await loadRasterizer())) return;
		expect(greyIcon(PNG.toString("base64"), { widthPx: 1, heightPx: 1 }, 2)?.sequence).toContain("1337;File=");
		expect(items()).not.toContain("✓");
		expect(items().indexOf("▸")).toBeGreaterThan(0);
	});

	const withKitty = (body: () => void) => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		try {
			body();
		} finally {
			setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		}
	};

	test("a Kitty header portrait takes its columns: the cursor steps over it before the lane text", () => {
		withKitty(() => {
			const line = panelLines(theme, panelModel("Lane: Q shield up: hold.", { champions: [], status: "" }), 100, { header: { opponent: "Viego", detail: "mid" } })[0]!;
			const columns = iconLine("Viego", ["champion"])!.columns;
			expect(columns).toBeGreaterThan(0);
			expect(new RegExp(`\\x1b_G[^\\x1b]*\\x1b\\\\\\x1b\\[${columns}C`).test(line)).toBe(true);
		});
	});

	test("with Kitty icons every boxed line is as wide as its box, at any width", () => {
		withKitty(() => {
			for (const width of [150, 100, 60, 36]) {
				const widths = new Set<number>();
				let steps = 0;
				for (const line of draw(width)) {
					const cells = visibleWidth(line.replace(INLINE_ICON, (_m, n) => (steps++, " ".repeat(Number(n)))));
					expect(cells).toBeLessThanOrEqual(width);
					if (line.replace(/\x1b\[[0-9;]*m/g, "").startsWith("┃")) widths.add(cells);
				}
				expect(widths.size).toBe(1);
				// Without this the test is green when no icon is drawn at all, or when Kitty icons step 0 columns.
				expect(steps).toBeGreaterThan(0);
			}
		});
	});
});
