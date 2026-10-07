# Driving the coach from an agent

The coach is a terminal program. Agents verify it the same way on macOS and Windows: cheapest loop first, real TUI last, and never by driving the operating system.

## The ladder

Use the first rung that answers the question. Move down only when the rung above cannot see the thing you changed.

| Rung | Command | Sees | Cost |
| --- | --- | --- | --- |
| 1. Unit tests | `bun test` (one file: `bun test src/lcu.test.ts`) | Every module through a fake Pi, a fake gateway, a fake LCU transport. Card rows come back as plain strings from the `*Lines` functions with a tagged theme, so colour roles are asserted, not eyeballed. | Seconds. |
| 2. Print mode | `coach -p "/review 3"` (any command or question) | The whole pipeline, tools, prompt, answer, with no TUI. Exit code and stdout are yours. | One model turn. |
| 3. Terminal tab | The app's terminal tools: `run_in_terminal` to launch `coach`, `read_terminal` to read the screen as text, `stop_terminal_tab` to close it | Header, footer, cards, the answer, as rendered text at the pane width. | One tab per launch. |
| 4. Headless TUI | `tui-test` to drive it by hand, `just tui ...` to script a scenario. See below. | The real TUI in [Microsoft tui-test](https://github.com/microsoft/tui-test)'s pseudo-terminal (ConPTY on Windows): the agent types, waits on the screen, reads text, colours, and a full-colour screenshot. Nothing opens on screen. | `tui-test close` when done; `just tui` exits on its own. |
| 5. WezTerm window | `just wez open` (prints a pid), then `send`, `read`, `shot`, `record`, `close` with `--pid`. See below. Windows, and macOS once Screen Recording is allowed (W6); `just devbox --no-sync <step>` drives a Mac over SSH. | The coach in its own WezTerm window, pictures included: text through `wezterm cli`, real-pixel captures of the window even when other windows cover it, and GIF recordings of a whole run. The only rung that sees charts and icons. | One window, `close` when done. A `send` that runs a command is a model turn. |

Rungs 1, 2, and 4 run on Windows and macOS; rung 5 on Windows; rung 3 works wherever the desktop app's terminal panel exists. `bun test` includes `src/e2e/tui.test.ts`, the real TUI under tui-test with no model turn, so every CI run on Linux and Windows proves rung 4's engine still types, reads, and waits.

The coach home (`.env`, the key store, sessions, `profile.json`) lives outside the repo and is shared across every worktree of it, so a key stored from one checkout works from all of them — but each worktree still needs its own `node_modules`, via `npm run setup:worktree` (`npm ci`, matching CI, skipping the pi-install and `npm link` steps already done for the primary checkout). `node bin/coach.mjs --version` (or `-v`) prints that checkout's own branch, short commit, and path before touching `.env` or Pi, so an agent working from an unfamiliar worktree can confirm which one is actually running.

### Rung 4: tui-test

One engine for both halves: the `tui-test` CLI for an interactive session, and its library inside `just tui` and `src/e2e/tui.test.ts`. The library comes with `npm ci`, pinned exactly in `package.json`. The CLI is a separate binary at the same version; install it once:

```bash
gh release download 0.1.0-beta.5 -R microsoft/tui-test -p 'tui-test-aarch64-apple-darwin.tar.gz' -O - | tar xz -C ~/.local/bin   # macOS; Windows: 'tui-test-x86_64-pc-windows-msvc.zip', tui-test.exe on PATH
tui-test --version    # must print the pinned version; src/e2e/tui.test.ts fails when it does not
```

Drive a session. Every command reads `TUI_TEST_SESSION`, so set it once per shell call and never pass `--session` after the subcommand (pitfall P1):

```bash
export TUI_TEST_SESSION=coach
IDLE=$(node -p 'require("path").join(require("os").tmpdir(),"coach-idle-"+process.pid)')
tui-test run --cols 120 --rows 40 --env "VOXREN_COACH_IDLE_FILE=$IDLE" node bin/coach.mjs
tui-test expect text "VOXREN COACH"               # wait for the header before typing (P3)
tui-test text                                     # viewport: the header, or a dialog if one is up; --full adds scrollback
tui-test submit '/review 3'                       # the whole line in one call (P4)
node -e 'const fs=require("fs"),f=process.argv[1];fs.watch(require("path").dirname(f),()=>fs.existsSync(f)&&process.exit(0));fs.existsSync(f)&&process.exit(0);setTimeout(()=>process.exit(1),300000)' "$IDLE"
tui-test text --full                              # the card and the answer
tui-test close
```

`VOXREN_COACH_IDLE_FILE` is the coach's idle marker: the extension touches that path every time Pi's `agent_settled` event fires, which covers a finished answer, an abort, and a failed turn alike. The `node -e` line waits on it without polling, exits 0 when it appears and 1 after five minutes; on 1, read the viewport to see what is stuck. Delete the file before the next command if you need to wait again. Without the variable nothing is written. The path comes from Node so it is native on Windows, where a Git Bash `/tmp` path means nothing to the coach.

For a panel or key that needs no model turn, wait on the screen instead: `tui-test key press Escape`, then `tui-test expect text "Coach settings" --not`. `tui-test screenshot out.png` renders the screen in full colour for an alignment or theme question; `tui-test cells <x> <y> <w> <h> --json` gives each cell's colour and weight.

To show the human, open one terminal tab with `run_in_terminal` running `tui-test monitor --session coach`. They watch; the agent keeps driving from the shell. Close the tab with `stop_terminal_tab` after `tui-test close`.

### Scripted: `just tui`

`src/lab/tui.ts` runs `bin/coach.mjs` under the same library and exits when it has what was asked for. It runs in a throwaway coach home (keys copied, Pi's sign-in shared) unless `--real-home`, so its sessions never reach the player's picker.

```bash
just tui --replay data/lab/drafts/pyke-picks.json --step 100 --send "/draft@2" --runs 1   # type a command, wait for one run
just tui --replay data/lab/drafts/pyke-picks.json --auto --step 1500 --runs 2            # a whole champ select, auto /draft twice
just tui --replay <live-client-raw.ndjson> --send "/comp@3" --runs 1                     # a recorded game as the fake client
```

`--replay` takes a draft file (expanded pick by pick), a `VOXREN_LCU_RECORD` file, or a Live Client Data dump, and plays it as the League client (`VOXREN_LCU_REPLAY`). `--send "<text>@<seconds>"` types a line and presses Enter that many seconds after the header draws; from Git Bash set `MSYS_NO_PATHCONV=1`, or it rewrites `/draft` into a Windows path. `--runs N` stops after N model runs, else `--for` seconds (default 60); `--every N` also prints the screen every N seconds. The output ends with the screen and scrollback, then every run as command (`draft:auto` for an auto run), seconds, tools, and answer.

`just freeze <sessionId> --split train|holdout` turns one real session from the exchange log into a story file in the `just stories` format (typed turns in order, automatic runs and runs logged before the typed line was kept left out and listed, Riot IDs scrubbed), written outside the repository; a replay has no League client unless the story names a `replay`.

### tui-test pitfalls

Each row was hit for real. Check here before debugging a tui-test surprise.

| Id | Symptom | Fix | Seen |
| --- | --- | --- | --- |
| P1 | `--session x` after a subcommand's arguments (`key press Escape --session x`) is typed into the coach as text | `TUI_TEST_SESSION`, or `--session` right after `tui-test` | 0.1.0-beta.5, macOS |
| P2 | A read right after a key shows the old screen; `wait idle` can return before the coach reacts | `expect text "<what should appear>"` (or `--not` for what should go) before reading | 0.1.0-beta.5, macOS |
| P3 | Keys sent before the first paint land raw above the header | `expect text "VOXREN COACH"` first | 0.1.0-beta.5, macOS |
| P4 | A slash command typed in pieces opens the autocomplete; the Enter then picks a completion and a mangled line goes to the model | Send the whole line and Enter in one call: `submit '/config'`, or `write("/config\r")` in the library | 0.1.0-beta.5, macOS |
| P5 | Library: keys sent while a wait (`waitExit`, `expect`) is pending on the same session are not delivered until it ends | One call at a time per session; poll `state().exited` instead of holding `waitExit` | 0.1.0-beta.5, macOS |
| P6 | `wait ready` and `wait command` time out: they need shell integration, and the coach is not a shell | Screen text or the idle file | 0.1.0-beta.5, macOS |
| P7 | `--timeout 20s` is rejected | Milliseconds: `--timeout 20000` | 0.1.0-beta.5, macOS |
| P8 | Item icons and audit charts never show, on any backend | Not a coach bug: tui-test draws no inline images. Those need Kitty, Ghostty, WezTerm, or iTerm2 | 0.1.0-beta.5, macOS |
| P9 | No build for Windows on ARM, and no Homebrew formula | GitHub release binaries, x64 on Windows | 0.1.0-beta.5 |

### Keeping this section true

tui-test is a beta, pinned exactly. The table above is how agents stop paying for the same surprise twice.

1. **Hit something new:** once the fix works, add a row in the same change: symptom as you saw it, the fix, the version and OS. If an existing row was wrong or incomplete, edit that row instead. Keep the table under 12 rows by merging rows that share a fix.
2. **Bump tui-test:** change the exact pin in `package.json` and the version in the install line above together, install the matching CLI, run `bun test src/e2e/tui.test.ts` and one `just tui` scenario, and retry each row's symptom. Delete rows that no longer reproduce; a row stays only while it is true. CI runs `src/e2e/tui.test.ts` on Linux and Windows; a bump that fails there is reverted, not worked around.
3. **When tui-test cannot do the job** (no build for the platform, a crash with no workaround): drive the coach through rung 3 or ask the human, and add a row naming what failed. The pre-tui-test driver (`@lydell/node-pty` and `@xterm/headless`) is in git at `2a2d38a:src/lab/tui.ts`; restore it only if tui-test stays broken past one release.

### Rung 5: the WezTerm window

`src/lab/wezterm.ts` runs the real coach in its own WezTerm window, as a player gets it, and drives it from the shell. It is the rung for pictures (charts, icons) and for anything that only shows mid-run, such as a spinner or a row drawn twice.

```bash
just wez open                                      # prints "pid <n>"; throwaway coach home (keys copied), --real-home for the player's
just wez send --pid <n> "/review 5"                # type a line and press Enter
just wez key --pid <n> esc                         # esc, enter, tab, up, down, left, right
just wez read --pid <n> --wait "CHECK"             # the screen as text, once that text shows (--timeout, default 120 s)
just wez shot --pid <n> shot.png                   # the window at real pixels, covered or not
just wez record --pid <n> run.gif --send "/review 5" --seconds 45 --fps 3
just wez close --pid <n>
```

**One window per session, always by pid.** `open` prints the pid of the window it started; every other command requires `--pid` and refuses a pid with no window behind it. There is no "current window": sessions working in parallel each keep their own pid, and never type into, read, record, or close another's. `just wez` runs through PowerShell and `node src/lab/wezterm.ts` from Git Bash both work; a line arrives whole either way (PowerShell's word split and Git Bash's `/review` to `C:/Program Files/Git/review` rewrite are both undone). Do not pipe `open` (`| tail`): the detached WezTerm holds the pipe open and the call never returns.

`record` captures the window on a timer while the line runs and writes the GIF, a `run-frames/` folder, and contact sheets (`run-sheet-1.png`, …: every fourth frame, 36 to a page; needs `ffmpeg` on PATH). Read the sheets first, then single frames at full size where something looks off.

To see bytes, not pixels: `PI_TUI_WRITE_LOG=<dir>` on `open` logs everything Pi writes, and `WEZTERM_LOG="wezterm_term=debug,info"` logs every sequence WezTerm receives after ConPTY (`~/.local/share/wezterm/wezterm-gui.exe-log-<pid>.txt`). The two side by side show what ConPTY changed.

An interactive `coach` reopens itself in WezTerm and the first process exits. A driver that runs `bin/coach.mjs` under its own pty sets `VOXREN_COACH_TERMINAL=here`, as `src/lab/tui.ts` and `src/e2e/tui.test.ts` do; `-p` and tmux always run in place.

Rung 5 has its own pitfalls, kept the same way as the tui-test table:

| Id | Symptom | Fix | Seen |
| --- | --- | --- | --- |
| W1 | Two agents on one machine shared a single "the window" record: one agent's `close` killed the other's coach mid-session, and the other's next call failed with `No window: run open first` | Every window is its own: `open` prints its pid and every other command takes `--pid <n>`. Never close a window you did not open | WezTerm 20240203, Windows 10 |
| W2 | `just wez send "/review 5"` typed `C:/Program` into the coach, which answered it as a question (a wasted model turn) | PowerShell (under `just`) splits the quoted line into words, and Git Bash first rewrites `/review` into `C:/Program Files/Git/review`; `send` and `record --send` now rebuild the line from every word up to the next `--flag`. From Git Bash, still `export MSYS_NO_PATHCONV=1` first | WezTerm 20240203, Windows 10 |
| W3 | `open -- cmd /c ...` from Git Bash ran `cmd C:/` | The same rewrite hits any bare `/x` argument, not only lines: `export MSYS_NO_PATHCONV=1` before any `wezterm.ts` call | WezTerm 20240203, Windows 10 |
| W4 | A lab script run in the window (`open -- <command>`) closed the window as soon as it exited, before `shot` | `terminal/wezterm.lua` closes on exit; `open -- <command>` passes `exit_behavior="Hold"`, so the window stays until `close` | WezTerm 20240203, Windows 10 |
| W5 | `wezterm-gui` started straight from an SSH session on macOS exits at once (`launchctl asuser`: `Could not switch to audit session`) | macOS: `open -n -a WezTerm.app --args ...` starts it in the logged-in GUI session; it gets launchd's environment, so `open` passes PATH and the coach home through `env` | WezTerm 20240203, macOS 26.5 |
| W6 | macOS `shot` fails with `could not create image from window` (or `from display`) | Screen Recording is off for the caller: System Settings → Privacy & Security → Screen & System Audio Recording → add `/usr/libexec/sshd-keygen-wrapper` when driven over SSH (the terminal app when run on the Mac), then reconnect | WezTerm 20240203, macOS 26.5 |
| W7 | A devbox run passed its tests, yet a file it wrote was back to the old copy and its `.venv` was gone | Another agent session synced the same mirror mid-run and replaced it. `devbox.sh` now holds a lock per mirror (a second caller waits and says so); a flow of several `--no-sync` steps, which the lock cannot cover between steps, sets its own `VOXREN_DEVBOX_MIRROR` | macOS 26.5 over SSH from Windows |

### Smoke tests: stories replayed offline

`just smoke` is the fast, cheap check before a push: every story that has a cassette (`data/lab/cassettes/<id>.json`), plus the /flow stories that need no model, in the WezTerm grid of rung 5. No key, no network, no model cost.

```bash
just smoke                          # all; report.md, tier.json, and per story a GIF, frames with their pane text, contact sheets
just smoke --only cmd-matchup-two --no-gif --no-notes
just smoke record cmd-matchup-two   # a live run (about $0.25) turned into data/lab/cassettes/cmd-matchup-two.json; --force records over one
```

- A cassette holds one story's assistant turns (thinking, text, tool calls) and each tool's gateway response, Jev verdicts inside, scrubbed of keys, Riot IDs, and home paths. Replay answers a tool call from the cassette (same operation and arguments, in recorded order), after a tenth of the recorded time, at most 1.5 s, so a spinner and clock still animate.
- The seam in shipped code is one optional last parameter of `installVoxrenCoach` (`makeGateway`, default the live gateway). `src/lab/smoke-coach.mjs` starts Pi with `src/lab/smoke-extension.ts` in place of `src/index.ts`: Pi's faux provider under the coach's own provider and model names, the cassette gateway, no keys, `PI_OFFLINE=1`, and every non-loopback fetch or socket refused and written to `VOXREN_SMOKE_NET_LOG` (a line there fails the story's `offline` gate). `VOXREN_SMOKE_CASSETTE` names the recording and `VOXREN_SMOKE_TPS` the streamed tokens per second (default 400). No env var exists in the shipped coach for any of this.
- Gates on the text timeline (`timeline.ts`): a spinner and clock row shows while a tool runs and is gone at the end; no row twice in one frame; a row's clock never goes backwards; no HTML entity, escape text, or `**` that holds still for two frames; the last frame is the final screen. Each has a hand-made failing timeline in `timeline.test.ts`.
- One `claude -p --model sonnet` call per run (images in one message, no tools) reviews only the stories whose look changed since the last run (a hash of the final screen and the running rows, kept in `~/.cache/voxren-smoke/hashes.json`): one small contact sheet and the last frame each, and writes `notes.md`: flicker, layout jumps, icon placement, the spinner. Nothing changed: skipped and said so; `--notes all` forces every story. About $0.02 typical, $0.055 with all 16 changed. Advisory; it never fails the run.
- Icons: Data Dragon (version list, item, rune, and summoner lists, icon PNGs) is served from `~/.cache/voxren-smoke/ddragon`, read only during a run. `just smoke --warm` fills it over the real network (one story's misses at a time); a story that needs a file the cache lacks fails with `icons: missing-cache`, never silently. The coach itself has no on-disk icon cache, and the coach home is never read for this.
- The recording starts when the pane shows the story's banner (the pane was cleared), and the `first-frame` gate checks frame 1 shows it. The runner closes its WezTerm window, recorder, and throwaway homes on any exit.
- `src/lab/smoke-extension.test.ts` replays a hand-made cassette under tui-test with the timeline gates, so `bun test` (CI) covers the replay path and the gates without a window.
- The grid GIFs are one `wezterm.ts record` over the whole window, cut per pane with ffmpeg. macOS needs Screen Recording allowed (W6).

## What never to do

- Do not drive the machine. No OS-level automation (computer-use, screen clicks, synthetic keystrokes into a terminal window) to run or read the coach. It is slow, blind to widths and colours, and it fails on the first dialog. Everything the coach shows is text on rungs 1 to 4.
- Do not open a new terminal window or tab per check. One tab, reused. Close it when the check is done.
- Do not screenshot as the primary loop. A screenshot answers one question (alignment or colour); text answers the rest. `tui-test screenshot` answers it headlessly; ask the human only for what tui-test cannot draw (inline images, P8).
- Do not poll with `sleep`. `read_terminal` takes a wait; tests and print mode exit on their own.
- Do not kill by port or process name. Stop the tab you opened, or `tui-test close`.
- Do not type secrets into the TUI. `/riot-key` and `/login` are the human's; the agent verifies their result by reading the header afterwards.
- Do not probe the League client by hand (reading the lockfile, curling the port). `bun test src/lcu.test.ts` includes a live check against the client open on this machine (skipped when none is open), and when a client is found but unreadable the header says why in an `LCU:` warning row.

## Pi facts that shape the loop

- Pi loads the extension at launch. A code change needs a fresh `coach`; there is no reload inside a running session.
- The flow tree (`/flow`) is open at startup, in the editor's place, with the keys. A typed line still works: the first character closes it and lands in the editor. To read the plain editor, press Escape first.
- Extension rows are strings. `wrapLines` and the card builders take a width; test at 80 and 120, and the narrow case that wraps.
- Tool cards use Pi's self render shell and draw a coloured bar down the left, never a background (the themes set the tool, user, and custom message backgrounds to the terminal's own). The pending call row, a spinner and a running time, disappears when the result renders. Assert on `toolResultLines`, not on the component; `just card-demo` plays a fake turn through the real renderers to look at.
- Inline item icons draw only on Kitty, Ghostty, WezTerm, and iTerm2. The desktop app's pane and Windows Terminal show item names; that is the text fallback working, not a bug.
- Pi repaints the header and footer on input and agent events. The LCU poller requests a repaint when its snapshot changes, so the player name and the LCU row land within one poll (5 s) of the client opening, with no keypress.
- Print mode has no UI, so no footer poller: the first turn names the env account, and a `/riot-key` or `/login` inside `-p` cannot work.

## Windows notes

- `coach` runs Pi through `node` with no shell; `pi.cmd` on PATH is the last resort. If `coach --help` prints nothing, the launcher is not resolving the entry script; that is a bug to fix, not a reason to call `pi` yourself.
- A full `bun test` that hangs after the banner means a timer is `unref`'d somewhere. Run per file to locate it, then fix the timer; do not skip the file.
- The Riot key store is DPAPI. Its round trip is verified by the human running `/riot-key` in the TUI and the agent reading "accepted (HTTP 200)" from the header. The helper can be exercised directly in a test with `VOXREN_RIOT_PLATFORM` set; its stdout carries sanitized state only.
- `%LOCALAPPDATA%\voxren-coach` holds sessions, the key blob, and Pi's agent state. Deleting it resets the coach; do that only when the human asks.

## The exchange log

Every model run appends one JSON line to `<coach home>/exchanges.ndjson` (`%LOCALAPPDATA%\voxren-coach` on Windows, see the README for macOS and Linux). Labs and debugging read this file; nobody mines Pi's session logs.

| Field | Holds |
| --- | --- |
| `ts`, `ms` | When the run started (ISO) and how long it took |
| `sessionId`, `model` | Pi's session id and `{ provider, id }` of the lane that answered |
| `command` | The slash command that composed the prompt (`comp`, `review`, ...); absent for a typed question |
| `input` | The line the player typed: `/matchup Syndra` for a command (rebuilt from the command name and the arguments Pi hands the handler; the interactive prompt trims the line's ends), the question itself for a typed question (equal to `prompt`); absent on an auto run, whose `command` ends in `:auto`, and on lines logged before this field existed |
| `prompt` | The text the model received: a command's composed text, or the question as typed |
| `systemPrompt`, `toolsAvailable`, `thinkingLevel` | The system prompt forced for the run, the tools the model could call, and Pi's thinking level |
| `reasoning[]` | Every reasoning block the provider returned, in order (empty when the provider returns none) |
| `turns[]` | Each assistant message: `text` (intermediate narration included), `toolCalls`, `stopReason`, `error` |
| `tools[]` | Each call in order: `name`, `args`, `ms`, `ok`, and `result` (the tool's `details`, which for a coach tool is the gateway response, or its text when there are no details or they exceed 200 KB) |
| `answer` | The final assistant text |
| `usage` | `input`, `output`, `costUsd` summed over the run, and `turns` (assistant messages) |

Examples, from a shell:

```bash
LOG="$LOCALAPPDATA/voxren-coach/exchanges.ndjson"
jq -c 'select(.command == "comp") | {ts, model: .model.id, ms, tools: [.tools[].name], answer}' "$LOG"   # every /comp run
jq -r 'select(.command == "comp") | .prompt' "$LOG" | sort -u                                          # the scenario set for a lab
jq -c 'select(.tools[] | .ok == false) | {ts, tools: [.tools[] | select(.ok == false) | .name]}' "$LOG"  # runs with a failed tool
```

A lab run under its own `VOXREN_COACH_HOME` gets its own `exchanges.ndjson`, so lab lines never mix with the player's.

## The diagnostic log

`<coach home>/coach.log.ndjson`, beside `exchanges.ndjson`: one line (`level`, `component`, `event`, `details?`, `error?`)
for every catch that used to fail silently, and for a notice raised when pictures, icons, or another optional
capability degrades. Read it next to `exchanges.ndjson` when debugging, not in place of it: a line's `runId` is the
exact `ts` of the exchange it happened during, so the two files join on it.

```bash
LOG="$LOCALAPPDATA/voxren-coach/coach.log.ndjson"
jq -c 'select(.level != "info")' "$LOG"                                              # every warning and error
RUN_ID="2026-10-03T18:04:12.345Z"                                                     # a runId from one of those lines
jq -c --arg run "$RUN_ID" 'select(.runId == $run)' "$LOG"                            # every other line from that same run
jq -c --arg run "$RUN_ID" 'select(.ts == $run)' "$LOCALAPPDATA/voxren-coach/exchanges.ndjson"  # the exchange itself
```

Capped and rotated to `.1` past a few MB; secrets, keys, and Riot IDs are scrubbed before a line is written, the same as everywhere else they leave the process.

## Reporting

Say which rung produced the evidence. "`bun test` passes" is rung 1. "`coach -p '/review 3'` returned two habits with numeric targets" is rung 2. "Footer shows `$0.000 sub · ctx 0.0% of 272k`" is rung 3 and should quote the line. A change to a card, the footer, or a command is not done until a rung 2 or 3 result is in the report.
