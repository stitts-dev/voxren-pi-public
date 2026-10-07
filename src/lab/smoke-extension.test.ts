import { expect, test } from "bun:test";
import net from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { TuiTest } from "@microsoft/tui-test";
import { RESEARCH_CONTRACT_VERSION } from "../contracts";
import { blockNetwork } from "./offline.ts";
import { timelineGates, type Frame } from "./timeline.ts";

// The offline proof: the real coach under tui-test on Pi's faux model, with a cassette that calls a tool and no network.
// Every non-loopback connection is refused and written to the net log, so a replay that reaches out leaves a line there.
const repo = join(import.meta.dir, "..", "..");
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";

test("a cassette replays offline: the model turns and a tool card come from the recording, nothing reaches the network", async () => {
	const dir = mkdtempSync(join(tmpdir(), "voxren-smoke-test-"));
	const response = { version: RESEARCH_CONTRACT_VERSION, operation: "gamedata.lookup", data: { entities: [] }, evidence: [] };
	const args = { entities: [{ kind: "champion", name: "Zed" }], detail: "compact" };
	const cassette = {
		id: "t",
		turns: [
			{ thinking: [], text: "", calls: [{ name: "voxren_game_facts", args }] },
			{ thinking: [], text: "Lane: replayed answer from the cassette", calls: [] },
		],
		tools: [{ name: "voxren_game_facts", operation: "gamedata.lookup", args, ms: 12_000, response }],
	};
	const file = join(dir, "t.json");
	writeFileSync(file, JSON.stringify(cassette));
	const netLog = join(dir, "net.log");
	const terminal = TuiTest.ephemeral("voxren-smoke-offline");
	try {
		await terminal.run("node", ["src/lab/smoke-coach.mjs"], {
			cols: 120,
			rows: 40,
			cwd: repo,
			env: { VOXREN_COACH_HOME: join(dir, "home"), VOXREN_COACH_TERMINAL: "here", VOXREN_SMOKE_CASSETTE: file, VOXREN_SMOKE_NET_LOG: netLog, [pathKey]: `${join(repo, "node_modules", ".bin")}${delimiter}${process.env[pathKey] ?? ""}` },
			waitReady: false,
		});
		await terminal.getByText("VOXREN COACH").expect({ timeout: 30_000 });
		await terminal.write("who is Zed?\r");
		// The text timeline while the cassette's tool "runs" (12 s recorded, 1.2 s replayed): the animation gates run on it too.
		const frames: Frame[] = [];
		const began = Date.now();
		for (let text = ""; !text.includes("replayed answer from the cassette"); await Bun.sleep(100)) {
			text = await terminal.text();
			frames.push({ t: Date.now() - began, text });
			if (Date.now() - began > 30_000) throw new Error(`no answer within 30 s:\n${text}`);
		}
		await Bun.sleep(300);
		const final = await terminal.text();
		frames.push({ t: Date.now() - began, text: final });
		expect(final).toMatch(/FACTS\s+✓/);
		expect(timelineGates(frames, final, 120, true)).toEqual([]);
	} finally {
		await terminal.closeQuiet();
	}
	expect(() => readFileSync(netLog, "utf8")).toThrow(); // no line, no file: nothing tried the network
}, 90_000);

test("the network block refuses a remote fetch and a remote socket, writes each to the log, and lets loopback through", async () => {
	const log = join(mkdtempSync(join(tmpdir(), "voxren-smoke-net-")), "net.log");
	const unblock = blockNetwork(log);
	try {
		// 203.0.113.0/24 is documentation space: nothing routes there, so any result here is the block's refusal, never a network's.
		await expect(fetch("https://203.0.113.9/x")).rejects.toThrow("offline replay: refused fetch https://203.0.113.9/x");
		expect(() => net.connect(443, "203.0.113.9")).toThrow("offline replay: refused socket 203.0.113.9");
		const server = net.createServer();
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		await new Promise<void>((done) => net.connect((server.address() as net.AddressInfo).port, "127.0.0.1", done).on("connect", function (this: net.Socket) { this.destroy(); }));
		server.close();
	} finally {
		unblock();
	}
	// appendFileSync has returned by here, so the log is whole; NDJSON, one refusal a line.
	expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["fetch https://203.0.113.9/x", "socket 203.0.113.9"]);
}, 5_000);
