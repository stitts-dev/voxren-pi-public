import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEBUG_COMMAND } from "./debug-handoff";
import { setLogContext, setLogSink } from "./coach-log";
import { saveProfile, profilePath } from "./config";
import { createAutoComp, installVoxrenCoach } from "./index";
import { createLiveResearchGateway } from "./live-gateway";
import { knowChampions, loadChampionCard, promptCard } from "./champion-card";
import { knownNames, resetIcons } from "./icons";
import { gateSetupRows } from "./setup-swaps";

const custodian = { fetch: async () => ({ status: 200, body: "{}" }), status: async () => ({ state: { stored: false } }) } as any;

function fakePi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
	const sent: string[] = [];
	const pi = { registerTool() {}, setActiveTools() {}, sendUserMessage: (text: string) => sent.push(text), sendMessage() {}, registerMessageRenderer() {}, registerMarkdownTransformer() {}, getThinkingLevel: () => "medium", setModel: async () => true, setThinkingLevel() {}, registerCommand: (name: string, options: any) => commands.set(name, options), on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) };
	return { pi, commands, handlers, sent };
}

function tuiCtx(custom: (factory: any) => Promise<unknown> = async () => undefined) {
	return { hasUI: true, mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "s", getBranch: () => [], getEntries: () => [] }, ui: { notify() {}, custom, setTitle() {}, setHeader() {}, setFooter() {}, setWorkingMessage() {}, setHiddenThinkingLabel() {}, setWidget() {}, setEditorText() {}, getEditorText: () => "" } };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const home = (name: string) => join(mkdtempSync(join(tmpdir(), "voxren-index-")), name);

