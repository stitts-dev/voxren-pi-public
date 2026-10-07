# Jev integration: grounding gate, OP.GG screen, calibration labs and the answer rubric

Design: `docs/superpowers/specs/2026-09-27-jev-integration-design.md`. Plan: `docs/superpowers/plans/2026-09-27-jev-integration.md`. Prototype: branch `proto/grounding-gate`, `just proto-grounding`. Related: issue #8 (Jev picks OP.GG `desired_output_fields`), out of scope here.

## Problem Statement

The coach answers from third-party text it cannot verify. Web snippets are screened for planted instructions, but OP.GG summaries are not, and nothing checks that a coaching row the model writes is actually stated by the evidence it cites. `voxren_strategy_frame` exists for that purpose and returns canned filler. When the player reads "max E first" or "rush Lich Bane", they cannot tell whether a source said it or the model did. Prompt edits to `coach.yaml` are also judged by eye, one answer at a time, so a regression in specificity or hedging goes unnoticed.

## Solution

With `TYPESAFE_API_KEY` set, Jev (TypeSafe System One) answers closed questions about text in under a second and code routes on the probabilities. Three uses:

1. `voxren_strategy_frame` takes the coach's intended answer rows as claims plus the evidence ids they cite, and labels each row `grounded` (with the source id), `unsupported`, `contradicted`, or `not_judged`. The card shows one row per claim. The gate flags, it never removes a row.
2. Every OP.GG summary passes the existing passage screen; a summary carrying instructions aimed at the assistant is blanked and the card says so.
3. One lab, run by hand into a private directory, sweeps grounding thresholds on labelled claim/passage pairs so no cookbook default ships unmeasured. The story runner grades each answer on the coach's own rubric so a `coach.yaml` edit gets a number before and after.

Without the key, nothing changes except that the frame reports every claim `not_judged`.

## User Stories

1. As a player, I want each coaching row marked as grounded in a cited source, so that I know which advice rests on evidence and which is the model's own.
2. As a player, I want a row that a source contradicts to name that source, so that I can read the disagreement myself.
3. As a player, I want unsupported rows dropped or flagged in a few words, so that I do not act on advice nothing backs.
4. As a player, I want the frame card to show one line per claim with its route and source id, so that the check is visible without expanding the card.
5. As a player, I want OP.GG text with planted instructions blanked before the model reads it, so that a poisoned page cannot steer my coach.
6. As a player, I want the meta card to show the screen result, so that I know whether OP.GG text was checked this turn.
7. As a player, I want the coach to keep working when Jev is down, so that an outage costs me a check, not an answer.
8. As a player, I want the coach to say plainly when a check did not run, so that "not judged" is never mistaken for "grounded".
9. As a player, I want the coach without a TypeSafe key to behave exactly as before, so that opting out has no side effects.
10. As a player, I want my Riot ID and match ids scrubbed from anything sent to TypeSafe, so that my identity stays local.
11. As a player, I want audit data and Data Dragon facts never sent to TypeSafe, so that first-party game data stays in the process.
12. As a player, I want the coach to check numbers in code and judgments with Jev, so that gold, CS, and timings are never "estimated" by a model.
13. As the owner, I want grounding thresholds set from a measured sweep on labelled pairs, so that the live gate is calibrated on this corpus and not a cookbook.
14. As the owner, I want the grounding lab to include planted pairs with known labels, so that a regression in Jev's behaviour shows up on a rerun.
15. As the owner, I want the passage-screen thresholds fitted the same way the day the key lands, so that the existing screen is calibrated before anything is built on it.
16. As the owner, I want the story runner to grade answers on the coach's rules, so that a `coach.yaml` edit gets a before/after number.
17. As the owner, I want the story runner's rubric grade to compare against a baseline run (`--compare`), so that the delta per question is one table.
18. As the owner, I want every Jev question to live in `coach.yaml`, so that prompt text has one home and rule 1 holds for Jev too.
19. As the owner, I want the labs to write only into the directory I name, so that corpus text and answers never land in the repository.
20. As the owner, I want the model-facing frame schema to require claims, so that the model cannot call the frame without stating what it will say.
21. As the owner, I want the frame to reject evidence ids not returned this session, so that the model cannot cite what it never saw.
22. As the owner, I want a bounded store of evidence text, so that a long session cannot grow memory without limit.
23. As the owner, I want a single Jev transport with one failure taxonomy, so that a new question type is a few lines and not a second HTTP client.
24. As the owner, I want the OP.GG screen to record relevance but never remove on it, so that structured aggregate rows are not dropped by a question that does not fit them.
25. As the owner, I want the key read by name from the environment and absent from every log and request body, so that rule 4 holds.
26. As the owner, I want the first live run to verify the `choice` and `score` answer field names, so that a shape mismatch is caught before the thresholds are set.
27. As a contributor, I want the grounding logic exercised through the gateway with a fake fetch, so that tests prove behaviour and never grep source.
28. As a contributor, I want the OP.GG screen and the frame gate tested through the same fake upstream seam as the web screen, so that one test pattern covers all three.
29. As a contributor, I want the card rows returned as plain strings from the line builders, so that route colours are asserted, not eyeballed.
30. As a contributor, I want a throwaway prototype of the frame's state model preserved on its own branch, so that the awkward cases it settled can be replayed.
31. As an agent implementing this, I want each ticket demoable on its own with `bun test` green, so that a fresh context can pick up any frontier ticket.
32. As an agent, I want the human-only calibration step flagged as such, so that I do not attempt to run a lab that needs a key I do not have.

