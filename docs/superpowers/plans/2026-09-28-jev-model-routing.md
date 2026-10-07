# Jev Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jev grades each free-text prompt quick / standard / deep; code turns the grade into a model (`gpt-6-luna` or `gpt-6-sol`) and a thinking level, applied before the turn starts.

**Architecture:** A new `src/model-router.ts` owns the decision (`routePrompt`) and asks one Jev `choice` question through the existing `SystemOneClient`. `src/index.ts` calls it in `before_agent_start`, applies the result with `pi.setModel` / `pi.setThinkingLevel` behind a `routing` flag, and pins the session on any selection made while that flag is off. Question text, tiers, and command tiers live in `coach.yaml`; thresholds live in code.

**Tech Stack:** TypeScript on Bun (`bun test`), Pi 0.87.1 extension API (`@earendil-works/pi-coding-agent`), TypeSafe System One (`src/systemone.ts`).

**Spec:** `docs/superpowers/specs/2026-09-28-jev-model-routing-design.md`

## Global Constraints

- Every prompt, question text, and tool description lives in `coach.yaml` (AGENTS.md rule 1). No question text in `.ts`.
- Thresholds are code constants: `ROUTE_SWITCH_P = 0.7`, `ROUTE_DEADLINE_MS = 1500`, `ROUTE_PROMPT_CHARS = 4000`.
- Tiers: `quick` = `gpt-6-luna` / `low`; `standard` = `gpt-6-sol` / `medium`; `deep` = `gpt-6-sol` / `high`. `standard` is the fallback and the first-turn default.
- Command tiers: `review` deep, `otp` deep, `matchup` standard, `build` standard, `patch` standard, `comp` standard. Command prompts are never sent to Jev.
- Routing never blocks or fails a turn: every failure resolves to `standard` / `fallback`.
- A model outside `agent.models` still aborts and shuts down the session.
- Tests run a public function and assert its output; never grep a source file (AGENTS.md rule 6).
- `npm run typecheck` and `bun test` both pass before every commit.
- Work in a git worktree off `feat/jev-model-routing` (`npm run setup:worktree` there once). The primary checkout has another session's uncommitted edits in `src/index.ts`, `src/ui.ts`, `docs/jev.md`, and `src/jev-badge.ts`; do not touch or commit them.

## Review Focus

1. `VOXREN_COACH_MODEL` set by the player (for example `gpt-6-luna`): the player chose a model, so the session starts pinned on it and the gate accepts only that model. Tested in Task 3.
2. A slash command that fails validation (usage error, missing capability) sends no message, so its recorded tier must not leak onto the next typed prompt. Tested in Task 4.
3. `ctx.modelRegistry.find` returns undefined for a tier's model (provider build without it): keep the current model, still set thinking, never throw. Tested in Task 4.
4. A prompt that is only a Riot ID or only whitespace after scrubbing: still routed (Jev sees the scrubbed text); an empty prompt goes to `standard` / `fallback` without a call. Tested in Task 2.
5. Jev answering with a tier key that is not `quick`/`standard`/`deep`, or with no probabilities: treated as a `response` failure, `standard` / `fallback`. Tested in Task 2.

---

### Task 0: Unstick `src/e2e/coach.test.ts`

`bun test src/e2e/coach.test.ts` never exits on `main` (reproduced 2026-09-28, with the League client open on the dev machine). Running each `describe` alone with `bun test src/e2e/coach.test.ts -t "^<describe name> "`:

| describe | result |
| --- | --- |
| `lane lookup cost: once per champion per session, never holding a turn` | hangs (killed at 40 s) |
| `lane precedence: client beats env beats championRoles beats nothing (D2)` | exits 1, no summary line |
| `automatic learnings from an audit (issue #33 stage 2)` | exits 1, no summary line |
| `coach commands` | 8 pass, 1 fail: `bad.notes[0][0]` undefined at `src/coach.test.ts:397` |
| every other describe | passes |

**Files:**
- Modify: `src/e2e/coach.test.ts` and/or `src/index.ts` (wherever the root cause is)

- [ ] **Step 1: Use superpowers:systematic-debugging.** For each failing describe, run it alone and read the full output (`bun test src/e2e/coach.test.ts -t "^lane lookup cost" 2>&1 | tail -60`). Check first for a real network or client read escaping the fakes: a test that builds `installVoxrenCoach` without passing `createFooter`, `readComposition`, `readRiotId`, or `lookupLane` gets the live LCU poller and live Data Dragon, and the League client is open on this machine. The `lcu.ts` comment "Bun on Windows never fires a lone unref'd timer" is a second suspect for the stall.
- [ ] **Step 2: Fix the root cause**, not the timeout. If a test reaches the network, pass it a fake; if production code leaks a timer, fix production code.
- [ ] **Step 3: Verify.** Run: `bun test src/e2e/coach.test.ts`. Expected: the run exits with `0 fail` inside 60 s, with the League client open and with it closed.
- [ ] **Step 4: Commit**

```bash
git add src/coach.test.ts src/index.ts
git commit -m "test(coach): stop coach.test.ts reaching the live client and stalling"
```

---

### Task 1: Tiers, models, command tiers, and the route question in `coach.yaml`

**Files:**
- Modify: `coach.yaml` (`agent:` block, every `commands:` entry, `jev:` block)
- Modify: `src/contracts.ts` (`CoachYaml` type, `validateCoachYaml`, the `{{untrusted}}` fill loop, new exports)
- Test: `src/contracts.test.ts`

