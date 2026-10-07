import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
// A copied mirror (`just devbox`) has no history, so the guard cannot tell a tracked folder from an ignored one there.
const inGit = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: repo }).status === 0;

describe("label-kit sheet", () => {
	test.skipIf(!inGit)("refuses a folder inside the repository that git tracks, before anything is written", () => {
		const scratch = mkdtempSync(join(tmpdir(), "label-kit-"));
		const out = join(repo, "data", "eval", "sheet-guard-test");
		try {
			const answers = join(scratch, "answers.json");
			writeFileSync(answers, JSON.stringify({ made_up: "Made-up answer text: step in at level 3." }));
			const ran = spawnSync(process.execPath, ["src/lab/label-kit.ts", "sheet", "--answers", answers, "--out", out], { cwd: repo, encoding: "utf8" });
			expect(ran.status).toBe(1);
			expect(ran.stderr).toContain("inside the repository and not git-ignored");
			expect(existsSync(out)).toBe(false);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
			rmSync(out, { recursive: true, force: true });
		}
	});
});
