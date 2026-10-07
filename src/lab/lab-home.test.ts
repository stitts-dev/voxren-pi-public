import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { autoOn, parseAutoComp } from "../contracts";
import { loadProfile } from "../config";
import { parseEnvFile } from "../../bin/coach.mjs";
import { labHome, labRunId } from "./lab-home";

describe("labHome", () => {
	test("saves the automatic calls off, whatever the real profile says; an explicit VOXREN_COACH_AUTO_COMP=1 still forces them on", () => {
		const real = mkdtempSync(join(tmpdir(), "voxren-real-"));
		mkdirSync(join(real, "pi-agent"));
		writeFileSync(join(real, "profile.json"), JSON.stringify({ theme: "void", commands: { draft: { auto: true, args: "x" }, review: { args: "15" } } }));
		const previous = process.env.VOXREN_COACH_HOME;
		process.env.VOXREN_COACH_HOME = real;
		try {
			const home = labHome(join(mkdtempSync(join(tmpdir(), "voxren-lab-")), "home"));
			const saved = loadProfile(join(home, "profile.json"));
			expect(saved.commands?.draft?.auto).toBe(false);
			expect(saved.commands?.review).toEqual({ args: "15", auto: false });
			expect(saved.commands?.comp?.auto).toBe(false);
			expect(autoOn(parseAutoComp("1"), saved.commands?.comp)).toBe(true);
			expect(autoOn(parseAutoComp(undefined), saved.commands?.draft)).toBe(false); // the default in a lab
			expect(autoOn(parseAutoComp("1"), saved.commands?.draft)).toBe(true); // auto requested
			expect(JSON.parse(readFileSync(join(real, "profile.json"), "utf8")).commands.draft.auto).toBe(true); // the real profile is untouched
		} finally {
			if (previous === undefined) delete process.env.VOXREN_COACH_HOME;
			else process.env.VOXREN_COACH_HOME = previous;
		}
	});

	test("freshFlow (resetHome) drops saved /flow rows but keeps the auto calls off, and 1 still forces them on", () => {
		const real = mkdtempSync(join(tmpdir(), "voxren-real-"));
		mkdirSync(join(real, "pi-agent"));
		writeFileSync(join(real, "profile.json"), JSON.stringify({ commands: { draft: { auto: true }, review: { args: "15" } } }));
		const previous = process.env.VOXREN_COACH_HOME;
		process.env.VOXREN_COACH_HOME = real;
		try {
			const home = labHome(join(mkdtempSync(join(tmpdir(), "voxren-lab-")), "home"), true);
			const saved = loadProfile(join(home, "profile.json"));
			expect(saved.commands?.review).toEqual({ auto: false });
			expect(saved.commands?.comp?.auto).toBe(false);
			expect(autoOn(parseAutoComp("1"), saved.commands?.comp)).toBe(true);
			expect(autoOn(parseAutoComp(undefined), saved.commands?.draft)).toBe(false);
			expect(autoOn(parseAutoComp("1"), saved.commands?.draft)).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.VOXREN_COACH_HOME;
			else process.env.VOXREN_COACH_HOME = previous;
		}
	});

	test("a real home with no profile still gets one", () => {
		const real = mkdtempSync(join(tmpdir(), "voxren-real-"));
		mkdirSync(join(real, "pi-agent"));
		const previous = process.env.VOXREN_COACH_HOME;
		process.env.VOXREN_COACH_HOME = real;
		try {
			const home = labHome(join(mkdtempSync(join(tmpdir(), "voxren-lab-")), "home"));
			expect(loadProfile(join(home, "profile.json")).commands?.draft?.auto).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.VOXREN_COACH_HOME;
			else process.env.VOXREN_COACH_HOME = previous;
		}
	});

	test("a repeat call on the same dir reuses it instead of throwing EEXIST", () => {
		const real = mkdtempSync(join(tmpdir(), "voxren-real-"));
		mkdirSync(join(real, "pi-agent"));
		const previous = process.env.VOXREN_COACH_HOME;
		process.env.VOXREN_COACH_HOME = real;
		try {
			const dir = join(mkdtempSync(join(tmpdir(), "voxren-lab-")), "home");
			expect(labHome(dir)).toBe(labHome(dir));
		} finally {
			if (previous === undefined) delete process.env.VOXREN_COACH_HOME;
			else process.env.VOXREN_COACH_HOME = previous;
		}
	});

	test("two cases that share scenario and label (a live dump with one frame, asked at several minutes) get two homes", () => {
		const real = mkdtempSync(join(tmpdir(), "voxren-real-"));
		mkdirSync(join(real, "pi-agent"));
		const previous = process.env.VOXREN_COACH_HOME;
		process.env.VOXREN_COACH_HOME = real;
		try {
			const out = mkdtempSync(join(tmpdir(), "voxren-lab-"));
			const a = labHome(join(out, "homes", labRunId(0, "s5", "0m", "", 0)));
			const b = labHome(join(out, "homes", labRunId(1, "s5", "0m", "", 0)));
			expect(a).not.toBe(b);
		} finally {
			if (previous === undefined) delete process.env.VOXREN_COACH_HOME;
			else process.env.VOXREN_COACH_HOME = previous;
		}
	});
});