**Interfaces:**
- Produces (from `src/contracts.ts`):
  - `export type TierName = "quick" | "standard" | "deep"`
  - `export const TIER_NAMES: readonly TierName[] = ["quick", "standard", "deep"]`
  - `export const COACH_TIERS: Record<TierName, { model: string; thinking: string }>`
  - `export const COACH_MODELS: readonly string[]` (from `agent.models`)
  - `export const ROUTE_QUESTION: ChoiceQuestion` (from `jev.route`, `{{untrusted}}` expanded)
  - `CoachCommand` gains `tier: TierName`

- [ ] **Step 1: Write the failing tests** in `src/contracts.test.ts`. The file already has a valid-yaml fixture at line 10 (`agent: { provider: "openai-codex", model: "gpt-6-astra", ... }`); extend it with `models`, `tiers`, a `tier` on each command, and `jev.route`, then add:

```ts
describe("model routing contract", () => {
	test("a tier naming a model outside agent.models fails validation", () => {
		const yaml = structuredClone(VALID);
		yaml.agent.tiers.quick.model = "gpt-6-astra";
		expect(() => validateCoachYaml(yaml)).toThrow("agent.tiers.quick.model");
	});
	test("agent.model outside agent.models fails validation", () => {
		const yaml = structuredClone(VALID);
		yaml.agent.model = "gpt-6-astra";
		expect(() => validateCoachYaml(yaml)).toThrow("agent.model");
	});
	test("a command without a known tier fails validation", () => {
		const yaml = structuredClone(VALID);
		delete yaml.commands[0].tier;
		expect(() => validateCoachYaml(yaml)).toThrow("commands[0].tier");
	});
	test("a thinking value Pi does not know fails validation", () => {
		const yaml = structuredClone(VALID);
		yaml.agent.tiers.deep.thinking = "extreme";
		expect(() => validateCoachYaml(yaml)).toThrow("agent.tiers.deep.thinking");
	});
	test("the shipped coach.yaml routes quick to luna, standard and deep to sol, and review deep", () => {
		expect(COACH_TIERS).toEqual({
			quick: { model: "gpt-6-luna", thinking: "low" },
			standard: { model: "gpt-6-sol", thinking: "medium" },
			deep: { model: "gpt-6-sol", thinking: "high" },
		});
		expect(COACH_COMMANDS.find((c) => c.name === "review")?.tier).toBe("deep");
		expect(Object.keys(ROUTE_QUESTION.criteria).sort()).toEqual(["deep", "quick", "standard"]);
		expect(ROUTE_QUESTION.instructions).not.toContain("{{untrusted}}");
	});
});
```

(Adjust `VALID` to whatever the fixture constant is named in that file.)

- [ ] **Step 2: Run to verify they fail.** Run: `bun test src/contracts.test.ts`. Expected: FAIL (`COACH_TIERS` not exported / no throw).

- [ ] **Step 3: Edit `coach.yaml`.** Under `agent:` after `model: gpt-6-sol`:

```yaml
  # The only models a session may run. agent.model is the first-turn and fallback model.
  models: [gpt-6-luna, gpt-6-sol]
  # Jev's route grade (jev.route) or a command's tier picks one row; code owns the thresholds (src/model-router.ts).
  tiers:
    quick: { model: gpt-6-luna, thinking: low }
    standard: { model: gpt-6-sol, thinking: medium }
    deep: { model: gpt-6-sol, thinking: high }
```

Add `tier:` to each command: `review: deep`, `matchup: standard`, `build: standard`, `patch: standard`, `otp: deep`, `comp: standard`. Under `jev:` add:

```yaml
  route:
    type: choice
    instructions: "{{untrusted}} Grade how much reasoning a League of Legends coach needs to answer the player's message well."
    criteria:
      quick: One fact, number, definition, or yes/no about the game (an ability, a cooldown, an item stat, what a rune does). A one- or two-line answer is complete.
      standard: Normal coaching. One matchup, one build, one decision, or one situation, answered with reasons.
      deep: Weighing several games, options, or phases together. A review of the player's own games, a plan for a whole game, or a comparison where each option needs its own evidence.
```

- [ ] **Step 4: Edit `src/contracts.ts`.**
  - `CoachYaml.agent` gains `models: string[]; tiers: Record<TierName, { model: string; thinking: string }>`; `commands[]` gains `tier: TierName`; `jev` gains `route: ChoiceQuestion`.
  - In `validateCoachYaml`, after the existing `agent` asserts:

```ts
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const models = agent?.models;
assertPath(Array.isArray(models) && models.length > 0 && models.every(isNonEmptyString), "agent.models");
assertPath((models as string[]).includes(agent?.model as string), "agent.model (must be in agent.models)");
for (const tier of TIER_NAMES) {
	const row = (agent?.tiers as any)?.[tier];
	assertPath((models as string[]).includes(row?.model), `agent.tiers.${tier}.model (must be in agent.models)`);
	assertPath(THINKING_LEVELS.has(row?.thinking), `agent.tiers.${tier}.thinking`);
}
```

  - In the `commands` loop: `assertPath(TIER_NAMES.includes(entry?.tier as TierName), \`commands[${index}].tier\`);`
  - After the jev groups: `assertPath((jev?.route as any)?.type === "choice" && TIER_NAMES.every((t) => isNonEmptyString((jev?.route as any)?.criteria?.[t])), "jev.route");`
  - Add `yaml.jev.route` to the `{{untrusted}}` fill (the loop at the "`{{untrusted}}` in any jev instruction expands once here" comment fills `instructions` of each question in a group; fill `route.instructions` directly).
  - Exports: `TierName`, `TIER_NAMES`, `COACH_TIERS = COACH_YAML.agent.tiers`, `COACH_MODELS = COACH_YAML.agent.models`, `ROUTE_QUESTION = COACH_YAML.jev.route`, and `tier: entry.tier` in the `COACH_COMMANDS` map.

