# Player model: death scenes, a focus loop, and calls tailored to the player's own games

Date: 2026-10-03. Status: proposed. Decisions taken with the owner in session, reviewed once against
the source by three readers, not built.
Deciders: Jaden (owner).
Line numbers refer to commit f346962 on branch `mac-wip`. `origin/main` is ahead of it and its
`coach.yaml` lines differ, so prompt text is cited by section tag, doctrine id, or command name where possible.

## Context

We compared a generic "best League coach" system prompt (written by Perplexity) with `coach.yaml`.
That prompt is a whole product written as text because it has no tools. Most of it is already covered
here more strictly (tool-only numbers, the grounding frame, row discipline, commands instead of a
mode menu) or is general knowledge the model already has. It has one real advantage: it coaches
across games, with one measurable focus, session rules, and a plan. Voxren does that only thinly
today: `/review`, a learnings summary in the prompt, and a recent-form strip in the lobby footer.

Owner direction from the session:

1. The coach does both jobs: the best call for the game in front of the player, and a habit loop between games.
2. Any role and any champion. The coach steers the player to a small pool and derives that pool from match history. The player types nothing.
3. The coach determines why a death happened and makes the alternative clear, in the terms of that exact game. Doing this from the player's own games is what sets this coach apart from a prompt-only one.
4. A review headline names why the player died, never when. "Stop dying after 15" teaches the player to sit under a tower. Some deaths are required or worth it, and those never count against the player.
5. A goal says what to do, not only what to avoid. Non-death goals are allowed.
6. The coach may strongly recommend that the player stop queueing, and may call a dodge plainly. Dodges are scarce, one or two a day.
7. A dodge verdict carries a reason and a number.

What the code does today:

- The audit counts deaths by the clock: before 6, by 15, after 15 (`src/audit-metrics.ts:183-188`). The `<audit>` section tells the model to use the "ahead at 15: stop dying" comparison, which conflicts with "a death is a trade" in `<situations>`.
- Per death the audit keeps the minute, the map position, whether a teammate died nearby just before, and whether the team got something back within 30 seconds (`src/audit-metrics.ts:56-65`, `:250-258`). The "got something back" test has no position check: a teammate's kill anywhere on the map counts. The audit does not read who killed the player, how many enemies were there, the bounty, or the gold the player held.
- The learnings file keeps two death flags per game beside the result (`src/learnings-store.ts:12-19`) and derives two fixed focus areas by the clock (`:219-221`), which go into every system prompt. The `<audit>` section makes any audit answer end in a "Next game" number. No code parses that number, keeps it as a field, or checks it later.
- `playedAt` is a UTC date with no time (`src/audit-metrics.ts:292`) and the fold sorts on it alone (`src/learnings-store.ts:196`). After a second audit on the same day, a stored older game sorts ahead of a newer one. Read from the code, not run.
- The lobby footer reads the client's match history, wins only, with no time and no game id (`src/lcu.ts:171-173`, `:267-275`).
- A Dodge row exists only in `/pick`. `/draft` demands exactly four rows and, on the auto path, runs once four enemies have locked (`src/lcu.ts:762`). The draft lab scores no dodge field and no lab draft is labelled as one to dodge.
- No wired source returns a win probability for a whole composition. The matchup query names which side has the lane, and per-lane rates exist only in the counter lists of `champion_overview`.
- The audit result is capped at 8 KiB of model text and drops its oldest games to fit (`src/policy.ts:6`, `src/live-gateway.ts:1233-1239`). The passage the grounding frame judges is clipped at 6,000 characters (`src/live-gateway.ts:1230`).
- `/review` is described as "top 3 habits" while the `<audit>` format demands one goal.
- Two basics doctrine rows name a champion class: `wave.clear-decides` and `trade.assassin-into-mage`. `lane.plan-shape` is class-free apart from the pronoun "her". `champion_overview` falls back to mid when the model omits a position (`src/live-gateway.ts:141`).
- The draft lab covers `/comp`, `/draft`, and `/pick`. The answer-rubric lab grades five fixed queries, among them `/matchup`, `/build`, and `/patch` (`src/lab/answer-rubric-lab.ts:21`). `/review` has no lab.

