import { visibleWidth } from "@earendil-works/pi-tui";
import { resetCapabilitiesCache, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "bun:test";
import { clearAllNoticesForTest, noticeLines } from "./coach-log";
import { dropHideCursor, fitInlineIcons, greyIcon, hasInlineIcon, iconRows, inlineIcon, loadRasterizer, keepCursorShown, pictureStatus, picturesNoticeText, qoi, setCellTimedOut, setExactCell, setRasterizerFailed, svgRows, syncPicturesNotice, takeCellSizeReply, watchCellSize } from "./terminal-images";

const hasResvg = await import("@resvg/resvg-js").then(() => true, () => false);

/** The 1x1 PNG header with a 64x64 size and a body as big as a real item icon: only the header decides the cell size, only the body decides how long the sequence is. */
function iconPng(): { base64: string; dims: { widthPx: number; heightPx: number } } {
	const head = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
	head.writeUInt32BE(64, 16);
	head.writeUInt32BE(64, 20);
	return { base64: Buffer.concat([head, Buffer.alloc(6000, 0x6b)]).toString("base64"), dims: { widthPx: 64, heightPx: 64 } };
}

/** What each icon sequence leaves behind once the escape sequences are gone: the cells it steps over, as spaces. */
const cellsOf = (row: string) => visibleWidth(row.replace(/\x1b7\x1b\]1337;File=[^\x07]*\x07\x1b8\x1b\[(\d+)C/g, (_, n) => " ".repeat(Number(n))).replace(/(?:\x1b_G[^\x1b]*\x1b\\)+/g, ""));
const ICON = /\x1b7\x1b\]1337;File=[^\x07]*\x07\x1b8\x1b\[\d+C/g;

describe("inline icons in a row", () => {
	afterEach(() => resetCapabilitiesCache());

	test("a row that fits keeps every icon, and pi-tui's own width count would have cut it (the reason this exists)", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const { base64, dims } = iconPng();
		const icon = inlineIcon(base64, dims, 1)!;
		const row = ["Dark Seal 3:18", "Doran's Ring 3:20", "Boots 4:01"].map((item) => `${icon.sequence} ${item}`).join(" · ");
		expect(visibleWidth(row)).toBeGreaterThan(cellsOf(row) + 20);
		expect(cellsOf(row)).toBeLessThanOrEqual(70);
		expect(hasInlineIcon(row)).toBe(true);
		expect(fitInlineIcons(row, 70)).toBe(row);
	});

	test("an iTerm2 icon is exactly its rows tall, whatever the cell shape: its width is in pixels, the cursor steps over the cells that cover it", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const { base64, dims } = iconPng();
		expect(dims.widthPx).toBe(dims.heightPx);
		// Whole columns drew 0.89 of a row at 12x27 (floor) or 1.1 (ceil): the pixel width does neither.
		for (const cell of [{ widthPx: 12, heightPx: 27 }, { widthPx: 9, heightPx: 18 }, { widthPx: 10, heightPx: 31 }, { widthPx: 14, heightPx: 26 }]) {
			setCellDimensions(cell);
			for (const rows of [1, 2]) {
				const icon = inlineIcon(base64, dims, 1, rows)!;
				expect(icon.sequence).toContain(`width=${cell.heightPx * rows}px;height=${rows}`);
				expect(icon.columns).toBe(Math.ceil((cell.heightPx * rows) / cell.widthPx));
			}
		}
		setCellDimensions({ widthPx: 9, heightPx: 18 });
	});

	test("a wide picture keeps its aspect: its pixel width is its rows' height times width over height", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		setCellDimensions({ widthPx: 12, heightPx: 27 });
		const icon = inlineIcon(iconPng().base64, { widthPx: 96, heightPx: 48 }, 1, 2)!;
		expect(icon.sequence).toContain("width=108px;height=2");
		setCellDimensions({ widthPx: 9, heightPx: 18 });
	});

	test("a tall icon in WezTerm rises into the row above its own, as wide as two rows are tall, and a row is still cut by the cells it steps over", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const program = process.env.TERM_PROGRAM;
		process.env.TERM_PROGRAM = "WezTerm";
		try {
			setCellDimensions({ widthPx: 15, heightPx: 34 });
			expect(iconRows()).toBe(2);
			const { base64, dims } = iconPng();
			const icon = inlineIcon(base64, dims, 1, iconRows())!;
			expect(icon.columns).toBe(5);
			expect(icon.sequence).toStartWith("7[1A]1337;File=");
			expect(icon.sequence).toContain("width=68px;height=2");
			const row = `${icon.sequence} → ${icon.sequence}`;
			expect(fitInlineIcons(row, 13)).toBe(row);
			expect(fitInlineIcons(row, 12)).toBe(`${icon.sequence} → `);
			// Any other terminal keeps the icon in its row.
			expect(iconRows({ TERM_PROGRAM: "vscode" })).toBe(1);
			expect(iconRows({})).toBe(1);
		} finally {
			if (program === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = program;
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	test("a row too long is cut in its text with an ellipsis: every icon it keeps is whole, the ones past the cut are dropped with their text", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const { base64, dims } = iconPng();
		const icon = inlineIcon(base64, dims, 1)!;
		const row = ["Dark Seal 3:18", "Doran's Ring 3:20", "Boots 4:01"].map((item) => `${icon.sequence} ${item}`).join(" · ");
		for (const cells of [10, 20, 25, 30, 40, 50]) {
			const cut = fitInlineIcons(row, cells);
			expect(cellsOf(cut)).toBeLessThanOrEqual(cells);
			// Every sequence that starts also ends, and nothing is left half drawn.
			expect(cut.split("\x1b]1337;File=").length).toBe((cut.match(ICON) ?? []).length + 1);
			expect(cut.split("\x1b7").length).toBe(cut.split("\x1b8").length);
			expect((cut.match(ICON) ?? []).length).toBeGreaterThanOrEqual(1); // the first icon always fits, even in ten cells
		}
		expect(fitInlineIcons(row, 30)).toContain("…");
		expect(fitInlineIcons(row, 30)).not.toContain("Boots");
	});

	test("Kitty icons are whole sequences too: kept when the row fits, dropped whole when it does not", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const { base64, dims } = iconPng();
		const icon = inlineIcon(base64, dims, 2)!;
		expect(icon.sequence.match(/\x1b_G/g)!.length).toBeGreaterThan(1); // a big icon goes out in chunks
		const row = ["Dark Seal 3:18", "Doran's Ring 3:20"].map((item) => `${icon.sequence} ${item}`).join(" · ");
		expect(hasInlineIcon(row)).toBe(true);
		expect(fitInlineIcons(row, 80)).toBe(row);
		const cut = fitInlineIcons(row, 20);
		expect(cut.match(/\x1b_G/g)!.length).toBe(cut.match(/\x1b\\/g)!.length);
		expect(cut).not.toContain("Doran's");
	});

	test("a row with no icon is not an icon row", () => {
		expect(hasInlineIcon("Dark Seal 3:18 · Boots 4:01")).toBe(false);
	});
});

