import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	CONFIG_COMMAND,
	CONFIG_NO_ARGS_MESSAGE,
	CONFIG_TUI_ONLY_MESSAGE,
	ConfigPanel,
	applyLcuSignIn,
	applyProfileChange,
	createConfigSession,
	loadProfile,
	profilePath,
	removeRiotId,
	resolveKnownAccounts,
	sanitizeProfile,
	saveCommandSettings,
	saveProfile,
	setPrimaryRiotId,
	updateProfile,
	type ConfigPanelHooks,
	type Profile,
	type ProfileConfigTarget,
	type SecretRowInit,
	type ThemeName,
} from "./config";
import { clearAllNoticesForTest, noticeLines } from "./coach-log";
import { autoOn, parseAutoComp } from "./contracts";
import { installVoxrenCoach, resolveCoach } from "./index";
import { addTakeaway, emptyLearnings, learningsFilePath, loadLearnings, saveLearnings, summarizeLearnings } from "./learnings-store";
import type { RiotKeyCustodian, RiotKeyNotice, RiotKeyOutcome } from "./riot-key";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
const RETURN = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const UP = "\x1b[A";
/** Lets an async ConfirmView action settle; matches riot-key.test.ts's own flush(). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sanitizeProfile", () => {
	test("keeps the per-command settings the /flow tree can save and drops everything else", () => {
		const result = sanitizeProfile({
			riotIds: { known: [] },
			commands: {
				review: { args: " 15 ", auto: true }, // trimmed; auto is kept only for /draft, /comp and /review (the pick: {auto:true} row below is still dropped)
				matchup: { args: "Zed" }, // bare /matchup reads the live enemy: no saved default
				draft: { auto: true, args: "x" },
				otp: { args: "Faker#KR1" },
				patch: { args: "Ah\u0007ri" }, // a control character
				comp: { args: 7 },
				pick: { auto: true },
				nope: { args: "1" },
			},
		});
		expect(result.commands).toEqual({ review: { args: "15", auto: true }, draft: { auto: true }, otp: { args: "Faker#KR1" } });
		expect(sanitizeProfile({ riotIds: { known: [] }, commands: { review: { args: "40" }, draft: { auto: false } } })).toEqual({ riotIds: { known: [] }, commands: { draft: { auto: false } } }); // off is a saved value now: it beats the default on
	});

	test("undefined and null return the default", () => {
		const fallback = { riotIds: { known: [] } };
		expect(sanitizeProfile(undefined)).toEqual(fallback);
		expect(sanitizeProfile(null)).toEqual(fallback);
	});

	test("drops an invalid theme/champion/primary, keeps valid known entries, dedupes a case-only duplicate", () => {
		const raw = {
			theme: "neon",
			champion: "",
			riotIds: {
				primary: "not-a-riot-id",
				known: ["Player01#NA1", "player01#na1", "Other#NA1", "##", 42, null],
			},
		};
		const result = sanitizeProfile(raw);
		expect(result.theme).toBeUndefined();
		expect(result.champion).toBeUndefined();
		expect(result.riotIds.primary).toBeUndefined();
		expect(result.riotIds.known).toEqual(["Player01#NA1", "Other#NA1"]);
	});

	test("caps known at 20 from 25 valid inputs", () => {
		const known = Array.from({ length: 25 }, (_, i) => `Player${i}#NA${1 + (i % 9)}`);
		const result = sanitizeProfile({ riotIds: { known } });
		expect(result.riotIds.known.length).toBe(20);
		expect(result.riotIds.known).toEqual(known.slice(0, 20));
	});
});

describe("loadProfile", () => {
	test("undefined path, a missing file, and invalid JSON all return the same default without throwing", () => {
		const fallback = sanitizeProfile(undefined);
		expect(loadProfile(undefined)).toEqual(fallback);

		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		expect(loadProfile(join(dir, "missing.json"))).toEqual(fallback);

		const badPath = join(dir, "bad.json");
		writeFileSync(badPath, "{not json");
		expect(loadProfile(badPath)).toEqual(fallback);
	});
});

describe("a profile.json that does not parse (#264)", () => {
	const original = '{ "champion": "Ahri", }\n'; // a trailing comma, as a hand edit leaves it
	const keptFiles = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("profile.json.bad-"));

	test("the file is moved aside whole, a header notice names it, and the next save does not destroy it", () => {
		clearAllNoticesForTest();
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const path = join(dir, "profile.json");
		writeFileSync(path, original);

		expect(loadProfile(path)).toEqual(sanitizeProfile(undefined));
		const kept = keptFiles(dir);
		expect(kept).toHaveLength(1);
		expect(readFileSync(join(dir, kept[0]), "utf8")).toBe(original);
		expect(existsSync(path)).toBe(false);
		expect(noticeLines().join("\n")).toContain(kept[0]);

		updateProfile(path, (p) => applyLcuSignIn(p, "Mine#NA1") ?? p);
		expect(loadProfile(path).riotIds.known).toEqual(["Mine#NA1"]);
		expect(readFileSync(join(dir, kept[0]), "utf8")).toBe(original);
		clearAllNoticesForTest();
	});

	test("a file holding JSON that is not an object is kept the same way", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const path = join(dir, "profile.json");
		writeFileSync(path, "[1]");

		loadProfile(path);

		expect(keptFiles(dir)).toHaveLength(1);
		clearAllNoticesForTest();
	});

	test("a missing file is routine: nothing is kept and no notice is raised", () => {
		clearAllNoticesForTest();
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));

		loadProfile(join(dir, "profile.json"));

		expect(readdirSync(dir)).toEqual([]);
		expect(noticeLines()).toEqual([]);
	});
});

describe("saveProfile", () => {
	test("undefined path is a silent no-op", () => {
		expect(() => saveProfile(undefined, sanitizeProfile(undefined))).not.toThrow();
	});

	test("round-trips exactly through loadProfile and leaves no .tmp file", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const path = join(dir, "profile.json");
		const profile: Profile = { theme: "hextech", champion: "Fizz", riotIds: { primary: "Name#TAG", known: ["Name#TAG", "Other#EUW1"] } };

		saveProfile(path, profile);

		expect(loadProfile(path)).toEqual(profile);
		expect(readdirSync(dirname(path))).toEqual(["profile.json"]);
	});
});

describe("saveProfile failures (#260)", () => {
	test("a directory squatting on the old fixed .tmp name does not block a save", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const path = join(dir, "profile.json");
		mkdirSync(`${path}.tmp`);

		expect(saveProfile(path, { theme: "void", riotIds: { known: [] } })).toBeUndefined();

		expect(loadProfile(path).theme).toBe("void");
	});

	test("a failed rename returns the reason, throws nothing, and leaves no temp file behind", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const path = join(dir, "profile.json");
		mkdirSync(path); // a non-empty directory where the file belongs: rename over it fails
		writeFileSync(join(path, "keep"), "x");

		const failure = saveProfile(path, { theme: "void", riotIds: { known: [] } });

		expect(failure).toBeString();
		expect(failure!.length).toBeGreaterThan(0);
		expect(readdirSync(dir)).toEqual(["profile.json"]);
	});
});

describe("updateProfile and a panel open on a stale snapshot (#262)", () => {
	test("a panel save keeps the account and /flow setting another window wrote after the panel opened, and fields this version does not know", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const environment = { PI_CODING_AGENT_DIR: join(dir, "agent") };
		const path = profilePath(environment)!;
		saveProfile(path, { riotIds: { primary: "X#NA1", known: ["X#NA1"] } });
		const config: ProfileConfigTarget = { champion: undefined, accounts: [], labels: { accounts: [] }, learningsOff: false };
		const session = createConfigSession(environment, config, () => {});
		const fake = fakeConfigCtx();
		await session.open("", fake.ctx);
		const panel = fake.customFactory({ requestRender: () => {} }, theme, {}, () => {});

		// Another window, or a newer version, writes while the panel is open.
		writeFileSync(
			path,
			JSON.stringify({ riotIds: { primary: "X#NA1", known: ["X#NA1", "Y#NA1"] }, commands: { draft: { auto: true }, zzz: { args: "1" } }, futureField: { a: 1 } }),
		);
		for (let i = 0; i < 4; i++) panel.handleInput(DOWN); // Learnings row
		panel.handleInput(RETURN);
		panel.handleInput(RETURN); // Memory: on -> off

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.learningsOff).toBe(true);
		expect(saved.riotIds.known).toEqual(["X#NA1", "Y#NA1"]);
		expect(saved.commands).toEqual({ draft: { auto: true }, zzz: { args: "1" } });
		expect(saved.futureField).toEqual({ a: 1 });
	});

	test("a /flow save and an LCU sign-in write keep what they do not own, and an unchanged profile is not rewritten", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const path = join(dir, "profile.json");
		writeFileSync(path, JSON.stringify({ theme: "void", futureField: [1], commands: { zzz: { args: "1" } } }));

		saveCommandSettings(path, "draft", { auto: true });
		updateProfile(path, (p) => applyLcuSignIn(p, "Mine#NA1") ?? p);

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved).toMatchObject({ theme: "void", futureField: [1], commands: { zzz: { args: "1" }, draft: { auto: true } }, riotIds: { known: ["Mine#NA1"] } });

		const before = readFileSync(path, "utf8");
		const past = new Date(Date.now() - 60_000);
		utimesSync(path, past, past);
		updateProfile(path, (p) => applyLcuSignIn(p, "mine#na1") ?? p);
		expect(Math.floor(statSync(path).mtimeMs)).toBe(Math.floor(past.getTime()));
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});

describe("resolveKnownAccounts", () => {
	test("orders signedIn > primary > known > env, and dedupes case-insensitively", () => {
		const profile: Profile = {
			riotIds: { primary: "Primary#NA1", known: ["Known#NA1", "primary#na1", "signed#na1"] },
		};
		const result = resolveKnownAccounts("Signed#NA1", profile, ["Env#NA1", "known#na1"]);
		expect(result).toEqual(["Signed#NA1", "Primary#NA1", "Known#NA1", "Env#NA1"]);
	});

	test("tolerates all-undefined signedIn and primary", () => {
		const profile: Profile = { riotIds: { known: ["Known#NA1"] } };
		expect(resolveKnownAccounts(undefined, profile, ["Env#NA1"])).toEqual(["Known#NA1", "Env#NA1"]);
	});
});

describe("applyLcuSignIn", () => {
	test("no-ops for an already-known id, case-insensitively", () => {
		const profile: Profile = { riotIds: { primary: "Name#TAG", known: ["Name#TAG"] } };
		expect(applyLcuSignIn(profile, "name#tag")).toBeUndefined();
	});

	test("sets primary only the first time, appends otherwise", () => {
		const first = applyLcuSignIn({ riotIds: { known: [] } }, "First#NA1");
		expect(first).toEqual({ riotIds: { primary: "First#NA1", known: ["First#NA1"] } });

		const second = applyLcuSignIn(first as Profile, "Second#NA1");
		expect(second).toEqual({ riotIds: { primary: "First#NA1", known: ["First#NA1", "Second#NA1"] } });
	});
});

describe("setPrimaryRiotId", () => {
	test("marks an already-known id primary", () => {
		const profile: Profile = { riotIds: { primary: "First#NA1", known: ["First#NA1", "Second#NA1"] } };
		expect(setPrimaryRiotId(profile, "Second#NA1")).toEqual({ riotIds: { primary: "Second#NA1", known: ["First#NA1", "Second#NA1"] } });
	});

	test("a no-op copy for an id that is not known", () => {
		const profile: Profile = { riotIds: { primary: "First#NA1", known: ["First#NA1"] } };
		expect(setPrimaryRiotId(profile, "Stranger#NA1")).toEqual(profile);
	});
});

describe("removeRiotId", () => {
	test("removing a non-primary id leaves primary untouched", () => {
		const profile: Profile = { riotIds: { primary: "First#NA1", known: ["First#NA1", "Second#NA1"] } };
		expect(removeRiotId(profile, "Second#NA1")).toEqual({ riotIds: { primary: "First#NA1", known: ["First#NA1"] } });
	});

	test("removing the primary promotes the next known entry", () => {
		const profile: Profile = { riotIds: { primary: "First#NA1", known: ["First#NA1", "Second#NA1", "Third#NA1"] } };
		expect(removeRiotId(profile, "First#NA1")).toEqual({ riotIds: { primary: "Second#NA1", known: ["Second#NA1", "Third#NA1"] } });
	});

	test("removing the last known id clears primary", () => {
		const profile: Profile = { riotIds: { primary: "Only#NA1", known: ["Only#NA1"] } };
		expect(removeRiotId(profile, "Only#NA1")).toEqual({ riotIds: { primary: undefined, known: [] } });
	});
});

describe("saveCommandSettings", () => {
	test("re-reads the profile, writes one command's settings beside the rest, and refuses a default the command's parser refuses", () => {
		const path = join(mkdtempSync(join(tmpdir(), "voxren-command-settings-")), "profile.json");
		saveProfile(path, { theme: "void", riotIds: { known: ["Player01#NA1"] }, commands: { draft: { auto: true } } });
		const next = saveCommandSettings(path, "review", { args: "15" });
		expect(next).toEqual({ draft: { auto: true }, review: { args: "15" } });
		expect(loadProfile(path)).toEqual({ theme: "void", riotIds: { known: ["Player01#NA1"] }, commands: next });
		expect(saveCommandSettings(path, "review", { args: "40" })).toBeUndefined();
		expect(saveCommandSettings(path, "matchup", { args: "Zed" })).toBeUndefined();
		expect(loadProfile(path).commands).toEqual(next);
		saveCommandSettings(path, "review", {});
		expect(saveCommandSettings(path, "draft", { auto: false })).toEqual({ draft: { auto: false } });
		expect(loadProfile(path)).toEqual({ theme: "void", riotIds: { known: ["Player01#NA1"] }, commands: { draft: { auto: false } } });
	});

	test("auto precedence: the env var when it says on or off, else the saved row, else on", () => {
		for (const [value, parsed] of [[undefined, undefined], ["", undefined], ["banana", undefined], ["1", true], [" TRUE ", true], ["on", true], ["0", false], ["false", false], ["off", false], ["OFF ", false]] as const)
			expect(parseAutoComp(value)).toBe(parsed);
		expect(autoOn(undefined, undefined)).toBe(true);
		expect(autoOn(undefined, {})).toBe(true);
		expect(autoOn(undefined, { auto: false })).toBe(false); // a saved off beats the default
		expect(autoOn(undefined, { auto: true })).toBe(true);
		expect(autoOn(false, { auto: true })).toBe(false); // the env var beats the saved row
		expect(autoOn(true, { auto: false })).toBe(true);
	});

	test("with no coach home it still returns the settings, so the live session follows the change", () => {
		expect(saveCommandSettings(undefined, "draft", { auto: true })).toEqual({ draft: { auto: true } });
	});
});

describe("applyProfileChange", () => {
	function fakeConfig(champion: string, accounts: string[]): ProfileConfigTarget {
		return { champion, accounts, labels: { accounts }, learningsOff: false };
	}

	test("persists the save and updates champion/accounts on the same config object, in place", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const environment = { PI_CODING_AGENT_DIR: join(dir, "agent") };
		const config = fakeConfig("Fizz", ["Old#NA1"]);
		const labelsRef = config.labels;
		const invalidated: number[] = [];
		const next: Profile = { champion: "Ahri", riotIds: { primary: "New#NA1", known: ["New#NA1"] } };

		applyProfileChange(config, () => invalidated.push(1), environment, () => next);

		expect(loadProfile(profilePath(environment))).toEqual(next);
		expect(config.champion).toBe("Ahri");
		expect(config.accounts).toEqual(["New#NA1"]);
		// Mutated in place: installCoachSurface's header/footer closures captured this exact object at session_start.
		expect(config.labels).toBe(labelsRef);
		expect(config.labels.accounts).toEqual(["New#NA1"]);
		expect(invalidated).toEqual([1]);
	});

	test("a still-set VOXREN_COACH_CHAMPION beats a later profile-only champion save", () => {
		const config = fakeConfig("Fizz", []);
		const environment = { VOXREN_COACH_CHAMPION: "Jinx" };

		applyProfileChange(config, () => {}, environment, () => ({ champion: "Ahri", riotIds: { known: [] } }));

		expect(config.champion).toBe("Jinx");
	});

	test("champion is undefined when neither env nor profile names one", () => {
		const config = fakeConfig("Fizz", []);

		applyProfileChange(config, () => {}, {}, () => ({ riotIds: { known: [] } }));

		expect(config.champion).toBeUndefined();
	});

	test("a failed write returns the reason and leaves the live config as it was", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		mkdirSync(join(dir, "profile.json", "x"), { recursive: true });
		const config = fakeConfig("Fizz", []);

		const { failure } = applyProfileChange(config, () => {}, { PI_CODING_AGENT_DIR: join(dir, "agent") }, () => ({ champion: "Ahri", riotIds: { known: [] } }));

		expect(failure).toBeString();
		expect(config.champion).toBe("Fizz");
	});

	test("invalidateLane fires only when the champion actually changed", () => {
		const config = fakeConfig("Fizz", []);
		const invalidated: number[] = [];

		applyProfileChange(config, () => invalidated.push(1), {}, () => ({ champion: "Fizz", riotIds: { known: [] } }));
		expect(invalidated).toEqual([]);

		applyProfileChange(config, () => invalidated.push(1), {}, () => ({ champion: "Ahri", riotIds: { known: [] } }));
		expect(invalidated).toEqual([1]);
	});
});

function panelHarness(
	profile: Profile,
	initialTheme: ThemeName = "tidal",
	initialChampion: string | undefined = profile.champion,
	overrides: Partial<ConfigPanelHooks> = {},
	secrets?: SecretRowInit[],
	learningsDir?: string,
) {
	const themeCalls: ThemeName[] = [];
	const saves: Profile[] = [];
	let current = profile;
	const notices: RiotKeyNotice[] = [];
	let renders = 0;
	let closed = false;
	const panel = new ConfigPanel(
		theme,
		profile,
		initialTheme,
		initialChampion,
		{
			setTheme: (name) => themeCalls.push(name),
			onSave: (change) => {
				current = change(current);
				saves.push(current);
				return { profile: current };
			},
			requestRender: () => renders++,
			done: () => (closed = true),
			onNotice: (notice) => notices.push(notice),
			...overrides,
		},
		secrets,
		learningsDir,
	);
	return { panel, themeCalls, saves, notices, get renders() { return renders; }, get closed() { return closed; } };
}

describe("ConfigPanel: theme row", () => {
	test("Right and Left step the themes, preview each live, and save at once with no Enter", () => {
		const h = panelHarness({ riotIds: { known: [] } });
		h.panel.handleInput(RIGHT); // theme is the first row
		expect(h.themeCalls).toEqual(["hextech"]);
		expect(h.saves.map((save) => save.theme)).toEqual(["hextech"]);
		h.panel.handleInput(LEFT);
		h.panel.handleInput(LEFT); // wraps past the first theme
		expect(h.themeCalls).toEqual(["hextech", "tidal", "signal"]);
		expect(h.saves.map((save) => save.theme)).toEqual(["hextech", "tidal", "signal"]);
		expect(h.panel.render(80).join("\n")).toContain("signal");
		expect(h.closed).toBe(false);
	});

	test("Enter and typing on the theme row do nothing", () => {
		const h = panelHarness({ riotIds: { known: [] } });
		h.panel.handleInput(RETURN);
		h.panel.handleInput(" ");
		h.panel.handleInput("x");
		expect(h.themeCalls).toEqual([]);
		expect(h.saves).toEqual([]);
	});
});

describe("ConfigPanel: a failed save (#260)", () => {
	test("says not saved with the reason, keeps the row's old value, and puts the previewed theme back", () => {
		const h = panelHarness({ riotIds: { known: [] } }, "tidal", undefined, { onSave: () => ({ profile: { riotIds: { known: [] } }, failure: "disk full" }) });
		h.panel.handleInput(RIGHT);

		expect(h.notices).toEqual([{ level: "error", text: "Not saved: disk full" }]);
		expect(h.themeCalls).toEqual(["hextech", "tidal"]);
		const screen = h.panel.render(80).join("\n");
		expect(screen).toContain("Not saved: disk full");
		expect(screen).not.toContain("hextech");
	});
});

describe("ConfigPanel: champion row", () => {
	const names = async () => ["Zed", "Ahri", "Fizz"];
	const championRow = (champion: string | undefined, overrides: Partial<ConfigPanelHooks> = {}) => {
		const h = panelHarness({ champion, riotIds: { known: [] } }, "tidal", champion, { loadChampions: names, ...overrides });
		h.panel.handleInput(DOWN); // champion is the second row
		return h;
	};

	test("Right and Left step the Data Dragon names through the unset state, saving each step with no Enter", async () => {
		const h = championRow("Fizz");
		h.panel.handleInput(RIGHT); // loads the list, then lands on the step
		await flush();
		expect(h.saves.map((save) => save.champion)).toEqual(["Zed"]);
		h.panel.handleInput(RIGHT); // past the last name: unset
		h.panel.handleInput(RIGHT); // then the first
		h.panel.handleInput(LEFT);
		expect(h.saves.map((save) => save.champion)).toEqual(["Zed", undefined, "Ahri", undefined]);
		expect(h.panel.render(80).join("\n")).toContain("detected from game");
	});

	test("a typo cannot be saved: typed letters, Enter and Space on the row change nothing", async () => {
		const h = championRow("Fizz");
		for (const ch of "Ahrri") h.panel.handleInput(ch);
		h.panel.handleInput(RETURN);
		h.panel.handleInput(" ");
		await flush();
		expect(h.saves).toEqual([]);
	});

	test("a champion list that will not load says so and saves nothing", async () => {
		const h = championRow("Fizz", {
			loadChampions: async () => {
				throw new Error("offline");
			},
		});
		h.panel.handleInput(RIGHT);
		await flush();
		expect(h.saves).toEqual([]);
		expect(h.panel.render(80).join("\n")).toContain("Could not load the champion list");
	});
});

describe("ConfigPanel: Riot IDs row", () => {
	/** Riot IDs is the third row; Enter opens its list, Esc comes back to the rows. */
	function openRiotIds(panel: ConfigPanel) {
		panel.handleInput(DOWN);
		panel.handleInput(DOWN);
		panel.handleInput(RETURN);
	}
	function addRiotId(panel: ConfigPanel, id: string) {
		panel.handleInput(RETURN); // on "+ Add Riot ID"
		for (const ch of id) panel.handleInput(ch);
		panel.handleInput(RETURN);
	}

	test("adding two ids, marking the second primary with Right, then removing the first with Left twice: one save per action", () => {
		const h = panelHarness({ riotIds: { known: [] } });
		openRiotIds(h.panel);

		addRiotId(h.panel, "First#NA1");
		expect(h.saves).toHaveLength(1);
		expect(h.saves[0].riotIds).toEqual({ primary: "First#NA1", known: ["First#NA1"] });

		h.panel.handleInput(DOWN); // First#NA1 -> "+ Add Riot ID"
		addRiotId(h.panel, "Second#NA1");
		expect(h.saves[1].riotIds).toEqual({ primary: "First#NA1", known: ["First#NA1", "Second#NA1"] });

		h.panel.handleInput(RIGHT); // the cursor sits on the id just added
		expect(h.saves).toHaveLength(3);
		expect(h.saves[2].riotIds).toEqual({ primary: "Second#NA1", known: ["First#NA1", "Second#NA1"] });

		h.panel.handleInput(UP);
		h.panel.handleInput(LEFT); // arms First#NA1
		expect(h.saves).toHaveLength(3);
		expect(h.panel.render(80).join("\n")).toContain("Left again to remove");
		h.panel.handleInput(LEFT);
		expect(h.saves).toHaveLength(4);
		expect(h.saves[3].riotIds).toEqual({ primary: "Second#NA1", known: ["Second#NA1"] });
		expect(h.closed).toBe(false);
	});

	test("any other key disarms a removal", () => {
		const h = panelHarness({ riotIds: { primary: "First#NA1", known: ["First#NA1", "Second#NA1"] } });
		openRiotIds(h.panel);
		h.panel.handleInput(LEFT);
		h.panel.handleInput(DOWN);
		h.panel.handleInput(UP);
		h.panel.handleInput(LEFT);
		expect(h.saves).toEqual([]);
	});

	test("removing the primary promotes the next id", () => {
		const h = panelHarness({ riotIds: { primary: "First#NA1", known: ["First#NA1", "Second#NA1"] } });
		openRiotIds(h.panel);
		h.panel.handleInput(LEFT);
		h.panel.handleInput(LEFT);
		expect(h.saves[0].riotIds).toEqual({ primary: "Second#NA1", known: ["Second#NA1"] });
	});

	test("an invalid Riot ID stays in the field with the reason and no save; completing it to Name#TAG then saves", () => {
		const h = panelHarness({ riotIds: { known: [] } });
		openRiotIds(h.panel);
		h.panel.handleInput(RETURN); // "+ Add Riot ID"
		for (const ch of "bad") h.panel.handleInput(ch); // no '#': fails RIOT_ID_PATTERN
		h.panel.handleInput(RETURN);
		expect(h.saves).toEqual([]);
		expect(h.panel.render(80).join("\n")).toContain("Name#TAG");
		for (const ch of "#NA1") h.panel.handleInput(ch); // buffer is now "bad#NA1": valid
		h.panel.handleInput(RETURN);
		expect(h.saves).toHaveLength(1);
		expect(h.saves[0].riotIds.known).toEqual(["bad#NA1"]);
	});

	test("Esc on the add field cancels without saving", () => {
		const h = panelHarness({ riotIds: { known: [] } });
		openRiotIds(h.panel);
		h.panel.handleInput(RETURN);
		for (const ch of "Some#NA1") h.panel.handleInput(ch);
		h.panel.handleInput(ESCAPE);
		expect(h.saves).toEqual([]);
	});
});