Outside facts, from web search summaries and not read in full:

- Predicting the winner from the draft alone is weak: one cited approach reaches about 54%. One study reaches 75.1% by adding every player's experience on their pick, which ranked champ select hides.
- Riot's dodge penalties: first dodge -5 LP and 6 minutes, second within 24 hours -15 LP and 30 minutes, third -15 LP and 12 hours. Master and above lose 20 LP.
- With 20 LP won or lost per game, a first dodge pays when the win chance is below 37.5%, and a second when it is below 12.5%. This ignores MMR and queue time.

## Decision

Build a measured player model and make every command read it.

1. **Scene.** Code builds one fact record per death from the match and its timeline.
2. **Ledger and cause signal.** Code nets the fight around the death, lists the objectives that followed, marks the death worthwhile or costly, and gives a costly death at most one cause signal. A worthwhile death is never counted against the player.
3. **Cause and alternative.** The coach reads the costly scenes, names the cause in that game's own terms, and gives one alternative that rests only on scene facts. Example: "23:10 top river, no teammate near, killed by Vi, Ahri, Jinx, Baron lost 20 s later. Instead: stay within reach of a teammate while Baron is alive."
4. **Focus loop.** One stored goal per role, picked by code, worded by the coach as an action. A game hits it only when the count is met and the guard held, so passive play and feeding both score a miss.
5. **Three surfaces for one game.** See the table below.
6. **Post-game read.** A second automatic trigger reads the ranked games the model has not seen, updates the player model, and shows one code-built row. No model turn.
7. **Session guard.** A stop row in the lobby when the session is going badly. The exact trigger is an owner decision listed at the end.
8. **Dodge.** `/draft` gains a fifth row for the queue decision, only when all five enemy picks are locked. It states the verdict, one reason, the cost it assumes, and only numbers that code put in front of the model.
9. **Pool.** Code derives the player's champions per role from a match-only read, ranked by games played, with the game count shown.
10. **Doctrine.** The two class-specific basics rows move to lane-scoped ids or are reworded. No open issue owns this yet: #84 migrates more basics, #85 the mastery layer, #86 adds per-lane rules.
11. **Retire the clock measures.** The two clock focus areas, the "ahead at 15: stop dying" line, and the card's "traded" and "alone" labels are removed or rebuilt from the ledger in the same step that adds the scenes, so the card and the coach never label one death two ways.

| Surface | Built by | Holds |
|---|---|---|
| Row after a game | Code, no model turn | Costly-death count, top cause signal, focus hit or miss. The decision it changes: run `/review last`, or stop. |
| `/review last` | Model turn | The last game's costly scenes, each with cause and alternative. |
| `/review` | Model turn | The pattern across stored games, from per-game signal counts, and the focus. |

Not adopted from the generic prompt: the mode menu, the five-part answer template, the typed player
profile, the metrics list, and the lists of fundamentals.

## Contracts

No real timeline is stored in the repo: the tests use hand-built stubs. Public docs confirm the kill
event's time, position, killer, assists, and bounty. Everything else below is unconfirmed until step 3
saves a trimmed real timeline as a fixture: per-participant frame position, unspent gold, and level;
a killer id of 0 for a tower or monster kill; monster and building types; assists on objective
events; and a game-end marker. A missing field yields `null`, never 0.

```ts
/** One death, facts only. Built in src/audit-metrics.ts beside DeathMark. */
interface DeathScene {
	sec: number;                // whole seconds from the event timestamp, printed as m:ss
	zone: string;               // named area from data/map-zones.json, "unknown" outside every area
	killers: string[];          // champion names of the enemies in the kill, killer first
	executed: boolean;          // no champion killer: a tower, minion, or monster
	junglerIn: boolean;         // the enemy jungler is among the killers
	alliesNear: number | null;  // teammates in range at the frames either side of the death, null when the two frames disagree
	goldHeld: number | null;    // unspent gold at the last frame before the death, null when I bought between that frame and the death
	levelGap: number | null;    // my level minus the killer's, from LEVEL_UP events
	bounty: number | null;      // gold the kill paid
	fight: { mine: number; theirs: number }; // kills by each team within range, from 20 s before to 30 s after, my death counted in theirs
	bought: string[];           // objectives my team took in the 30 s after, typed
	cost: string[];             // objectives the enemy took in the 30 s after, typed
	worthwhile: boolean;
	signal: "executed" | "rescue" | "ganked" | "outnumbered" | "solo" | null;
}
```