describe("installVoxrenCoach", () => {
	const lines: any[] = [];
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => void unhandled.push(reason);
	afterEach(() => {
		setLogSink(undefined);
		setLogContext({});
		lines.length = 0;
		unhandled.length = 0;
		process.off("unhandledRejection", onUnhandled);
	});
	const capture = () => {
		process.on("unhandledRejection", onUnhandled);
		setLogSink((line) => lines.push(JSON.parse(line)));
	};

	test("an auto /draft whose composition read rejects is logged, not unhandled", async () => {
		const environment = { PI_CODING_AGENT_DIR: join(home("auto"), "agent") };
		saveProfile(profilePath(environment), { riotIds: { known: [] }, commands: { draft: { auto: true } } });
		const fake = fakePi();
		let onChange = () => {};
		let state: any = { kind: "closed" };
		installVoxrenCoach(fake.pi as any, environment, custodian, async () => Promise.reject(new Error("client quit")), async () => undefined, (change) => ((onChange = change), { read: () => state, stop() {} }), async () => undefined);
		await fake.handlers.get("session_start")![0]({}, tuiCtx());
		capture();
		state = { kind: "champSelect", secondsLeft: 30, picksMade: 10, picksTotal: 10, bansMade: 10, bansTotal: 10, lockedDraft: "a" };
		onChange();
		await tick();
		await tick();
		expect(unhandled).toEqual([]);
		expect(lines.map((line) => line.event)).toContain("auto-draft-failed");
	});

	test("createAutoComp asks the router which command a lock runs", () => {
		const cs = { kind: "champSelect", secondsLeft: 30, picksMade: 10, picksTotal: 10, bansMade: 10, bansTotal: 10 };
		const calls: string[] = [];
		const events: any[] = [];
		createAutoComp((call) => calls.push(call), (event) => (events.push(event), "pick"))({ ...cs, lockedDraft: "a" } as any, true);
		expect(events).toEqual([{ event: "locked", draft: true }]);
		expect(calls).toEqual(["pick"]);
		const own: any[] = [];
		createAutoComp(() => undefined, (event) => (own.push(event), "pick"))({ ...cs, pickKey: "ahri" } as any, true);
		expect(own).toEqual([{ event: "locked", draft: false }]);
	});

	test("createAutoComp: a second pick key waits for the pick still in flight", () => {
		const cs = { kind: "champSelect", secondsLeft: 30, picksMade: 10, picksTotal: 10, bansMade: 10, bansTotal: 10 };
		const calls: string[] = [];
		const trigger = createAutoComp((call) => (calls.push(call), new Promise(() => {})));
		trigger({ ...cs, pickKey: "ahri" } as any, true);
		trigger({ ...cs, pickKey: "lux" } as any, true);
		expect(calls).toEqual(["pick"]);
	});

	describe("one automatic call at a time", () => {
		const champSelect = (extra: object) => ({ kind: "champSelect", secondsLeft: 30, picksMade: 10, picksTotal: 10, bansMade: 10, bansTotal: 10, ...extra });
		const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const setup = async (readComposition: () => Promise<any>, name: string) => {
			const environment = { PI_CODING_AGENT_DIR: join(home(name), "agent"), VOXREN_COACH_CHAMPION: "Ahri" };
			saveProfile(profilePath(environment), { riotIds: { known: [] }, commands: { draft: { auto: true } } });
			const fake = fakePi();
			let onChange = () => {};
			let state: any = { kind: "closed" };
			installVoxrenCoach(fake.pi as any, environment, custodian, readComposition, async () => undefined, (change) => ((onChange = change), { read: () => state, stop() {} }), async () => undefined);
			const ctx: any = tuiCtx();
			await fake.handlers.get("session_start")![0]({}, ctx);
			setLogSink((line) => lines.push(JSON.parse(line)));
			return { fake, ctx, set: (next: any) => ((state = next), onChange()) };
		};
		const comp = (text: string) => async () => ({ text, inGame: false });

		test("pick and draft in one composition read: the team call is sent, the pick key is spent (#396)", async () => {
			const { fake, set } = await setup(async () => (await wait(20), { text: "Team: a, b, c" }), "both");
			set(champSelect({ pickKey: "ahri" }));
			set(champSelect({ pickKey: "ahri", lockedDraft: "a" }));
			await wait(80);
			expect(fake.sent).toHaveLength(1);
			expect(fake.sent[0]).toContain("Team: a, b, c");
			expect(lines.filter((line) => line.event === "auto-call-dropped").map((line) => line.details.reason)).toEqual(["the team call replaced it"]);
			set(champSelect({ pickKey: "ahri", lockedDraft: "a" }));
			await wait(40);
			expect(fake.sent).toHaveLength(1);
		});

		test("a lock never asks Jev", async () => {
			const environment = { PI_CODING_AGENT_DIR: join(home("nojev"), "agent"), VOXREN_COACH_CHAMPION: "Ahri" };
			saveProfile(profilePath(environment), { riotIds: { known: [] }, commands: { draft: { auto: true } } });
			const fake = fakePi();
			let onChange = () => {};
			let state: any = { kind: "closed" };
			const asked: unknown[] = [];
			const judge = { model: "jev-latest", ask: async (...args: unknown[]) => { asked.push(args); throw new Error("Jev must not be asked for a lock"); } } as any;
			installVoxrenCoach(fake.pi as any, environment, custodian, comp("Team: a"), async () => undefined, (change) => ((onChange = change), { read: () => state, stop() {} }), async () => undefined, undefined, undefined, undefined, judge);
			await fake.handlers.get("session_start")![0]({}, tuiCtx());
			const set = (next: any) => ((state = next), onChange());
			set(champSelect({ pickKey: "ahri" }));
			set(champSelect({ pickKey: "ahri", lockedDraft: "a" }));
			await wait(80);
			expect(fake.sent).toHaveLength(1);
			expect(asked).toEqual([]);
		});

		test("a busy coach with no typed turn gives the key back, logs once, and the next idle poll sends (#394)", async () => {
			let idle = true;
			const { fake, ctx, set } = await setup(async () => (await wait(5), (idle = false), { text: "Team: a" }), "busy");
			ctx.isIdle = () => idle;
			set(champSelect({ lockedDraft: "a" }));
			await wait(40);
			expect(fake.sent).toHaveLength(0);
			const drops = lines.filter((line) => line.event === "auto-call-dropped");
			expect(drops).toHaveLength(1);
			expect(drops[0].details).toMatchObject({ call: "draft", key: "draft:a", retry: true });
			idle = true;
			ctx.isIdle = () => true;
			set(champSelect({ lockedDraft: "a" }));
			await wait(40);
			expect(fake.sent).toHaveLength(1);
		});

		test("a typed turn that starts during the read wins: dropped and logged once, the key stays spent (#394, #370)", async () => {
			let idle = true;
			const { fake, ctx, set } = await setup(async () => {
				await wait(5);
				await fake.handlers.get("before_agent_start")![0]({ prompt: "typed question", systemPromptOptions: {} }, ctx);
				idle = false;
				return { text: "Team: a" };
			}, "typed");
			ctx.isIdle = () => idle;
			set(champSelect({ lockedDraft: "a" }));
			await wait(40);
			idle = true;
			set(champSelect({ lockedDraft: "a" }));
			await wait(40);
			expect(fake.sent).toHaveLength(0);
			const drops = lines.filter((line) => line.event === "auto-call-dropped");
			expect(drops).toHaveLength(1);
			expect(drops[0].details).toMatchObject({ key: "draft:a", reason: "a typed turn is running and wins", retry: false });
		});
	});

	describe("a typed question after a cancelled automatic call (#412)", () => {
		const champSelect = (extra: object) => ({ kind: "champSelect", secondsLeft: 30, picksMade: 10, picksTotal: 10, bansMade: 10, bansTotal: 10, ...extra });
		const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		// An automatic /draft in flight (its turn started), then the player types a plain question while the footer has moved on.
		const inFlight = async (name: string, moveTo?: string) => {
			const environment = { PI_CODING_AGENT_DIR: join(home(name), "agent"), VOXREN_COACH_CHAMPION: "Ahri" };
			saveProfile(profilePath(environment), { riotIds: { known: [] }, commands: { draft: { auto: true } } });
			const fake = fakePi();
			let onChange = () => {};
			let state: any = { kind: "closed" };
			installVoxrenCoach(fake.pi as any, environment, custodian, async () => ({ text: "Team: a", inGame: false }), async () => undefined, (change) => ((onChange = change), { read: () => state, stop() {} }), async () => undefined);
			let idle = true;
			const ctx: any = tuiCtx();
			ctx.isIdle = () => idle;
			// A real abort ends the turn a moment later: settled fires, then the coach is idle.
			ctx.abort = () => setTimeout(async () => ((idle = true), await fake.handlers.get("agent_settled")![0]({}, ctx)), 10);
			await fake.handlers.get("session_start")![0]({}, ctx);
			const set = (next: any) => ((state = next), onChange());
			set(champSelect({ lockedDraft: "a" }));
			await wait(30);
			expect(fake.sent).toHaveLength(1);
			await fake.handlers.get("before_agent_start")![0]({ prompt: fake.sent[0], systemPromptOptions: {} }, ctx);
			idle = false;
			if (moveTo) set(champSelect({ lockedDraft: moveTo }));
			await wait(30);
			setLogSink((line) => lines.push(JSON.parse(line)));
			const type = (text: string) => fake.handlers.get("input")![0]({ text, source: "interactive" }, ctx);
			return { fake, ctx, set, type, setIdle: (value: boolean) => (idle = value) };
		};

		test("the typed turn runs before any further automatic call and is not steered", async () => {
			const { fake, ctx, set, type, setIdle } = await inFlight("typed-wins", "b");
			const result = await type("why not Ignite?");
			await wait(30);
			expect(result).toEqual({ action: "continue" });
			// The cancelled call settled while the footer was on a new lock: nothing automatic has been sent.
			expect(fake.sent).toHaveLength(1);
			await fake.handlers.get("before_agent_start")![0]({ prompt: "why not Ignite?", systemPromptOptions: {} }, ctx);
			setIdle(false);
			set(champSelect({ lockedDraft: "c" }));
			await wait(30);
			expect(fake.sent).toHaveLength(1);
		});

		test("the cancelled call is not retried once the typed turn settles (#370)", async () => {
			const { fake, ctx, type, setIdle } = await inFlight("no-retry");
			await type("why not Ignite?");
			await fake.handlers.get("before_agent_start")![0]({ prompt: "why not Ignite?", systemPromptOptions: {} }, ctx);
			setIdle(true);
			await fake.handlers.get("agent_settled")![0]({}, ctx);
			await wait(30);
			expect(fake.sent).toHaveLength(1);
		});

		test("a typed input that never becomes a turn stops holding automatic calls, logged once", async () => {
			const { fake, set, type } = await inFlight("swallowed", "b");
			await type("why not Ignite?");
			await wait(30);
			expect(fake.sent).toHaveLength(1);
			await wait(5600);
			expect(lines.filter((line) => line.event === "typed-gate-timeout")).toHaveLength(1);
			// The backstop re-checks at once: the new lock gets its automatic call without another footer change.
			expect(fake.sent).toHaveLength(2);
			set(champSelect({ lockedDraft: "c" }));
			await wait(30);
			expect(fake.sent).toHaveLength(3);
		}, 15000);
	});

	test("a startup /flow panel that rejects is logged, not unhandled", async () => {
		const fake = fakePi();
		installVoxrenCoach(fake.pi as any, {}, custodian, async () => undefined, async () => undefined, () => ({ read: () => ({ kind: "closed" as const }), stop() {} }), async () => undefined);
		capture();
		await fake.handlers.get("session_start")![0]({}, tuiCtx(async () => Promise.reject(new Error("tui gone"))));
		await tick();
		expect(unhandled).toEqual([]);
		expect(lines.map((line) => line.event)).toContain("flow-open-failed");
	});

	test("a profile that cannot be saved still gets the coach system prompt", async () => {
		const parent = home("blocked");
		writeFileSync(parent, "a file where the coach home should be");
		const environment = { PI_CODING_AGENT_DIR: join(parent, "agent") };
		const fake = fakePi();
		const state = { kind: "lobby", summoner: { gameName: "New", tagLine: "EUW" } } as any;
		installVoxrenCoach(fake.pi as any, environment, custodian, async () => undefined, async () => undefined, () => ({ read: () => state, stop() {} }), async () => undefined);
		const ctx = tuiCtx();
		await fake.handlers.get("session_start")![0]({}, ctx);
		capture();
		const event = { prompt: "hi", systemPromptOptions: {} as any };
		const result = await fake.handlers.get("before_agent_start")![0](event, ctx);
		expect(result.systemPrompt).toBe(event.systemPromptOptions.forceSystemPrompt);
		expect(result.systemPrompt.length).toBeGreaterThan(100);
		expect(lines.map((line) => line.event)).toContain("profile-save-failed");
	});

	{
		test("/report that cannot start in print mode prints to stderr and exits 1", async () => {
			const fake = fakePi();
			// No coach home: startDebugSession answers { ok: false, message } without spawning anything.
			installVoxrenCoach(fake.pi as any, {}, custodian, async () => undefined, async () => undefined, undefined, async () => undefined);
			const written: string[] = [];
			const realWrite = process.stderr.write;
			process.stderr.write = ((text: string) => (written.push(String(text)), true)) as any;
			let code: number | undefined;
			const notes: string[] = [];
			try {
				await fake.commands.get(DEBUG_COMMAND).handler("it broke", { mode: "print", hasUI: false, isIdle: () => true, setExitCode: (value: number) => (code = value), sessionManager: undefined, ui: { notify: (text: string) => notes.push(text) } });
			} finally {
				process.stderr.write = realWrite;
			}
			expect(written.join("")).not.toBe("");
			expect(code).toBe(1);
			expect(notes).toEqual([]);
		});
	}

	test("a throwing championLane at launch yields no lane and one warn line", async () => {
		const fake = fakePi();
		installVoxrenCoach(fake.pi as any, { VOXREN_COACH_CHAMPION: "Ahri" }, custodian, async () => undefined, async () => undefined, undefined, async () => Promise.reject(new Error("dd down")));
		capture();
		const ctx = tuiCtx();
		const result = await fake.handlers.get("before_agent_start")![0]({ prompt: "hi", systemPromptOptions: {} }, ctx);
		expect(result.systemPrompt).toBeString();
		expect(lines.filter((line) => /lane-failed/.test(line.event) && line.level === "warn")).toHaveLength(1);
	});
});

