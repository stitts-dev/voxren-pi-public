# Coach knowledge: doctrine, champion cards, doctrine judge and autoresearch

Date: 2026-09-27. Status: approved design, spec under review.

The Voxren monorepo carries a coaching mental model the Pi coach never got:
`prompts/coaching/knowledge/mastery.md` (19 KB of pro doctrine) plus the
coaching-craft rules spread across `prompts/coaching/{live,scout,personas}/`.
The Pi coach's system prompt (`coach.yaml` `prompts.system`, 4.1 KB) holds
format and grounding rules only. This spec moves the doctrine into the Pi
coach, adds a stored per-champion knowledge base, and builds a Jev judge set
plus an autoresearch loop that tunes the coach against it.

Three sub-projects, built in order, each with its own implementation plan:

- **S1 Doctrine**: basics and mastery rows in `coach.yaml`, in the system prompt.
- **S2 Champion cards**: `data/champions/<id>.json`, Data Dragon facts plus a grounded coaching layer.
- **S3 Doctrine judge and autoresearch**: Jev questions that enforce doctrine ids, an eval set, and a measured edit loop.

## Goals

1. The coach reasons from the full doctrine on every answer, not from general model knowledge.
2. Stable champion knowledge (kit facts, damage profile, spikes, comp role) is on disk, stamped with its patch, and needs no fetch while current.
3. A prompt, model, or tool-description change is kept only when a calibrated judge says it made answers better beyond run-to-run noise.

Not goals: goal and
playstyle overlays (the profile has no field to feed them), fine-tuning, any
automatic champ-select behavior (AGENTS rule 3).

## Decisions

| Id | Decision |
| --- | --- |
| D1 | Autoresearch may edit `doctrine`, `prompts.system`, `agent.model`, and `tools.*` descriptions in `coach.yaml`. Jev questions are the ruler and stay fixed during a loop. |
| D2 | Every insight from the source inventory below migrates at full detail. Humor voices, Ren/Vox personas, TTS and JSON output formats, and the rune catalog do not: they are voice or hardcoded game data, not doctrine. |
| D3 | Doctrine has two layers, `basics` and `mastery`. |
| D4 | Champion knowledge is stored in the repo, one file per champion. |
| D5 | All doctrine goes into the system prompt (about 1k to about 6k tokens). Move mastery behind a lookup tool only if the S3 lab shows cost, latency, or answer-quality harm from inlining it. |
| D6 | The main champion's card (`agent.champion` / profile) renders into the system prompt. Every other champion's card is read through `voxren_game_facts`. |
| D7 | A card is Data Dragon facts plus a grounded coaching layer. Per-matchup notes are separate, per player, and built on demand: the first lookup of a matchup starts a background build from recent matchup videos and written guides (`src/matchup-note-build.ts`), stored in the coach home and returned by `voxren_meta_research` (matchup) as a citable passage. Reversed on 2026-10-01: the first version said no per-matchup notes, and live web search alone gave neither the depth nor the agreement between sources. Notes are not shipped in the repository: which matchups matter depends on the player's champion and lane. |
| D8 | Lane strategy and composition theory are doctrine rows (`lane.*`, `comp.*`). A champion's comp role is a card field. `/comp` applies both to a live lobby. |
| D9 | The autoresearch driver is a native Claude Code workflow. The lab script measures only; no custom proposer code. |

## Source inventory

Every file under `voxren/prompts/` was read. Destination per source:

| Source | Content | Destination |
| --- | --- | --- |
| `coaching/knowledge/mastery.md` prime directives, roles, wave, matchups, micro, itemization, behind/ahead, mental | fundamentals | `doctrine.basics` |
| `mastery.md` tempo, macro chain, vision, objectives, jungle, teamfighting, draft, solo queue, elo bottleneck ladder | advanced play | `doctrine.mastery` |
| `mastery.md` lane-specific rows (role jobs, lane geometry, jungle) | lane play | `doctrine.basics` `lane.*` |
| `mastery.md` draft and archetype rows | comp theory | `doctrine.mastery` `comp.*` |
| `mastery.md` coaching guardrails | tier tagging, never-from-memory list | merged into `prompts.system` rules already present; tier tagging to `calibration.*` |
| `scout/rank_calibration_{low,mid,high,elite}.md` | per-tier depth | `doctrine.basics` `calibration.*` |
| `live/lens_map.md` | the map not the shop, name what to give up, be specific or say nothing | `doctrine.basics` `craft.*` |
| `live/deathline_system.md` | one instruction, never restate what the player sees, "why" is a read | `doctrine.basics` `craft.*`, adapted from death-screen to chat |
| `scout/banned_phrases.md`, `synthesis/champion_synthesis.md` BAD/GOOD | anti-generic | `doctrine.basics` `craft.specific` |
| `personas/coach.md` confidence ledger, data overrides narrative, answer the asked fork, verdict closer | coaching craft | `doctrine.basics` `craft.*` where `prompts.system` lacks it |
| `live/voice_smurf.md`, `personas/coach.md` caveman and length rules | voice | dropped: the Pi rows format wins |
| `scout/goals_overlay.md`, `scout/playstyle_overlay.md` | personalization | dropped until `Profile` carries goals or playstyle |
| humor/, `personas/{ren,vox}*.md`, compose/, `scout/*_format.md`, `copilot/`, `draft/`, `synthesis/researchers/`, `lab/*` | voice, output formats, pipeline prompts, rune catalog | not migrated |