Cause signals. A costly death takes the first rule that matches, so the counts add up. A worthwhile
death takes none.

| Signal | Rule |
|---|---|
| `executed` | No champion killer. |
| `rescue` | Exactly one teammate died within range in the 20 s before. Two or more is a fight, not a rescue. |
| `ganked` | The enemy jungler is in the kill, during the lane phase, and I am not the jungler. |
| `outnumbered` | Enemies in the kill exceed teammates near plus me. |
| `solo` | One enemy in the kill and no teammate near. |
| none | An even fight or a team fight. Costly, with no cause signal, so it adds to no count. |

Worthwhile rule. The shape is fixed here and the numbers are tuned in step 3. A death is worthwhile
when `fight.mine` exceeds `fight.theirs`, or when `bought` holds an objective and `cost` holds none.
A tie or an empty ledger is costly. Costly means not worthwhile. The objective list covers every type
the `traded` test credits today. Objectives count by time alone, which is association and not cause,
and the passage text says so.

```ts
/** What the learnings file keeps per game. Every new field is optional. */
interface RecentGame {
	// existing: matchId, playedAt, champion, win, diedBefore6, aheadAt15ThenDied
	playedAtMs?: number;                  // from info.gameCreation
	role?: string;
	opponent?: string;                    // absent when no lane opponent was found
	deaths?: number;
	signals?: Record<string, number>;     // costly deaths per cause signal
	killParticipation?: number;
	goldDiffAt15?: number | null;
	objectivesJoined?: number;
	objectivesTeam?: number;
}

/** The stored goal, a new top-level key of LearningsProfile. Numbers only. */
interface Focus {
	role: string;
	metric: string;                       // a cause signal or csAt10
	dir: "atMost" | "atLeast";
	target: number;                       // per game
	baseline: { deaths: number; killParticipation: number; objectiveShare: number | null; goldDiffAt15: number | null };
	setAt: number;                        // ms
}
```

Focus rules:

- Code picks the focus: the cause signal with the most costly deaths per game over the last 10 stored games in the player's most-played role, only when it has enough events and leads the next signal. When no signal qualifies, the non-death metric furthest below the one-trick reference, when a reference exists. The thresholds are set in step 5.
- A focus is judged over the next 5 games in its role played after `setAt`, then retired. The player can retire it sooner.
- `scoreFocus(focus, game)` is a pure function returning hit, miss, or skip. A hit needs the metric met and the guard held: deaths not above the baseline plus a margin, and none of kill participation, objective share, and gold difference below its baseline minus a margin. A `null` guard value is not checked. A game in another role is a skip.
- `objectivesMissed` and `leadNotConverted` become legal metrics once step 3 confirms the fields they need.
- Role rules: for a jungler `ganked` is never set. For a support `csAt10` is not a legal metric and the gold guard is not checked. A game with no lane opponent is skipped by any metric that needs one.

Rules the contracts must hold:

