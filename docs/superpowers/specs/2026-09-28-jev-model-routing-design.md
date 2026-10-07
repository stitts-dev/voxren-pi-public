# Jev model routing: pick the model and thinking level per prompt

Date: 2026-09-28. Status: approved design, awaiting plan.

The coach runs one fixed model (`agent.model` in `coach.yaml`, now `gpt-6-sol`) at
Pi's default thinking level. Most prompts do not need that: "what does Fizz W do"
wants a fast, cheap answer; `/review 10` wants the deepest reasoning available.
This spec has Jev (TypeSafe System One, see `docs/jev.md`) grade each free-text
prompt and has code turn the grade into a model and thinking level.

## Goals

- Quality first: Sol at medium thinking is the normal case. Luna only for prompts
  Jev is confident are quick lookups; Sol at high thinking for deep analysis.
- Routing never blocks or fails a turn. Every failure lands on the standard tier.
- The player stays in control: a manual model or thinking change pins the session.
- The player can see who chose the current model, in one footer word.

## Non-goals

- Astra (`gpt-6-astra`, 5x Sol's price). Add it as an opt-in tier once the lab
  shows routing separates prompts reliably.
- Changing the model mid-turn (between tool calls). One decision per player prompt.
- Routing with code heuristics (length, keywords). Jev or the fixed fallback, nothing else.

## Tiers

| Tier | Model | Thinking | Meant for |
| --- | --- | --- | --- |
| `quick` | `gpt-6-luna` | `low` | a single fact, number, or definition; a one-line answer |
| `standard` | `gpt-6-sol` | `medium` | normal coaching: a matchup, a build, a decision with reasons |
| `deep` | `gpt-6-sol` | `high` | multi-game review, comparing several options against the player's own data, a plan across a whole game |

`standard` is the fallback and the first-turn default.

## coach.yaml

```yaml
agent:
  provider: openai-codex
  model: gpt-6-sol                 # fallback / first-turn model; must be in `models`
  models: [gpt-6-luna, gpt-6-sol]  # the only models a session may run
  tiers:
    quick:    { model: gpt-6-luna, thinking: low }
    standard: { model: gpt-6-sol,  thinking: medium }
    deep:     { model: gpt-6-sol,  thinking: high }

commands:
  - name: review
    tier: deep                     # every command carries a fixed tier; no Jev call
    ...

jev:
  route:
    type: choice
    instructions: <how much reasoning does the player's message need>
    criteria:
      quick: <...>
      standard: <...>
      deep: <...>
```

The question is a `choice`, not a `score`: `score` returns only the expected level
index, and the switch rule below needs a probability for the winning tier, which
`choiceProbabilities` (`src/systemone.ts`) gives.

`src/contracts.ts` validates at load: every tier's model is in `models`, `model`
is in `models`, every command has a tier that exists, every thinking value is a
Pi `ThinkingLevel`. A bad file fails the launch, like every other contract error.

Initial command tiers: `review` deep, `otp` deep, `matchup` standard, `build`
standard, `patch` standard, `comp` standard.

## Components

**`src/model-router.ts`** (new). One public entry:

```ts
routePrompt(input: { prompt: string; commandTier?: TierName; pinned: boolean }, judge?: SystemOneClient, current: { model: string })
  : Promise<{ tier: TierName; model: string; thinking: ThinkingLevel; source: "command" | "jev" | "held" | "fallback" | "pinned" }>
```

- `pinned`: returns the current model and thinking unchanged, source `pinned`.
- `commandTier`: that tier, source `command`, no Jev call.
- No judge (no `TYPESAFE_API_KEY`): `standard`, source `fallback`.
- Otherwise: scrub the prompt with `scrubIdentifiers` (`src/passage-judge.ts`),
  cut it to its first 4,000 characters, ask the `route` question with a 1.5 s
  deadline. The winning tier sets the thinking level. The model changes only when
  the winning tier's probability is at least `ROUTE_SWITCH_P = 0.7`; below that the
  current model stays and the source is `held`. Any `JudgeFailure` or timeout:
  `standard`, source `fallback`.

Thresholds (`ROUTE_SWITCH_P`, the deadline, the character cut) are constants in
this file, never in yaml.

**`src/index.ts`** changes:

- Command handlers record the command's tier; the next `before_agent_start`
  consumes it as `commandTier`.
- `before_agent_start` calls `routePrompt`, then applies the result with
  `pi.setModel` (model looked up in `ctx.modelRegistry`) and `pi.setThinkingLevel`,
  with a `routing` flag set around both calls. `setModel` returning false keeps
  the current model and still applies the thinking level.
- `model_select`: a model outside `models` still aborts and shuts down the session.
  A model inside `models` selected while `routing` is false pins the session.
- `thinking_level_select` while `routing` is false pins the session.
- `CoachConfig.approvedModel` becomes `approvedModels: string[]` plus the provider;
  `bin/coach.mjs` passes every model in `models` to `--models`.

Pi reports both the extension's and the player's selections with source `"set"`,
so the `routing` flag is the only way to tell them apart.

**`src/ui.ts`**: `FooterStats` gains `routeSource`. The right side of the footer
reads `<model> · thinking <level> · <word>`, where the word is:

| Source | Word |
| --- | --- |
| `jev`, `held` | `jev` |
| `command` | `/<command name>` |
| `fallback` without a key | `jev off` |
| `fallback` after a failure | `jev <reason>` (for example `jev timeout`) |
| `pinned` | `pinned` |

It changes a decision: a cheap answer marked `jev` tells the player a manual pick
would pin a better model; `jev off` and `pinned` explain why the coach is not adapting.

## Privacy

New data flow: with `TYPESAFE_API_KEY` set, the player's typed prompt (scrubbed of
Riot IDs and match ids, cut to 4,000 characters) is sent to TypeSafe. Command
prompts are not sent. `docs/privacy.md` and `docs/jev.md` each get a section
saying so.

## Testing

`src/model-router.test.ts`, Jev faked, public function run, output asserted:

- a command tier returns that tier and makes no Jev call
- a winning tier at 0.7 or above switches the model; below 0.7 keeps it and still
  sets the thinking level (source `held`)
- each `JudgeFailure` reason, and a fake Jev slower than 1.5 s, return `standard` / `fallback`
- pinned ignores both a command tier and Jev
- a Riot ID in the prompt never reaches the fake Jev; a 10,000-character prompt
  arrives as 4,000

`src/coach.test.ts`:

- the gate accepts every model in `models` and still shuts down on any other
- a player model or thinking selection pins; the router's own selections do not
- the footer shows each source word

`src/contracts.test.ts`: a tier naming a model outside `models`, and a command
without a tier, both fail validation.

**Step 0 of the plan:** `src/coach.test.ts` hangs on `main` today (every other
test file passes). Find and fix that hang before adding tests to it.

## Lab

`src/lab/route-lab.ts`: about 30 hand-labelled prompts (quick, standard, deep)
through live Jev. Reports the confusion matrix and every prompt labelled deep that
Jev sent to Luna at 0.7 or above; that miss is the one to drive to zero before
tightening anything else. Offline, never loaded by the coach.

## Verification

Run the coach per `docs/agent-terminal.md`: a quick fact, then `/review`, then a
manual model switch. Read the footer word and the model that answered each turn.
