import { beforeAll, describe, expect, test } from "bun:test";
import { knownNames, loadKnownNames, resetIcons } from "./icons";
import { gateSetupRows, pageBacked, setupSwaps, type ResolveName } from "./setup-swaps";

/** Small Data Dragon tables; the stat shards come from data/stat-shards.json, as they do for the build strip. */
const fetchImpl = (async (url: string) => {
	if (url.endsWith("runesReforged.json")) return { json: async () => [{ slots: [{ runes: [{ name: "Electrocute", icon: "e.png" }, { name: "Dark Harvest", icon: "d.png" }, { name: "Transcendence", icon: "t.png" }, { name: "Scorch", icon: "s.png" }] }] }] } as Response;
	if (url.endsWith("summoner.json")) return { json: async () => ({ data: { SummonerFlash: { name: "Flash", image: { full: "f.png" }, modes: ["CLASSIC"] }, SummonerHeal: { name: "Heal", image: { full: "h.png" }, modes: ["CLASSIC"] } } }) } as Response;
	return { json: async () => ({ data: { "1056": { name: "Doran's Ring", maps: { "11": true } }, "3157": { name: "Zhonya's Hourglass", maps: { "11": true } } } }) } as Response;
}) as typeof fetch;

let resolve: ResolveName;
beforeAll(async () => {
	resetIcons();
	await loadKnownNames("setup-swaps-test", "https://ddragon.example", fetchImpl);
	resolve = knownNames()!;
});

const verdicts = (row: string) => setupSwaps(row, resolve).map((swap) => swap.verdict);

describe("setupSwaps", () => {
	test("a real swap is ok: a rune to a rune, a shard to a shard, an item to an item", () => {
		expect(verdicts("Electrocute to Dark Harvest, because Skarner and Nautilus have no escape.")).toEqual(["ok"]);
		expect(verdicts("Health Scaling shard to Health, because Skarner and Nautilus chain hard CC.")).toEqual(["ok"]);
		expect(verdicts("Doran's Ring to Zhonya's Hourglass, because Zed ult.")).toEqual(["ok"]);
	});

	test("the seen no-op is same: both sides are one Data Dragon name, shard word or not", () => {
		expect(verdicts("Health Scaling shard to Health Scaling shard, because Skarner chains CC.")).toEqual(["same"]);
		expect(verdicts("Doran's Ring to Dorans Ring, because poke.")).toEqual(["same"]);
	});

	test("the seen invented target is unknown-target", () => {
		expect(verdicts("Electrocute to the listed Electrocute page with Transcendence and Scorch, because Ahri bursts.")).toEqual(["unknown-target"]);
		expect(verdicts("Flash to Teleportation Ward, because Skarner.")).toEqual(["unknown-target"]);
	});

	test("a target the page may not list but Data Dragon knows is still ok (page-backing is measured apart)", () => {
		expect(verdicts("Electrocute to Scorch, because Nautilus.")).toEqual(["ok"]);
	});

	test("text with no 'X to Y' shape is unparsed", () => {
		expect(verdicts("Keep the page, because Skarner.")).toEqual(["unparsed"]);
	});

	test("two swaps are classified one by one", () => {
		expect(verdicts("Electrocute to Dark Harvest, because Skarner; Flash to Flash, because Zed.")).toEqual(["ok", "same"]);
	});

	test("with no tables loaded only a literal repeat and the shape are caught", () => {
		expect(setupSwaps("Scorch to Imaginary Rune, because Zed.").map((swap) => swap.verdict)).toEqual(["ok"]);
		expect(setupSwaps("Armor shard to armor shard, because Zed.").map((swap) => swap.verdict)).toEqual(["same"]);
	});
});

describe("gateSetupRows", () => {
	const answer = (setup: string) => `Matchup: Ahri's charm lands in lane.\n${setup}\nDodge: no.`;

	test("drops the invalid swap and keeps the valid one in the same row", () => {
		const out = gateSetupRows(answer("Setup: Health Scaling shard to Health Scaling shard, because Skarner; Electrocute to Dark Harvest, because Zed."), resolve);
		expect(out).toBe(answer("Setup: Electrocute to Dark Harvest, because Zed."));
	});

	test("drops the whole row when no swap is left, and never fails", () => {
		const dropped: string[] = [];
		const out = gateSetupRows(answer("- **Setup:** Health Scaling shard to Health Scaling shard, because Skarner chains CC."), resolve, false, (swap, row) => dropped.push(`${swap.verdict}:${row}`));
		expect(out).toBe("Matchup: Ahri's charm lands in lane.\nDodge: no.");
		expect(dropped).toEqual(["same:true"]);
	});

	test("a valid row passes untouched, and the line still being written is left alone", () => {
		const ok = answer("Setup: Electrocute to Dark Harvest, because Zed.");
		expect(gateSetupRows(ok, resolve)).toBe(ok);
		expect(gateSetupRows("Setup: Health to Health", resolve, true)).toBe("Setup: Health to Health");
	});
});

describe("pageBacked", () => {
	test("a target the page text mentions is page-backed, another is not", () => {
		const [swap] = setupSwaps("Electrocute to Dark Harvest, because Zed.", resolve);
		expect(pageBacked(swap, "runes: Electrocute, Dark Harvest, Scorch")).toBe(true);
		expect(pageBacked(swap, "runes: Electrocute, Scorch")).toBe(false);
	});
});