- The scene carries facts only. Cause and alternative are the coach's judgement and are not stored.
- An alternative may cite the place, who killed the player, teammates near against enemies in the kill, gold held, the level gap, and what followed. It may not cite wave state, vision, cooldowns, or summoner spells: the timeline has none of them. A lab check scans alternative rows for those words.
- Persistence: `sanitizeRecentGame`, `sanitizeLearnings`, `AuditGameResult`, the `foldAuditGames` return, and the fold mapping in `src/index.ts` all carry the new fields, or the next load or fold silently drops them. A bad field is dropped alone, never its game. The sort key is `playedAtMs ?? Date.parse(playedAt)`, newest first, ties broken by match id.
- Byte caps: scenes ride only on the newest game, at most 5, in one total order named in code. Every other game row carries its signal counts only. The trim drops scenes first, then the oldest games. `/review` reads the pattern from stored counts.
- Grounding: the passage text prints one line per scene the result carries, from the same selection function, ahead of the per-game lines, so the clip never cuts a number the model was shown.
- Learnings off: the focus block is computed in `src/index.ts` after the audit result and gated on the switch at that moment. The gateway never reads learnings. The post-game read makes no Riot call when learnings are off.
- Data files (AGENTS rule 5): `data/map-zones.json` holds named areas in Riot units with a validator and a skip-never-fatal loader, passed to `auditGame` through `AuditNames`. Dodge penalties and the lane-phase end live in a named data file too.
- Rows (AGENTS rule 2): the stop row changes whether to queue, the post-game row whether to run `/review last`, the focus row what to do next game, the dodge row whether to play. Every number is shown with its comparison.
- Prompt text (AGENTS rule 1): the signal glossary, the `/review last` prompt, the dodge row, and any reason the stop row words live in `coach.yaml`. The `<audit>` rule "no number outside the Next game row" is rewritten to allow scene numbers.
- Rule 3: the post-game read is a second automatic trigger and the owner rewords rule 3 before it ships. It is opt-in through `VOXREN_COACH_POST_GAME=1` until its cost is measured. It fires when the footer is in the lobby and the newest ranked game in the client history is not in the learnings file, which needs a game id on the history read. It runs single-flight, at most a pinned number of attempts per game, and waits on the next footer poll, never on an unref'd timer (rule 8).
- Docs that change with rule 3: `AGENTS.md`, `README.md`, `docs/lcu.md`, `docs/configuration.md`, `docs/privacy.md`, and the walkthrough page. `docs/privacy.md` also changes its learnings paragraph, its Jev row (scene facts now go into the audit passage), and its Riot API row. The header of `src/audit-metrics.ts` promises no enemy names beyond the lane opponent and is amended.
- The pool read (about 60 match calls) runs on `/review`, never unasked. A champion needs at least 3 games and a role at least 8 before either is listed.

## Options considered

| Option | Complexity | Riot and model cost | Measurable | Fits owner direction |
|---|---|---|---|---|
| A. Adopt the generic prompt's text | Low | None | Partly: the rubric lab grades five fixed queries, `/review` has no lab | No: self-reported profile, nothing tailored |
| B. Focus loop on death counts by the clock | Low, about 6 files | None beyond `/review` | Yes | No: rewards passive play |
| C. Player model with scenes, cause signals, and ledger | Medium to high | About 4 Riot calls per game end, more off the americas cluster, plus one pool read | Partly: see trade-offs | Yes |

Option C is chosen. Option B was the first proposal in the session and the owner rejected its headline.

## Trade-offs

- The alternative is a judgement over coarse facts. Teammate positions are known once a minute. A confident wrong alternative is the main risk. The word scan catches claims about things the timeline cannot show; nothing automated can judge the rest, so the owner reads real games before anything builds on it.
- The focus trend is weak evidence that coaching works. The focus is the worst of several signals, so the next games drift back toward the player's average with no change in play. With an average of 1.5 costly deaths on a signal, a cap of 1 is met in about 56% of games by chance. The trend is shown as five games, read beside the signals that were not picked, and never as one game's verdict.
- The guard uses kill participation, which a player can keep by arriving late to fights. It is a coarse check, and the death ceiling exists so that a generous worthwhile rule cannot hide feeding.
- The dodge row will fire rarely. The numbers the coach can source sit near even odds, and a first dodge pays only below 37.5%. A backtest over one player's history is too small to gate anything, since telling 37.5% from 50% needs about 100 flagged games, so it reports its count and nothing more.
- Two straight losses are common: for a player at 50% they describe one pair of games in four. A bare two-loss stop row would show often and say little.
- Code owns the count and the coach owns the wording. A free-text goal cannot be parsed back, so the stored goal is a metric and a number.

## Consequences

- Easier: tailoring any command to the player (a habit row in `/draft`, own history first in `/matchup`), telling a worthwhile death from a wasted one, reviewing one game in its own terms.
- Harder: the learnings file grows and every new field must be carried in five places, the audit result needs a scene budget, and rule 3 gains a second trigger to keep true in six documents.
- Revisit: the worthwhile rule, the signal thresholds, and the guard margins after the owner reads 20 real games. The dodge row's model tier, which is the quick tier today. The one-trick reference, which assumes one main champion.

