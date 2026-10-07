# Jev integration: grounding gate, OP.GG screen, answer rubric lab

Date: 2026-09-27. Status: approved design, awaiting `TYPESAFE_API_KEY`.

Jev (TypeSafe System One, `POST https://api.typesafe.ai/v1/systemone`) answers
closed questions over a JSON state: `noul` (yes/no probability), `choice` (one of
up to 255 named options with per-option probabilities), `score` (2 to 10 rubric
levels). It never writes text. Code owns every threshold and every action.

The coach already runs a Jev passage screen on `web_search` results
(`src/passage-judge.ts`, three nouls per passage, all-or-nothing, fail-open to
"unscreened"). This spec adds three uses on top of that screen and one rule fix.

## Goals

1. Trust: the coach's advice is checked against the evidence it cites, and
   every third-party text the model reads is screened for planted instructions.
2. Prompt quality: a cheap, repeatable grade for `coach.yaml` edits.

Not goals: routing between models, compaction, anything that watches champ
select, anything that judges numbers the code already computes.

## Decisions

| Id | Decision |
| --- | --- |
| D1 | `voxren_strategy_frame` takes a required `claims` list. |
| D2 | The frame's canned `options`, `risks`, `next_test`, and the `constraints` input are deleted. The frame is claims, routes, and citations. |
| D3 | All Jev question text moves to `coach.yaml` under a `jev:` section (AGENTS rule 1). This includes the existing passage questions. |
| D4 | Grounding thresholds are measured in a lab on planted claim/passage pairs before the live gate ships. No cookbook default goes live unmeasured. |
| D5 | OP.GG text is screened by the existing passage judge. The README's "OP.GG text never reaches TypeSafe" boundary was scope, not privacy, and is replaced. |
| D6 | Jev withholds or flags; it never vouches. Any Jev failure leaves the caller's data intact and says nothing was judged. |

## Pieces

Build order: S2, S4, S1, S3-lab, S3, S5. A0 runs the day the key lands.

### A0. Calibrate the existing passage screen (human step)

Run `bun run src/lab/passage-judge-lab.ts --out <private dir>` with
`PERPLEXITY_API_KEY` and `TYPESAFE_API_KEY` set. Fit `PASSAGE_THRESHOLDS` from
`summary.md`. Commit the new thresholds with the precision/recall numbers in the
commit message. No code change beyond the three constants.

### S2. Shared transport: `SystemOneClient`

Pull the network half of `PassageJudge` into `src/systemone.ts`:

```ts
type Question =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; options: Record<string, string> }
  | { type: "score"; instructions: string; levels: Record<string, string> };

interface AskResult { model: string; inputTokens: number; answers: Record<string, unknown> }

class SystemOneClient {
  constructor(options: { apiKey: string; fetchImpl?; url?; model?; timeoutMs? });
  ask(state: Record<string, unknown>, questions: Record<string, Question>, signal?: AbortSignal): Promise<AskResult>;
}
```

`ask` throws `JudgeFailure(reason)` with the existing taxonomy
(`timeout | network | authentication | rate_limited | server | response | input`).
Byte caps (`MAX_JUDGE_REQUEST_BYTES`, `MAX_JUDGE_RESPONSE_BYTES`),
`redirect: "error"`, bearer auth, and the abort race move with it.
`PassageJudge` keeps `scrubIdentifiers`, `routeFor`, the question set, and the
all-or-nothing batch, and calls `ask`. Behavior of the web screen is unchanged;
`src/passage-judge.test.ts` passes without edits to its assertions.

### S4. OP.GG injection screen

In `LiveResearchGateway.opggOverview`, when `options.passageJudge` is set, judge
one passage `{ id: "meta", title, domain: "op.gg", text: summary }` with the
request label as the query. `scrubIdentifiers` already masks Riot IDs from
`top_players`.

- `withheld`: `summary` becomes `""`, `judgment.answer = "withheld"`.
- `off_topic`, `weak`, `evidence`: summary kept as is; route recorded in
  `judgment` only. Relevance is ill-posed for structured aggregate rows, so it
  never removes anything here.
