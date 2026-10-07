// PreToolUse guard for the Bash tool: refuse a command that runs the test suite (src/lab/devbox.sh, `just devbox`,
// `bun test`, `npm test`) and pipes it into head or tail. A pipeline exits with its last command's status, so
// `bun test 2>&1 | tail -5` exits 0 whatever the suite did: a loop session launched the devbox suite 87 times through
// head or tail and all 179 completion notices said "exit code 0", runs with 3 and 8 failures among them.
// Any filter may sit between the suite and the head or tail. A command that sets pipefail or reads PIPESTATUS goes through.
// Quoted text, comments and heredoc bodies are not read, so a commit message or a PR body may quote the pipe; for the same reason a
// pipeline written inside quotes (`bash -c '...'`, `just devbox '...'`) is not seen either.
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const command = String(JSON.parse(raw || "{}").tool_input?.command ?? "");

const suite = /\b(bun\s+test|npm\s+test|just\s+devbox)\b|src\/lab\/devbox\.sh/;
const headOrTail = /^\s*[({]?\s*(?:(?:sudo|env|command|exec)\s+)*(?:\S*\/)?(head|tail)(\s|;|\)|$)/; // also `/usr/bin/tail`, `env tail`, `(tail -5)`, `{ head; }`
const pipefail = /(^|\s)-[a-zA-Z]*o\s+pipefail\b/; // `set -o pipefail`, `bash -euo pipefail`
const pipestatus = /\$\{?pipestatus\b/i; // $PIPESTATUS, zsh's $pipestatus; read inside double quotes, where it expands

const code = command
	.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "$3") // a heredoc body, keeping the rest of its first line
	.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""') // quoted text
	.replace(/(^|\s)#.*/g, "$1") // a comment
	.replace(/\\\n/g, " ") // a line continued with a backslash
	.replace(/\|(&?)\s*\n/g, "|$1"); // a pipeline continued after its pipe
const expanded = command // the same without comments, heredoc bodies and single-quoted text, but double-quoted text kept
	.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "$3")
	.replace(/'[^']*'/g, "''")
	.replace(/(^|\s)#.*/g, "$1");
const piped = code.split(/&&|\|\||;|\n/).some((line) => {
	const stages = line.split(/\|&?/);

	return stages.length > 1 && headOrTail.test(stages.at(-1)) && stages.slice(0, -1).some((stage) => suite.test(stage));
});

if (piped && !pipefail.test(code) && !pipestatus.test(expanded)) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason:
					"A test run piped into head or tail reports the pipe's exit code, not the suite's: failures read as exit 0. Run it bare (`bun test`), or start the command with `set -o pipefail;`, or write the output to a file (`bun test > /tmp/suite.log 2>&1`) and read the file afterwards.",
			},
		}),
	);
}
