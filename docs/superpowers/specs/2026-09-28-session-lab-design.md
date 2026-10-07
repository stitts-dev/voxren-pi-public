# Session lab design

Date: 2026-09-28. Status: approved direction, revised after prior-art review.

This spec replaces the Lab and Loop sections of S3 in `docs/superpowers/specs/2026-09-27-coach-knowledge-design.md`. S3's judge contract (doctrine questions, #92) and calibration (hand labels, #93) stand unchanged and plug in here.

## Goal

Replay scripted coach sessions in the real Pi TUI while the owner can watch, score every answer with Jev over repeated runs, and let the agent present the scores, its own judgment, and ranked experiment ideas, so every `coach.yaml`, UI, or tool change is kept only when it measurably improves what the player gets.

Layout in the desktop app: the live Pi session in the terminal pane on the right; the agent in the chat on the left with a score widget, its reasoning, and the experiment ideas.

Outcome, as a check: the owner says "run the session lab on train"; a terminal tab shows the coach being driven; the chat then shows a widget with per-turn median scores, raw repeats, a strict all-runs pass, and each turn marked improved, regressed, or unchanged against the baseline; the agent's per-turn agree/disagree with quoted lines; and two to four ranked ideas the owner can run or skip.

## Decisions

- **D1** One runner. The session lab is S3's lab: it replaces `src/lab/answer-rubric-lab.ts` (deleted) and S3's `data/eval/queries.json` (never built). A single-turn query is a one-turn session.
- **D2** The owner watches the real session through `tui-test monitor --session <name>` in one terminal tab. No text report in the terminal.
- **D3** Jev scores with `jev.answerRubric` and, once #92 lands, `jev.doctrine`. Questions stay fixed while experiments run.
- **D4** Sessions are hand-scripted files, or files frozen from a real session in the exchange log.
- **D5** Every session runs 3 times (`--n 3`). Scores keep every repeat; the headline is the median.
- **D6** The agent, not the script, presents results and proposes experiments. The procedure lives in the project skill `.claude/skills/session-lab/SKILL.md`; the script produces data only.
- **D7** Attended mode: an experiment may change anything (`coach.yaml`, cards and UI, tools, the gateway) and changes nothing until the owner accepts it.
- **D8** Overnight mode: unattended, limited to S3's surface (`doctrine`, `prompts.system`, `agent.model`, `tools.*` descriptions in `coach.yaml`), keep only real gains, the owner reviews the ledger and kept commits afterwards.
- **D9** Every experiment is one commit on the lab branch plus one ledger line in `data/lab/ledger.jsonl`. Keep or revert is a git operation.
- **D10** The proposer never sees holdout sessions: not their inputs, answers, or screens.

## Prior art adopted

| Id | From | What we take |
| --- | --- | --- |
| A1 | Inspect (epochs, reducers) | Keep every repeat's raw score; headline is the median, robust to one flaky run. |
| A2 | tau-bench (pass^k) | Strict pass per turn: all repeats reach quality 3 or more with no flag raised. |
| A3 | Braintrust (experiment diff) | After a rerun, a per-turn list: improved, regressed, unchanged, not a grid. |
| A4 | pi-autoresearch (MAD confidence), S3 noise floor | Noise per turn is the median absolute deviation of the baseline's repeats. A change is real at 2x noise or more, marginal at 1-2x, noise below 1x. |
| A5 | GEPA, S3 | Train and holdout splits; holdout runs once after an accepted series and is reported next to train. |
| A6 | Anthropic eval guidance, S3 #93 | A question under 0.8 agreement with the owner's labels is shown but cannot decide keep or revert. |
| A7 | Karpathy autoresearch, pi-autoresearch | One ledger line per experiment, including dead ends; the proposer reads it before proposing so failed ideas are not retried. |
| A8 | AutoSOTA decay data | Stop proposing after 3 consecutive experiments with no real gain; say so and ask for new direction. |
| A9 | BAITBENCH, S3 R1 | Every judgment checks whether a gain games the rubric (a flag cleared by cutting substance, a shorter answer that no longer changes a decision). |
| A10 | Rehearse | Propose several ideas and rank them before running any; read only ledger lines that touch the same sessions or questions, not the full history. |