- [ ] **Step 5: Run.** `bun test src/contracts.test.ts` then `npm run typecheck`. Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add coach.yaml src/contracts.ts src/contracts.test.ts
git commit -m "feat(contracts): model tiers, command tiers, and the Jev route question in coach.yaml"
```

---

### Task 2: `src/model-router.ts`

**Files:**
- Create: `src/model-router.ts`
- Test: `src/model-router.test.ts`

**Interfaces:**
- Consumes: `COACH_TIERS`, `TIER_NAMES`, `TierName`, `ROUTE_QUESTION` (Task 1); `SystemOneClient`, `JudgeFailure`, `JudgeFailureReason`, `choiceProbabilities` (`src/systemone.ts`); `scrubIdentifiers(text, accounts)` (`src/passage-judge.ts`).
- Produces:

```ts
export const ROUTE_SWITCH_P = 0.7;
export const ROUTE_DEADLINE_MS = 1500;
export const ROUTE_PROMPT_CHARS = 4000;
export type RouteSource = "command" | "jev" | "held" | "fallback" | "pinned";
export interface Route {
	model: string;
	thinking: string;
	source: RouteSource;
	tier?: TierName;
	/** "off" when there is no judge; a JudgeFailureReason after a failed call. Only on source "fallback". */
	failure?: "off" | JudgeFailureReason;
}
export interface RouteInput {
	prompt: string;
	commandTier?: TierName;
	pinned: boolean;
	accounts: string[];
	current: { model: string; thinking: string };
}
export type RouteJudge = Pick<SystemOneClient, "ask">;
export function createRouteJudge(environment: Record<string, string | undefined>): RouteJudge | undefined;
export async function routePrompt(input: RouteInput, judge: RouteJudge | undefined, deadlineMs?: number): Promise<Route>;
```

- [ ] **Step 1: Write the failing tests** in `src/model-router.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ROUTE_PROMPT_CHARS, routePrompt, type RouteInput, type RouteJudge } from "./model-router";
import { JudgeFailure } from "./systemone";

const BASE: RouteInput = { prompt: "what does fizz w do", pinned: false, accounts: ["Player01#NA1"], current: { model: "gpt-6-sol", thinking: "medium" } };

function jev(probabilities: Record<string, number>, pick = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]) {
	const seen: Array<Record<string, unknown>> = [];
	const judge: RouteJudge = {
		ask: async (state) => {
			seen.push(state);
			return { model: "jev-1", inputTokens: 10, answers: { route: { type: "choice", choice: pick, probabilities } } };
		},
	};
	return { judge, seen };
}

