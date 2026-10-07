import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");

/** What the guard answers a Bash call that runs `command`: the reason it refuses with, or "" when the call goes through. */
const guard = (command: string) => {
	const ran = spawnSync("node", [join(repo, ".claude", "guards", "suite-pipe.mjs")], {
		input: JSON.stringify({ tool_input: { command } }),
		encoding: "utf8",
	});
	expect(ran.status).toBe(0);

	return ran.stdout ? String(JSON.parse(ran.stdout).hookSpecificOutput.permissionDecisionReason) : "";
};

// A pipeline exits with its last command's status, so a suite run that ends in head or tail reads as exit 0.
const refused = [
	"bun test | head",
	"bun test | tail",
	"bun test 2>&1 | tail -5",
	"bun test 2>&1 | tail -n 30",
	"bun test src/ui.test.ts | head -n 20",
	"bun test 2>&1 | grep -v pass | tail -5",
	"bun test 2>&1 | grep -v pass | sed 's/x/y/' | head -40",
	"bun test |& tail -5",
	"just devbox | tail -20",
	"just devbox 2>&1 | tail",
	"just devbox bun test src/ui.test.ts 2>&1 | head -30",
	"VOXREN_DEVBOX=user@host just devbox 2>&1 | tail -5",
	"bash src/lab/devbox.sh | tail -5",
	"bash src/lab/devbox.sh bun test src/ui.test.ts 2>&1 | grep -E 'pass|fail' | tail -3",
	"./src/lab/devbox.sh --no-sync bun test | tail",
	"npm test | tail -5",
	"npm test 2>&1 | grep -v ok | head",
	"cd /work/tree && bun test 2>&1 | tail -5",
	"npx tsc --noEmit && bun test 2>&1 | tail",
	"bun test 2>&1 | tail -5; echo done",
	"set -e; bun test 2>&1 | tail -5",
	"cd /work/tree\nbun test 2>&1 | tail -5",
	"bun test 2>&1 \\\n  | tail -5",
	"bun test 2>&1 |\n  tail -5",
	"git log | head && bun test | tail",
	'bun test | tail; git commit -m "set -o pipefail"',
	"bun test | tail # PIPESTATUS",
	"bun test | tail # set -o pipefail",
	"bun test | /usr/bin/tail -5",
	"bun test | env tail -5",
	"bun test | sudo tail -5",
	"bun test | (tail -5)",
	"bun test | { head; }",
];

const allowed = [
	"bun test",
	"bun test src/ui.test.ts",
	"npm test",
	"just devbox",
	"bash src/lab/devbox.sh bun test src/ui.test.ts",
	"bun test > /tmp/suite.log 2>&1",
	"just devbox > /tmp/devbox.log 2>&1",
	"bun test 2>&1 | tee /tmp/suite.log",
	"bun test > /tmp/suite.log 2>&1; tail -5 /tmp/suite.log",
	"bun test 2>&1 | tee /tmp/suite.log; tail -5 /tmp/suite.log",
	"set -o pipefail; bun test 2>&1 | tail -5",
	"set -euo pipefail; bun test 2>&1 | grep -v pass | tail -5",
	"bash -o pipefail src/lab/devbox.sh 2>&1 | tail -5",
	"bun test 2>&1 | tail -5; echo \"${PIPESTATUS[0]}\"",
	"bun test 2>&1 | head -50; echo $pipestatus",
	"git log | head",
	"git log --oneline | head -20",
	"cat package.json | tail -5",
	"bun test && git log | head",
	"bun test; git log | head -5",
	"bun test\ngit log | head -5",
	"bun run src/lab/stories.ts | tail -5",
	"grep -rn \"bun test\" docs | head",
	"echo 'just devbox' | tail -1",
	'git commit -m "explain why bun test 2>&1 | tail -5 hides failures"',
	"gh pr create --body \"$(cat <<'EOF'\nDon't run `bun test 2>&1 | tail -5`.\nEOF\n)\"",
	"cat > notes.md <<'EOF'\nDon't run bun test 2>&1 | tail -5\nEOF",
	"bun test # then tail | head later",
	"cat <<'EOF' | head -3\nbun test | tail\nEOF",
];

for (const command of refused) {
	test(`refuses ${JSON.stringify(command)}`, () => {
		expect(guard(command)).toContain("pipefail");
	});
}

for (const command of allowed) {
	test(`allows ${JSON.stringify(command)}`, () => {
		expect(guard(command)).toBe("");
	});
}

test("the refusal says how to run the suite instead: bare, with pipefail, or to a file", () => {
	const reason = guard("bun test 2>&1 | tail -5");
	expect(reason).toContain("exit");
	expect(reason).toContain("bare");
	expect(reason).toContain("set -o pipefail");
	expect(reason).toContain("> /tmp/suite.log 2>&1");
});

test("a call with no command goes through", () => {
	expect(guard("")).toBe("");
});

test("the project settings run the guard on every Bash call, and the configured command refuses a piped suite", () => {
	const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
	const commands: string[] = settings.hooks.PreToolUse.filter((entry: { matcher: string }) => new RegExp(`^(${entry.matcher})$`).test("Bash")).flatMap(
		(entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command),
	);
	const answers = commands.map((command) =>
		spawnSync(command.replaceAll("$CLAUDE_PROJECT_DIR", repo), {
			shell: true,
			input: JSON.stringify({ tool_input: { command: "bun test 2>&1 | tail -5" } }),
			encoding: "utf8",
		}),
	);
	expect(answers.length).toBeGreaterThan(0);
	expect(answers.some((ran) => ran.stdout.includes('"permissionDecision":"deny"'))).toBe(true);
});