Skipped: simulated users (a second nondeterministic model fights repeat-based noise control), tree search and automatic prompt search (one pick from 2-4 ideas does not need them), binary log formats, and installing `pi-autoresearch` (provenance unverified: the same repo appears under 7+ unrelated accounts).

## Session file

`data/eval/sessions/<id>.json`:

```json
{
  "split": "train",
  "tier": "gold",
  "applies": ["names_tradeoff"],
  "client": "data/lab/drafts/pyke-picks.json",
  "step": 1500,
  "turns": [
    { "send": "/matchup Syndra" },
    { "key": "ctrl+o" },
    { "send": "why not Ignite?" }
  ]
}
```

- `split` (required): `train` or `holdout`. `tier` (optional): the player tier the session assumes. `applies` (optional): doctrine questions that apply beyond the four `answerRubric` questions, which apply to every answer.
- `client`, `step` (optional): anything `tui.ts --replay` takes, and milliseconds per frame.
- A `send` turn types the line, presses Enter, and waits until that run is in the exchange log, up to 180 s. A timeout is recorded on the turn and the session continues.
- A `key` turn presses `ctrl+o` or `escape` and captures the screen with no model run.
- The parser rejects unknown fields, a missing or unknown `split`, empty `turns`, and a turn with both or neither of `send` and `key`, naming the file and turn index.

Set: about 40 sessions (30 train, 10 holdout) covering each lane, mental, macro, comp, builds, deaths, and every tier, as S3 planned, including the five queries now hardcoded in `answer-rubric-lab.ts`, the six recorded `/comp` scenarios from #30, and at least five multi-turn sessions with a follow-up question and a `ctrl+o` turn.

## Freezing a real session

`just session-lab --freeze <sessionId> --split <split> [--from <exchanges.ndjson>] [--name <id>]` writes one session file with a `send` turn per exchange in that session, in order.

The exchange log gains `input?: string`: the raw line as submitted, set where `src/index.ts` calls `exchangeLog.command(...)`; for a typed question it equals `prompt`. Auto runs (`draft:auto`) are skipped with a note. Exchanges logged before this change freeze only their typed questions and list command runs as skipped.

## Runner (`src/lab/session-lab.ts`)

- Engine: the tui-test code in `src/lab/tui.ts` moves into `src/lab/tui-session.ts`, used by `tui.ts` and the lab. `tui.ts` keeps its command line and output.
- Each repeat gets a throwaway coach home (`labHome`) and a named tui-test session, `lab-<session id>-r<repeat>`. The runner prints `session <name>` before the first turn and holds 5 s after the header so a monitor can attach.
- `--parallel N` (default 3) runs repeats side by side; each has its own home and tui-test session. Pitfall P5 applies: no tui-test wait is held while keys are sent; the runner polls the exchange log and `state()`.
- `--split train|holdout|all` (default `train`) or explicit session ids.
- After each turn: the new screen lines, and for a `send` turn that run's exchange.
- Scoring: each `send` answer (first 12,000 characters) goes to Jev with a 5 s timeout. Without `TYPESAFE_API_KEY` scores are `null` and the run completes.

## Results

`--out <dir>` (required, 0700), per session `<out>/<id>/`: `run-<r>/turn-<t>.txt` screens, and `results.json` with per turn:

- `input`, `kind`, each repeat's exchange summary (tools, ok, ms, cost, answer), scores, timeout flag;
- `median`, `raw`, `mad` per question; `strictPass` (A2); flag counts;
- with `--baseline <dir>`: `delta` (median change), `confidence` (|delta| / baseline MAD, `null` when MAD is 0 and delta is 0, `real` when MAD is 0 and delta is not), `verdict` (`improved` | `regressed` | `unchanged` by A4 at 2x), a word diff of the first repeat's answer (`git diff --no-index --word-diff`).

