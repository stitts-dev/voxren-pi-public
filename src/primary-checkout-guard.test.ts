import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A primary checkout (its .git is a directory) with a worktree beneath it (its .git is a file), each holding the guard
// the way a real checkout does, so the guard is run from where a session would load it.
const root = mkdtempSync(join(tmpdir(), "seat-guard-"));
const primary = join(root, "primary");
const worktree = join(primary, ".claude", "worktrees", "task");
for (const checkout of [primary, worktree]) {
	mkdirSync(join(checkout, ".claude", "guards"), { recursive: true });
	mkdirSync(join(checkout, "src"), { recursive: true });
	copyFileSync(join(import.meta.dir, "..", ".claude", "guards", "primary-checkout.mjs"), join(checkout, ".claude", "guards", "primary-checkout.mjs"));
}
mkdirSync(join(primary, ".git"));
writeFileSync(join(worktree, ".git"), "gitdir: ../../../.git/worktrees/task\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** What the guard answers a session started in `checkout` that edits `file`: the reason it refuses with, or "" when the edit goes through. */
const guard = (checkout: string, file: string, env: Record<string, string> = {}) => {
	const ran = spawnSync("node", [join(checkout, ".claude", "guards", "primary-checkout.mjs")], {
		input: JSON.stringify({ tool_input: { file_path: file } }),
		env: { ...process.env, VOXREN_SEAT_EDIT: "", ...env },
		encoding: "utf8",
	});
	expect(ran.status).toBe(0);

	return ran.stdout ? String(JSON.parse(ran.stdout).hookSpecificOutput.permissionDecisionReason) : "";
};

test("an edit of a file in the primary checkout is refused, and the refusal says how to start a worktree", () => {
	const reason = guard(primary, join(primary, "src", "ui.ts"));
	expect(reason).toContain("primary checkout");
	expect(reason).toContain("git worktree add .claude/worktrees/<task>");
	expect(guard(primary, join(primary, "AGENTS.md"))).toContain("primary checkout");
});

test("an edit inside a worktree goes through, from a session started in the worktree or in the primary checkout", () => {
	expect(guard(worktree, join(worktree, "src", "ui.ts"))).toBe("");
	expect(guard(primary, join(worktree, "src", "ui.ts"))).toBe("");
});

test("a file outside the checkout goes through, and so does an edit the player asked for with VOXREN_SEAT_EDIT=1", () => {
	expect(guard(primary, join(root, "scratch", "notes.md"))).toBe("");
	expect(guard(primary, join(primary, "src", "ui.ts"), { VOXREN_SEAT_EDIT: "1" })).toBe("");
});
