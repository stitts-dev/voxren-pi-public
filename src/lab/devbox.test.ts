import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const script = join(import.meta.dir, "devbox.sh").replaceAll("\\", "/");
/** On Windows, Bun.which("bash") can be WSL's System32 launcher, which cannot run a C:/ script: use Git for Windows' bash, found next to git.exe. */
function findBash() {
	if (process.platform !== "win32") return Bun.which("bash");
	const git = Bun.which("git");
	const gitBash = git && [join(dirname(git), "..", "bin", "bash.exe"), join(dirname(git), "bash.exe")].find(existsSync);
	return gitBash ?? null;
}
const bash = findBash();

/**
 * Runs with_timeout from devbox.sh through its POSIX-sh fallback, even where GNU timeout exists. `seconds` is measured
 * inside the shell around with_timeout alone: on a loaded Windows runner starting bash itself can stall for seconds
 * (an `echo hi` took 5 s), and that is not the kill this test is about. The 20 s ceiling only stops a real hang.
 */
function run(secs: number, cmd: string, prelude = "") {
	const p = Bun.spawnSync([bash as string, "-c", `${prelude}. "$S"; SECONDS=0; rc=0; with_timeout ${secs} ${cmd} || rc=$?; echo "ELAPSED=$SECONDS" >&2; exit $rc`], { env: { ...process.env, S: script, VOXREN_DEVBOX_FUNCTIONS_ONLY: "1", VOXREN_DEVBOX_PORTABLE_TIMEOUT: "1" }, timeout: 20_000 });
	const err = p.stderr.toString();
	return { code: p.exitCode, out: p.stdout.toString(), err, seconds: Number(/ELAPSED=(\d+)/.exec(err)?.[1] ?? Infinity) };
}

test.skipIf(!bash)("fallback timeout kills a hung command at the limit", () => {
	const r = run(1, "sleep 30");
	expect(r.code).not.toBe(0);
	expect(r.seconds, r.err).toBeLessThan(5);
}, 25_000);

test.skipIf(!bash)("fallback passes output and exit status, and ends at once when the command does", () => {
	const r = run(30, "echo hi");
	expect(r.out.trim(), r.err).toBe("hi");
	expect(r.code).toBe(0);
	expect(r.seconds).toBeLessThan(5);
	expect(run(30, "false").code).not.toBe(0);
}, 25_000);

test.skipIf(!bash)("fallback passes output and exit status with stdin closed, as under a non-interactive ssh", () => {
	const r = run(30, "echo hi", "exec <&-; ");
	expect(r.out.trim(), r.err).toBe("hi");
	expect(r.code).toBe(0);
}, 25_000);

test.skipIf(!bash)("devbox.sh has LF line endings, which bash needs", () => {
	expect(Bun.file(script).text()).resolves.not.toContain("\r");
});