describe("ConfigPanel: Keys row (#36 stage 4)", () => {
	function fakeCustodian(overrides: Partial<RiotKeyCustodian> = {}): RiotKeyCustodian {
		const notStored: RiotKeyOutcome = { ok: true, state: { stored: false } };
		return {
			status: async () => notStored,
			store: async () => notStored,
			test: async () => notStored,
			remove: async () => notStored,
			fetch: async () => ({ ok: true, httpStatus: 200, body: "" }),
			...overrides,
		};
	}

	/** Keys is the fourth row. */
	function openKeys(panel: ConfigPanel) {
		panel.handleInput(DOWN);
		panel.handleInput(DOWN);
		panel.handleInput(DOWN);
		panel.handleInput(RETURN);
	}

	test("renders Riot, Perplexity, and Typesafe with the source clause resolveKeySource computes for each", () => {
		const secrets: SecretRowInit[] = [
			{ id: "riot", label: "Riot", custodian: fakeCustodian(), state: { stored: true } },
			{ id: "perplexity", label: "Perplexity", custodian: fakeCustodian(), state: { stored: true }, envTag: "env" },
			{ id: "typesafe", label: "Typesafe", custodian: fakeCustodian(), state: { stored: true }, envTag: "dotenv" },
		];
		const h = panelHarness({ riotIds: { known: [] } }, "tidal", undefined, {}, secrets);
		openKeys(h.panel);
		const text = h.panel.render(80).join("\n");
		expect(text).toMatch(/Riot\s+stored\b/);
		expect(text).toContain("Perplexity");
		expect(text).toContain("env (shadowing a stored key)");
		expect(text).toContain("Typesafe");
		expect(text).toContain(".env (shadowing a stored key)");
	});

	test("not stored, and a plain env/.env value with nothing stored to shadow, render without the shadow clause", () => {
		const secrets: SecretRowInit[] = [
			{ id: "riot", label: "Riot", custodian: fakeCustodian(), state: { stored: false } },
			{ id: "perplexity", label: "Perplexity", custodian: fakeCustodian(), state: { stored: false }, envTag: "env" },
			{ id: "typesafe", label: "Typesafe", custodian: fakeCustodian(), state: { stored: false }, envTag: "dotenv" },
		];
		const h = panelHarness({ riotIds: { known: [] } }, "tidal", undefined, {}, secrets);
		openKeys(h.panel);
		const text = h.panel.render(80).join("\n");
		expect(text).toMatch(/Riot\s+not stored\b/);
		expect(text).toMatch(/Perplexity\s+env\b/);
		expect(text).toMatch(/Typesafe\s+\.env\b/);
		expect(text).not.toContain("shadowing");
	});

	test("with no secrets argument (every pre-Keys caller), all four rows are unavailable and the summary reads 0 of 4", () => {
		const h = panelHarness({ riotIds: { known: [] } });
		expect(h.panel.render(80).join("\n")).toMatch(/Keys\s+0 of 4 active/);
		openKeys(h.panel);
		const text = h.panel.render(80).join("\n");
		expect(text).toContain("Riot");
		expect(text).toContain("Perplexity");
		expect(text).toContain("Typesafe");
		expect(text).toContain("Gemini");
		h.panel.handleInput(RETURN); // Riot row: no custodian
		expect(h.panel.render(80).join("\n")).toContain("Riot key store is unavailable in this launch (no key store configured).");
		h.panel.handleInput(RETURN); // Enter/Esc back
		expect(h.closed).toBe(false); // backs out, never closes the whole panel
	});

	test("storing a key calls the custodian, fires onNotice, and updates the top-level summary once the four-action panel is left", async () => {
		const stored: string[] = [];
		const custodian = fakeCustodian({
			store: async (key) => {
				stored.push(key);
				return { ok: true, state: { stored: true, updatedAt: "2026-09-27T00:00:00.000Z" } };
			},
		});
		const secrets: SecretRowInit[] = [
			{ id: "riot", label: "Riot", state: { stored: false } },
			{ id: "perplexity", label: "Perplexity", custodian, state: { stored: false } },
			{ id: "typesafe", label: "Typesafe", state: { stored: false } },
		];
		const h = panelHarness({ riotIds: { known: [] } }, "tidal", undefined, {}, secrets);
		expect(h.panel.render(80).join("\n")).toMatch(/Keys\s+0 of 3 active/);

		openKeys(h.panel);
		h.panel.handleInput(DOWN); // Perplexity row
		h.panel.handleInput(RETURN); // its four-action panel
		h.panel.handleInput(RETURN); // "Development key" row: hidden input
		for (const ch of "pplx-abcdefghijklmnop") h.panel.handleInput(ch);
		h.panel.handleInput(RETURN); // submit
		await flush();

		expect(stored).toEqual(["pplx-abcdefghijklmnop"]);
		expect(h.notices.at(-1)?.text).toBe("Perplexity key stored in the system key store. Takes effect at the next launch of coach.");
		expect(h.closed).toBe(false);
		// Storing returns to the four-action panel itself (so Live test can follow immediately), the
		// same as /riot-key's own panel; it already shows the fresh value there.
		expect(h.panel.render(80).join("\n")).toContain("stored · updated 2026-09-27 00:00Z");

		h.panel.handleInput(ESCAPE); // leave the four-action panel: back to ConfigPanel's top-level list
		expect(h.closed).toBe(false);
		expect(h.panel.render(80).join("\n")).toMatch(/Keys\s+1 of 3 active/);
	});

	test("a Perplexity or Gemini key the research service never reads is shown as stored but unused, and is not counted active", () => {
		const secrets: SecretRowInit[] = [
			{ id: "riot", label: "Riot", state: { stored: true } },
			{ id: "perplexity", label: "Perplexity", state: { stored: true }, unused: "a service you run holds its own keys" },
			{ id: "gemini", label: "Gemini", state: { stored: true }, unused: "a service you run holds its own keys" },
		];
		const h = panelHarness({ riotIds: { known: [] } }, "tidal", undefined, {}, secrets);
		expect(h.panel.render(120).join("\n")).toMatch(/Keys\s+1 of 3 active/);
		openKeys(h.panel);
		const text = h.panel.render(160).join("\n");
		expect(text).toMatch(/Perplexity\s+stored, unused: a service you run holds its own keys/);
		expect(text).toMatch(/Gemini\s+stored, unused: a service you run holds its own keys/);
		expect(text).toMatch(/Riot\s+stored\s*$/m);
	});

	test("removing a key fires the removed notice and drops the summary count once the four-action panel is left", async () => {
		const custodian = fakeCustodian({ remove: async () => ({ ok: true, state: { stored: false } }) });
		const secrets: SecretRowInit[] = [
			{ id: "riot", label: "Riot", state: { stored: false } },
			{ id: "perplexity", label: "Perplexity", custodian, state: { stored: true, updatedAt: "2026-09-27T00:00:00.000Z" } },
			{ id: "typesafe", label: "Typesafe", state: { stored: false } },
		];
		const h = panelHarness({ riotIds: { known: [] } }, "tidal", undefined, {}, secrets);
		expect(h.panel.render(80).join("\n")).toMatch(/Keys\s+1 of 3 active/);

		openKeys(h.panel);
		h.panel.handleInput(DOWN); // Perplexity row
		h.panel.handleInput(RETURN); // its four-action panel
		h.panel.handleInput(DOWN); // "Live test"
		h.panel.handleInput(DOWN); // "Status"
		h.panel.handleInput(DOWN); // "Remove key"
		h.panel.handleInput(RETURN); // ConfirmView
		h.panel.handleInput(RETURN); // confirm
		await flush();

		expect(h.notices.at(-1)?.text).toBe("Perplexity key removed. Takes effect at the next launch of coach.");
		expect(h.panel.render(80).join("\n")).toContain("not stored"); // still the four-action panel, refreshed

		h.panel.handleInput(ESCAPE); // leave the four-action panel: back to ConfigPanel's top-level list
		expect(h.panel.render(80).join("\n")).toMatch(/Keys\s+0 of 3 active/);
	});
});