## Implementation Decisions

- One transport module for TypeSafe System One: bearer auth, byte caps both ways, `redirect: "error"`, and a fixed failure taxonomy (`timeout`, `network`, `authentication`, `rate_limited`, `server`, `response`, `input`). Judges own their batch timers and pass an abort signal. The transport decides nothing.
- The existing passage judge keeps its routing, scrubbing, and all-or-nothing batch, and calls the transport. Its test assertions do not change.
- A grounding judge asks three questions per claim over the cited passages: `supported` (noul), `contradicted` (noul), `source` (choice over the passage ids plus `none`). State is exactly `{ claim, passages: [{ id, text }] }`, scrubbed. Route in code: contradiction first, then support, else unsupported. A `source` of `none` or an undeclared id yields no source field; an undeclared id is a `response` failure for the batch.
- The frame tool's input becomes `question`, `claims` (1 to 8, each up to 240 characters, required), `evidence` (1 to 12 ids). `constraints` is removed. Output is `goal`, `claims` with routes, `citation_ids`, and a `judgment` block shaped like the web search one. The canned options, risks, and next-test rows are deleted.
- The gateway keeps a bounded evidence store (64 entries, oldest evicted) of id to source and optional text. Text is stored for web snippets only after a successful screen (the same rule that governs what the model reads), for OP.GG summaries and matchup rows, and (amended 2026-09-27, owner decision after the first live run) for Data Dragon facts, which are public static data. Audit and OTP ids store no text. An id absent from the store is a validation error, as today.
- Frame behaviour by judge state, settled with the prototype on branch `proto/grounding-gate`:

  ```
  judge absent            -> every claim not_judged, no judgment field
  judge present, no text  -> every claim not_judged, judgment unavailable (input)
  judge fails             -> every claim not_judged, judgment unavailable (reason)
  judge answers           -> per-claim route; contradicted wins over grounded when both cross threshold
  id evicted or unseen    -> VALIDATION, whatever the judge state
  ```

