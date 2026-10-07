set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

# Only the research recipes read it; the coach launcher does not forward it.
export RESEARCH_TOOLS_TOKEN := env_var_or_default("RESEARCH_TOOLS_TOKEN", "dev")

# Open the coach (`just coach -c` continues, `just coach -r` resumes)
coach *args:
    node bin/setup.mjs --if-needed
    node bin/coach.mjs {{args}}

# Once: check node, install pi 0.87.1, link `coach`
setup:
    npm run setup

# A second worktree: install this checkout's own node_modules (shares the coach home with the rest)
setup-worktree:
    npm run setup:worktree

# All tests, or one file: just test src/lcu.test.ts
test *args:
    bun test {{args}}

# Replay drafts (or a recorded game) through /comp: just lab --n 2, just lab <file> --at all
lab *args:
    bun run src/lab/draft-lab.ts {{args}}

# Every audit chart for every scenario, to PNG: just charts, just charts one-long --out charts
charts *args:
    bun run src/lab/chart-gallery.ts {{args}}

# One fake turn through the real card renderers, no model and no network: just card-demo, just card-demo --width 100 --final, just card-demo --keyless (the turn with no judge key), just card-demo --unread (a check citing a source the judge never read), just card-demo --expanded (every card as Ctrl+O draws it, each claim or passage once), just card-demo --expanded --detail full (the judge's questions and score bars); --width defaults to the terminal's
card-demo *args:
    bun run src/lab/card-demo.ts {{args}}

# The primary checkout, where the player tests: the newest main, an install only when package.json or package-lock.json changed or node_modules is behind the lock file (refused before the pull on Windows while a running coach holds a file open), and which commit it now runs
latest:
    node bin/latest.mjs

# The BUILD strip through the real renderer with live Data Dragon icons, no model turn: just strip-preview prints it here; just strip-preview --shot strip.png captures it in the WezTerm window (Windows); --answer file for your own answer
strip-preview *args:
    bun run src/lab/strip-preview.ts {{args}}

# The integration worktree the way rule 8 defines it: origin/main plus every open pull request that merges cleanly, drafts included, lowest number first; conflicts are left out and named. just dev; just dev --worktree qa (the QA loop's); DEV_SKIP="167 213@<sha>" leaves some out; DEV_FORCE=1 rebuilds anyway. docs/loops.md
dev *args:
    bash src/lab/dev-rebuild.sh {{args}}

# The typecheck and the full suite on another machine over SSH (VOXREN_DEVBOX=user@host), in a mirror of this working tree there: just devbox, just devbox bun test src/ui.test.ts
devbox *args:
    bash src/lab/devbox.sh {{args}}

# The /flow panel with made-up session numbers, in any terminal: just tree-demo, just tree-demo --final --at matchup
tree-demo *args:
    bun run src/lab/tree-demo.ts {{args}}

# /flow user stories live in tmux (Linux, macOS): the coach, the tree demo, and the verdicts in three panes; --close tears it down
flow-stories *args:
    bash src/lab/flow-stories.sh {{args}}

# QA stories fired into the real coach in one WezTerm window, a 2x2 grid of panes, judged by gates, Jev's rubric, and a sonnet note: just stories (3x3 grid of 80x24 panes, 2x2 of 100x30 when the screen is too small; --split train|holdout|all (default train; a story with no split is train), --only id1,id2 (any split unless --split is given), --panes 1|4|9, --max-model 4, --no-notes, --out <dir>, --compare <old stats.json>)
stories *args:
    bun run src/lab/story-runner.ts {{args}}

# Freeze one real session from the exchange log into a story file, outside the repository, Riot IDs scrubbed, no model call: just freeze <sessionId> --split train|holdout [--name <id>] [--from <exchanges.ndjson>] [--out <dir>]; an unknown id lists the sessions the log holds
freeze *args:
    bun run src/lab/freeze.ts {{args}}

# The research-tools service on 127.0.0.1:8787 (needs uv): YouTube, web search, and page text over HTTP. Token "dev" unless RESEARCH_TOOLS_TOKEN is set.
research:
    uv run --directory services/research-tools uvicorn app.main:app --host 127.0.0.1 --port 8787

# Build matchup notes by hand, printing every dropped row and why: just notes Fizz Ahri Zed (the coach builds them itself in a session)
notes *args:
    bun run src/lab/refresh-matchup-notes.ts {{args}}

# Its lint and tests
research-test:
    uv run --directory services/research-tools ruff check .
    uv run --directory services/research-tools pytest

# The real TUI, headless: just tui --replay data/lab/drafts/pyke-picks.json --auto --runs 2 (docs/agent-terminal.md rung 4)
tui *args:
    node src/lab/tui.ts {{args}}

# The coach in its own WezTerm window, driven and recorded as a player sees it (Windows): just wez open (prints a pid), just wez record --pid <n> run.gif --send "/review 5", just wez close --pid <n>
wez *args:
    node src/lab/wezterm.ts {{args}}

# Ask once and print the answer: just ask "/review 3"
ask +question:
    node bin/coach.mjs -p {{quote(question)}}

# Recent coach.log.ndjson warnings and errors, newest last: just logs, just logs --run 2026-10-03T18:04:12.345Z, just logs --all
logs *args:
    bun run src/lab/show-logs.ts {{args}}

# How this checkout scores, as the conductor's K2 scores file (.claude/conductor/scores.json): just score (quick: typecheck, bun test, any tier.json), just score --full (adds `just stories --panes 4 --no-notes`, which spends real money), just score --stories (only that), --out <file>
score *args:
    bun run src/lab/score.ts {{args}}

# Every main view and state through the real renderers, no model and no network: just ui (--only name,name, --width 100, --theme tidal, --watch, --json <file>); writes <out>/tier.json. just ui --shoot [--changed] [--no-critique] [--out <dir>] shoots the views in a WezTerm grid and has three sonnet critics read the sheets
ui *args:
    bun run src/lab/ui-shoot.ts {{args}}

# Smoke tests: every story with a cassette replayed offline through Pi's faux model in a WezTerm grid, GIF per story, animation gates on the text timeline, advisory visual review of changed stories: just smoke [--only id1,id2] [--no-gif] [--no-notes] [--notes all] [--warm] [--panes 1|4|9] [--out <dir>] [--json <file>]; just smoke record <story-id> [--force] records a cassette from one live run
smoke *args:
    bun run src/lab/smoke.ts {{args}}
