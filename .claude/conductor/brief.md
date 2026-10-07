# Task {{ticket}}: {{title}}

Repository: {{repo}}. Read `AGENTS.md` first: it is the whole contract for this repository, and its rules (prompts only in `coach.yaml`, no empty catch, tests prove behavior, no machine details in shipped files) apply to every line you write.

## What to change
{{body}}

## Where you work
- One task, one worktree, one branch, one pull request. Your worktree is {{worktree}}, branch {{branch}}, from `origin/{{mainBranch}}`. Never edit the primary checkout.
- Reuse a finished worktree instead of a fresh install: if a worktree of a merged task exists and its `package-lock.json` is unchanged against yours, check out your branch there (`git checkout -B {{branch}} origin/{{mainBranch}}`) and keep its `node_modules`. Run `npm run setup:worktree` only when the lockfile changed. A fresh `npm ci` floods fseventsd and heats the Mac.
- Open the pull request against `{{mainBranch}}`. The conductor merges your branch into the local `{{mergeTarget}}` for integration. You never merge, never push `{{mergeTarget}}`, never force-push, and delete only your own merged branch and worktree.

## Done means
- `{{quick}}` passes (typecheck and the full suite). Green means go up to the pull request: commit, push your branch, open the PR without asking.
- Anything a player sees: run the coach from your worktree and read the result (`docs/agent-terminal.md`); pictures, layout and motion need the WezTerm rung.
- Prompt changes (`coach.yaml`): put a before and after measurement on the same inputs in the PR.
- Jev threshold changes: label the corpus first, set the bar first, then compare old and new on the frozen corpus; put the comparison in the PR.
- Scope: {{scope}}. Anything else becomes a new ticket, not part of this PR.
- Touch only the files this task needs. Live sessions are editing: {{busyFiles}}. Leave those.

## Clean up after yourself
- Close the WezTerm windows you opened (`just wez close --pid <n>`, your own pid only) and stop every process and background job you started.
- Before your final report, stop or wait for every background job you started. Report once.

## Commits and reports
- No `Co-Authored-By` trailer in any commit message.
- Need a human decision? Write it to the decision queue (`node <team-player plugin>/conductor/cli.ts decide add`, stdin `{ question, options (2 to 4), recommended, default, blocks, evidence }`), then continue on the default or switch tasks. Never wait.
- Read files by range. Do not read a file more than 3 times; keep notes instead.
- When review findings arrive, fix them and push to the same branch. At most 2 rounds.
- Your report opens with four lines: the objective, its status, how the player can try it, and what you need from the player (nothing, or one question). End with the PR URL and how you verified it.