describe("known names at session start", () => {
	test("a session start loads the Data Dragon names, so an unknown-target swap is dropped with no image terminal (#367)", async () => {
		const tables: Record<string, unknown> = {
			"versions.json": ["1.0.1"],
			"champion.json": { data: { MonkeyKing: { id: "MonkeyKing", name: "Wukong", key: "62" } } },
			"runesReforged.json": [{ slots: [{ runes: [{ name: "Electrocute", icon: "e.png" }, { name: "Dark Harvest", icon: "d.png" }] }] }],
			"summoner.json": { data: { SummonerFlash: { name: "Flash", image: { full: "f.png" }, modes: ["CLASSIC"] } } },
			"item.json": { data: { "1056": { name: "Doran's Ring", maps: { "11": true } } } },
		};
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string) => new Response(JSON.stringify(tables[String(url).split("/").pop()!] ?? {}))) as typeof fetch;
		resetIcons();
		try {
			expect(knownNames()).toBeUndefined();
			const fake = fakePi();
			installVoxrenCoach(fake.pi as any, { PI_CODING_AGENT_DIR: join(home("names"), "agent") }, custodian);
			await fake.handlers.get("session_start")![0]({}, tuiCtx());
			for (let i = 0; i < 50 && !knownNames(); i++) await tick();
			const resolve = knownNames()!;
			expect(resolve).toBeDefined();
			const answer = (row: string) => `Matchup: x.\n${row}\nDodge: no.`;
			expect(gateSetupRows(answer("Setup: Electrocute to Teleportation Ward, because Ahri."), resolve)).toBe("Matchup: x.\nDodge: no.");
			expect(gateSetupRows(answer("Setup: Electrocute to Dark Harvest, because Ahri."), resolve)).toBe(answer("Setup: Electrocute to Dark Harvest, because Ahri."));
		} finally {
			globalThis.fetch = realFetch;
			resetIcons();
		}
	});

	test("the first turn of a display-name main waits for the names, so the champion list maps its display name to its id (#390)", async () => {
		// A made-up champion: every real one has a card (#90), and only a name with no card logs `no-card`.
		const realFetch = globalThis.fetch;
		const tables: Record<string, unknown> = {
			"versions.json": ["1.0.1"],
			"champion.json": { data: { Voxtest: { id: "Voxtest", name: "Vox the Test Dummy", key: "9001" } } },
			"runesReforged.json": [],
			"summoner.json": { data: {} },
			"item.json": { data: {} },
		};
		globalThis.fetch = (async (url: string) => new Response(JSON.stringify(tables[String(url).split("/").pop()!] ?? {}))) as typeof fetch;
		knowChampions(undefined);
		const environment = { PI_CODING_AGENT_DIR: join(home("wukong"), "agent") };
		saveProfile(profilePath(environment), { riotIds: { known: [] }, champion: "Vox the Test Dummy" });
		const lines: any[] = [];
		try {
			const fake = fakePi();
			installVoxrenCoach(fake.pi as any, environment, custodian, undefined, async () => undefined, undefined, async () => undefined);
			await fake.handlers.get("session_start")![0]({}, tuiCtx());
			setLogSink((line) => lines.push(JSON.parse(line)));
			await fake.handlers.get("before_agent_start")![0]({ prompt: "hi", systemPromptOptions: {} }, { hasUI: true, mode: "tui", ui: {}, sessionManager: { getSessionId: () => "s", getBranch: () => [] } });
			expect(lines.find((line) => line.event === "no-card")?.details).toMatchObject({ champion: "Vox the Test Dummy", id: "voxtest", mapped: true });
		} finally {
			globalThis.fetch = realFetch;
			knowChampions(undefined);
		}
	});

	test("a display-name main's stored card reaches the first turn's prompt, and only on the patch it was built on", async () => {
		// A real stored card, read from its file, so the test follows a rebuild on a later patch.
		const card = loadChampionCard("MonkeyKing")!;
		const row = promptCard(card, card.meta.version)?.rows[0];
		expect(row).toBeDefined();
		expect(card.name).not.toBe(card.id);
		const realFetch = globalThis.fetch;
		const firstPrompt = async (name: string, liveVersion: string) => {
			const tables: Record<string, unknown> = {
				"versions.json": [liveVersion],
				"champion.json": { data: { MonkeyKing: { id: card.id, name: card.name, key: "1" } } },
				"runesReforged.json": [],
				"summoner.json": { data: {} },
				"item.json": { data: {} },
			};
			globalThis.fetch = (async (url: string) => new Response(JSON.stringify(tables[String(url).split("/").pop()!] ?? {}))) as typeof fetch;
			knowChampions(undefined);
			const environment = { PI_CODING_AGENT_DIR: join(home(name), "agent") };
			saveProfile(profilePath(environment), { riotIds: { known: [] }, champion: card.name });
			const fake = fakePi();
			installVoxrenCoach(fake.pi as any, environment, custodian, undefined, async () => undefined, undefined, async () => undefined);
			await fake.handlers.get("session_start")![0]({}, tuiCtx());
			const result = await fake.handlers.get("before_agent_start")![0]({ prompt: "hi", systemPromptOptions: {} }, { hasUI: true, mode: "tui", ui: {}, sessionManager: { getSessionId: () => "s", getBranch: () => [] } });
			return result.systemPrompt as string;
		};
		try {
			expect(await firstPrompt("card-prompt", card.meta.version)).toContain(row!);
			// A card built on another patch stays out: its rows could name numbers the live patch moved.
			expect(await firstPrompt("card-prompt-later", card.meta.version.replace(/\d+$/, (last) => String(Number(last) + 1)))).not.toContain(row!);
		} finally {
			globalThis.fetch = realFetch;
			knowChampions(undefined);
		}
	});
});