## S1 Doctrine

### Contract

```yaml
doctrine:
  basics:
    - id: prime.death-cost
      rule: "Dying is the most expensive action ... name what the team got for it, or do not take the risk."
  mastery:
    - id: objective.ev
      rule: "..."
```

- `id` matches `^[a-z]+(\.[a-z0-9-]+)+$` and is unique across both layers. The first segment is the group: `prime`, `role`, `lane`, `wave`, `trade`, `tempo`, `macro`, `vision`, `objective`, `jungle`, `fight`, `build`, `comp`, `state`, `soloq`, `mental`, `calibration`, `craft`.
- `rule` is one non-empty line of guidance.
- Ids are stable. Rewording a rule keeps its id; S3 questions and autoresearch diffs cite ids.
- `src/contracts.ts` validates `doctrine` when it loads `COACH_YAML` and throws on a bad id, a duplicate, or an empty rule.

### Assembly

`coachSystemPrompt` appends, after `prompts.system` and before the per-launch
rows: a one-line basics label, the basics rules as `- ` rows, a one-line
mastery label, the mastery rules, then (once S2 lands) the main champion's card. Ids do
not render. The two labels live in `coach.yaml` under `prompts`.

### Migration edits

1. No champion or item names in doctrine (AGENTS rule 5). "Zed, Talon, Kha'Zix deal physical; Maw is useless" becomes "name the threat's damage type from game facts before choosing the resist".
2. Game-fact numbers become cues: "about the 7th minion" becomes "the level-2 race". Coaching heuristics stay as rules: "lose 2, take a break; lose 3, stop".
3. No voice or length rules: `prompts.system` owns format.
4. The dead reference to `volatile-to-tool.md` is dropped.
5. No row restates a rule `prompts.system` already has: a death is a trade, match resist to the killer, a spent Flash is the kill window, pushback is authoritative.

### Size gate

A `contracts.test.ts` case builds the full system prompt (doctrine plus the
largest checked-in card) and asserts it is under 32 KB. Crossing the cap is
the trigger for D5's fallback, not a reason to raise the cap.

### Verification

- `bun test src/contracts.test.ts`: every doctrine rule appears in the assembled prompt; a duplicate id, bad id, or empty rule throws; the size gate holds.
- `coach -p` on the five current rubric-lab queries before and after; read both. Reported, not asserted.

## S2 Champion cards

### Contract

`data/champions/<id>.json`, where `<id>` is the Data Dragon champion id:

```json
{
  "meta": { "patch": "16.19", "generated": "2026-09-27", "model": "...", "sources": [{ "id": "web-3", "title": "...", "url": "..." }] },
  "id": "Fizz",
  "name": "Fizz",
  "facts": {
    "tags": [], "resource": "", "stats": {},
    "passive": { "name": "", "text": "" },
    "spells": [{ "slot": "Q", "name": "", "cooldown": [], "cost": [], "range": [], "text": "" }]
  },
  "coaching": {
    "damage": { "value": "", "sources": [] },
    "archetype": { "value": "", "sources": [] },
    "axis": { "value": "", "sources": [] },
    "spikes": [{ "at": "", "why": "", "sources": [] }],
    "bait": [{ "slot": "", "why": "", "sources": [] }],
    "winCondition": { "value": "", "sources": [] },
    "mistakes": [{ "value": "", "sources": [] }],
    "comp": { "tags": [], "sources": [] }
  }
}
```

- `facts` is copied from Data Dragon `championFull.json`, never model-written.
- Every `coaching` row has at least one source id, and every cited id is in `meta.sources`. `game-1` denotes the Data Dragon facts of the same patch.
- `comp.tags` values come from a fixed set: `engage`, `peel`, `poke`, `pick`, `split`, `scale`, `dive`.
- Lane play rates are not copied: they stay in `data/championRoles.json`.
- A loader and validator in `src/champion-card.ts` (same shape as `src/otp-reference.ts`) reject a file that breaks any rule above.

### Generation

`src/lab/refresh-champion-kb.ts`, a lab run by hand, never loaded by the
coach, output committed. Mirrors `src/lab/refresh-champion-roles.ts`.

1. Fetch `championFull.json` for the current version; write `facts`.
2. Gather a fixed passage set per champion: `web_search` results through the existing Jev passage screen (`evidence` route only), plus the Data Dragon spell text as `game-1`.
3. The configured model drafts the coaching rows, citing only passage ids from step 2.
4. Each row goes through the grounding gate (`src/grounding-judge.ts`). `grounded` rows are kept; `unsupported` and `contradicted` rows are dropped and printed.
5. Write the card with `meta.patch`. A champion whose run fails keeps its previous file and is reported.