describe("ConfigPanel: Learnings row (issue #33 stage 5)", () => {
	/**
	 * Learnings is the fifth row. Every leaf action below exits straight back to the top row list
	 * with Learnings still selected (see learningsSubmenu's "exit" comment in src/config.ts), so
	 * only the first entry needs the four DOWNs; a later re-entry is a bare Enter.
	 */
	function openLearnings(panel: ConfigPanel, first: boolean) {
		if (first) for (let i = 0; i < 4; i++) panel.handleInput(DOWN);
		panel.handleInput(RETURN);
	}

	test("cycling Memory off then back on saves once per flip and flips the row's value", () => {
		const h = panelHarness({ riotIds: { known: [] } });
		openLearnings(h.panel, true);
		h.panel.handleInput(RETURN); // Memory row: on -> off
		expect(h.saves).toHaveLength(1);
		expect(h.saves[0].learningsOff).toBe(true);
		h.panel.handleInput(RETURN); // off -> on
		expect(h.saves).toHaveLength(2);
		expect(h.saves[1].learningsOff).toBe(false);
		expect(h.closed).toBe(false); // toggling never closes the whole panel
	});

	test("View summary renders summarizeLearnings' text for one id and the empty-state fallback for another with no file; Esc returns to the top row list", () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const path = learningsFilePath(dir, "First#NA1")!;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ takeaways: [{ text: "working on wave management", savedAt: "2026-09-27T00:00:00.000Z" }] }));

		const h = panelHarness({ riotIds: { known: ["First#NA1", "Second#NA1"] } }, "tidal", undefined, {}, undefined, dir);
		openLearnings(h.panel, true);
		h.panel.handleInput(DOWN); // First#NA1 (row 0 is Memory)
		h.panel.handleInput(RETURN); // its View summary / Reset actions
		h.panel.handleInput(RETURN); // View summary
		expect(h.panel.render(80).join("\n")).toContain(summarizeLearnings(loadLearnings(path)));
		h.panel.handleInput(ESCAPE);
		expect(h.closed).toBe(false); // back to the top row list, panel stays open

		openLearnings(h.panel, false); // fresh nested list: row0 Memory, row1 First#NA1, row2 Second#NA1
		h.panel.handleInput(DOWN);
		h.panel.handleInput(DOWN); // Second#NA1: no file on disk
		h.panel.handleInput(RETURN);
		h.panel.handleInput(RETURN); // View summary
		expect(h.panel.render(80).join("\n")).toContain("Nothing remembered yet.");
	});

	test("Reset deletes only that id's file, leaving a second id's file untouched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const firstPath = learningsFilePath(dir, "First#NA1")!;
		const secondPath = learningsFilePath(dir, "Second#NA1")!;
		saveLearnings(firstPath, addTakeaway(emptyLearnings(), "note", "2026-09-27T00:00:00.000Z"));
		saveLearnings(secondPath, addTakeaway(emptyLearnings(), "note", "2026-09-27T00:00:00.000Z"));

		const h = panelHarness({ riotIds: { known: ["First#NA1", "Second#NA1"] } }, "tidal", undefined, {}, undefined, dir);
		openLearnings(h.panel, true);
		h.panel.handleInput(DOWN); // First#NA1
		h.panel.handleInput(RETURN); // its actions
		h.panel.handleInput(DOWN); // Reset
		h.panel.handleInput(RETURN); // ConfirmView
		h.panel.handleInput(RETURN); // confirm
		await flush();

		expect(existsSync(firstPath)).toBe(false);
		expect(existsSync(secondPath)).toBe(true);
	});
});