## Verification

Each line is a test that runs a public function and asserts its output, unless marked.

- Fold game A, then fold B and A where B is later the same day: B is first. A stored game without `playedAtMs` still orders by `playedAt`.
- For a fixture cut from a real timeline, `DeathScene` names the killers, the zone, the gold held, the fight count, and what followed.
- A death followed by the team taking Baron is worthwhile and takes no signal. A solo death with a teammate's kill 20 s later on the far side of the map is costly. A one-for-one trade is costly.
- The last death of a won fight is worthwhile. A frontline death in a lost fight is costly with no cause signal.
- A death with no champion killer is `executed`, and `solo`, `ganked`, and `outnumbered` are not set.
- `scoreFocus` returns a miss for a game with zero costly deaths and kill participation below the guard, a miss for a game with ten deaths all marked worthwhile, and a skip for a game in another role or with no lane opponent where the metric needs one.
- A game with every new field and a `Focus` survive save, load, a second fold, and a `voxren_remember` call. A file written before this change loads with its games intact.
- An audit of 20 fixture games with 10 costly deaths each returns model text within the cap, scenes on the newest game only, and signal counts on every kept game. Every scene number in the result occurs in the passage text.
- With a `Focus` on disk and learnings off, the audit result has no focus block and the file is unchanged after an audit and a post-game trigger.
- A `/draft` answer ending in the queue-decision row is not scored as a setup row. A function that lists numbers absent from the tool results and the composition block returns none for a clean fixture answer and the offending number for a doctored one.
- A function that scans alternative rows returns the row for one that mentions wave, ward, vision, cooldown, or a summoner spell.
- Human look, not a gate a machine can hold: the owner reads the scenes for their last 20 real games and says whether the signals match what happened.

## Action items

1. [ ] Bring `mac-wip` (f346962, the champion-optional work) up to `origin/main` first: both touch the same files.
2. [ ] Same-day order: `playedAtMs` on `GameAudit`, the audit row, and the fold, with the fallback sort.
3. [ ] Save a trimmed real timeline as a fixture and confirm every field the scene uses. Then build scene, ledger, and signals as pure functions with tests, the zone data file, and a lab script that prints scenes for the owner's last 20 games. Stop for the owner's read.
4. [ ] Audit rows carry signal counts, the newest game carries scenes, and the passage text carries the scene lines. Rewrite the `<audit>` section and the `/review` description, add `/review last`, and retire the clock measures on the card and in the prompt.
5. [ ] Store the player model and the focus with `scoreFocus`. Add the focus row to the audit card. Remove the two clock focus areas.
6. [ ] Session guard in the lobby footer, then the post-game read behind its switch after the owner rewords rule 3.
7. [ ] Dodge: label lab drafts, add a dodge column and the ungrounded-number check, raise the `/draft` row count, stop the scorer from reading the new row as a setup row, and seed a fixture learnings file in the lab home. Then add the row.
8. [ ] Derived pool, the live pick as the command champion, and a position default that is not mid.
9. [ ] Open an issue that owns the two class-specific basics rows.

## Open points

- Which timeline fields exist: step 3 settles this. Frames may also carry health once a minute, which would widen what an alternative may cite.
- How soon Riot and the client list a finished game, and whether the client history carries a game id, a time, and a remake flag.
- The dev key's request limits, which are not in the repo. A 60-call pool read next to a 20-game audit may exceed them.
- Whether the client exposes dodge or queue-penalty state. No such endpoint is typed today, so the dodge row states the cost it assumes.
- "Dodge" is also a matchup-note label for an ability to avoid. Both prompts must say the row means leaving the lobby, or the row takes another label.

## Owner decisions still needed

- Session guard trigger: two losses in one session with deaths above the player's own average, three straight losses, or a bare two losses.
- Dodge row: accept that it fires rarely and states its assumed cost, or hold it until a source gives a composition win chance.
- Guard: include the death ceiling against the player's own average, or leave deaths out of the guard entirely.
- Focus picked by code and judged over five games in one role, or a different rule.
