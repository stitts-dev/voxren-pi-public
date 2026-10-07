// PreToolUse guard for AGENTS.md rule 8: refuse an edit that writes `ref: false` into src/ or bin/.
// `ref: false` only exists on node:timers/promises timers, which are always awaited, and Bun on
// Windows never fires a lone unref'd timer, so the await hangs (the e2e/coach.test.ts lane-lookup hang).
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || "{}").tool_input ?? {};
const path = String(input.file_path ?? "").replaceAll("\\", "/");
if (!/\/(src|bin)\/[^]*\.(ts|mjs|js)$/.test(path)) process.exit(0);
const written = [input.content, input.new_string, ...(input.edits ?? []).map((edit) => edit.new_string)].filter(Boolean).join("\n");
if (/\bref:\s*false\b/.test(written)) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason:
					"AGENTS.md rule 8: no awaited unref'd timer (`ref: false`). Bun on Windows never fires a lone unref'd timer, so the await hangs. Use a plain setTimeout and clearTimeout it once the race settles (see the lane wait in src/index.ts).",
			},
		}),
	);
}
