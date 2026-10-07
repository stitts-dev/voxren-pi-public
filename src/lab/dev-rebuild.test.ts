import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(import.meta.dir, "dev-rebuild.sh").replaceAll("\\", "/");
/** On Windows, Bun.which("bash") can be WSL's System32 launcher, which cannot run a C:/ script: use Git for Windows' bash, found next to git.exe. */
function findBash() {
	if (process.platform !== "win32") return Bun.which("bash");
	const git = Bun.which("git");
	const gitBash = git && [join(dirname(git), "..", "bin", "bash.exe"), join(dirname(git), "bash.exe")].find(existsSync);
	return gitBash ?? null;
}
const bash = findBash();

function git(cwd: string, ...args: string[]) {
	const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

/**
 * A primary checkout with an origin that has main and three pull request branches: fix/a merges cleanly, fix/b
 * conflicts with a later commit on main, fix/c conflicts with fix/a only (both add b.txt). `gh` is a stub on PATH that
 * prints what the test says the open pull requests are.
 */
function repo() {
	const dir = mkdtempSync(join(tmpdir(), "voxren-dev-rebuild-"));
	const origin = join(dir, "origin.git");
	git(dir, "init", "-q", "--bare", "-b", "main", origin);
	const root = join(dir, "repo");
	git(dir, "clone", "-q", origin, root);
	writeFileSync(join(root, "a.txt"), "one\n");
	git(root, "add", "a.txt");
	git(root, "commit", "-q", "-m", "main");
	git(root, "checkout", "-q", "-b", "fix/a");
	writeFileSync(join(root, "b.txt"), "a\n");
	git(root, "add", "b.txt");
	git(root, "commit", "-q", "-m", "a");
	git(root, "checkout", "-q", "-b", "fix/b", "main");
	writeFileSync(join(root, "a.txt"), "b\n");
	git(root, "commit", "-q", "-am", "b");
	git(root, "checkout", "-q", "-b", "fix/c", "main");
	writeFileSync(join(root, "b.txt"), "c\n");
	git(root, "add", "b.txt");
	git(root, "commit", "-q", "-m", "c");
	git(root, "checkout", "-q", "main");
	writeFileSync(join(root, "a.txt"), "main moved\n");
	git(root, "commit", "-q", "-am", "main moved");
	git(root, "push", "-q", "origin", "main", "fix/a", "fix/b", "fix/c");
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), '#!/usr/bin/env bash\nprintf \'%s\' "$GH_PRS"\n', { mode: 0o755 });
	const prs = ["fix/a", "fix/b", "fix/c"].map((branch, i) => ({ number: i + 1, headRefName: branch, headRefOid: git(root, "rev-parse", `origin/${branch}`), isDraft: i === 2 }));
	return { dir, root, bin, prs };
}

function run(r: ReturnType<typeof repo>, env: Record<string, string> = {}, ...args: string[]) {
	const p = Bun.spawnSync([bash as string, script, ...args], { cwd: r.root, env: { ...process.env, PATH: `${r.bin}:${process.env.PATH}`, GH_PRS: JSON.stringify(r.prs), ...env }, timeout: 20_000 });
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

test.skipIf(!bash)("dev is main plus every pull request that merges, conflicts named by what they conflict with, and a second run is no change", () => {
	const r = repo();
	const first = run(r);
	expect(first.code, first.err).toBe(0);
	expect(first.out).toContain("in dev: #1 fix/a (open)");
	expect(first.out).toContain("LEFT OUT #2 fix/b (conflicts with main): a.txt");
	expect(first.out).toContain("LEFT OUT #3 fix/c (conflicts with another pull request in dev): b.txt");
	expect(first.out).toMatch(/^dev rebuilt: [0-9a-f]+, /m);
	const dev = join(r.root, ".claude", "worktrees", "dev");
	expect(git(dev, "show", "HEAD:b.txt")).toBe("a");
	expect(git(dev, "show", "HEAD:a.txt")).toBe("main moved");
	// An upstream an editor set is removed by the rebuild, so a sync there can never push dev to main.
	git(dev, "checkout", "-q", "-B", "dev");
	git(dev, "branch", "--set-upstream-to=origin/main");
	const second = run(r);
	expect(Bun.spawnSync(["git", "-C", dev, "config", "--get", "branch.dev.merge"]).exitCode).not.toBe(0);
	expect(second.code, second.err).toBe(0);
	expect(second.out.trim()).toMatch(/^dev: no change \([0-9a-f]+\)$/);
	rmSync(r.dir, { recursive: true, force: true });
}, 30_000);

test.skipIf(!bash)("DEV_SKIP leaves a pull request out, --worktree names another worktree, and a skipped head returns once it moves", () => {
	const r = repo();
	const skipped = run(r, { DEV_SKIP: `1 3@${r.prs[2]?.headRefOid}` }, "--worktree", "qa");
	expect(skipped.code, skipped.err).toBe(0);
	expect(skipped.out).toContain("skipped #1 fix/a (DEV_SKIP)");
	expect(skipped.out).toContain("skipped #3 fix/c (DEV_SKIP)");
	// Nothing merged, so the new worktree still holds origin/main: no suite is owed.
	expect(skipped.out).toMatch(/^qa: same content as before \([0-9a-f]+\); no new suite run needed$/m);
	expect(existsSync(join(r.root, ".claude", "worktrees", "qa", "a.txt"))).toBe(true);
	// The sha in fix/c's entry is no longer its head, so the entry no longer matches and it is tried again.
	const moved = run(r, { DEV_SKIP: `1 3@${"0".repeat(40)}` }, "--worktree", "qa");
	expect(moved.code, moved.err).toBe(0);
	expect(moved.out).toContain("in qa: #3 fix/c (draft)");
	expect(moved.out).toMatch(/^qa rebuilt: /m);
	rmSync(r.dir, { recursive: true, force: true });
}, 30_000);

test.skipIf(!bash)("dev-rebuild.sh has LF line endings, which bash needs", () => {
	expect(Bun.file(script).text()).resolves.not.toContain("\r");
});