- Judge unavailable: summary kept, `judgment.status = "unavailable"`.

`judgment` has the same shape as the `web_search` one, so `judgmentLine` in
`src/ui.ts` renders it on meta cards too. README "Jev" and "Privacy boundaries"
paragraphs updated. Cost: one Jev request per meta call.

### S1. Evidence text store

`LiveResearchGateway.observedEvidence` changes from `Set<string>` to
`Map<string, { source: EvidenceReference["source"]; text?: string }>`, bounded
to 64 entries, oldest evicted. `response()` fills it:

| Source | Stored text |
| --- | --- |
| `web_search` | the kept snippet (already ≤ 300 chars) |
| `voxren_meta_research` | `summary` (already ≤ 4000 chars) |
| game facts, player audit, otp build | none: first-party, code-verified, never judged |

`close()` still clears it. Unknown ids in a frame call still throw `VALIDATION`.

### S3-lab. Grounding lab (measure first, D4)

`src/lab/grounding-lab.ts --out <private dir> [--corpus <passage lab dir>]`.

- Planted set: claim/passage pairs with known labels for `supported` and
  `contradicted`, covering: exact restatement, paraphrase, number changed,
  wrong champion, unrelated passage, imperative game advice, and a passage that
  supports the opposite.
- Real set: claims drafted by hand against `corpus.json` from the passage lab,
  labeled in `labels.json` like the passage lab does.
- Output: `results.json` (per pair probabilities), `summary.md` (precision and
  recall for `supported` and `contradicted` at a threshold sweep 0.4 to 0.8 in
  steps of 0.05, plus the `source` choice accuracy).
- `GROUNDING_THRESHOLDS` are set from `summary.md` and committed with the
  numbers. Nothing under `src/lab/` writes into the repository.

### S3. Grounding gate in `voxren_strategy_frame`

Tool schema (`src/tools.ts`):

```ts
{
  question: string (3..1200),
  claims: string[] (1..8 items, each 1..240),
  evidence: { id: string }[] (1..12),
}
```

Per claim, one Jev request through `SystemOneClient.ask`:

- state: `{ claim, passages: [{ id, text }] }` for the cited ids that have
  stored text. Nothing else in state; Jev is sensitive to extra fields.
- questions (text in `coach.yaml jev.grounding`): `supported` noul,
  `contradicted` noul, `source` choice over the passage ids plus `none`.
- Route in code, in `src/grounding-judge.ts`:

```ts
function routeClaim(p, thresholds): "contradicted" | "grounded" | "unsupported"
// contradicted >= thresholds.contradictedMin  -> "contradicted"
// else supported >= thresholds.supportedMin   -> "grounded"
// else                                        -> "unsupported"
```

Batch is all-or-nothing like the passage screen. Requests run in parallel,
capped at 8 claims, one 3 s timeout for the batch.

Response `data`:

```ts
{
  goal: string,                          // clipped question
  claims: Array<{
    claim: string,
    route: "grounded" | "unsupported" | "contradicted" | "not_judged",
    p?: { supported: number; contradicted: number },
    source?: string,                     // evidence id when grounded
  }>,
  citation_ids: string[],
  judgment: { judge: "jev", status: "judged" | "unavailable", ... }  // same shape as web_search
}
```

- No judge configured: every claim is `not_judged` and no `judgment` field is
  present, mirroring `web_search` without a key.
- Judge configured but no cited id has stored text: every claim is
  `not_judged`, `judgment.status = "unavailable"`, reason `"input"`.
- Judge fails: every claim `not_judged`, `judgment.status = "unavailable"`.
- The gate never removes a claim. The model decides what to do with the route;
  `coach.yaml` tells it to drop `unsupported` rows or flag them in five words,
  and to name `contradicted` rows with their source.

Card (`src/ui.ts`, `strategy_frame` case): one row per claim, route first, then
the source id when present, then the claim clipped to the width. Row colour by
route: `grounded` normal, `unsupported` warn, `contradicted` error,
`not_judged` dim. The `judgmentLine` renders under the rows. The `options`,
`risks`, and `next test` rows are gone (D2).

