import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Pi does not export its HTML exporter or its theme loader, so the test reads them from the package's files, the way /export reaches them.
import { exportFromFile } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/index.js";
import { loadThemeFromPath, setRegisteredThemes } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const THEMES = ["tidal", "hextech", "void", "signal"];
const themePath = (name: string) => fileURLToPath(new URL(`../themes/${name}.json`, import.meta.url));

/** WCAG contrast of two colours given as #rrggbb or rgb(r, g, b). */
function contrast(a: string, b: string): number {
	const channels = (color: string) => (color.startsWith("#") ? [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16)) : color.match(/\d+/g)!.map(Number));
	const luminance = (color: string) => {
		const [r, g, blue] = channels(color).map((value) => ((value / 255) <= 0.03928 ? value / 255 / 12.92 : (((value / 255) + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * blue;
	};
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

describe("the HTML export of each theme", () => {
	afterEach(() => setRegisteredThemes([]));

	for (const name of THEMES) {
		test(`${name}: /export draws the page, the cards and the info blocks dark under the theme's light text`, async () => {
			// What Pi does for a theme the coach loads: it registers the file, and /export asks for the theme by name.
			setRegisteredThemes([loadThemeFromPath(themePath(name), "truecolor")]);
			const dir = mkdtempSync(join(tmpdir(), "voxren-export-"));
			const session = join(dir, "session.jsonl");
			writeFileSync(
				session,
				[
					{ type: "session", version: 3, id: "export-test", timestamp: "2026-10-01T00:00:00.000Z", cwd: dir },
					{ type: "message", id: "m1", parentId: null, timestamp: "2026-10-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "why do I lose lane?" }], timestamp: 1 } },
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
			);
			let html: string;
			try {
				html = readFileSync(await exportFromFile(session, { outputPath: join(dir, "out.html"), themeName: name }), "utf8");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
			const variable = (css: string) => html.match(new RegExp(`--${css}:\\s*([^;]+);`))![1].trim();
			for (const ground of ["exportPageBg", "exportCardBg", "exportInfoBg"]) expect(contrast(variable("text"), variable(ground)), `${name} ${ground}`).toBeGreaterThanOrEqual(4.5);
		});
	}
});
