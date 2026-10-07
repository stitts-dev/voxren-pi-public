# One router for typed questions and game events

Today a typed question is a plain turn, whatever it asks. Only a slash command gets a coach frame, and only auto `/draft` and `/pick` fire on their own: in champ select, on locks. In-game, a draft frame cannot answer, and a champ-select question like "how do I lane vs Kassadin" never reaches `/matchup`. The goal: one entry point. Typed text and game events both go through a router that reads the input and the game phase, picks the coach command, fills its template, and runs it. Slash commands stay as a manual override.

Three pieces, built in order, one pull request each:

- **A. Router.** Typed text and champ-select locks are routed to a command.
- **B. Commands as skills.** The coach can load another command's frame mid-turn.
- **C. New auto events.** Game start, in-game moments, and post game become router inputs.

## A. Router

### Phase table

The phase is `lcuFooter.read().kind`. Each phase lists the commands the router may pick and its default:

| Phase | Candidates | Default |
|---|---|---|
| `closed`, `lobby` | review, patch, otp, matchup, build, comp, none | none |
| `champSelect` | pick, draft, matchup, build, comp, none | draft once the player and four enemies have locked, else pick |
| `liveGame` | live, build, matchup, none | live |

`live` is a new command in `coach.yaml`: today's `prompts.liveQuestion` frame (Now, Next, Kill, Threat, Fights, Buy) moved into `commands:` with tier `standard`. It takes `{{state}}` and `{{question}}`. `none` is a plain turn: no frame (in `liveGame` it is still the live-state path today's input hook gives a plain question).

The table lives in `coach.yaml` beside the commands, so a prompt author changes it without code: each command gains `phases: [champSelect, liveGame]`, and `agent.routeDefaults` names each phase's default.

### Flow

1. The `input` hook sees the text. A line starting with `/` runs that command as today; nothing below applies.
2. Otherwise `routeCommand({ text, phase })` asks Jev a choice over the phase's candidates, with each candidate's `description` as its criterion. The deadline is the tier grade's 1.5 s, and it runs in parallel with the tier grade, so a routed turn waits no longer than today.
3. When Jev picks a command with p >= `ROUTE_SWITCH_P` (0.7), the hook runs that command's handler with the text as its question. The handler reads the composition and lane as today, fills the template, and the command's yaml `tier` sets the model (the parallel tier grade is dropped).
4. Below 0.7, `none`, or a failed or missing Jev: the phase default. A default of `none` is a plain turn graded by the tier router as today.
5. Arguments: `matchup` and `build` take their champions from the composition when one is read (champ select, live game). In `lobby` the command's parser reads them from the text; a parse failure is a plain turn, logged with the reason.

Every command's prompt gains a `{{question}}` slot (empty for an auto event), so the typed question is answered inside the frame, not dropped. `assertPlaceholders` enforces it.

### Auto events

A champ-select lock enters as `{ event: "locked" }`. Events skip Jev: the phase default decides (`draft` once four enemies have locked, else `pick`), which is today's rule. The budget (five per champ select), the idle-only rule, the team call beating a pending pick, and the refund on busy are unchanged; `createAutoComp` calls the router instead of naming the command.

### What the player sees

The route row names the frame and how it was chosen: `/matchup (routed) · quick · gpt-6-luna · low`, `/draft (auto) · …`, `/draft · …` when typed, and today's tier-only row for `none`. The typed line keeps the player's words, not the expanded prompt.

### Failure

Jev down, no `TYPESAFE_API_KEY`, or a timeout falls back to the phase default and logs `route-command-fallback` with the cause (AGENTS.md rules 9 and 10). The deadline timer is never an awaited unref'd timer (rule 8).

### AGENTS.md rule 3

Rewritten in the same pull request: the client is read for a turn the player starts and for the router's auto events; auto events are the champ-select locks (as today) plus those piece C adds, each with its budget, and only while idle.

### Verification

- Unit: `routeCommand` with a stubbed Jev picks a candidate, refuses a command outside the phase, falls back below 0.7, on timeout, and on no key; a lock event never calls Jev; a routed `/matchup` in champ select reads the opponent from the composition.
- `src/lab/route-lab.ts` gains a command label on each prompt and about 30 more prompts across the three phases; the lab reports command accuracy beside tier accuracy.
- `scenarios.test.ts` replays a lock and a typed champ-select question through the router.
- Live: a WezTerm recording (`just wez record --pid`) of a typed champ-select question routed to `/matchup` and a typed in-game question routed to `live`.

## B. Commands as skills

The coach clears pi's skills each turn (`src/index.ts`, `systemPromptOptions.skills = []`). Instead, the phase's other candidates are offered as skills: name, `description`, and the filled frame as the skill body. The router's pick stays the main frame; the model loads another only when the question needs it (a lane question that also asks about items loads `build`). A loaded skill never makes a second research call the main frame already made. Verified by a lab prompt that needs two frames and one that needs one, counting loads.

## C. New auto events

Router inputs with their own budget, only while idle, each a short answer:

| Event | Fires | Default command |
|---|---|---|
| `gameStart` | first live read past 0:00 | live, opener: lane plan from the live state |
| `death` | the player dies | live, one line: what killed me and the fix |
| `level6` | the player reaches level 6 | live, the all-in window |
| `objectiveSoon` | dragon, herald, or baron spawns within 60 s | live, where to be |
| `recall` | the player is in base with gold to spend | live, the next buy |
| `gameEnd` | phase leaves `liveGame` for `lobby` after a game | review of that game |

In-game events share a budget of one per two minutes of game time; a typed question always beats a pending event. Each event is its own `/flow` row (on or off), default on for `gameStart` and `gameEnd`, off for the rest until a lab shows they help.

Out of scope: routing between models beyond today's tier grade, voice input, events from teammates' actions.