- The OP.GG screen reuses the passage judge on the summary with the request label as the query. `withheld` blanks the summary; every other route is recorded and changes nothing. The matchup query builds structured rows from parsed JSON and stays unscreened.
- The card shows one row per claim: route padded to a column, source id when present, then the claim. Route colours: grounded success, unsupported warning, contradicted error, not judged dim. The Jev screen line renders on any card whose response carries a judgment.
- All Jev question text moves to a `jev` section in `coach.yaml` with `passage`, `grounding`, and `answerRubric` groups and one shared "untrusted" sentence expanded at load. The system prompt's Jev addendum gains a grounding paragraph telling the model to call the frame with its rows as claims, keep grounded rows, drop or flag unsupported ones, and name the source of a contradicted one.
- Grounding thresholds are placeholders until the grounding lab runs with the key; the lab sweeps 0.4 to 0.8 and reports precision and recall for both nouls plus source accuracy on planted and hand-labelled pairs. The key is not placed in the coach home before the measured thresholds are committed.
- The story runner (`just stories`) asks Jev, for each answer, one score question (a rubric from the coach's rules) and three nouls (intro or closing, hedges, unsourced number), and writes a per-turn table with a delta against a baseline run's noise (`--compare`).
- The live shape of `choice` and `score` answers is unverified until the first run with a key. Parsers are strict, so a mismatch fails closed to `not_judged`; the first calibration run fixes the parsers and adds a test for the real shape.

## Testing Decisions

- A good test drives a public function with a fake upstream and asserts on what the model or the player would see: the tool's JSON text, the response data, the evidence list, the card lines. No test reads source files or private fields.
- Seams, highest first, all existing: the gateway's `fetchImpl` option (fake Perplexity, OP.GG, Data Dragon, and TypeSafe in one function); the tool wrapper's `execute` through the tool factory; the card line builders with a tagging theme. One new, small seam: a public recall accessor on the gateway for the evidence store, so the store is tested through a public function.
- Transport: every upstream failure class maps to its reason; the key is in the header and never in the body; an empty key fails before any network call.
- OP.GG screen: withheld blanks, other routes keep, failure keeps and says unavailable, judge off means no judgment field, and a leaderboard full of Riot IDs leaves the process as `[riot-id]`.
- Grounding judge: routes at the thresholds exactly, one request per claim with a minimal scrubbed state, undeclared source id fails the batch, no passages is an input failure without a network call, claims cap at 8.
- Frame through the gateway: unknown or evicted id is validation; missing, empty, or oversize claims are validation; the removed `constraints` key is validation; judge off, judge failing, and first-party-only citations each produce the documented shape; the card shows one row per claim with the padded route and source id.
- Evidence store: the 65th id evicts the first; re-remembering refreshes; clear empties.
- `coach.yaml`: the `jev` section parses with the expected groups and keys, every instruction that judges text contains the untrusted sentence, and the rubric levels are 2, 4, 6, 8, 10.
- Prior art: the passage judge suite (fake fetch keyed by URL, deterministic Jev scores by passage text, failure table), the gateway suite (fake upstreams, tool execution, card lines at a width), and the coach suite (yaml shape assertions).
- Labs are not tests. They never run under `bun test` and never fail CI.

## Out of Scope

- Routing between models or deciding whether a question needs search (Jev as a router).
- Compaction or context-drift detection at turn end.
- Anything that reads the League client on its own or acts on champ select.
- Judging numbers the code computes: audit metrics, OTP frequencies, gold diffs.
- Screening the matchup query's structured rows.
- Jev choosing OP.GG `desired_output_fields` per question (issue #8).
- An agent-callable `ask_jev` tool.
- Validating thresholds in this branch. Calibration is a human step once the key exists.

## Further Notes

- Known Jev limits shape the design: unreliable counting, weak date comparison, sensitivity to extra state fields, susceptibility to text in state. Hence minimal state objects, no staleness questions, the untrusted sentence on every judging question, and thresholds measured before use.
- Cost is small: input is billed at USD 0.042 per million tokens and output is free; a frame with eight claims is eight short requests in parallel under one 3 second budget.
- Human-only steps when the key lands, in order: run the passage lab and commit fitted `PASSAGE_THRESHOLDS`; run the grounding lab and commit fitted `GROUNDING_THRESHOLDS`; check the live `choice` and `score` answer shapes; then put the key in the coach home and quote the frame card from `coach -p "/matchup Syndra"`.