`coach.yaml`: tool description rewritten for the new input; the `passageJudge`
addendum grows one paragraph on the frame; `jev.grounding` holds the three
questions. System prompt tool list updated to "check the claims you will state
against cited evidence ids".

### S5. Answer rubric lab

`src/lab/answer-rubric-lab.ts --out <private dir> [--replay] [--baseline <dir>]`.

- Runs `node bin/coach.mjs -p "<query>"` for a fixed query set (matchup, build,
  patch, review, one open question), stores stdout per query in `answers.json`.
  Needs the coach signed in and `PERPLEXITY_API_KEY`; `--replay` skips the run.
- Per answer, one Jev request: `score` on a 2 to 10 rubric built from the system
  prompt's rules (rows not prose; exact action, no hedge; numbers labeled with
  a source; contrast-style why), plus nouls `has_intro_or_closing`, `hedges`,
  `unsourced_number`. Question text in `coach.yaml jev.answerRubric`.
- Writes `results.json`, `summary.md`; with `--baseline`, a per-query delta.
- A lab, not a test: it never runs under `bun test` and never fails CI.

### S6. Jev question text in `coach.yaml`

New top-level `jev:` section with `passage`, `grounding`, and `answerRubric`
maps. `CoachYaml` gains the matching type. `src/passage-judge.ts` reads
`COACH_YAML.jev.passage` instead of the `PASSAGE_QUESTIONS` literal; the export
stays as an alias so tests and the lab keep working.

## Contracts pinned as checks

Rung 1 (`bun test`), fake fetch throughout:

1. `SystemOneClient.ask` maps 401/403, 429, 5xx, oversize, malformed, timeout,
   and transport error to the seven failure reasons; sends bearer auth and
   `redirect: "error"`.
2. Passage screen tests pass unchanged after S2.
3. OP.GG: `withheld` blanks `summary`; other routes leave it intact; judge
   failure leaves it intact with `judgment.status = "unavailable"`; the request
   body contains no raw Riot ID from a `top_players` summary.
4. Evidence store: the 65th evidence id evicts the first; game-facts ids carry
   no text; `close()` empties it.
5. Frame: unknown id throws `VALIDATION`; `claims` outside 1..8 or 240 chars
   throws `VALIDATION`; no judge → all `not_judged`; judge failure → all
   `not_judged` with claims intact; `routeClaim` at exactly the thresholds;
   card rows come back from the `*Lines` builder with the right colour roles at
   80 and 120 columns.
6. `coach.yaml` parses with the `jev` section and every referenced question id
   exists.

Rung 2, with `TYPESAFE_API_KEY` set:

- `coach -p "/matchup Syndra"`: the frame card shows one row per claim with a
  route and, for grounded rows, a source id. The report quotes the rows.
- `coach -p "/build Zed"`: the meta card shows a `screen: Jev ...` line.

Labs (evidence for the thresholds, written into private directories only):

- A0: `summary.md` precision/recall on the planted injection set.
- S3-lab: `summary.md` threshold sweep; the chosen `GROUNDING_THRESHOLDS` and
  their numbers appear in the commit message that sets them.
- S5: one `coach.yaml` edit, two runs, a delta table.

## Boundaries kept

- AGENTS rule 3: nothing here reads the League client or triggers on its own.
- AGENTS rule 4: the key is read from the environment by name and never logged.
- AGENTS rule 5: no champion or item constant enters code; planted lab text is
  fixture data under `src/lab/`.
- Riot IDs and match ids are scrubbed from every Jev request. Audit rows and
  Data Dragon facts never leave the process.
- Numbers stay in code. Jev judges text, never gold, CS, timings, or win rates.

## Known Jev limits that shape the design

Unreliable counting, weak date comparison, sensitivity to extra state fields,
and vulnerability to user-controlled text in state. Hence: minimal state
objects, no staleness or patch-age questions, every passage tagged as untrusted
in the question text, and thresholds measured on this corpus before use.