`<out>/summary.json`: per split, mean of medians per question, strict-pass count, guard counts (contradicted claims from `voxren_strategy_frame`, `unsourced_number` flags, the 32 KB size gate), total tokens, dollars, and wall time.

Stdout is progress only: `session <name>`, then `r2 turn 3 done · 41.2 s`.

## Attended loop (the skill)

1. Start the runner in the background on `train` with `--baseline` set to the last kept run.
2. Open one terminal tab: `tui-test monitor --session <name>` for the first session; switch when the owner asks. Close it at the end.
3. Read `summary.json` and the regressed and worst turns' `results.json` and screens. Never open holdout output while proposing (D10).
4. Show one widget: split totals, then the regression list (A3) with median, raw repeats, strict pass, and verdict per turn.
5. In chat: agree or disagree with Jev on the regressed and worst turns, quoting the line each judgment rests on, and the A9 gaming check.
6. Two to four ranked ideas (A10), each aimed at value (the answer changes a decision), consistency (same question, same answer shape, every run and command), or trust (sourced numbers, visible and correct grounding flags, the coach says what it does not know). Each states the change, the player-facing reason, the hypothesis, and the measure. The skill reads the ledger lines for the same sessions and questions first (A7) and does not repeat a failed idea without saying why.
7. On accept: make the change; a code change passes `npm run typecheck` and `bun test`; commit; rerun with `--baseline`; append the ledger line; offer to revert when there is no real gain.
8. After a series the owner calls done: run `holdout` once and report it beside train. After three experiments in a row with no real gain, stop proposing (A8).

## Overnight mode

A Claude Code workflow (S3 D9) repeats: read summary and ledger, propose one idea inside D8's surface, commit, rerun train, keep only when the mean doctrine score gain is real (A4) on questions that pass the agreement gate (A6) and no guard regresses; otherwise revert. Every iteration writes a ledger line. It stops at `--max-iterations`, a dollar cap, a wall-time cap, or the A8 rule. Holdout runs once at the end. The morning summary in chat: ledger lines, kept commits, train and holdout deltas, and the largest answer diffs for the owner to read before any merge.

## Ledger

`data/lab/ledger.jsonl`, one line per experiment: `ts`, `mode` (`attended` | `overnight`), `commit`, `idea`, `aim` (`value` | `consistency` | `trust`), `hypothesis`, `sessions`, `before` and `after` (split means per question, strict-pass count, guards), `verdict`, `kept`, `note`. No answers, screens, or player data.

## Tests

`bun test`, pure functions:

- session parser: the example accepts; each invalid shape rejects with its turn index;
- freeze: `input` used, auto runs skipped, pre-`input` command runs reported;
- aggregate: fixed repeats produce median, MAD, strict pass, flag counts;
- baseline: fixed pairs produce delta, confidence, verdict, including MAD 0 and unmatched turns;
- ledger line validation, and that a ledger line with an answer field is rejected;
- the exchange log writes `input` (`src/exchange-log.test.ts`).

Done: tests and `npm run typecheck` pass; one attended iteration on train runs end to end in the app; one overnight pilot of one iteration records wall time and dollars before any longer run.

## Risks

| Id | Risk | Mitigation |
| --- | --- | --- |
| R1 | 40 sessions x 3 repeats in the real TUI takes hours. | `--parallel`; the pilot records wall time; cut to 2 repeats or 20 train sessions if too slow (S3's fallback). |
| R2 | Tuning games Jev. | Fixed questions, agreement gate, holdout, A9 check, owner reads diffs. |
| R3 | Judge accuracy decays with history. | A10 scoped reading; #93 labels rechecked after any judge change. |
| R4 | Cost of a full train pass. | Pilot records dollars; overnight has a dollar cap. |