Pilot on 5 champions first. Record cost, wall time, and dropped-row rate
before running all 173.

### Runtime

`voxren_game_facts` (no new tool):

- Loads the stored card for each requested champion.
- Card patch equals the live Data Dragon version: returns the stored facts plus `coaching`. Otherwise: live facts, the stored `coaching` marked stale with its patch.
- Registers the card's coaching rows as evidence `kb-<id>` in `src/evidence-store.ts`, so `voxren_strategy_frame` can ground claims against it.
- A champion with no card behaves exactly as today.

### Verification

- `bun test`: every file in `data/champions/` passes the validator; the lab's Data Dragon parser on a fixture; `voxren_game_facts` on the fresh-card, stale-card, and no-card paths.
- `coach -p "how do I lane into Syndra"` with the Syndra card present: read that the answer uses the card and the tool card shows `kb-Syndra`.

## S3 Doctrine judge and autoresearch

### Judge contract

```yaml
jev:
  doctrine:
    names_tradeoff:
      type: noul
      enforces: [craft.give-up]
      instructions: "{{untrusted}} Does the answer name what the player should give up and what to take with the time it buys?"
      criteria:
        "true": "..."
        "false": "..."
```

- Every `enforces` entry resolves to a doctrine id or an id prefix ending in `.*`. `contracts.test.ts` fails on one that resolves to nothing.
- First set, about 10: `generic_copout`, `names_tradeoff`, `death_as_trade`, `resist_matches_threat`, `one_sentence_win_condition`, `leads_with_one_fix`, `tier_fit` (choice over tiers), `contrast_reason`, plus the four existing `jev.answerRubric` questions.
- `unsourced_number` criteria exclude doctrine heuristics (break after 2 losses) from "game number".
- Per answer, the lab also records the grounded, unsupported, and contradicted claim counts from `voxren_strategy_frame`, plus tokens and cost, read from `<coach home>/exchanges.ndjson` (`src/exchange-log.ts`).

### Eval set

`data/eval/queries.json`: `[{ "id", "query", "split": "train" | "holdout", "tier"?, "applies": [questionId] }]`.
About 40 queries (30 train, 10 holdout) covering each lane, mental, macro,
comp, builds, deaths, and every tier. `applies` is set by hand; the four
`answerRubric` questions apply to all. The five queries now hardcoded in
`answer-rubric-lab.ts` move here.

### Calibration

`data/eval/labels.json`: the owner's yes/no labels on about 30 stored
answers per doctrine question. The lab reports Jev agreement per question at
its threshold. A question under 0.8 agreement is excluded from the keep
decision until its criteria are fixed.

### Lab

`src/lab/answer-rubric-lab.ts` gains `--split train|holdout`, `--runs N`
(default 3), and the doctrine questions. Output per run goes to the private
`--out` directory: answers, grades, claim counts, and a summary with per-question
means and spread. `--replay` grades stored answers without running the coach.

Noise floor: run the baseline twice; the per-question spread between the two
runs is the floor.

### Loop

A Claude Code workflow drives one hypothesis per iteration:

1. Read the train summary: failing questions, the doctrine ids they enforce, the worst answers.
2. Propose one edit inside D1's surface.
3. Rerun train.
4. Keep when the mean doctrine score gains more than twice the noise floor and no guard regresses: contradicted claims, `unsourced_number`, the 32 KB size gate. Otherwise revert.
5. Append one ledger row: edit, before, after, kept.

After the loop, run holdout once. The proposer never reads holdout queries or
answers. The owner reads the biggest answer diffs before a merge.

Pilot one iteration first and record wall time and dollars (about 90 coach
runs and 900 Jev calls). If too slow, cut to `--runs 2` or 20 train queries.

### Verification

- `bun test`: `enforces` ids resolve; `queries.json` and `labels.json` validate; `--replay` on a fixture produces a fixed summary.
- One real pilot iteration with its ledger row read by the owner.

## Open items

| Id | Item | Default |
| --- | --- | --- |
| OI1 | Per-lane doctrine beyond the ~10 source rows is new content, not migration. | Model drafts `lane.*` rows; the owner approves them before they land. |
| OI2 | Model that writes the champion cards. | The coach's configured model; autoresearch may change it. |

## Risks

| Id | Risk | Mitigation |
| --- | --- | --- |
| R1 | Tuning against Jev games the metric. | Fixed questions, hand-label agreement gate, holdout split, owner reads diffs. |
| R2 | Five queries run once is noise. | 40 queries, 3 runs, measured noise floor. |
| R3 | Coach output varies run to run. | Means over runs; keep only above twice the floor. |
| R4 | Stored cards go stale every patch. | Patch stamp, live facts on mismatch, stale flag in the tool result. |
| R5 | Inlined doctrine dilutes attention. | Run the S3 lab at the pre-S1 commit and at S1 on the same queries; D5 fallback to a lookup tool if S1 loses. |
