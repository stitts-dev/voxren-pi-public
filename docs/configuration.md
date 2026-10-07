# Configuration

*For a player setting up the coach, and anyone debugging why a launch looks wrong.*

## Where keys come from

`coach` reads the process environment first. Anything missing falls back to a `.env` file in
the coach home, or wherever `VOXREN_COACH_ENV_FILE` points instead. `VOXREN_COACH_HOME` and
`VOXREN_COACH_ENV_FILE` must be real environment variables: they decide where the `.env` file is,
so setting them inside it has no effect. Of the other names below, only those are read from `.env`;
nothing else in that file reaches Pi. Only the chosen provider's API key is forwarded; the other
providers' keys are dropped.

| Name | Turns on |
| --- | --- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | the matching API provider (see below) |
| `BRAVE_API_KEY` / `PERPLEXITY_API_KEY` | optional: a faster keyed search provider for `web_search`, tried before the model provider's hosted search. Needs the research service. Neither is needed on the default ChatGPT/Codex plan |
| `GEMINI_API_KEY` | optional: the research service asks Gemini to read each video's public URL instead of scraping its captions. Needs the research service. See [Web search and video research](#web-search-and-video-research) |
| `VOXREN_RESEARCH_URL` / `VOXREN_RESEARCH_TOKEN` | a research service you already run (see below), instead of the local one the coach starts |
| `TYPESAFE_API_KEY` | the Jev screen on web and OP.GG text, and the claim grounding gate in `voxren_strategy_frame` |
| `VOXREN_COACH_ACCOUNTS` | `Name#TAG`, the account a bare `/review` audits while the League client is closed |
| `VOXREN_COACH_PROVIDER` | provider override (default `openai-codex`) — pins the model like `VOXREN_COACH_MODEL` |
| `VOXREN_COACH_MODEL` | model override (default `gpt-6-sol`) — pins the model; Jev routing still picks the thinking level |
| `VOXREN_COACH_CHAMPION` | main champion (unset: detected from the live game or a command's argument) |
| `VOXREN_COACH_LANE` | main lane override: `top`, `jungle`, `mid`, `bot`, or `support` |
| `VOXREN_COACH_THINKING` | Pi's thinking level for the run: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (Pi's default when unset) — fixes the thinking level; Jev routing still picks the model |
| `VOXREN_COACH_THEME` | look override (default `tidal`) |
| `VOXREN_COACH_CARD_DETAIL` | what `Ctrl+O` shows on a tool card: `claims` (default) lists each claim or passage once with what the judge found under it; `full` is the judge's questions and score bars, for debugging a verdict; `brief` keeps an expanded card as short as a collapsed one. Any other value is the default. The layouts are in [jev.md](jev.md#what-the-model-and-the-card-see). It is a launch setting with no panel row: `/flow`'s rows belong to one command and `/config`'s change with the arrows |
| `VOXREN_COACH_HOME` | coach home override |
| `VOXREN_COACH_ENV_FILE` | `.env` path override |
| `VOXREN_COACH_IDLE_FILE` | idle-marker path for an agent driving the TUI, see [agent-terminal.md](agent-terminal.md) |
| `VOXREN_COACH_AUTO_COMP` | On unless set to `0`, `false` or `off` (any case). Sends `/pick` on its own when your champion is locked or has stayed hovered for two polls, and `/draft` once you and four enemies have locked, again on the fifth lock or a swap (at most five automatic turns per champ select between them); on by default. The `auto` row on `/draft` in `/flow` turns it on or off and is saved to `profile.json`; it shows the effective state, and a saved value beats the default. Precedence: this variable when it says `1`/`true`/`on` or `0`/`false`/`off`, else the saved row, else on. The same variable and the `auto` rows on `/comp` (game start) and `/review` (game end) switch the two game calls: `/comp` once the live game is past 0:00, `/review 1` when the game ends |
| `VOXREN_COACH_AUTO_UPDATE` | On unless set to `0`. Every 10 minutes the coach looks for new commits on its branch and, between games (League client closed or in the lobby) and while idle, pulls them and reloads in place, then lists what changed. Set to `0` to get only the header line saying `/update` is ready |
| `VOXREN_COACH_FEEDBACK` | On unless set to `0`. After a `/review`, one dim line asks `was this useful? /feedback good \| meh \| bad <note>`, after the first review and then every third. `/feedback` itself always works; its rows stay in `feedback.jsonl` in the coach home (see [privacy.md](privacy.md)) |
| `VOXREN_COACH_TURN_TIMEOUT_MS` | per-turn deadline in milliseconds (default `180000`); `0` or unset means the default, a non-number fails the launch |