describe("createConfigSession", () => {
	function fakeCtx(mode = "tui") {
		const calls: Record<string, unknown[][]> = {};
		const log = (name: string) => (...args: unknown[]) => {
			(calls[name] ??= []).push(args);
		};
		const themeCalls: string[] = [];
		let customFactory: any;
		return {
			calls,
			themeCalls,
			get customFactory() {
				return customFactory;
			},
			ctx: {
				hasUI: true,
				mode,
				ui: {
					notify: log("notify"),
					setTheme: (name: string) => {
						themeCalls.push(name);
						return { success: true };
					},
					custom: async (factory: any) => {
						customFactory = factory;
						log("custom")();
						return undefined;
					},
				},
			},
		};
	}

	test("non-empty args and non-TUI mode both refuse before the panel ever opens", async () => {
		const config: ProfileConfigTarget = { champion: "Fizz", accounts: [], labels: { accounts: [] }, learningsOff: false };
		const session = createConfigSession({}, config, () => {});

		const withArgs = fakeCtx();
		await session.open("hextech", withArgs.ctx);
		expect(withArgs.calls.notify).toEqual([[CONFIG_NO_ARGS_MESSAGE, "error"]]);
		expect(withArgs.calls.custom).toBeUndefined();

		const printMode = fakeCtx("print");
		await session.open("", printMode.ctx);
		expect(printMode.calls.notify).toEqual([[CONFIG_TUI_ONLY_MESSAGE, "error"]]);
		expect(printMode.calls.custom).toBeUndefined();
	});

	test("a theme save persists to profile.json at the scratch path and never invalidates the lane; a champion save does both", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const environment = { PI_CODING_AGENT_DIR: join(dir, "agent") };
		const config: ProfileConfigTarget = { champion: undefined, accounts: [], labels: { accounts: [] }, learningsOff: false };
		const invalidated: number[] = [];
		const session = createConfigSession(environment, config, () => invalidated.push(1), {}, undefined, undefined, async () => new Map([[2, "Jinx"], [1, "Ahri"]]));

		const fake = fakeCtx();
		await session.open("", fake.ctx);
		expect(fake.calls.custom).toHaveLength(1);
		let closed = false;
		const panel = fake.customFactory({ requestRender: () => {} }, theme, {}, () => (closed = true));

		panel.handleInput(RIGHT); // theme row: hextech, saved at once
		expect(fake.themeCalls).toEqual(["hextech"]);
		expect(loadProfile(profilePath(environment)).theme).toBe("hextech");
		expect(invalidated).toEqual([]);
		expect(closed).toBe(false);

		panel.handleInput(DOWN); // champion row
		panel.handleInput(RIGHT); // loads the names, then steps to the first
		await flush();
		expect(loadProfile(profilePath(environment)).champion).toBe("Ahri");
		expect(config.champion).toBe("Ahri");
		expect(invalidated).toEqual([1]);

		panel.handleInput(ESCAPE);
		expect(closed).toBe(true);
	});

	test("toggling Memory persists profile.learningsOff to profile.json and flips config.learningsOff live, with no restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const environment = { PI_CODING_AGENT_DIR: join(dir, "agent") };
		const config: ProfileConfigTarget = { champion: "Fizz", accounts: [], labels: { accounts: [] }, learningsOff: false };
		const session = createConfigSession(environment, config, () => {});

		const fake = fakeCtx();
		await session.open("", fake.ctx);
		const panel = fake.customFactory({ requestRender: () => {} }, theme, {}, () => {});

		for (let i = 0; i < 4; i++) panel.handleInput(DOWN); // Learnings row
		panel.handleInput(RETURN); // its submenu
		panel.handleInput(RETURN); // Memory row: on -> off

		expect(loadProfile(profilePath(environment)).learningsOff).toBe(true);
		expect(config.learningsOff).toBe(true);

		panel.handleInput(RETURN); // off -> on
		expect(loadProfile(profilePath(environment)).learningsOff).toBe(false);
		expect(config.learningsOff).toBe(false);
	});

	test("an account the coach uses but the profile never saved (VOXREN_COACH_ACCOUNTS) still gets a Learnings row", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const environment = { PI_CODING_AGENT_DIR: join(dir, "agent") };
		const config: ProfileConfigTarget = { champion: "Fizz", accounts: ["Env#NA1"], labels: { accounts: ["Env#NA1"] }, learningsOff: false };
		const session = createConfigSession(environment, config, () => {});

		const fake = fakeCtx();
		await session.open("", fake.ctx);
		const panel = fake.customFactory({ requestRender: () => {} }, theme, {}, () => {});
		for (let i = 0; i < 4; i++) panel.handleInput(DOWN); // Learnings row
		panel.handleInput(RETURN); // its submenu
		expect(panel.render(80).join("\n")).toContain("Env#NA1");
	});
});