describe("labHome without the Jev key", () => {
	const realHome = (env: string | undefined) => {
		const real = mkdtempSync(join(tmpdir(), "voxren-real-"));
		mkdirSync(join(real, "pi-agent"));
		if (env !== undefined) writeFileSync(join(real, ".env"), env);
		for (const file of ["typesafe-key.dpapi", "typesafe-key-state.json", "perplexity-key.dpapi"]) writeFileSync(join(real, file), "x");
		return real;
	};
	const inHome = <T>(real: string, run: () => T): T => {
		const previous = process.env.VOXREN_COACH_HOME;
		process.env.VOXREN_COACH_HOME = real;
		try {
			return run();
		} finally {
			if (previous === undefined) delete process.env.VOXREN_COACH_HOME;
			else process.env.VOXREN_COACH_HOME = previous;
		}
	};
	const labDir = () => join(mkdtempSync(join(tmpdir(), "voxren-lab-")), "home");

	test("drops the key lines from .env and the typesafe store files, leaves the rest, and leaves the real home alone", () => {
		const real = realHome("ANTHROPIC_API_KEY=a\nTYPESAFE_API_KEY=t1\nexport TYPESAFE_API_KEY=t2\nOTHER=1\n");
		const home = inHome(real, () => labHome(labDir(), false, true));
		expect(parseEnvFile(readFileSync(join(home, ".env"), "utf8"))).toEqual({ ANTHROPIC_API_KEY: "a", OTHER: "1" });
		expect(existsSync(join(home, "typesafe-key.dpapi"))).toBe(false);
		expect(existsSync(join(home, "typesafe-key-state.json"))).toBe(false);
		expect(existsSync(join(home, "perplexity-key.dpapi"))).toBe(true);
		expect(readFileSync(join(real, ".env"), "utf8")).toContain("TYPESAFE_API_KEY=t1");
		expect(existsSync(join(real, "typesafe-key.dpapi"))).toBe(true);
		expect(existsSync(join(real, "typesafe-key-state.json"))).toBe(true);
	});

	test("without the flag the key stays", () => {
		const home = inHome(realHome("TYPESAFE_API_KEY=t1\n"), () => labHome(labDir()));
		expect(parseEnvFile(readFileSync(join(home, ".env"), "utf8")).TYPESAFE_API_KEY).toBe("t1");
		expect(existsSync(join(home, "typesafe-key.dpapi"))).toBe(true);
	});

	test("a real home with no .env does not throw", () => {
		expect(() => inHome(realHome(undefined), () => labHome(labDir(), false, true))).not.toThrow();
	});
});