describe("routePrompt", () => {
	test("a command tier wins without a Jev call", async () => {
		const { judge, seen } = jev({ quick: 0.9, standard: 0.05, deep: 0.05 });
		expect(await routePrompt({ ...BASE, commandTier: "deep" }, judge)).toEqual({ model: "gpt-6-sol", thinking: "high", source: "command", tier: "deep" });
		expect(seen).toHaveLength(0);
	});
	test("pinned keeps the current model and thinking, ignoring command and Jev", async () => {
		const { judge, seen } = jev({ quick: 0.9, standard: 0.05, deep: 0.05 });
		expect(await routePrompt({ ...BASE, pinned: true, commandTier: "deep", current: { model: "gpt-6-luna", thinking: "low" } }, judge)).toEqual({ model: "gpt-6-luna", thinking: "low", source: "pinned" });
		expect(seen).toHaveLength(0);
	});
	test("no judge falls back to standard with failure off", async () => {
		expect(await routePrompt(BASE, undefined)).toEqual({ model: "gpt-6-sol", thinking: "medium", source: "fallback", tier: "standard", failure: "off" });
	});
	test("a confident quick grade switches to luna at low thinking", async () => {
		const { judge } = jev({ quick: 0.82, standard: 0.15, deep: 0.03 });
		expect(await routePrompt(BASE, judge)).toEqual({ model: "gpt-6-luna", thinking: "low", source: "jev", tier: "quick" });
	});
	test("exactly 0.7 switches", async () => {
		const { judge } = jev({ quick: 0.7, standard: 0.2, deep: 0.1 });
		expect((await routePrompt(BASE, judge)).model).toBe("gpt-6-luna");
	});
	test("an unsure quick grade keeps the current model but still sets low thinking", async () => {
		const { judge } = jev({ quick: 0.55, standard: 0.4, deep: 0.05 });
		expect(await routePrompt(BASE, judge)).toEqual({ model: "gpt-6-sol", thinking: "low", source: "held", tier: "quick" });
	});
	for (const reason of ["timeout", "network", "authentication", "rate_limited", "server", "response", "input"] as const) {
		test(`a ${reason} failure falls back to standard`, async () => {
			const judge: RouteJudge = { ask: async () => { throw new JudgeFailure(reason); } };
			expect(await routePrompt(BASE, judge)).toEqual({ model: "gpt-6-sol", thinking: "medium", source: "fallback", tier: "standard", failure: reason });
		});
	}
	test("a Jev slower than the deadline is cut off as a timeout", async () => {
		const judge: RouteJudge = { ask: () => new Promise(() => {}) };
		const started = Date.now();
		const route = await routePrompt(BASE, judge, 50);
		expect(route).toMatchObject({ source: "fallback", failure: "timeout" });
		expect(Date.now() - started).toBeLessThan(1000);
	});
	test("an unknown tier key or missing probabilities is a response failure", async () => {
		expect(await routePrompt(BASE, jev({ trivial: 0.9 }, "trivial").judge)).toMatchObject({ source: "fallback", failure: "response" });
		const bare: RouteJudge = { ask: async () => ({ model: "jev-1", inputTokens: 1, answers: { route: { type: "choice", choice: "quick" } } }) };
		expect(await routePrompt(BASE, bare)).toMatchObject({ source: "fallback", failure: "response" });
	});
	test("a Riot ID never reaches Jev and a long prompt is cut", async () => {
		const { judge, seen } = jev({ quick: 0.1, standard: 0.8, deep: 0.1 });
		await routePrompt({ ...BASE, prompt: `how did Player01#NA1 play ${"x".repeat(10_000)}` }, judge);
		const sent = String(seen[0].message);
		expect(sent).not.toContain("Player01");
		expect(sent.length).toBe(ROUTE_PROMPT_CHARS);
	});
	test("an empty prompt falls back without a call", async () => {
		const { judge, seen } = jev({ quick: 0.9, standard: 0.05, deep: 0.05 });
		expect(await routePrompt({ ...BASE, prompt: "   " }, judge)).toMatchObject({ source: "fallback", tier: "standard" });
		expect(seen).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `bun test src/model-router.test.ts`. Expected: FAIL, "Cannot find module ./model-router".

- [ ] **Step 3: Write `src/model-router.ts`.**

```ts
// Model routing: Jev grades a typed prompt quick / standard / deep; code picks the model and thinking level.
import { COACH_TIERS, ROUTE_QUESTION, TIER_NAMES, type TierName } from "./contracts";
import { scrubIdentifiers } from "./passage-judge";
import { JudgeFailure, SystemOneClient, choiceProbabilities, type JudgeFailureReason } from "./systemone";

/** The winning tier must reach this probability before the model changes; below it the model stays (and keeps its prompt cache). */
export const ROUTE_SWITCH_P = 0.7;
export const ROUTE_DEADLINE_MS = 1500;
/** Only the start of a long prompt is sent: enough to grade it, and far under the 32 KB request cap. */
export const ROUTE_PROMPT_CHARS = 4000;

export type RouteSource = "command" | "jev" | "held" | "fallback" | "pinned";
export interface Route {
	model: string;
	thinking: string;
	source: RouteSource;
	tier?: TierName;
	/** "off" when there is no judge; a JudgeFailureReason after a failed call. Only on source "fallback". */
	failure?: "off" | JudgeFailureReason;
}
export interface RouteInput {
	prompt: string;
	commandTier?: TierName;
	pinned: boolean;
	accounts: string[];
	current: { model: string; thinking: string };
}
export type RouteJudge = Pick<SystemOneClient, "ask">;

/** On when `TYPESAFE_API_KEY` is non-empty, like the passage screen and the grounding gate. */
export function createRouteJudge(environment: Record<string, string | undefined>): RouteJudge | undefined {
	const apiKey = environment.TYPESAFE_API_KEY?.trim();
	return apiKey ? new SystemOneClient({ apiKey }) : undefined;
}

function tierRoute(tier: TierName, source: RouteSource, failure?: Route["failure"]): Route {
	return { ...COACH_TIERS[tier], source, tier, ...(failure && { failure }) };
}

export async function routePrompt(input: RouteInput, judge: RouteJudge | undefined, deadlineMs = ROUTE_DEADLINE_MS): Promise<Route> {
	if (input.pinned) return { ...input.current, source: "pinned" };
	if (input.commandTier) return tierRoute(input.commandTier, "command");
	if (!judge) return tierRoute("standard", "fallback", "off");
	const message = scrubIdentifiers(input.prompt, input.accounts).trim().slice(0, ROUTE_PROMPT_CHARS);
	if (!message) return tierRoute("standard", "fallback", "input");
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Race the call so a transport that ignores the signal cannot hold the turn. Not unref'd: Bun on Windows never fires a lone unref'd timer.
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new JudgeFailure("timeout"));
		}, deadlineMs);
	});
	try {
		const result = await Promise.race([judge.ask({ message }, { route: ROUTE_QUESTION }, controller.signal), timeout]);
		const probabilities = choiceProbabilities(result.answers.route);
		if (!probabilities) throw new JudgeFailure("response");
		const [tier, p] = TIER_NAMES.map((name) => [name, probabilities[name] ?? 0] as const).sort((a, b) => b[1] - a[1])[0];
		if (p <= 0) throw new JudgeFailure("response");
		if (p >= ROUTE_SWITCH_P) return tierRoute(tier, "jev");
		return { model: input.current.model, thinking: COACH_TIERS[tier].thinking, source: "held", tier };
	} catch (error) {
		return tierRoute("standard", "fallback", error instanceof JudgeFailure ? error.reason : "network");
	} finally {
		clearTimeout(timer);
	}
}
```

Note the empty-prompt branch returns `failure: "input"`; the test only checks `source` and `tier`.

- [ ] **Step 4: Run.** `bun test src/model-router.test.ts` then `npm run typecheck`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model-router.ts src/model-router.test.ts
git commit -m "feat(router): route each typed prompt to a model and thinking level through Jev"
```

---

### Task 3: Approved models in the launcher and `resolveCoach`

**Files:**
- Modify: `bin/coach.mjs` (the `--models` argument, around the `"--models", \`${provider}/${model}\`` line)
- Modify: `src/index.ts` (`CoachConfig.approvedModel`, `resolveCoach`)
- Test: `bin/coach.test.mjs`, `src/e2e/coach.test.ts`

**Interfaces:**
- Consumes: `COACH_MODELS` (Task 1).
- Produces: `CoachConfig.approvedModels: { provider: string; ids: string[] }` replacing `approvedModel`; `CoachConfig.pinnedAtLaunch: boolean` (true when `VOXREN_COACH_MODEL` or `VOXREN_COACH_PROVIDER` is set).

- [ ] **Step 1: Write the failing tests.** In `src/e2e/coach.test.ts`, replace the two `approvedModel` assertions (currently lines 97 and 142):

```ts
expect(config.approvedModels).toEqual({ provider: "openai-codex", ids: ["gpt-6-luna", "gpt-6-sol"] });
expect(config.pinnedAtLaunch).toBe(false);
```

```ts
// VOXREN_COACH_PROVIDER=anthropic, VOXREN_COACH_MODEL=claude-opus-5-5 (the existing override test)
expect(config.approvedModels).toEqual({ provider: "anthropic", ids: ["claude-opus-5-5"] });
expect(config.pinnedAtLaunch).toBe(true);
```

In `bin/coach.test.mjs`, where `fallback[fallback.indexOf("--models") + 1]` is asserted:

```js
expect(fallback[fallback.indexOf("--models") + 1]).toBe("openai-codex/gpt-6-luna,openai-codex/gpt-6-sol");
```

and add, next to it, a launch with `VOXREN_COACH_MODEL: "gpt-6-luna"` asserting `--model gpt-6-luna` and `--models openai-codex/gpt-6-luna`.

- [ ] **Step 2: Run to verify they fail.** `bun test bin/coach.test.mjs src/coach.test.ts -t "config"`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `bin/coach.mjs`: add `export const DEFAULT_MODELS = COACH_YAML.agent.models;` next to `DEFAULT_MODEL_ID`, then

```js
const models = values.VOXREN_COACH_MODEL ? [model] : DEFAULT_MODELS;
// ...
"--models", models.map((id) => `${provider}/${id}`).join(","),
```

  - `src/index.ts` `resolveCoach`:

```ts
const pinnedAtLaunch = Boolean(environment.VOXREN_COACH_MODEL?.trim() || environment.VOXREN_COACH_PROVIDER?.trim());
// ...
approvedModels: { provider, ids: pinnedAtLaunch ? [id] : [...COACH_MODELS] },
pinnedAtLaunch,
```

  - `model_select` handler: `if (event.model?.provider === config.approvedModels.provider && config.approvedModels.ids.includes(event.model?.id)) return;` (the pin logic comes in Task 4).

- [ ] **Step 4: Run.** `bun test bin/coach.test.mjs src/coach.test.ts` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/coach.mjs bin/coach.test.mjs src/index.ts src/coach.test.ts
git commit -m "feat(coach): approve every routed model; a launch model override pins the session"
```

---

### Task 4: Route every turn in `before_agent_start`; pin on a player selection

**Files:**
- Modify: `src/index.ts` (`registerCoachCommands`, `installVoxrenCoach`: `before_agent_start`, `model_select`, new `thinking_level_select`)
- Test: `src/e2e/coach.test.ts`

**Interfaces:**
- Consumes: `routePrompt`, `createRouteJudge`, `Route`, `RouteJudge` (Task 2); `config.approvedModels`, `config.pinnedAtLaunch` (Task 3); `CoachCommand.tier` (Task 1).
- Produces: `installVoxrenCoach` gains a trailing optional parameter `routeJudge: RouteJudge | undefined = createRouteJudge(environment)`; a closure variable `lastRoute` readable by the footer through `readFooterStats(ctx, pi, route?)` (Task 5 consumes it). `registerCoachCommands`' `onCommand` callback is called with `(name, tier)`.
- The `installVoxrenCoach` `pi` pick gains `"setModel" | "setThinkingLevel"`.

- [ ] **Step 1: Write the failing tests** in `src/e2e/coach.test.ts`. Extend `fakePi()` with:

```ts
const selected: Array<{ model?: string; thinking?: string }> = [];
// inside the returned object:
setModel: async (model: any) => { selected.push({ model: model.id }); return true; },
setThinkingLevel: (thinking: string) => { selected.push({ thinking }); },
```

and a ctx helper that carries `modelRegistry.find(provider, id) => ({ provider, id, reasoning: true })` and `model: { provider: "openai-codex", id: "gpt-6-sol" }`. Then:

```ts
const quickJudge = { ask: async () => ({ model: "jev-1", inputTokens: 1, answers: { route: { type: "choice", choice: "quick", probabilities: { quick: 0.9, standard: 0.08, deep: 0.02 } } } }) };
const failIfCalled = { ask: async () => { throw new Error("Jev must not be called"); } };
const agentStartEvent = (prompt: string) => ({ prompt, systemPromptOptions: {} });
/** ctx for routing tests: a signed-in Sol session, a registry that knows the given ids (all approved ids by default). */
function routingCtx(known: string[] = ["gpt-6-luna", "gpt-6-sol"], current = "gpt-6-sol") {
	return {
		model: { provider: "openai-codex", id: current, reasoning: true },
		modelRegistry: { find: (provider: string, id: string) => (known.includes(id) ? { provider, id, reasoning: true } : undefined) },
		ui: { notify: () => {} },
		abort: mock(() => {}),
		shutdown: mock(() => {}),
	};
}
/**
 * installVoxrenCoach with every live dependency faked. Positions after `environment` follow the signature:
 * custodian, readComposition, readRiotId, createFooter, lookupLane, exchangeLog, perplexityCustodian, typesafeCustodian, routeJudge.
 * Use the same fakes Task 0 settled on for the non-hanging tests (a closed-client footer, a fixed lane, an in-memory exchange log).
 */
function installRouted(fake: ReturnType<typeof fakePi>, judge: RouteJudge | undefined, environment: Record<string, string> = FULL_ENV) {
	installVoxrenCoach(
		fake.pi as any,
		environment,
		custodian,
		async () => undefined,
		async () => undefined,
		() => ({ read: () => ({ kind: "closed" }), stop: () => {} }),
		async () => "mid",
		{ start: () => {}, end: () => {}, command: () => {} } as any,
		undefined,
		undefined,
		judge,
	);
}
const typed = (fake: ReturnType<typeof fakePi>, prompt: string, ctx = routingCtx()) => fake.handlers.get("before_agent_start")![0](agentStartEvent(prompt), ctx);

describe("model routing", () => {
	test("a typed quick prompt switches to luna at low thinking before the turn", async () => {
		const fake = fakePi();
		installRouted(fake, quickJudge);
		await typed(fake, "what does fizz w do");
		expect(fake.selected).toEqual([{ model: "gpt-6-luna" }, { thinking: "low" }]);
	});

	test("the router's own selections never pin; a later typed prompt still routes", async () => {
		const fake = fakePi();
		// Pi fires model_select from inside setModel; replay that so the routing flag is exercised.
		fake.pi.setModel = async (model: any) => {
			fake.selected.push({ model: model.id });
			await fake.handlers.get("model_select")![0]({ model, source: "set" }, routingCtx());
			return true;
		};
		fake.pi.setThinkingLevel = (thinking: string) => {
			fake.selected.push({ thinking });
			fake.handlers.get("thinking_level_select")![0]({ level: thinking, previousLevel: "medium" }, routingCtx());
		};
		installRouted(fake, quickJudge);
		await typed(fake, "what does fizz w do");
		await typed(fake, "what does fizz e do");
		expect(fake.selected).toEqual([{ model: "gpt-6-luna" }, { thinking: "low" }, { model: "gpt-6-luna" }, { thinking: "low" }]);
	});

	test("a player model selection inside the approved list pins the session", async () => {
		const fake = fakePi();
		installRouted(fake, quickJudge);
		await fake.handlers.get("model_select")![0]({ model: { provider: "openai-codex", id: "gpt-6-sol" }, source: "set" }, routingCtx());
		await typed(fake, "what does fizz w do");
		expect(fake.selected).toEqual([]);
	});

	test("a player thinking selection pins the session", async () => {
		const fake = fakePi();
		installRouted(fake, quickJudge);
		await fake.handlers.get("thinking_level_select")![0]({ level: "high", previousLevel: "medium" }, routingCtx());
		await typed(fake, "what does fizz w do");
		expect(fake.selected).toEqual([]);
	});

	test("a model outside the approved list still shuts the session down", async () => {
		const fake = fakePi();
		installRouted(fake, quickJudge);
		const ctx = routingCtx();
		await fake.handlers.get("model_select")![0]({ model: { provider: "openai-codex", id: "gpt-6-astra" }, source: "set" }, ctx);
		expect(ctx.shutdown).toHaveBeenCalled();
	});

	test("/review routes deep with no Jev call", async () => {
		const fake = fakePi();
		installRouted(fake, failIfCalled);
		await fake.commands.get("review").handler("5", { ...routingCtx(), mode: "tui" });
		await typed(fake, fake.sent[0].text);
		// Sol is already the current model, so only the thinking level changes.
		expect(fake.selected).toEqual([{ thinking: "high" }]);
	});

	test("a command that fails validation does not leak its tier onto the next typed prompt", async () => {
		const fake = fakePi();
		installRouted(fake, quickJudge);
		await fake.commands.get("otp").handler("", { ...routingCtx(), mode: "tui" }); // usage error: nothing sent
		expect(fake.sent).toHaveLength(0);
		await typed(fake, "what does fizz w do");
		expect(fake.selected).toEqual([{ model: "gpt-6-luna" }, { thinking: "low" }]);
	});

	test("a tier model the registry does not know keeps the current model and still sets thinking", async () => {
		const fake = fakePi();
		installRouted(fake, quickJudge);
		await typed(fake, "what does fizz w do", routingCtx(["gpt-6-sol"]));
		expect(fake.selected).toEqual([{ thinking: "low" }]);
	});

	test("VOXREN_COACH_MODEL starts the session pinned", async () => {
		const fake = fakePi();
		installRouted(fake, failIfCalled, { ...FULL_ENV, VOXREN_COACH_MODEL: "gpt-6-luna" });
		await typed(fake, "what does fizz w do", routingCtx(undefined, "gpt-6-luna"));
		expect(fake.selected).toEqual([]);
	});
});
```

`fakePi()` must expose `pi` (the object handed to `installVoxrenCoach`), `handlers`, `commands`, `sent`, and the new `selected`; `fake.pi.setModel` / `setThinkingLevel` push onto `selected` as shown above the block. If Task 0 changed which fakes the other tests pass, use those in `installRouted` instead. Import `mock` from `bun:test` and `type RouteJudge` from `./model-router`.

- [ ] **Step 2: Run to verify they fail.** `bun test src/e2e/coach.test.ts -t "model routing"`. Expected: FAIL (`selected` empty).

- [ ] **Step 3: Implement in `src/index.ts`.**
  - `registerCoachCommands`: change `onCommand: (name: string) => void` to `onCommand: (name: string, tier: TierName) => void` and call `onCommand(command.name, command.tier)` where it is called today (after the empty-text check, right before `pi.sendUserMessage`, so a usage error records nothing).
  - In `installVoxrenCoach`:

```ts
let pinned = config.pinnedAtLaunch;
let routing = false;
let pendingCommand: { name: string; tier: TierName } | undefined;
let lastRoute: (Route & { command?: string }) | undefined;
registerCoachCommands(pi, config, readComposition, championLane, (name, tier) => {
	exchangeLog.command(name);
	pendingCommand = { name, tier };
});
```

  - In `before_agent_start`, after the turn timer is armed and before the system prompt is built:

```ts
const command = pendingCommand;
pendingCommand = undefined;
const route = await routePrompt(
	{ prompt: event.prompt ?? "", commandTier: command?.tier, pinned, accounts: config.accounts, current: { model: ctx?.model?.id ?? config.approvedModels.ids[0], thinking: pi.getThinkingLevel() } },
	routeJudge,
);
lastRoute = { ...route, ...(command && { command: command.name }) };
if (route.source !== "pinned") {
	routing = true;
	try {
		const target = route.model !== ctx?.model?.id ? ctx?.modelRegistry?.find(config.approvedModels.provider, route.model) : undefined;
		if (target) await pi.setModel(target); // false = provider not signed in: keep the current model
		pi.setThinkingLevel(route.thinking as any);
	} finally {
		routing = false;
	}
}
```

  - `model_select`: after the approved-list check passes, `if (!routing) pinned = true;` (approved selection by the player pins). Outside the list: unchanged abort + shutdown.
  - New handler: `pi.on("thinking_level_select", async () => { if (!routing) pinned = true; });`
  - `session_start`: reset `pinned = config.pinnedAtLaunch; pendingCommand = undefined; lastRoute = undefined;`.

- [ ] **Step 4: Run.** `bun test src/e2e/coach.test.ts` then `npm run typecheck`. Expected: PASS, file exits.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/coach.test.ts
git commit -m "feat(coach): route model and thinking per turn, pin on a player selection"
```

---

### Task 5: The footer word

**Files:**
- Modify: `src/ui.ts` (`FooterStats`, `footerLines`)
- Modify: `src/index.ts` (`readFooterStats` takes the last route; `installCoachSurface` passes it)
- Test: `src/e2e/coach.test.ts` (the footer tests near the existing `footerLines(theme, { ...stats, subscription: true, thinking: "high" }, ...)` assertion)

**Interfaces:**
- Consumes: `lastRoute` (Task 4), `Route` (Task 2).
- Produces: `FooterStats.route?: string` — the finished word; `routeWord(route: (Route & { command?: string }) | undefined): string | undefined` exported from `src/ui.ts`.

- [ ] **Step 1: Write the failing tests.**

```ts
describe("footer route word", () => {
	test("each route source has its word", () => {
		expect(routeWord({ model: "gpt-6-luna", thinking: "low", source: "jev", tier: "quick" })).toBe("jev");
		expect(routeWord({ model: "gpt-6-sol", thinking: "low", source: "held", tier: "quick" })).toBe("jev");
		expect(routeWord({ model: "gpt-6-sol", thinking: "high", source: "command", tier: "deep", command: "review" })).toBe("/review");
		expect(routeWord({ model: "gpt-6-sol", thinking: "medium", source: "fallback", tier: "standard", failure: "off" })).toBe("jev off");
		expect(routeWord({ model: "gpt-6-sol", thinking: "medium", source: "fallback", tier: "standard", failure: "timeout" })).toBe("jev timeout");
		expect(routeWord({ model: "gpt-6-sol", thinking: "high", source: "pinned" })).toBe("pinned");
		expect(routeWord(undefined)).toBeUndefined();
	});
	test("the word ends the right side of the footer", () => {
		const line = footerLines(theme, { ...stats, subscription: true, thinking: "low", route: "jev" }, 80, resolveCoach(FULL_ENV).labels)[0];
		expect(line.endsWith("gpt-6-sol · thinking low · jev")).toBe(true);
	});
});
```

(The model label on the footer is the launch label; showing the routed model name is Step 3's second bullet.)

- [ ] **Step 2: Run to verify they fail.** `bun test src/e2e/coach.test.ts -t "footer route word"`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `src/ui.ts`: add `route?: string` to `FooterStats`; export `routeWord`:

```ts
/** Who chose the model on the right: Jev, a command's fixed tier, the fallback, or the player's pin. */
export function routeWord(route: { source: string; command?: string; failure?: string } | undefined): string | undefined {
	if (!route) return undefined;
	if (route.source === "jev" || route.source === "held") return "jev";
	if (route.source === "command") return route.command ? `/${route.command}` : undefined;
	if (route.source === "fallback") return `jev ${route.failure ?? "off"}`;
	return "pinned";
}
```

  - In `footerLines`, the right side becomes `${modelName}${stats.thinking ? ` · thinking ${stats.thinking}` : ""}${stats.route ? ` · ${stats.route}` : ""}`, and `modelName` comes from `stats.model ?? labels.model` so the routed model shows, not the launch model: add `model?: string` to `FooterStats` and set it in `readFooterStats` from `ctx?.model?.id`.
  - `src/index.ts`: `readFooterStats(ctx, pi, route?)` sets `route: routeWord(route)` and `model: ctx?.model?.id`; `installCoachSurface` gains a `readRoute: () => Route | undefined` argument threaded into the `createFooter` read callback; `installVoxrenCoach` passes `() => lastRoute`.

- [ ] **Step 4: Run.** `bun test src/e2e/coach.test.ts` then `npm run typecheck`. Expected: PASS. Update the two existing footer width assertions if the new `model` field changes them (they read `gpt-6-sol` either way).

- [ ] **Step 5: Commit**

```bash
git add src/ui.ts src/index.ts src/coach.test.ts
git commit -m "feat(ui): name who chose the model on the footer"
```

---

### Task 6: Privacy, Jev docs, and the route lab

**Files:**
- Modify: `docs/privacy.md`, `docs/jev.md`, `docs/configuration.md`, `AGENTS.md` (layout table row)
- Create: `src/lab/route-lab.ts`

- [ ] **Step 1: `docs/privacy.md`** — add a section "Model routing": with `TYPESAFE_API_KEY` set, the typed prompt (Riot IDs and match ids scrubbed by `scrubIdentifiers`, cut to 4,000 characters) goes to TypeSafe System One to pick a model; slash-command prompts are never sent; without the key nothing is sent and every typed prompt runs at the standard tier.
- [ ] **Step 2: `docs/jev.md`** — add "Model routing" after the grounding gate: the `jev.route` choice question, the tier table from Global Constraints, `ROUTE_SWITCH_P = 0.7` held-vs-switch rule, the 1.5 s deadline, the footer words, and pinning.
- [ ] **Step 3: `docs/configuration.md`** — `VOXREN_COACH_MODEL` row: "pins the session on this model; Jev routing stays off". Add `agent.models` and `agent.tiers` to the coach.yaml defaults paragraph.
- [ ] **Step 4: `AGENTS.md`** — layout row: `| \`src/model-router.ts\` | Jev model routing: grades a typed prompt quick / standard / deep; code picks the model and thinking level. |`
- [ ] **Step 5: `src/lab/route-lab.ts`** — mirror `src/lab/grounding-lab.ts`'s shape (reads `TYPESAFE_API_KEY` from the environment, exits with a message when absent). Holds 30 labelled prompts (10 per tier, written from real coach use: e.g. quick "what's fizz's e cooldown at rank 3", standard "how do I play fizz into syndra", deep "review my last 10 games and tell me my top 3 habits"). For each, calls `routePrompt({ prompt, pinned: false, accounts: [], current: { model: "gpt-6-sol", thinking: "medium" } }, createRouteJudge(process.env))`, prints a 3x3 confusion matrix of label vs `tier`, the switch rate at 0.7, and lists every `deep`-labelled prompt that came back `source: "jev", tier: "quick"` (the miss to drive to zero).
- [ ] **Step 6: Run** `npm run typecheck` and `bun test`. Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add docs/privacy.md docs/jev.md docs/configuration.md AGENTS.md src/lab/route-lab.ts
git commit -m "docs(jev): document model routing and add the route lab"
```

---

### Task 7: Verify in the running coach

- [ ] **Step 1:** With `TYPESAFE_API_KEY` set, run `bun src/lab/route-lab.ts` and record the confusion matrix in the PR description. If any deep prompt routed to Luna at 0.7 or above, stop and report before tuning.
- [ ] **Step 2:** Run the coach per `docs/agent-terminal.md` (its ladder: print mode, then the terminal tab). Send in order: `what does fizz w do`, `/review 5`, then pick `gpt-6-sol` with Pi's model picker and send `what does fizz e do`. After each, read the footer: expected `gpt-6-luna · thinking low · jev`, then `gpt-6-sol · thinking high · /review`, then `gpt-6-sol · thinking … · pinned`.
- [ ] **Step 3:** Unset `TYPESAFE_API_KEY`, relaunch, send one prompt: footer ends `gpt-6-sol · thinking medium · jev off`.
- [ ] **Step 4:** Use superpowers:finishing-a-development-branch.
