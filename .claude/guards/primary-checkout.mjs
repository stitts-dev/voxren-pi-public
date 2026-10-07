// PreToolUse guard for the clean seat (AGENTS.md, "Working alongside other sessions"): refuse an edit of a file in the
// primary checkout. The player tests the coach from the primary checkout, so it stays a clean copy of main; an agent
// works in a worktree. A primary checkout's `.git` is a directory, a worktree's is a file. Only a session started in the
// primary checkout is stopped: one started in a worktree that reaches into the primary by path is not seen here.
import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const path = String(JSON.parse(raw || "{}").tool_input?.file_path ?? "");
// VOXREN_SEAT_EDIT=1: an edit the player asked for in the primary checkout itself.
if (!path || process.env.VOXREN_SEAT_EDIT === "1") process.exit(0);

// The nearest `.git` above the file says which checkout the file belongs to.
let dir = dirname(resolve(path));
let git = statSync(join(dir, ".git"), { throwIfNoEntry: false });
while (!git && dirname(dir) !== dir) {
	dir = dirname(dir);
	git = statSync(join(dir, ".git"), { throwIfNoEntry: false });
}
// Real paths on both sides: node names this script by its real path, the edit may name the file through a link
// (macOS's /var is one), and the two must still compare equal.
const here = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
if (git?.isDirectory() && realpathSync(dir).toLowerCase() === here.toLowerCase()) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason:
					"This is the primary checkout: the player tests the coach from it, so it stays a clean copy of main (AGENTS.md, Working alongside other sessions). Make the change in a worktree of your own: `git worktree add .claude/worktrees/<task> -b <branch> origin/main`, then `npm run setup:worktree` in it. Work of yours that is already uncommitted here: commit only your own lines to a branch (`git add -p`). VOXREN_SEAT_EDIT=1 lets an edit through when the player asks for one here.",
			},
		}),
	);
}
