import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL = fileURLToPath(new URL("./install.mjs", import.meta.url));

/** @param {string} cwd @param {string[]} args */
const git = (cwd, ...args) => {
	const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

/**
 * A fake upstream repo (a voxren-pi package whose bin/setup.mjs records the directory it ran in) and a work folder.
 * `work` is the folder the bootstrap runs in: `name` lets a test give it a space or an `&`.
 * @param {string} [name]
 */
function fixture(name = "work") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "voxren-install-")));
	const upstream = join(root, "upstream");
	const work = join(root, name);
	const calls = join(root, "calls");
	mkdirSync(join(upstream, "bin"), { recursive: true });
	mkdirSync(work);
	writeFileSync(join(upstream, "package.json"), JSON.stringify({ name: "voxren-pi" }));
	writeFileSync(join(upstream, "bin", "setup.mjs"), `import { appendFileSync, existsSync } from "node:fs"; appendFileSync(${JSON.stringify(calls)}, process.cwd() + " " + existsSync("marker") + "\\n");\n`);
	git(root, "init", "-q", "-b", "main", upstream);
	git(upstream, "add", "-A");
	git(upstream, "commit", "-qm", "base");
	const env = { ...process.env, VOXREN_REPO: upstream };
	// The bootstrap is piped into node, as `curl | node` does.
	const install = () => spawnSync("node", [], { cwd: work, env, input: readFileSync(INSTALL), encoding: "utf8" });
	return { root, upstream, work, calls, install, clone: join(work, "voxren-pi") };
}

describe("install.mjs", () => {
	test.each([["a path with a space", "vp test"], ["a path with &", "vp&calc"]])("clones into %s and runs setup inside the clone", (_label, name) => {
		const f = fixture(name);
		try {
			const result = f.install();
			expect(result.stderr).not.toContain("git clone failed");
			expect(result.status).toBe(0);
			expect(readFileSync(f.calls, "utf8").trim()).toBe(`${f.clone} false`);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	test("a failed clone says why, in git's words", () => {
		const f = fixture();
		try {
			rmSync(f.upstream, { recursive: true, force: true });
			const result = f.install();
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("git clone failed");
			expect(result.stderr).toContain("fatal:");
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	// Windows CI timeout: measured max 0.55 s on an idle Windows machine (10 runs), one 5 s stall seen on windows-latest; 15 s is ~27x the max.
	test("an existing clone is fast-forwarded to the new main, then setup runs inside it", () => {
		const f = fixture();
		try {
			expect(f.install().status).toBe(0);
			writeFileSync(join(f.upstream, "marker"), "");
			git(f.upstream, "add", "marker");
			git(f.upstream, "commit", "-qm", "next");
			const again = f.install();
			expect(again.status).toBe(0);
			expect(readFileSync(f.calls, "utf8").trim().split("\n")).toEqual([`${f.clone} false`, `${f.clone} true`]);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}, 15_000);

	// Windows CI timeout: measured max 0.55 s on an idle Windows machine (10 runs), one 5 s stall seen on windows-latest; 15 s is ~27x the max.
	test("an existing clone that cannot be fast-forwarded is refused, with setup not run", () => {
		const f = fixture();
		try {
			expect(f.install().status).toBe(0);
			git(f.clone, "commit", "--allow-empty", "-qm", "local work");
			writeFileSync(join(f.upstream, "marker"), "");
			git(f.upstream, "add", "marker");
			git(f.upstream, "commit", "-qm", "next");
			const again = f.install();
			expect(again.status).not.toBe(0);
			expect(again.stderr).toContain("could not be updated");
			expect(readFileSync(f.calls, "utf8").trim().split("\n")).toHaveLength(1);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}, 15_000);

	test("a folder that is not a voxren-pi clone is refused, naming the folder and the choices", () => {
		const f = fixture();
		try {
			// An unrelated project that happens to have a setup script, and a clone of some other repo.
			mkdirSync(f.clone);
			writeFileSync(join(f.clone, "package.json"), JSON.stringify({ name: "other", scripts: { setup: "echo hi" } }));
			const result = f.install();
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(f.clone);
			expect(result.stderr).toContain("not a voxren-pi clone");
			expect(result.stderr).toContain("another folder");
			expect(() => readFileSync(f.calls)).toThrow();

			rmSync(f.clone, { recursive: true, force: true });
			git(f.root, "clone", "-q", f.upstream, f.clone);
			git(f.clone, "remote", "set-url", "origin", "https://example.com/other/thing.git");
			const other = f.install();
			expect(other.status).not.toBe(0);
			expect(other.stderr).toContain("not a voxren-pi clone");
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});
});
