import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseEnvFile } from "../../bin/coach.mjs";
import { coachEnvArgs, resetHome, type Pane } from "./grid.ts";
import type { Story } from "./stories.ts";

const pane = (home: string): Pane => ({ id: 1, index: 0, home, dir: join(home, "..", "dir"), idle: join(home, "..", "idle"), tty: "" });
const story: Story = { id: "t", title: "t", steps: [{ send: "/matchup Ahri" }], gates: {} };

describe("coachEnvArgs", () => {
	test("a noJevKey story unsets the key first and still sets the home", () => {
		const p = pane("/h/home");
		const args = coachEnvArgs(p, { ...story, noJevKey: true }, undefined);
		expect(args.slice(0, 2)).toEqual(["-u", "TYPESAFE_API_KEY"]);
		expect(args).toContain("VOXREN_COACH_HOME=/h/home");
	});
	test("a story without it unsets nothing and keeps the old list", () => {
		const p = pane("/h/home");
		expect(coachEnvArgs(p, { ...story, env: { A: "1" } }, "replay.json")).toEqual(["VOXREN_COACH_TERMINAL=here", "VOXREN_COACH_HOME=/h/home", `VOXREN_COACH_IDLE_FILE=${p.idle}`, "VOXREN_LCU_REPLAY=replay.json", "A=1"]);
	});
});

describe("resetHome", () => {
	test("a noJevKey story's fresh home has no key line; a bare reset keeps it", () => {
		const real = mkdtempSync(join(tmpdir(), "voxren-real-"));
		mkdirSync(join(real, "pi-agent"));
		writeFileSync(join(real, ".env"), "TYPESAFE_API_KEY=t1\nOTHER=1\n");
		const previous = process.env.VOXREN_COACH_HOME;
		process.env.VOXREN_COACH_HOME = real;
		try {
			const home = join(mkdtempSync(join(tmpdir(), "voxren-lab-")), "home");
			resetHome(pane(home), { ...story, noJevKey: true });
			expect(parseEnvFile(readFileSync(join(home, ".env"), "utf8"))).toEqual({ OTHER: "1" });
			resetHome(pane(home));
			expect(parseEnvFile(readFileSync(join(home, ".env"), "utf8")).TYPESAFE_API_KEY).toBe("t1");
		} finally {
			if (previous === undefined) delete process.env.VOXREN_COACH_HOME;
			else process.env.VOXREN_COACH_HOME = previous;
		}
	});
});