/** A PATH holding a `uv`, so the research service counts as one the coach starts itself (the only mode that hands it the Perplexity and Gemini keys). */
function pathWithUv(dir: string): string {
	const bin = join(dir, "uv-bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "uv"), "");
	return bin;
}

describe("/config command wiring", () => {
	function fakePi() {
		const commands = new Map<string, any>();
		const sent: string[] = [];
		return {
			commands,
			sent,
			pi: {
				registerTool: () => {},
				setActiveTools: () => {},
				registerProvider: () => {},
				sendUserMessage: (text: string) => sent.push(text),
				sendMessage: () => {},
				registerMessageRenderer: () => {},
				registerCommand: (name: string, options: any) => commands.set(name, options),
				on: () => {},
			},
		};
	}

	function fakeCtx(mode = "tui") {
		const calls: Record<string, unknown[][]> = {};
		const log = (name: string) => (...args: unknown[]) => {
			(calls[name] ??= []).push(args);
		};
		let customFactory: any;
		return {
			calls,
			get customFactory() {
				return customFactory;
			},
			ctx: {
				hasUI: true,
				mode,
				ui: {
					notify: log("notify"),
					setTheme: () => ({ success: true }),
					custom: async (factory: any) => {
						customFactory = factory;
						log("custom")();
						return undefined;
					},
				},
			},
		};
	}

	test("registers a zero-argument command that never creates an LLM turn", async () => {
		const fake = fakePi();
		installVoxrenCoach(fake.pi as any, {});
		const command = fake.commands.get(CONFIG_COMMAND);
		const withArgs = fakeCtx();
		await command.handler("hextech", withArgs.ctx);
		expect(withArgs.calls.notify).toEqual([[CONFIG_NO_ARGS_MESSAGE, "error"]]);
		expect(withArgs.calls.custom).toBeUndefined();
		const printMode = fakeCtx("print");
		await command.handler("", printMode.ctx);
		expect(printMode.calls.custom).toBeUndefined();
	});

	test("a champion save updates the live config in place and reaches the next composed prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const environment = { PI_CODING_AGENT_DIR: join(dir, "profile-only") };
		const fake = fakePi();
		installVoxrenCoach(fake.pi as any, environment, undefined, async () => undefined, async () => undefined, undefined, async () => undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => new Map([[1, "Ahri"], [2, "Jinx"]]));
		const command = fake.commands.get(CONFIG_COMMAND);
		const ctx = fakeCtx();
		await command.handler("", ctx.ctx);
		const panel = ctx.customFactory({ requestRender: () => {} }, theme, {}, () => {});
		panel.handleInput(DOWN); // champion row
		panel.handleInput(RIGHT); // loads the names, then steps to the first: Ahri
		await flush();

		const build = fake.commands.get("build");
		await build.handler("", { ui: { notify: () => {} } });
		expect(fake.sent.at(-1)).toContain("Build for Ahri");
	});

	test("a set VOXREN_COACH_CHAMPION is untouched by a champion save", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const environment = { PI_CODING_AGENT_DIR: join(dir, "env-override"), VOXREN_COACH_CHAMPION: "Jinx" };
		const fake = fakePi();
		installVoxrenCoach(fake.pi as any, environment, undefined, async () => undefined, async () => undefined, undefined, async () => undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => new Map([[1, "Ahri"], [2, "Jinx"]]));
		const command = fake.commands.get(CONFIG_COMMAND);
		const ctx = fakeCtx();
		await command.handler("", ctx.ctx);
		const panel = ctx.customFactory({ requestRender: () => {} }, theme, {}, () => {});
		panel.handleInput(DOWN);
		panel.handleInput(RIGHT);
		await flush();

		const build = fake.commands.get("build");
		await build.handler("", { ui: { notify: () => {} } });
		expect(fake.sent.at(-1)).toContain("Build for Jinx");
	});

	/** /config opened for one platform with a stored Gemini key, the Keys list open: uv on PATH, or a service the player runs, decides whether the key is used. */
	async function geminiKeys(environment: Record<string, string>, platform: NodeJS.Platform) {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		let statusReads = 0;
		const gemini = { status: async () => (statusReads++, { ok: true, state: { stored: true } }) } as unknown as RiotKeyCustodian;
		const config: ProfileConfigTarget = { champion: undefined, accounts: [], labels: { accounts: [] }, learningsOff: false };
		const session = createConfigSession({ PI_CODING_AGENT_DIR: join(dir, "gemini-keys"), ...environment }, config, () => {}, { gemini }, undefined, platform);
		const ctx = fakeCtx();
		await session.open("", ctx.ctx);
		const panel = ctx.customFactory({ requestRender: () => {} }, theme, {}, () => {});
		const top = panel.render(200).join("\n");
		for (let i = 0; i < 3; i++) panel.handleInput(DOWN);
		panel.handleInput(RETURN); // Keys
		return { top, keys: panel.render(200).join("\n"), statusReads, dir };
	}

	test("the Keys row has a Gemini entry backed by the Gemini custodian, labelled with its source, active where the coach starts the service and unused where it does not", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const source = { VOXREN_KEY_SOURCE_GEMINI: "dotenv+store" };
		// Riot, Perplexity, and Typesafe have no key store in these launches; Gemini's stored key is the only candidate.
		// The coach starts the service on Windows as on macOS, so the key is active on both.
		for (const platform of ["darwin", "win32"] as const) {
			const open = await geminiKeys({ ...source, PATH: pathWithUv(dir) }, platform);
			expect(open.statusReads).toBe(1);
			expect(open.top).toMatch(/Keys\s+1 of 4 active/);
			expect(open.keys).toMatch(/Gemini\s+\.env \(shadowing a stored key\)(?!, unused)/);
		}
		const noUv = await geminiKeys({ ...source, PATH: "/nonexistent" }, "win32");
		expect(noUv.top).toMatch(/Keys\s+0 of 4 active/);
		expect(noUv.keys).toMatch(/Gemini\s+\.env \(shadowing a stored key\), unused: install uv/);
	});

	test("a launch that points at a service you run marks the stored Gemini key unused, the one the coach starts leaves it active", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		const remote = { VOXREN_RESEARCH_URL: "http://127.0.0.1:9", VOXREN_RESEARCH_TOKEN: "t" };
		for (const platform of ["darwin", "win32"] as const) {
			expect((await geminiKeys(remote, platform)).keys).toMatch(/Gemini\s+stored, unused: a research service you run/);
			expect((await geminiKeys({ PATH: "/nonexistent" }, platform)).keys).toMatch(/Gemini\s+stored, unused: /);
			expect((await geminiKeys({ PATH: pathWithUv(dir) }, platform)).keys).toMatch(/Gemini\s+stored\s*$/m);
		}
	});

	test("a launch with a key-state dir backs every Keys row with a real custodian when none is passed in", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
		// A `security` that finds no item, so no real Keychain is read. On Windows the helper reads a file in the state dir instead.
		const security = join(dir, "security");
		writeFileSync(security, "#!/bin/sh\nexit 44\n");
		chmodSync(security, 0o755);
		const environment = { PI_CODING_AGENT_DIR: join(dir, "agent"), PATH: process.env.PATH, VOXREN_RIOT_KEY_STATE_DIR: join(dir, "state"), VOXREN_RIOT_SECURITY_BIN: security };
		const fake = fakePi();
		installVoxrenCoach(fake.pi as any, environment, undefined, async () => undefined, async () => undefined, undefined, async () => undefined);
		const ctx = fakeCtx();
		await fake.commands.get(CONFIG_COMMAND).handler("", ctx.ctx);
		for (const [row, label] of ["Riot", "Perplexity", "Typesafe", "Gemini"].entries()) {
			const panel = ctx.customFactory({ requestRender: () => {} }, theme, {}, () => {});
			for (let i = 0; i < 3; i++) panel.handleInput(DOWN);
			panel.handleInput(RETURN); // Keys
			for (let i = 0; i < row; i++) panel.handleInput(DOWN);
			panel.handleInput(RETURN); // this secret's own panel
			const text = panel.render(100).join("\n");
			// The key's own four actions, not the dead end a secret with no custodian opens.
			expect(text).toContain(`${label} `);
			expect(text).toContain("Live test");
			expect(text).toContain("Remove key");
			expect(text).not.toContain("key store is unavailable");
		}
	});
});