### Web search and video research

`web_search` needs no key on the default provider: the coach starts a second, plain Pi run that asks the provider
(your ChatGPT/Codex plan, or `openai`) to run its own hosted web search and to answer with quoted sentences and links.
It takes about 15 seconds. Another provider has no hosted search here; there, set `BRAVE_API_KEY` or
`PERPLEXITY_API_KEY`. With either key set the keyed provider is tried first (a second or two), and the hosted search
takes over when it fails or finds nothing.

`voxren_video_research` and keyed search run in the research service, `services/research-tools`: a small Python
service the coach starts on `127.0.0.1` the first time it is needed and stops when the session ends. It needs
[`uv`](https://docs.astral.sh/uv/) on `PATH`; the first start installs its packages and takes up to a minute. Without
`uv` the header says video research is off and everything else still works. This is the same on Windows, macOS and
Linux: coach windows on one machine share one service, it has no window of its own, and it stops when the last coach
window using it closes. `VOXREN_RESEARCH_URL` and `VOXREN_RESEARCH_TOKEN` point the coach at a copy you run yourself or
host elsewhere (`services/research-tools/README.md`) instead; the coach then starts nothing and sends that copy no keys.

With `GEMINI_API_KEY` set, the coach hands the key to the service it starts, and the service gets a video's transcript by
asking the Gemini API to read the public video URL instead of downloading captions. A transcript is made in 300-second
clips, a few at a time, and kept after the first read. A 36 minute video took 10 to 30 seconds when measured on
2026-10-01. `voxren_video_research` waits up to 90 seconds for its call, counted from the call and so including a first
start of the service. The service is told to answer within 75 of them with the videos it has: Gemini gives way to the
captions 20 seconds before that, and a video still being read is left out, which the card shows as "timed out". The
matchup-note build waits up to 240 seconds for each transcript; every other call keeps its 60-second wait. Pi itself never gets the key as `GEMINI_API_KEY`, the name Pi's own Google provider reads: the launcher
passes it as `VOXREN_GEMINI_API_KEY`, and only the service the coach starts is given it. A service you run yourself
(`VOXREN_RESEARCH_URL`) holds its own key: the coach sends it none. Without the key, or for a video Gemini fails on,
captions are used as before. What Google receives is in [privacy.md](privacy.md#what-leaves-the-machine).

YouTube limits how many transcripts one address can download: after about 15 in ten minutes it refuses more for a
long while. The service keeps every transcript it has fetched, fetches one at a time, and tells the coach when
YouTube is refusing; the video card then says `YouTube rate limit`.

`PERPLEXITY_API_KEY`, `TYPESAFE_API_KEY`, and `GEMINI_API_KEY` can also be set, tested, and removed from `/config`'s
Keys section instead of `.env` or a shell export; see [Keys](#keys) below. Either way, an
environment variable or `.env` value still wins over a stored one.

## Providers and models

Defaults come from `coach.yaml`: provider `openai-codex`, model `gpt-6-sol`, theme `tidal`, the
models a session may run (`agent.models`: `gpt-6-luna` and `gpt-6-sol`), and the per-tier model
and thinking level Jev routing picks from (`agent.tiers`; see
[Model routing](jev.md#model-routing)). `VOXREN_COACH_PROVIDER` and `VOXREN_COACH_MODEL` override
the provider and model per launch; either one also pins the model — Jev routing still picks the
thinking level — and narrows the launch to just it instead of every model in `agent.models`.

The `THINK` line in the transcript shows the titles of the model's thinking summaries; `Ctrl+T` collapses it to a bare `THINK …` for the session, and the next launch shows it again.

`openai-codex` is OAuth, billed on your ChatGPT/Codex plan: run `coach`, type `/login`, pick
"Sign in with an account", then restart the coach. The sign-in lives in the coach's own agent
dir, separate from any other Pi or Codex setup. The other three
providers read an API key: `anthropic` reads `ANTHROPIC_API_KEY`, `openai` reads
`OPENAI_API_KEY`, `openrouter` reads `OPENROUTER_API_KEY`. Launch fails with
a clear error if the chosen provider's key is missing.

## Coach home

The coach home holds sessions, the Pi agent dir (`pi-agent/`), `exchanges.ndjson` (one line per model run), `references/` (one-trick references saved by `/otp`, one JSON file per champion), `profile.json` (theme, default champion, and remembered Riot IDs, written by `/config`; per-command settings, auto `/draft` and what a bare `/review`, `/patch`, `/otp`, or `/comp` sends, written by `/flow`), and the optional `.env`:

| OS | Default path |
| --- | --- |
| macOS | `~/Library/Application Support/voxren-coach` |
| Windows | `%LOCALAPPDATA%\voxren-coach` |
| Linux | `$XDG_DATA_HOME/voxren-coach` (or `~/.local/share/voxren-coach`) |

`VOXREN_COACH_HOME` overrides all three. The working directory is a
separate temp-dir path outside the home tree, so an ancestor `.pi` or `.agents` folder never
triggers Pi's project-trust prompt.

## The Riot Development key

The key never goes in `.env` or anywhere in the tree. It lives in the system key store: the login
Keychain on macOS, a DPAPI-encrypted file in the coach home on Windows. Exactly how and where are
in [privacy.md](privacy.md#key-custody).

Riot Development keys expire every 24 hours. Run `/riot-key` inside the coach to paste a new
one (hidden input), test it live, or remove it. The helper's sanitized
state directory (`VOXREN_RIOT_KEY_STATE_DIR`) is the coach home on every OS.

## Champion and reference

`VOXREN_COACH_CHAMPION` sets the player's main. It fills
the system prompt's champion line, and it is the default champion for `/matchup`, `/build`, `/patch`,
and `/otp` when no champion is named. Unset, there is no main: the champion line drops out of the
system prompt, and every command that needs one (`/build`, `/patch` always; `/matchup` and `/otp`
when their own argument doesn't name one) asks you to name it instead of guessing.

The coach works for any champion in any role. The lane word comes from `VOXREN_COACH_LANE` (top,
jungle, mid, bot, or support; an invalid value is ignored), else the main champion's most-played lane
from `data/championRoles.json` looked up through Data Dragon, else no lane word at all when Data Dragon
is unreachable. In `/matchup` and `/build`, the League client's assigned role wins over both while a
champ-select or live-game read has one; the system prompt's champion line does not follow the client.

`voxren_player_audit` compares an audited game against the bundled one-trick reference in
`src/otp-reference.ts` only when that game was played on the reference champion, Fizz; an
audit on any other champion still returns the player's own item timings, with no reference
block. Pointing `VOXREN_COACH_CHAMPION` at a different main does not retarget the reference;
that means replacing the contents of `src/otp-reference.ts`.

## Themes

Four theme files ship in `themes/`: `tidal` (default), `hextech`, `void`, `signal`. Precedence at launch:
`VOXREN_COACH_THEME` (env) > the saved profile's theme (`profile.json`, see [Coach home](#coach-home)) >
`coach.yaml`'s default (`tidal`).

No theme paints a band behind a line: the tool, user, and custom message backgrounds are the terminal's own, and each kind of block (lookups, the check, the route row, errors, thinking, the player's line) draws in its own colour. An exported transcript (`/export`) draws its page dark from each theme's `export` block, but Pi gives the player's lines and tool rows a fixed light band whatever the theme says, so their light text is hard to read there.

`/config` opens a settings-style panel for the saved profile. Up and Down move between rows. On the theme
and champion rows, Left and Right change the value and save it at once to `profile.json`: no Enter, no
typing. The theme row previews each theme live as you step, and it becomes the default at every future
launch. The champion row steps through "detected from game" and every Data Dragon champion name (the list
loads on the first step), so a typo cannot be saved; it takes effect immediately, with no restart, and
follows the same precedence `VOXREN_COACH_CHAMPION` already wins above. A save that fails says
"Not saved" with the reason and leaves the row as it was. Each save re-reads `profile.json` and changes only
its own field, so another window's changes and fields this version does not know are kept. A
`profile.json` that does not parse is moved aside as `profile.json.bad-<time>` and the header says so; the
coach runs on defaults until you fix or discard that file.

A Riot IDs row opens the remembered ids, marking which one is primary. Right makes the id under the
cursor primary; Left twice removes it (the first Left arms it). Removing the current primary promotes the
next remembered id, and removing the last one clears primary. A trailing "+ Add Riot ID" row is the one
typed field in `/config`, since an id has no list to pick from: it takes a new `Name#TAG` id, and an
entry that doesn't match leaves the field open with the reason rather than saving. The League client's
signed-in account is added on its own, the first time each session sees it, with no panel needed. Every
Riot ID change takes effect immediately: the next system prompt, and the account `voxren_player_audit` reads
by default, follow the updated list without a restart.

## Keys

A Keys row opens Riot, Perplexity, Typesafe, and Gemini, each with the same four actions as `/riot-key`:
a hidden field to store a value, a live test, status, and remove. The key line names where the
active value comes from — stored, an environment variable, `.env`, or an environment variable
shadowing an already-stored key — the same precedence and wording the startup header uses, so the
two can never disagree. Perplexity's and Typesafe's live tests are each one small billed call to their own API. A key
stored in the last two minutes that gets 401/403 is retried for about 12 seconds, since new keys
(Riot dev keys especially) can be refused briefly before the provider accepts them. A value is never shown, logged, or
returned from a tool. Storing or removing a key takes effect at the next launch of `coach`, the
same as editing `.env` today.

A Gemini key is stored like the others: in the macOS login Keychain (service `voxren.gemini.api-key`, account
`voxren-coach`) or, on Windows, DPAPI-encrypted in `gemini-key.dpapi` in the coach home. Its live test lists one model,
which is free; a key Google does not accept reads as rejected (Google answers it with HTTP 400, and that is retried like
a 401 for a key stored in the last two minutes).

## Learnings

A Learnings row shows a Memory switch (on/off) and, below it, one row per remembered Riot ID.
Memory on folds each `voxren_player_audit` result into that Riot ID's local file and recalls a
short summary in the system prompt (see [privacy.md](privacy.md) for exactly what's stored);
turning it off stops both, and the `voxren_remember` tool, immediately, with no restart, but never deletes a file
already on disk. Turning it back on resumes the fold and recall at once; `voxren_remember` returns at the next launch.
Opening a Riot ID offers "View summary" (the same read-only text the prompt would recall, or
"Nothing remembered yet." when there's nothing saved) and "Reset", which deletes that one Riot
ID's file after a confirm. The Memory switch is saved to `profile.json`; a Reset only ever touches
that one Riot ID's file under `<coach home>/learnings/` (see [Coach home](#coach-home)).

## Windows

`coach` resolves the `pi` binary in this order, all run through the same Node with no shell:
next to the current Node executable, then Pi's entry script inside the global npm prefix (via
`npm prefix -g`, or `%APPDATA%\npm` if that fails), then any directory on `PATH`. Bare `pi.cmd`
is the last resort, since `cmd.exe` re-splits arguments and a `-p` question would arrive as one
message per word.

Pi-tui turns on Kitty-style inline images for Warp on every OS, but Warp only draws them on
macOS and Linux. On Windows under Warp, the launcher forces `PI_IMAGE_PROTOCOL=none` so the
audit card doesn't reserve blank rows for an image it can't draw; an explicit
`PI_IMAGE_PROTOCOL` always wins over this override.

## The coach's own terminal

`coach` opens itself in WezTerm, on Windows and macOS alike, loaded with
[`terminal/wezterm.lua`](../terminal/wezterm.lua) (your own `~/.wezterm.lua` is not read), so the font,
cell size, colours, and pictures match on every machine. What you check on a Mac is what Windows shows.

- **Pictures** go out the iTerm2 way in WezTerm on every platform (the launcher sets
  `PI_IMAGE_PROTOCOL=iterm2`): on Windows, WezTerm talks to the coach through ConPTY, which drops Kitty's APC
  sequences. Each picture carries WezTerm's `doNotMoveCursor`, so ConPTY's idea of the cursor and WezTerm's agree.
- **The cursor stays shown** in WezTerm (`keepCursorShown` in `src/terminal-images.ts` drops Pi's hide-cursor),
  drawn in the background colour by `wezterm.lua`; Pi draws its own in the editor. ConPTY only tells WezTerm where
  its cursor is while it is shown. Hidden, pictures landed at the right edge and Pi's OSC 133 prompt marks, which
  WezTerm reads as "start a fresh line", left a stale working row above the live one.
- **Paste** is `Ctrl+V`, on Windows and macOS alike, as well as WezTerm's own keys (`Ctrl+Shift+V`, `Shift+Insert`,
  `Cmd+V` on macOS). It is how a key reaches the hidden field in `/riot-key` and `/config`.

`npm run setup` installs WezTerm (winget on Windows, Homebrew on macOS) and never fails over it. The coach runs in
place when it is already in WezTerm, with `-p`, under tmux, when stdin or stdout is not a terminal, when WezTerm is
not installed, or with `VOXREN_COACH_TERMINAL=here` (tests, labs, and the VS Code launch configs set it).

## Terminal images

Inline item icons and audit charts draw only on Kitty, Ghostty, WezTerm, and iTerm2. Sixel is opt-in only: set `PI_FORCE_IMAGE_PROTOCOL=sixel` to
turn it on; it is never enabled from a terminal-identity variable, since a wrong guess would
draw garbage instead of falling back cleanly. Everywhere else, and
whenever the optional image rasterizer isn't installed, the audit card falls back to
block-character text strips.

Charts are drawn with no background, so on Kitty and iTerm2 they sit on your terminal's own; Sixel has no transparency, so its charts keep a solid dark ground.

VS Code, VSCodium, and Cursor terminals draw iTerm2 images once the editor allows it. In the editor's
user settings:

```jsonc
"terminal.integrated.gpuAcceleration": "auto", // images need the GPU renderer
"terminal.integrated.enableImages": true,
"terminal.integrated.env.windows": { "PI_IMAGE_PROTOCOL": "iterm2" }, // .osx / .linux elsewhere
```

Setting `PI_IMAGE_PROTOCOL` here, rather than guessing from `TERM_PROGRAM=vscode`, ties the
protocol to the exact place images are switched on. Open a new terminal after changing them.

These editors scale a picture to CSS pixels, so with Windows display scaling above 100% (or a
Retina Mac) charts come out slightly soft. Kitty, Ghostty, and WezTerm (on Windows too) draw at the
screen's real pixels.

The death map and heat map draw on `data/map-backgrounds/holographic.png`, a 2048 px restyle of
the Riot minimap (see `docs/maps/`), so they stay sharp at any pane width and need no network.

## Print mode and flags

```bash
coach -p "how do I beat Syndra"
```

`-c` continues the last conversation, `-r` picks one to resume, `-p "<text>"` asks once and
prints the answer, then exits; a `/command` works as the text too.
Print mode has no UI, so `/riot-key` refuses outside the TUI, and `/login` cannot run either: a launch that isn't signed in yet fails
`-p` immediately instead of waiting on a sign-in screen it has no way to show.

## Turn timeout

Every turn gets a wall-clock deadline, `VOXREN_COACH_TURN_TIMEOUT_MS` (default 180000, three
minutes), to cover a provider stream that stalls without closing. In print mode, a turn past the
deadline is aborted and `coach -p` exits non-zero; the exchange line in `exchanges.ndjson` still
gets written, with `aborted: "timeout"`. In the TUI, the same deadline aborts only the stuck turn
and shows a notice; the session stays open for the next command.
