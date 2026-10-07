# /comp advice-quality lab

The supervised loop for issue #30: measure `/comp` output against `coach.yaml`'s rules (rows not
prose, no bold or links, hedge unknown roles, one setup row, name a build) across lanes, catch a
regression before it ships, one prompt change at a time. Built on `src/lab/draft-lab.ts` (the
sweep and scorer) and `src/lab/tui.ts` (real-UX verification, rung 4 in `agent-terminal.md`).

## The six scenarios

Mined from real sessions (issue #30). `data/lab/drafts/`:

| # | File | Shape |
| --- | --- | --- |
| S1 | `s1-malz-velkoz-open-lanes.ndjson` | Champ select, 3 of 5 allies locked, all 5 enemies open |
| S2 | `malz-velkoz-teemo.json` | Champ select, full draft |
| S3 | `s3-pyke-picks-early.ndjson` | Champ select, 4 of 5 allies locked, 3 of 5 enemies locked |
| S4 | `pyke-picks.json` | Champ select, full draft — the golden reference (relayed, team won) |
| S5 | `s5-jayce-zyra-early-game.ndjson` | In game, 0:23, fresh spawn |
| S6 | `zed-support-dive.json` | Champ select, full draft |

`.json` files are `Draft` descriptors (`src/lab/drafts.ts`) expanded pick-by-pick by
`draftFrames()`. It cannot represent a team slot that stays open (an ally position missing from
`myTeam` is dropped from the whole cell roster, not shown as unconfirmed) or a partially-locked
enemy team, so S1 and S3 are hand-authored `.ndjson` frames instead: one line, the raw
`/lol-champ-select/v1/session` body, all 5 `myTeam` cells present with `assignedPosition` set and
`championId: 0` for the open ones (`src/lcu.ts`'s `LcuChampSelectMemberWire` is the wire shape).
S5 is a raw `/liveclientdata/allgamedata` dump, one JSON object per line (`LiveClientPlayerWire`).
Champion IDs for hand-authored fixtures come from Data Dragon (`championIds()` in
`src/lab/drafts.ts`), never a hardcoded constant (AGENTS.md rule 5).

## Running a sweep

```bash
bun run src/lab/draft-lab.ts data/lab/drafts/*.json data/lab/drafts/s1-*.ndjson data/lab/drafts/s3-*.ndjson \
  --models gpt-6-sol,gpt-6-luna --n 5 --parallel 5 --out /tmp/comp-lab-<round>
# S5 (or any single live-client scenario) needs its own run with --minutes 0:
# the default --minutes 5,14,25 all snap to the same 23s frame and collide on one labHome dir.
bun run src/lab/draft-lab.ts data/lab/drafts/s5-jayce-zyra-early-game.ndjson --minutes 0 \
  --models gpt-6-sol,gpt-6-luna --n 5 --parallel 5 --out /tmp/comp-lab-<round>-s5
```

n=1 is noise (issue #30) — n=5 per scenario per lane is the floor for treating a number as a
finding rather than a bad roll. Cost is real but small: ~$0.7-0.9 total for a 60-run sweep across
both approved lanes (`coach.yaml`'s `agent.models`), luna running ~25x cheaper than sol.

## Scorer fields (`src/lab/draft-lab.ts`, `score()`)

| Field | Checks | Caveat |
| --- | --- | --- |
| `hedges` | "unconfirmed", "no one is ahead", etc. | — |
| `enemiesNamed` | fraction of the scenario's enemies mentioned by name | — |
| `buildRows` | rows naming a purchasable item; rule is at most 1 | — |
| `leaks` | `**bold**`, markdown links, `⟦evidence-id⟧` | matches `coach.yaml`'s "never write a source id in an answer row" |
| `proseRows` | rows with 3+ sentences — a bullet marker doesn't save a row from being prose | real, both lanes: scored retroactively across 130 collected answers, sol 90% of runs / luna 77% of runs have at least one row this dense. Example (`s1-malz-velkoz-open-lanes-final-gpt-6-sol-0`): `- Lane phase: Malzahar cannot promise early mid priority, and the bottom carry is still open. Start top side, clear toward bot, and check mid on the way. Gank only a committed enemy; do not force a river fight without lane priority.` — bulleted, 3 sentences. the `/comp` prompt's "one call of 16 words or fewer" per row (the system prompt's old "Rows, not prose" rule, since loosened for between-game answers) is violated by density, not by missing bullets; the `/comp` prompt's 4 named categories (win conditions, lane phase, the fight, setup) may just not fit in one sentence each — no fix attempted yet, flagging for a product call before editing. |
| `setupUngrounded` | an item in the setup row (the row labelled `Setup:`; the last row for a `/comp` or `/draft` answer with no such label) with neither an OP.GG citation nor a named damage-type/CC threat (`THREATS` in `draft-lab.ts`) | F3, closed round 5, fixed round 6. Was "item string not in any `voxren_meta_research` result" — flagged sol far more than luna (round 5: 5/30 vs 0/30 on the six canonical scenarios; rounds 2-4: ~9/30 vs ~2/30) because sol counter-itemizes against a named enemy ability (Quicksilver Sash vs Malzahar's suppression, Mercury's Treads vs enemy CC/magic damage) while luna's "grounded" rows mostly parrot OP.GG's most-picked stat verbatim. The two checkable mechanical claims in round 5's flagged rows were verified against live Data Dragon 16.19.1 (the source `voxren_game_facts` reads): QSS "Remove all crowd control debuffs (excluding Airborne)" confirms both "removes the lockdown" (suppression, not excluded) and "will not remove Wukong's knockup" (Airborne, excluded). Fix (round 6): an item with a named threat in the row clears the flag even without an OP.GG citation, since that's the `/comp` prompt's own contract for the row, not a grounding claim. Re-run after the fix: sol 0/35, luna 0/35 (all 7 non-S5 scenarios, n=5). An item with no OP.GG citation and no named threat still flags. |
| `setupThreatMismatch` | an item claimed to remove/cleanse a threat its own Data Dragon description excludes (e.g. "removes Wukong's knockup" for a cleanse item that excludes Airborne), without a nearby negation | F1 (docs/comp-lab.md — added round 7): A1 only checks that a row names *a* threat, never that it's the *right* one for the named item; this catches the one concrete, checkable mismatch pattern (`src/lab/setup-threat.ts`, tested against a real and a planted-wrong claim in `setup-threat.test.ts`). Zero hits across round 7's 70 runs — neither model has made this mistake yet; the field exists so a future regression doesn't hide behind A1's fix. |
| `rows` | rows in the answer; a `/pick` Dodge row makes it 3 | — |
| `setupRunes` | rune names (Data Dragon `runesReforged.json`) in the setup row; `/pick`'s Setup row should give one or two changes against the matchup page, so more than two is a listed page | whole words, any case; stat shards are not in that file and are not counted; a rune named like a common word (Guardian, Last Stand) can false-match |
| `words`, `tools`, `ms`, `costUsd` | — | — |

`enemiesNamed` is a poor fit for S5 specifically: at 0:23, fresh spawn, nothing differentiates 4
of 5 enemies yet, so a focused answer naming only the lane opponent and the immediate jungle
threat (luna, both n=5 and n=15 checks) reads as correct coaching, not an omission — read low
scores there qualitatively before treating them as a defect.

String rules only; row-1-is-a-team-plan and "could a teammate act on row 1" stay a human read of
`report.md`, or an opt-in Jev judge (the story runner's rubric grade, `answer-rubric.ts`, is the pattern; `setup-pairwise-lab.ts`
below is the setup-row instance of it).

## Setup pairwise judge (A2)

`src/lab/setup-pairwise-lab.ts` answers what the string scorer can't: given two models' setup rows
for the same draft, which is actually better coaching. It reads an existing sweep's
`results.ndjson` (no new coach calls), pairs same `(scenario, at, rep)` runs across exactly two
models, and asks TypeSafe System One (Jev) a blind A/B choice question. Needs `TYPESAFE_API_KEY`;
if unset in the shell, it's the same key the coach itself reads from
`~/Library/Application Support/voxren-coach/.env` (macOS) — source that file's `TYPESAFE_API_KEY`
line into the shell before running.

```bash
bun run src/lab/setup-pairwise-lab.ts <draft-lab out dir> [<more out dirs>...] --out <dir>
```

Round 6's first pass judged each pair once with a random A/B order: 40 pairs, sol 27 (68%), luna 13
(33%), but the judge itself showed real position bias — slot A won 26/40 (65%) regardless of model.
The round-6 writeup argued the effect survived a position-conditioned split (81% as A vs 65% base,
53% as B vs 35% base) — a second adversarial pass (opus) pushed back: that split's sub-samples (21
and 19 pairs) are each too small to trust on their own, and the "does the edge survive" framing
undersold how close the base-rate correction can get with a cleaner design.

Round 7 (verification pass) rebuilt the script to judge every pair in **both** slot orders and only
count a win when both orders agree — this cancels the position bias by construction instead of
arguing around it. Same 40 pairs (fresh sweep, post-F1): 33/40 (83%) agreed across orders (the 17%
disagreement is the judge's own noise floor); of the 33 confirmed, sol won 27 (82%), luna 6 (18%).
Length check: of 31 confirmed pairs with a clear longer row, the longer row's model won 22 (71%) —
above the 50% a length-blind judge would show, so some of sol's win rate likely reflects sol's rows
usually being longer and more specific, not purely coaching quality; this design can't fully
separate the two.

**Human calibration (N2, opus's ask): failed, 6/10.** First 10-question quiz was rejected as too
easy — a second adversarial pass (opus, given all 40 pairs' text) found 13/40 were near-duplicate
content (sol and luna recommending the same thing in different words, e.g. all 5
`s1-malz-velkoz-open-lanes` pairs), where Jev's "winner" is arbitrary wording preference, not
signal; the original 68%-sol answer key also meant "always pick the sol-sounding row" alone scored
~8/10 without judging anything. Rebuilt with 10 pairs selected to have a real substantive gap,
answer key balanced 4/6 so guessing one letter caps at 60%. User graded them blind: 6/10 agreement
with Jev, below the 8/10 bar. Not uniform: 2 of the 4 mismatches look like Jev's own misses, not the
human's — one pair had luna naming Ekko an "AD" threat (Ekko is AP; the human avoided that row, Jev
picked it anyway) and one was a pair opus had already flagged pre-quiz as a likely bad Jev call
(Quicksilver Sash vs Banshee's Veil for a suppression threat), where the human's pick matched opus's
suspicion, not Jev's. A third adversarial pass (opus) ruled: **Jev fails the bar — don't extend the
judge to the whole `/comp` output (N4) on this evidence, and downgrade F3's "closed" status and
A2/N1's 82% sol win rate to directionally suggestive, not confirmed.** The narrower "Jev only
struggles on close calls" reading doesn't hold either — rescoring after seeing which mismatches look
defensible is not what an 8/10 bar set in advance is for.

One cheap check survived, though, using data already collected (no new judge calls): opus's
hypothesis that sol's whole 82% could just be "Jev/humans prefer specific answers, and sol names an
item more often than luna" — re-split the 33 confirmed pairs by whether BOTH rows name a specific
item/summoner (not just one committing over a generic "standard setup holds"): even there, sol wins
14/17 (82%), same ratio as overall. Sol's edge isn't explained by out-naming luna on specificity
alone — it holds in the apples-to-apples subset too. That doesn't rescue Jev as a general judge (it
still can't settle a real "which counter is better" dispute like QSS vs Banshee's Veil, per opus),
but it's real evidence the sol/luna setup-row gap itself isn't a pure specificity artifact.

Net: A1 and F1 (string-level scorer fixes) stand on their own verification (re-run sweeps, unit
tests). A2/N1's LLM-judge-based numbers do not clear the bar set for trusting them outright; treat
"sol writes better setup rows" as a working hypothesis with supporting-but-not-decisive evidence,
not a settled finding. Extending the pairwise judge to the rest of `/comp`'s output (win conditions,
lane phase, the fight) is not recommended until Jev itself is hardened — opus's suggestion: extend
`setup-threat.ts`'s pattern to check damage-type/item-effect claims before the judge call, which
would have caught the Ekko mismatch, though it can't resolve a genuine "which counter is better"
disagreement like item 5. Not built this round.

## Verifying a fix in the real UI

A scorer number can hide what the fix actually changed on screen. After a `coach.yaml` edit, grab
one real terminal capture on the scenario that showed the defect most:

```bash
node src/lab/tui.ts --replay data/lab/drafts/<scenario> --step 200 --send "/comp@3" --for 60 --every 0
```

`--step 200` replays the draft fast enough that the composer sees the final locked state by 3s
(the default 3000ms/frame step means `/comp@2` on a 10-pick draft fires mid-draft — which is its
own useful edge case to check, just not what you want when verifying a final-state fix). See
`docs/agent-terminal.md` for the full ladder and `tui-test` setup; if `node_modules/@microsoft/tui-test`
is missing in a fresh worktree, `npm install @microsoft/tui-test@0.1.0-beta.5 --no-save` pulls the
pinned version without touching `package-lock.json`.

## Loop discipline

1. One change to `coach.yaml` per round. Never chain edits without a check-in.
2. Re-run the full sweep (all scenarios, both lanes, n>=5) after every change — not just the
   scenarios that showed the defect, to catch collateral damage.
3. Grab one real `tui.ts` capture on the worst-affected scenario, before and after, so the review
   isn't scorer numbers alone.
4. Report the delta (aggregate table + per-scenario detail for anything that moved), as a widget
   (metric cards + a before/after bar chart for the one metric that changed), not a raw markdown
   dump.
5. Stop and wait for a decision before the next change.
