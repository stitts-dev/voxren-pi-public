import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLaunchSecrets, LAUNCH_SECRETS_VAR, stashSecrets } from "./launch-secrets.mjs";

describe("launch secrets", () => {
	test("keys leave the child's environment, reach the extension through a 0600 file, and the file is deleted when read", () => {
		const dir = mkdtempSync(join(tmpdir(), "launch-secrets-"));
		const stash = stashSecrets({ PATH: "/bin", PERPLEXITY_API_KEY: "p", VOXREN_GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o", VOXREN_COACH_MODEL: "m" }, dir);
		expect(stash.env).toEqual({ PATH: "/bin", VOXREN_COACH_MODEL: "m", [LAUNCH_SECRETS_VAR]: stash.env[LAUNCH_SECRETS_VAR] as string });
		const path = stash.env[LAUNCH_SECRETS_VAR] as string;
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		const environment: Record<string, string | undefined> = { ...stash.env };
		expect(adoptLaunchSecrets(environment)).toBeUndefined();
		expect(environment).toEqual({ PATH: "/bin", VOXREN_COACH_MODEL: "m", PERPLEXITY_API_KEY: "p", VOXREN_GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o" });
		expect(existsSync(path)).toBe(false);
	});

	test("no keys, no file; an unreadable file is reported and leaves the environment alone", () => {
		const dir = mkdtempSync(join(tmpdir(), "launch-secrets-"));
		const none = stashSecrets({ PATH: "/bin" }, dir);
		expect(none.env).toEqual({ PATH: "/bin" });
		const environment: Record<string, string | undefined> = { [LAUNCH_SECRETS_VAR]: join(dir, "missing.json") };
		expect(adoptLaunchSecrets(environment)).toBeDefined();
		expect(environment).toEqual({});
	});

	// Modes and owners are not the same kind of fact on Windows, where the sweep does not run.
	test.skipIf(process.platform === "win32")("a launch sweeps old handoff files a killed launch left, only in its own private directory, and keeps young ones and other files (#372)", () => {
		const dir = mkdtempSync(join(tmpdir(), "launch-secrets-"));
		chmodSync(dir, 0o700);
		const old = join(dir, "launch-secrets-old.json");
		const young = join(dir, "launch-secrets-young.json");
		const other = join(dir, "profile.json");
		for (const file of [old, young, other]) writeFileSync(file, "{}", { mode: 0o600 });
		const longAgo = new Date(Date.now() - 3600_000);
		utimesSync(old, longAgo, longAgo);
		utimesSync(other, longAgo, longAgo);
		const stash = stashSecrets({ OPENAI_API_KEY: "sk-FAKE" }, dir);
		expect([existsSync(old), existsSync(young), existsSync(other), existsSync(stash.env[LAUNCH_SECRETS_VAR] as string)]).toEqual([false, true, true, true]);
		// A directory other users can enter is not the coach's own: nothing in it is touched.
		const open = mkdtempSync(join(tmpdir(), "launch-secrets-"));
		chmodSync(open, 0o755);
		const theirs = join(open, "launch-secrets-old.json");
		writeFileSync(theirs, "{}", { mode: 0o600 });
		utimesSync(theirs, longAgo, longAgo);
		stashSecrets({ OPENAI_API_KEY: "sk-FAKE" }, open);
		expect(existsSync(theirs)).toBe(true);
		// A directory named like a handoff file is not a file to delete.
		const folder = join(dir, "launch-secrets-dir.json");
		mkdirSync(folder);
		utimesSync(folder, longAgo, longAgo);
		stashSecrets({ OPENAI_API_KEY: "sk-FAKE" }, dir);
		expect(existsSync(folder)).toBe(true);
	});
});