describe("first-turn wait for Data Dragon names (#395)", () => {
	const gatewayWith = (loadDataDragonInfo: (real: () => Promise<any>) => Promise<unknown>) => ((...args: any[]) => { const real = (createLiveResearchGateway as any)(...args); return Object.assign(Object.create(real), { loadDataDragonInfo: () => loadDataDragonInfo(() => real.loadDataDragonInfo()) }); }) as any;
	const bare = { hasUI: true, mode: "tui", ui: {}, sessionManager: { getSessionId: () => "s", getBranch: () => [] } };
	const start = async (name: string, loadDataDragonInfo: (real: () => Promise<any>) => Promise<unknown>, lines: any[]) => {
		const environment = { PI_CODING_AGENT_DIR: join(home(name), "agent") };
		saveProfile(profilePath(environment), { riotIds: { known: [] }, champion: "Vox & the Probe" });
		const fake = fakePi();
		installVoxrenCoach(fake.pi as any, environment, custodian, undefined, async () => undefined, undefined, async () => "mid", undefined, undefined, undefined, undefined, undefined, undefined, gatewayWith(loadDataDragonInfo));
		await fake.handlers.get("session_start")![0]({}, tuiCtx());
		setLogSink((line) => lines.push(JSON.parse(line)));
		const turn = async () => {
			const at = Date.now();
			const result = await fake.handlers.get("before_agent_start")![0]({ prompt: "hi", systemPromptOptions: {} }, bare);
			return { ms: Date.now() - at, result };
		};
		return turn;
	};

	test("names that load: turn 1 waits for them and the display-name main maps", async () => {
		const realFetch = globalThis.fetch;
		const tables: Record<string, unknown> = { "versions.json": ["1.0.1"], "champion.json": { data: { Voxprobe: { id: "Voxprobe", name: "Vox & the Probe", key: "9002" } } }, "runesReforged.json": [], "summoner.json": { data: {} }, "item.json": { data: {} } };
		globalThis.fetch = (async (url: string) => new Response(JSON.stringify(tables[String(url).split("/").pop()!] ?? {}))) as typeof fetch;
		knowChampions(undefined);
		const lines: any[] = [];
		try {
			const turn = await start("loads", async (real) => (await new Promise((resolve) => setTimeout(resolve, 300)), real()), lines);
			const first = await turn();
			expect(first.ms).toBeGreaterThanOrEqual(250);
			expect(lines.find((line) => line.event === "no-card")?.details).toMatchObject({ champion: "Vox & the Probe", id: "voxprobe", mapped: true });
			expect(lines.some((line) => line.event === "known-names-slow")).toBe(false);
		} finally {
			globalThis.fetch = realFetch;
			knowChampions(undefined);
		}
	});

	test("names that never load: only turn 1 waits, the resolved lane survives, one line", async () => {
		const lines: any[] = [];
		const turn = await start("hangs", () => new Promise(() => {}), lines);
		const first = await turn();
		const second = await turn();
		// A fixed bound, not the constant: cutting LANE_WAIT_MS in src/index.ts must fail this test.
		expect(first.ms).toBeGreaterThanOrEqual(2400);
		expect(second.ms).toBeLessThan(500);
		// The champion line the prompt builds with the lane. A bare "mid" matches doctrine text ("mid-game", "Mid priority") with no lane at all.
		expect(first.result.systemPrompt).toContain("The player's main champion: Vox & the Probe, played mid.");
		expect(lines.filter((line) => line.event === "known-names-slow")).toHaveLength(1);
	});
});