/** Minimal fakePi (mirrors coach.test.ts's own) for the two end-to-end sections below: captures registered tools too, so a tool can be invoked directly. */
function fakeInstallPi() {
	const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
	const tools: any[] = [];
	const commands = new Map<string, any>();
	return {
		handlers,
		tools,
		commands,
		pi: {
			registerTool: (tool: any) => tools.push(tool),
			setActiveTools: () => {},
			registerCommand: (name: string, options: any) => commands.set(name, options),
			registerMessageRenderer: () => {},
			sendUserMessage: () => {},
			on: (event: string, handler: (payload: any, ctx?: any) => any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		},
	};
}

function fakeConfigCtx(mode = "tui") {
	let customFactory: any;
	return {
		get customFactory() {
			return customFactory;
		},
		ctx: {
			hasUI: true,
			mode,
			ui: {
				notify: () => {},
				setTheme: () => ({ success: true }),
				custom: async (factory: any) => {
					customFactory = factory;
					return undefined;
				},
			},
		},
	};
}

describe("#32 acceptance", () => {
	describe("Stepping through theme options repaints the TUI live and keeps each one.", () => {
		test("Right previews live and saves at once, Left goes back; nothing waits for Enter", () => {
			const h = panelHarness({ riotIds: { known: [] } });
			h.panel.handleInput(RIGHT);
			expect(h.themeCalls).toEqual(["hextech"]);
			expect(h.saves[0].theme).toBe("hextech");
			h.panel.handleInput(LEFT);
			expect(h.themeCalls).toEqual(["hextech", "tidal"]);
			expect(h.saves[1].theme).toBe("tidal");
		});
	});

	describe("Every other setting takes effect in the current session without a restart.", () => {
		test("a champion save and a Riot ID save both update the live config object in place", () => {
			const config: ProfileConfigTarget = { champion: "Fizz", accounts: [], labels: { accounts: [] }, learningsOff: false };
			applyProfileChange(config, () => {}, {}, () => ({ champion: "Ahri", riotIds: { known: [] } }));
			expect(config.champion).toBe("Ahri");
			applyProfileChange(config, () => {}, {}, () => ({ champion: "Ahri", riotIds: { primary: "New#NA1", known: ["New#NA1"] } }));
			expect(config.accounts).toEqual(["New#NA1"]);
			expect(config.labels.accounts).toEqual(["New#NA1"]);
		});
	});

	describe("Choosing a theme in the panel survives a restart of `coach`.", () => {
		test("saveProfile persists the theme; a fresh loadProfile (a new launch) returns it (bin/coach.mjs's profileTheme reads the same file and feeds --use-theme, see bin/coach.test.mjs)", () => {
			const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
			const path = join(dir, "profile.json");
			saveProfile(path, sanitizeProfile({ theme: "void", riotIds: { known: [] } }));
			expect(loadProfile(path).theme).toBe("void");
		});
	});

	describe("Opening the client once while signed in, then closing it and restarting, still yields a system prompt containing that Riot ID.", () => {
		test("a remembered LCU sign-in, reloaded fresh with the client closed, still resolves as the player's account", () => {
			const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
			const environment = { PI_CODING_AGENT_DIR: join(dir, "agent") };
			const afterSignIn = applyLcuSignIn(loadProfile(profilePath(environment)), "Remembered#NA1")!;
			saveProfile(profilePath(environment), afterSignIn);

			// "Restart": a fresh resolveCoach call reading the persisted profile, no env accounts, client closed.
			const config = resolveCoach(environment, true, loadProfile(profilePath(environment)));
			expect(config.accounts).toContain("Remembered#NA1");
			expect(config.systemPrompt).toContain('Riot ID is "Remembered#NA1"');
		});
	});

	describe("Removing a Riot ID in the panel removes it from the next prompt.", () => {
		test("an id added then removed through /config is gone from before_agent_start's system prompt and from voxren_player_audit's default account", async () => {
			const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
			const environment = { PI_CODING_AGENT_DIR: join(dir, "agent") };
			const custodian = { fetch: async () => ({ status: 200, body: "{}" }), status: async () => ({ state: { stored: false } }) } as any;
			const fake = fakeInstallPi();
			installVoxrenCoach(fake.pi as any, environment, custodian, async () => undefined, async () => undefined);

			const command = fake.commands.get(CONFIG_COMMAND);
			const ctx = fakeConfigCtx();
			await command.handler("", ctx.ctx);
			const panel = ctx.customFactory({ requestRender: () => {} }, theme, {}, () => {});

			// Add "Removable#NA1" through the panel.
			panel.handleInput(DOWN);
			panel.handleInput(DOWN);
			panel.handleInput(RETURN); // Riot IDs row -> its list (empty: only "+ Add Riot ID")
			panel.handleInput(RETURN);
			for (const ch of "Removable#NA1") panel.handleInput(ch);
			panel.handleInput(RETURN);

			const withId = await fake.handlers.get("before_agent_start")![0]({ systemPromptOptions: {} });
			expect(withId.systemPrompt).toContain("Removable#NA1");
			const auditTool = fake.tools.find((tool: any) => tool.name === "voxren_player_audit");

			// Remove it again.
			panel.handleInput(LEFT); // the cursor sits on the id just added: arm it
			panel.handleInput(LEFT); // remove it

			const afterRemoval = await fake.handlers.get("before_agent_start")![0]({ systemPromptOptions: {} });
			expect(afterRemoval.systemPrompt).not.toContain("Removable#NA1");
			const defaulted = await auditTool.execute("call-2", {});
			expect(defaulted.content[0].text).not.toContain("Removable#NA1");
		});
	});

	describe('Riot IDs live as their own block in the one settings file, for example `{ "theme": "tidal", "riotIds": { "primary": "Name#TAG", "known": ["Name#TAG"] } }`. There is no separate file for them.', () => {
		test("theme and riotIds round-trip together at one path, with riotIds as its own nested object", () => {
			const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
			const path = join(dir, "profile.json");
			const profile: Profile = { theme: "tidal", riotIds: { primary: "Name#TAG", known: ["Name#TAG"] } };
			saveProfile(path, profile);
			const onDisk = JSON.parse(readFileSync(path, "utf8"));
			expect(onDisk).toEqual(profile);
			expect(onDisk.riotIds).toEqual({ primary: "Name#TAG", known: ["Name#TAG"] });
			expect(existsSync(join(dir, "riot-ids.json"))).toBe(false);
		});
	});

	describe("Profile file is plain JSON under the existing coach state directory, holds no secrets, and a corrupt or missing file falls back to defaults without crashing.", () => {
		test("profilePath sits beside the coach home; a missing or corrupt file loads the same default as no file at all", () => {
			const dir = mkdtempSync(join(tmpdir(), "voxren-config-"));
			const environment = { PI_CODING_AGENT_DIR: join(dir, "agent") };
			expect(profilePath(environment)).toContain(dir);
			expect(() => loadProfile(profilePath(environment))).not.toThrow();
			expect(loadProfile(profilePath(environment))).toEqual(sanitizeProfile(undefined));

			writeFileSync(profilePath(environment)!.replace(/[^/\\]+$/, "corrupt-marker.json"), "unused"); // the directory exists but profile.json itself does not
			expect(() => loadProfile(profilePath(environment))).not.toThrow();
		});
	});

	describe("Unit tests through the fake Pi and fake LCU transport, matching `riot-key.test.ts`.", () => {
		test("this file drives ConfigPanel with bare keystroke strings and a fakeCtx/fakePi, the same fixture shape riot-key.test.ts uses for RiotKeyPanel, with no real terminal or LCU socket", () => {
			const h = panelHarness({ riotIds: { known: [] } });
			expect(() => h.panel.handleInput(DOWN)).not.toThrow();
			h.panel.handleInput(ESCAPE);
			expect(h.closed).toBe(true); // no TUI, no network: closed purely by simulated key input
		});
	});
});