describe("grey icons", () => {
	afterEach(() => resetCapabilitiesCache());

	test("a grey icon goes out under an image id of its own, one per cache key", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		if (!hasResvg || !(await loadRasterizer())) return;
		const { base64, dims } = iconPng();
		const id = (seq?: string) => /i=(\d+)/.exec(seq ?? "")?.[1];
		const colour = inlineIcon(base64, dims, 7)!;
		const grey = greyIcon(base64, dims)!;
		expect(id(grey.sequence)).toBeDefined();
		expect(id(grey.sequence)).not.toBe(id(colour.sequence));
		expect(greyIcon(base64, dims)!.sequence).toBe(grey.sequence);
		expect(id(greyIcon(base64, dims, 2)!.sequence)).not.toBe(id(grey.sequence));
	});
});

/** A QOI decoder straight from the spec, to read back what `qoi` wrote. */
function unqoi(data: Buffer): { width: number; height: number; pixels: number[] } {
	const width = data.readUInt32BE(4);
	const height = data.readUInt32BE(8);
	const seen: number[][] = Array.from({ length: 64 }, () => [0, 0, 0, 0]);
	const pixels: number[] = [];
	let px = [0, 0, 0, 255];
	let at = 14;
	while (pixels.length < width * height * 4) {
		const op = data[at++];
		if (op === 0xfe) px = [data[at++], data[at++], data[at++], px[3]];
		else if (op === 0xff) px = [data[at++], data[at++], data[at++], data[at++]];
		else if (op >> 6 === 0) px = [...seen[op]];
		else if (op >> 6 === 1) px = [(px[0] + ((op >> 4) & 3) - 2) & 255, (px[1] + ((op >> 2) & 3) - 2) & 255, (px[2] + (op & 3) - 2) & 255, px[3]];
		else if (op >> 6 === 2) {
			const dg = (op & 63) - 32;
			const next = data[at++];
			px = [(px[0] + dg + (next >> 4) - 8) & 255, (px[1] + dg) & 255, (px[2] + dg + (next & 15) - 8) & 255, px[3]];
		} else for (let run = (op & 63) + 1; run > 1; run--) pixels.push(...px);
		seen[(px[0] * 3 + px[1] * 5 + px[2] * 7 + px[3] * 11) % 64] = [...px];
		pixels.push(...px);
	}
	expect([...data.subarray(at)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
	return { width, height, pixels };
}

const QUERY = "\x1b]1337;ReportCellSize\x07";
const reply = (height: number, width: number, end = "\x1b\\") => `\x1b]1337;ReportCellSize=${height};${width};1${end}`;
/** The QOI picture inside one iTerm2 sequence, and the sequence's parameters. */
const picture = (row: string) => {
	const [, params, data] = /\x1b\]1337;File=([^:]*):([^\x07]*)\x07/.exec(row)!;
	return { params, ...unqoi(Buffer.from(data, "base64")) };
};

describe("xterm.js pictures (VS Code, VSCodium, Cursor)", () => {
	afterEach(() => {
		resetCapabilitiesCache();
		setExactCell(undefined);
		delete process.env.TERM_PROGRAM;
	});
	const vscode = () => {
		process.env.TERM_PROGRAM = "vscode";
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
	};

	test("qoi writes pixels a spec decoder reads back exactly: runs, repeats, small and large steps, alpha changes", () => {
		const width = 70;
		const height = 9;
		const pixels = new Uint8Array(width * height * 4);
		for (let i = 0; i < width * height; i++) {
			const x = i % width;
			const shade = x < 20 ? 40 : x < 30 ? 40 + x : (x * 37) % 256; // a long run, then small steps, then jumps
			pixels.set([shade, (shade * 3) % 256, 255 - shade, x % 17 === 0 ? 128 : 255], i * 4);
		}
		const decoded = unqoi(qoi(pixels, width, height));
		expect([decoded.width, decoded.height]).toEqual([width, height]);
		expect(decoded.pixels).toEqual([...pixels]);
	});

	test("the cell size answer comes out of the input, and keys in the same chunk stay", () => {
		expect(takeCellSizeReply(reply(17, 7.7))).toEqual({ rest: "", cell: { height: 17, width: 7.7 } });
		expect(takeCellSizeReply(`a${reply(18, 9, "\x07")}b`)).toEqual({ rest: "ab", cell: { height: 18, width: 9 } });
		expect(takeCellSizeReply("/review")).toEqual({ rest: "/review" });
	});

	test("watchCellSize asks, swallows the answer, and redraws only when the size changes", () => {
		vscode();
		let handler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		const written: string[] = [];
		let changes = 0;
		const stop = watchCellSize((next) => ((handler = next), () => (handler = undefined)), (text) => written.push(text), () => changes++);
		expect(written).toEqual([QUERY]);
		expect(handler!(reply(17, 7))).toEqual({ consume: true });
		expect(handler!(`${reply(17, 7)}x`)).toEqual({ data: "x" });
		expect(changes).toBe(1);
		expect(handler!("q")).toBeUndefined();
		stop();
		expect(handler).toBeUndefined();
	});

	test("watchCellSize does nothing outside xterm.js", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const written: string[] = [];
		watchCellSize(() => () => {}, (text) => written.push(text), () => {})();
		expect(written).toEqual([]);
	});

	test.skipIf(!hasResvg)("a chart is QOI with no size, at the pixels its cells cover, over the rows it reserves; text until the size is known", async () => {
		vscode();
		expect(await loadRasterizer()).toBe(true);
		const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><rect width="200" height="50" fill="#2dd4bf"/></svg>`;
		expect(svgRows(markup, 40, 1)).toBeUndefined();
		setExactCell({ width: 7.5, height: 17 });
		const rows = svgRows(markup, 40, 1)!;
		// 40 cells of 7.5 px is 300 px wide, so 75 px tall: five rows of 17 px.
		expect(rows).toHaveLength(5);
		const drawn = picture(rows.at(-1)!);
		expect(drawn.params).not.toContain("width=");
		expect([drawn.width, drawn.height]).toEqual([300, 75]);
	});

	test.skipIf(!hasResvg)("an icon is one cell tall at the terminal's pixels and steps over the cells it covers", async () => {
		vscode();
		await loadRasterizer();
		setExactCell({ width: 7, height: 17 });
		const { dims } = iconPng();
		const icon = inlineIcon("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", dims, 1)!;
		expect(icon.columns).toBe(3);
		expect(icon.sequence).toEndWith("\x1b8\x1b[3C");
		const drawn = picture(icon.sequence);
		expect([drawn.width, drawn.height]).toEqual([17, 17]);
		expect(fitInlineIcons(`${icon.sequence} Dark Seal`, 40)).toBe(`${icon.sequence} Dark Seal`);
	});
});

describe("pictureStatus", () => {
	afterEach(() => {
		resetCapabilitiesCache();
		setExactCell(undefined);
		setCellTimedOut(false);
		setRasterizerFailed(false);
		delete process.env.TERM_PROGRAM;
	});

	test("no protocol at all, not VS Code: a plain terminal is told which ones draw pictures", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const status = pictureStatus({});
		expect(status.on).toBe(false);
		expect(status.reason).toBe("this terminal draws no inline images");
		expect(status.fix).toContain("WezTerm");
	});

	test("no protocol, VS Code family: the settings fix, not a different-terminal fix", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const status = pictureStatus({ TERM_PROGRAM: "vscode" });
		expect(status.on).toBe(false);
		expect(status.reason).toContain("images turned off");
		expect(status.fix).toContain("PI_IMAGE_PROTOCOL=iterm2");
		expect(status.fix).toContain("docs/configuration.md");
	});

	test("a protocol and a known cell size: pictures on, no reason or fix", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		expect(pictureStatus({})).toEqual({ on: true });
	});

	test("the xterm.js cell-size query timing out reports off with the VS Code fix, even though a protocol was detected", () => {
		process.env.TERM_PROGRAM = "vscode";
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		setCellTimedOut(true);
		const status = pictureStatus({ TERM_PROGRAM: "vscode" });
		expect(status.on).toBe(false);
		expect(status.reason).toContain("never answered the cell-size query");
		expect(status.fix).toContain("PI_IMAGE_PROTOCOL=iterm2");
	});

	test("watchCellSize's own timeout fires onTimeout once when nothing answers, and pictureStatus then agrees", async () => {
		process.env.TERM_PROGRAM = "vscode";
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		let timeouts = 0;
		const stop = watchCellSize(
			() => () => {},
			() => {},
			() => {},
			() => timeouts++,
			5,
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		stop();
		expect(timeouts).toBe(1);
		expect(pictureStatus({ TERM_PROGRAM: "vscode" }).on).toBe(false);
	});

	test("a known cell size before the timeout keeps pictures on", async () => {
		process.env.TERM_PROGRAM = "vscode";
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		let timeouts = 0;
		const stop = watchCellSize(
			(handler) => {
				setExactCell({ width: 7, height: 17 });
				return () => {};
			},
			() => {},
			() => {},
			() => timeouts++,
			5,
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		stop();
		expect(timeouts).toBe(0);
		expect(pictureStatus({ TERM_PROGRAM: "vscode" })).toEqual({ on: true });
	});

	test("the optional rasterizer missing when it was last needed: off, with the setup fix", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		setRasterizerFailed(true);
		const status = pictureStatus({});
		expect(status.on).toBe(false);
		expect(status.reason).toContain("rasterizer");
		expect(status.fix).toBe("run npm run setup");
	});
});

describe("the \"pictures\" notice stays in sync with pictureStatus", () => {
	afterEach(() => {
		resetCapabilitiesCache();
		setExactCell(undefined);
		setCellTimedOut(false);
		setRasterizerFailed(false);
		delete process.env.TERM_PROGRAM;
		clearAllNoticesForTest();
	});

	test("the rasterizer reason reads \"charts drawn as text\" where icons don't need it, \"pictures off\" where they do (xterm.js)", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		setRasterizerFailed(true);
		expect(picturesNoticeText(pictureStatus({}))).toStartWith("charts drawn as text: the optional image rasterizer");

		process.env.TERM_PROGRAM = "vscode";
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		expect(picturesNoticeText(pictureStatus({ TERM_PROGRAM: "vscode" }))).toStartWith("pictures off: the optional image rasterizer");
	});

	test("every call site raises the same wording -- one shared builder behind syncPicturesNotice and picturesNoticeText", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		syncPicturesNotice("startup", {});
		const fromStartup = noticeLines();
		clearAllNoticesForTest();
		syncPicturesNotice("cell-size-timeout", {});
		expect(noticeLines()).toEqual(fromStartup);
		expect(fromStartup[0]).toBe(picturesNoticeText(pictureStatus({}))!);
	});

	test("the notice clears once pictures recover: watchCellSize's own timeout raises it, a cell size landing after clears it", async () => {
		process.env.TERM_PROGRAM = "vscode";
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		let handler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		const stop = watchCellSize(
			(next) => ((handler = next), () => (handler = undefined)),
			() => {},
			() => {},
			() => syncPicturesNotice("cell-size-timeout", { TERM_PROGRAM: "vscode" }),
			5,
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(noticeLines().some((line) => line.includes("never answered the cell-size query"))).toBe(true);
		handler!(reply(17, 7));
		expect(noticeLines()).toEqual([]);
		stop();
	});
});

describe("WezTerm (ConPTY on Windows)", () => {
	test("Pi's hide-cursor is dropped in WezTerm, every other byte kept, and the cursor is shown once at the start", () => {
		expect(dropHideCursor("a\x1b[?25lb\x1b[?25hc\x1b[?25l")).toBe("ab\x1b[?25hc");
		const written: unknown[] = [];
		const stream = { isTTY: true, write: (chunk: unknown) => written.push(chunk) } as unknown as NodeJS.WriteStream;
		const undo = keepCursorShown(stream, { TERM_PROGRAM: "WezTerm" });
		stream.write("\x1b[?25lhi");
		undo();
		stream.write("\x1b[?25lhi");
		expect(written).toEqual(["\x1b[?25h", "hi", "\x1b[?25lhi"]);
		keepCursorShown(stream, { TERM_PROGRAM: "vscode" })();
		stream.write("\x1b[?25l");
		expect(written.at(-1)).toBe("\x1b[?25l");
	});

	test("a piped stdout gets no cursor escape and no write wrapper, even inside WezTerm", () => {
		const chunks: string[] = [];
		const write = (chunk: unknown) => chunks.push(String(chunk));
		const stream = { isTTY: false, write } as unknown as NodeJS.WriteStream;
		keepCursorShown(stream, { TERM_PROGRAM: "WezTerm" })();
		expect(chunks).toEqual([]);
		expect(stream.write as unknown).toBe(write);
	});

	test.skipIf(!hasResvg)("a WezTerm picture paints up from its last row, so no row written after it clears it", async () => {
		const previous = process.env.TERM_PROGRAM;
		process.env.TERM_PROGRAM = "WezTerm";
		try {
			setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
			await loadRasterizer();
			const rows = svgRows('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#fff"/></svg>', 40, 1)!;
			expect(rows.length).toBeGreaterThan(1);
			expect(rows.slice(0, -1).every((row) => row === "")).toBe(true);
			expect(rows.at(-1)).toStartWith(`\x1b7\x1b[${rows.length - 1}A\r\x1b]1337;File=doNotMoveCursor=1;`);
			expect(rows.at(-1)).toEndWith("\x1b8");
		} finally {
			process.env.TERM_PROGRAM = previous;
			resetCapabilitiesCache();
		}
	});
});