describe("voxrenCoach launch secrets", () => {
	test("an unreadable handoff file shows a header notice and logs launch_secrets_unreadable (#374)", async () => {
		const { default: voxrenCoach } = await import("./index");
		const { clearAllNoticesForTest, noticeLines } = await import("./coach-log");
		const { headerLines, coachLabels } = await import("./ui");
		const before = { secrets: process.env.VOXREN_LAUNCH_SECRETS, dir: process.env.PI_CODING_AGENT_DIR };
		const agentDir = join(home("agent"), "agent");
		mkdirSync(dirname(agentDir), { recursive: true });
		process.env.VOXREN_LAUNCH_SECRETS = join(home("none"), "missing.json");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			voxrenCoach(fakePi().pi as any);
			expect(readFileSync(join(dirname(agentDir), "coach.log.ndjson"), "utf8")).toContain("launch_secrets_unreadable");
			const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
			const labels = coachLabels("p/m", [], noticeLines());
			expect(headerLines(plain, undefined, labels, 200).join("\n")).toContain("Keys did not load");
		} finally {
			for (const [key, value] of [["VOXREN_LAUNCH_SECRETS", before.secrets], ["PI_CODING_AGENT_DIR", before.dir]] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			clearAllNoticesForTest();
			setLogSink(undefined);
		}
	});
});
