# Coach Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw a finished coach answer as boxed, colour-coded sections with champion portraits, phase order, a swap box, and live owned/next items, where the terminal draws pictures.

**Architecture:** A pure model (`panelModel`) turns the answer text plus live facts into sections; a renderer (`panelLines`) draws boxes at a width; `src/index.ts` appends one panel entry at `agent_end` in place of today's build-strip entry and hides the rows that entry draws. Older build entries keep drawing.

**Tech Stack:** TypeScript on Bun, `@earendil-works/pi-tui` (`wrapTextWithAnsi`, `visibleWidth`, `setCapabilities`), existing `src/icons.ts` / `src/terminal-images.ts` icon path.

**Spec:** `docs/superpowers/specs/2026-10-06-coach-panel-design.md`. The spike that proved the drawing is `src/lab/panel-spike.ts` on branch `spike/panel-layout` (read it for the box and side-by-side code; do not copy its icon loading).

## Global Constraints

- Rules in `AGENTS.md` apply: prompts only in `coach.yaml`; no empty catch, every fallback logs (`logEvent`); never await an unref'd timer; tests run public functions, never grep sources; no game constants in code (champion, item, rune names come from Data Dragon).
- Side by side at `width >= 130`; stacked below. Phase cutoff `LANING_UNTIL_SEC = 14 * 60`.
- Colours (truecolor hex, as theme-independent constants in `src/panel.ts`): NOW `#5fd4ff`, quiet box `#8592ad`, BUILD `#ffc24d`, SWAP `#ff8f66`, Fights `#d9a4ff`, Threat `#ff8f66`, Kill `#8ee07a`, Lane `#8592ad`, other labels `#5fd4ff`, cue `#a3acbf`, action bold `#ffffff`, key cap background `#5fd4ff` with text `#0f1420`.
- Box characters: top `┏━ TITLE ─…╮`, sides `┃` (section colour) and `│` (faint), bottom `┗─…╯`.
- Label groups: laning = `Lane, Kill, Gank, Side, Matchup`; later = `Fights, Macro, Win, Edge, Now, Next`; `Answer` and `Threat` always NOW; any other label NOW. Before the cutoff (or no live game) NOW = answer + laning + Threat and the quiet box is titled `LATER`; from the cutoff NOW = answer + later + Threat and the quiet box is `LANING`.
- Where pictures do not draw (`stripGateOn()` false) behaviour is unchanged.
- Base: branch `feat/coach-panel` from `origin/main`. Task 8 waits for `feat/unified-router` to merge (agreed with that session: it goes first on `coach.yaml`).
- Run the suite on the devbox (`just devbox`), not on the Windows machine.

## Review Focus

1. A row naming a champion Data Dragon does not know (a typo, "Cait"): the row draws with no portrait, text intact. Test in Task 1.
2. An answer with no call rows and no build lines (a plain prose answer): no panel entry, answer untouched. Test in Task 6.
3. A pane narrower than 40 columns, or resized after drawing: every line at most `width` cells, boxes stacked. Test in Task 4.
4. A key cap at a wrap point ("dodge Q" at the end of a line): the cap never splits and its background never runs into the next line. Test in Task 4.
5. A resumed session whose branch holds old `voxren-build` entries and new `voxren-panel` entries: both draw, and only answers with a panel lose their rows. Test in Task 6.

---

### Task 1: Champion portraits and champion names in text

**Files:**
- Modify: `src/icons.ts` (`IconKind`, `iconLine`, `cacheKey`, `loadChampionFiles`)
- Test: `src/icons.test.ts`

**Interfaces:**
- Produces: `IconKind = "item" | "rune" | "summoner" | "champion"`; `iconLine(name, ["champion"], rows)` draws a portrait cached by `prefetchChampionIcons`; `championsIn(text: string, ddragonVersion: string, base: string, fetchImpl?: FetchLike, timeoutMs?: number): Promise<string[]>` returns the display names (Data Dragon `name`) of champions named in `text`, in order of first appearance, no duplicates, matched on whole words by `id` or `name` ("Wukong" and "MonkeyKing" both give "Wukong"). Never throws; `[]` on a failed load (logged once).

- [ ] **Step 1: Write the failing tests** in `src/icons.test.ts`, with a stubbed `fetchImpl` serving a `champion.json` holding Caitlyn, Sona, Viego, and MonkeyKing/Wukong:
  - `championsIn("Sona uses Crescendo: burst Caitlyn, then Viego", …)` → `["Sona", "Caitlyn", "Viego"]`
  - `championsIn("MonkeyKing and Wukong", …)` → `["Wukong"]`
  - `championsIn("Cait walks up", …)` → `[]`
  - after `prefetchChampionIcons(["Sona"], …)` with images on (`setCapabilities({ images: "iterm2", … })`), `iconLine("Sona", ["champion"], 2)?.sequence` contains `1337;File=`; `iconLine("Sona", ["item"])` is `undefined`.
- [ ] **Step 2: Run** `bun test src/icons.test.ts` — expect the new tests to FAIL (`championsIn` not exported).
- [ ] **Step 3: Implement.** Keep a per-version champion name table beside `championFilesByVersion` (normalized id and name → display name) filled by `loadChampionFiles`; `championsIn` loads it under an `AbortController` with a plain `setTimeout` cleared in `finally`, then scans `text` word by word. `cacheKey("champion", name)` is the existing `champion:<normalized>` key.
- [ ] **Step 4: Run** `bun test src/icons.test.ts` — PASS.
- [ ] **Step 5: Commit** `icons: champion portraits draw inline, and the champions an answer names are found from Data Dragon`.

### Task 2: One live read for the panel

**Files:**
- Modify: `src/lcu.ts` (near `readComposition`)
- Test: `src/lcu.test.ts`

**Interfaces:**
- Produces: `export interface LivePanelFacts { gameTimeSec: number; ownedItems: string[] }` and `readLivePanel(makeClient: (target: LcuTarget) => LcuClient = …, timeoutMs = LCU_COMPOSITION_TIMEOUT_MS): Promise<LivePanelFacts | undefined>`: the live client's state through `readLiveGame`, `ownedItems` = the self player's `items` (`players[selfIndex].items`), `undefined` when no game runs, the read fails, or it times out (raced with a cleared plain timer, rule 8).

- [ ] **Step 1: Write the failing tests** with a stub client whose live feed has the self player at 1830 s holding Lich Bane and Zhonya's Hourglass: `readLivePanel(stub)` → `{ gameTimeSec: 1830, ownedItems: ["Lich Bane", "Zhonya's Hourglass"] }`; a client that rejects → `undefined`; a client that never answers with `timeoutMs = 20` → `undefined`.
- [ ] **Step 2: Run** `bun test src/lcu.test.ts` — FAIL.
- [ ] **Step 3: Implement** `readLivePanel` beside `readComposition`, reusing `LIVE_CLIENT_PORT` and `ALLOWED_HOST`. A failed read logs `panel-live-read-failed` and returns `undefined`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `lcu: one bounded live read gives the panel the clock and the player's items`.

### Task 3: The panel model

**Files:**
- Create: `src/panel.ts` (model half)
- Modify: `src/ui.ts` (export `ANSWER_ROW`, `CUE_WORDS`), `src/build-lines.ts` (nothing new; consumed)
- Test: `src/panel.test.ts`

**Interfaces:**
- Consumes: `buildLines`, `SWAP` (build-lines.ts), `setupSwaps` (setup-swaps.ts), `isBuildFormatLine`.
- Produces:
  ```ts
  export type CallRow = { label: string; cue: string; action: string; champions: string[] };
  export type SwapRow = { from: string; to: string; reason: string };
  export type Box = { title: string; colour: string; quiet: boolean; rows: CallRow[] };
  export type PanelModel = { boxes: Box[]; build?: BuildLines; swaps: SwapRow[]; owned: string[]; next?: string; clock?: string; status: string };
  export function panelModel(answer: string, facts: { champions: string[]; live?: LivePanelFacts; status: string }): PanelModel;
  export const LANING_UNTIL_SEC = 14 * 60;
  ```
  `boxes` is NOW first, the quiet box second, each left out when empty. `cue` is the text before the call's first ": " when it is `CUE_WORDS` words or fewer, else `""`. `champions` per row are `facts.champions` that the row's text names, in row order. `swaps` come from every `Swap:` line (`SWAP`: first → second, rest as reason without ", into ") and every `/pick` `Setup:` swap (`setupSwaps`: from → to, the "because …" clause as reason). `next` is the first item of the build path not in `owned`; `owned` is the build path's items found in `facts.live.ownedItems`. `clock` is `m:ss` when live.

- [ ] **Step 1: Write the failing tests** in `src/panel.test.ts` over this answer:
  ```
  Lane: Q shield up: hold abilities, then E his Q.
  Kill: Q missed and low: all-in.
  Threat: Viego enters melee range: save E for his engage.
  Fights: Sona uses Crescendo: burst Caitlyn before she free-hits.
  Runes: Electrocute, Sudden Impact, Grisly Mementos, Ultimate Hunter; Transcendence, Gathering Storm; Adaptive Force, Adaptive Force, Health; Flash, Ignite
  Build: Doran's Ring → Lich Bane → Sorcerer's Shoes → Zhonya's Hourglass
  Swap: Health instead of Health Scaling, into Viego and Sona engage
  ```
  - no live facts: `boxes.map(b => [b.title, b.rows.map(r => r.label)])` → `[["NOW", ["Lane", "Kill", "Threat"]], ["LATER", ["Fights"]]]`
  - `live: { gameTimeSec: 1830, ownedItems: ["Doran's Ring", "Lich Bane", "Sorcerer's Shoes"] }`: → `[["NOW · 30:20", ["Threat", "Fights"]], ["LANING", ["Lane", "Kill"]]]`, `owned` → `["Doran's Ring", "Lich Bane", "Sorcerer's Shoes"]`, `next` → `"Zhonya's Hourglass"`, quiet box `quiet: true`
  - the Fights row: `cue` `"Sona uses Crescendo"`, `action` `"burst Caitlyn before she free-hits."`, with `champions: ["Viego", "Sona", "Caitlyn"]` in facts → row champions `["Sona", "Caitlyn"]`
  - `swaps` → `[{ from: "Health Scaling", to: "Health", reason: "Viego and Sona engage" }]`; a `Setup: Health Scaling shard to Health, because Viego engages.` answer → `[{ from: "Health Scaling", to: "Health", reason: "Viego engages." }]`
  - a prose-only answer → `boxes: []`, `build: undefined`, `swaps: []`
  - an `Answer:` row and an unknown `Buy:` row land in NOW.
- [ ] **Step 2: Run** `bun test src/panel.test.ts` — FAIL.
- [ ] **Step 3: Implement `panelModel`** using the label groups in Global Constraints. Title is `NOW · m:ss` when live, else `NOW`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `panel: an answer's rows sorted into this phase's box and the other's, with its swaps and live items`.

### Task 4: The panel renderer

**Files:**
- Modify: `src/panel.ts` (render half), `src/ui.ts` (export `chip`, `packPieces`, `EDGE_CELLS`)
- Modify: `src/terminal-images.ts` (grey icon)
- Test: `src/panel.test.ts`

**Interfaces:**
- Consumes: `PanelModel` (Task 3), `iconLine` incl. `"champion"` (Task 1), `chip`, `packPieces`, `iconRows`, `fitInlineIcons`, `hasInlineIcon`.
- Produces: `panelLines(theme: UiTheme, model: PanelModel, width: number, header?: { self?: string; opponent?: string; detail: string }): string[]` and `createPanel(theme, model, header?): UiComponent` (indented by `CARD_MARGIN` like `createBuildStrip`). In `terminal-images.ts`: `greyIcon(base64: string, dims, imageId: number, rows: number): { sequence: string; columns: number } | undefined` — the PNG desaturated through resvg (`feColorMatrix type="saturate" values="0"`, opacity 0.45), memoized by base64 and rows; `undefined` without the rasterizer.

Drawing rules (spec "What the player sees"): a call row is label (colour by label) · glyph (`⚔` Fights, `⚠` Threat, followed by two spaces since WezTerm draws `⚔` wider than a cell) · portraits two rows tall standing on the cue line (the row above keeps their columns blank) · action in bold white, wrapped; then `when <cue>` dim. Standalone `Q W E R` (`/\b[QWER]\b/`) become key caps with no-break spaces inside; champion names from the row become bold underlined white. Every emitted line ends with `\x1b[0m`. The runes page is today's strip content (`chip`/`packPieces`, tall rows) with an amber `↻` after the piece a swap's `to` names; items: owned drawn with `greyIcon` (plain icon plus dim `✓` when it returns `undefined`), a gold `▸`, then the rest from `next`. SWAP box: `from` icon, amber `→`, `to` icon (two rows), reason wrapped in amber. Status line dim after the boxes.

- [ ] **Step 1: Write the failing tests** (images on, `TERM_PROGRAM=WezTerm`, stubbed icon fetch as in `src/ui.test.ts`'s build-strip tests; assertions on `plain()` text and on raw bytes where it matters):
  - at 150: a line contains both `┏━ NOW · 30:20` and `┏━ LANING`; at 100: no line contains both titles, and `NOW` comes before `LANING`
  - every line's `visibleWidth` with icons counted as their step (`fitInlineIcons(line, width) === line`) for widths 150, 100, 60, 36
  - the Fights row: the line holding `burst Caitlyn` has `Caitlyn` wrapped in `\x1b[4m`; the next line reads `when Sona uses Crescendo`; the portraits' `1337;File=` sequences sit on that cue line with a `[1A` (rising)
  - `save E for` renders `E` between ` ` inside the key-cap background, and at a width that puts `E` at a wrap point the cap is whole on one line and every line ends with `\x1b[0m`
  - a box with no rows draws no title; a model with only `build` draws BUILD and no NOW
  - SWAP box text reads `Viego and Sona engage`; the rune row has `↻` right after the Health shard's icon
  - `greyIcon` returns `undefined` when `loadRasterizer()` has not run, and the items row then shows `✓` after each owned icon
- [ ] **Step 2: Run** `bun test src/panel.test.ts` — FAIL.
- [ ] **Step 3: Implement** `panelLines` (boxes and side-by-side as in the spike's `box` and `sideBySide`, with widths `floor((width-2)*0.56)` for calls and `floor((width-2)*0.68)` for build), `createPanel`, and `greyIcon`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `panel: boxes with a coloured rail, portraits, key caps, and the build and swaps drawn with icons`.

### Task 5: Status line text

**Files:**
- Modify: `src/ui.ts` (export a helper from the CHECK card's source text)
- Test: `src/ui.test.ts`

**Interfaces:**
- Produces: `panelStatus(route: RouteView | undefined, messages: any[]): string` — `routeText(route)` then, when a `voxren_strategy_frame` result is in `messages`, `✓ N/M grounded` from the same count `sourceText` shows (ui.ts ~1443-1451; extract that count into `groundedCount(data): { grounded: number; total: number } | undefined` and use it in both places). No route and no check → `""`.

- [ ] **Step 1: Write the failing test**: a route `{ source: "draft", … }` and a check result with 4 claims all grounded → string containing `/draft` and `✓ 4/4 grounded`; neither → `""`; existing CHECK card tests still pass.
- [ ] **Step 2: Run** `bun test src/ui.test.ts` — FAIL.
- [ ] **Step 3: Implement** by extraction; the CHECK card's output is unchanged.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `ui: the check's grounded count as one helper, shared by the card and the panel's status line`.

### Task 6: Wire the panel into the coach

**Files:**
- Modify: `src/index.ts` (`showBuildStrip` ~729-755 → `showPanel`; transformer ~706-712; entry renderers ~713-715; `resumeBuildIcons` ~908-930; `agent_end` ~1223; extension params where `readComposition ??=` is set ~601)
- Test: `src/e2e/coach.test.ts`, `src/ui.test.ts`

**Interfaces:**
- Consumes: `panelModel`, `createPanel` (Tasks 3-4), `championsIn`, `prefetchChampionIcons` (Task 1), `readLivePanel` (Task 2), `panelStatus` (Task 5).
- Produces: `export const PANEL_ENTRY_TYPE = "voxren-panel"`, entry data `{ answer: string; source?: string; ownPicks?: string[]; champions: string[]; live?: LivePanelFacts; status: string; header?: { self?: string; opponent?: string; detail: string } }`, where `header` comes from the last `Composition` this turn's command read (keep it in a variable when `readComposition` resolves: `selfChampion` from the router's addition once merged, else the champion marked (you); `enemyLaner`; `detail` = `selfLane`), and is left out for a turn that read none; an injectable extension parameter `readLivePanel?: () => Promise<LivePanelFacts | undefined>` defaulting to `() => readLivePanel(lcuSource.makeClient)`, called only when the footer's last state is `liveGame`.

Behaviour: `showPanel(messages)` builds the answer text as `showBuildStrip` does, returns with no entry when the answer has neither call rows nor build lines; prefetches item, rune, and champion icons (each failure logged, never fatal); reads live facts when in game; appends the entry; adds `answer` to a `panelled: Set<string>` (capped at 200, oldest out). The transformer: for an assistant message with `stripGateOn()`, `!isStreaming`, and its markdown in `panelled`, draw `answerMarkdown` of the prose lines only (call rows and build lines removed); otherwise as today. Session start adds every `voxren-panel` entry's `answer` to `panelled` and prefetches its icons (extend `resumeBuildIcons`). The `voxren-build` renderer stays.

- [ ] **Step 1: Write the failing tests** in `src/e2e/coach.test.ts` beside the build-strip test at ~1232: with images on and a stubbed live read giving 1830 s and two owned items, a turn answering the Task 3 answer appends one `voxren-panel` entry whose data has `champions` `["Viego", "Sona", "Caitlyn"]`, `live.gameTimeSec` 1830, and a `status` containing `/draft`; no `voxren-build` entry; the rendered entry has a `┏━ NOW · 30:20` line. A prose-only answer appends nothing. A resumed branch with one old `voxren-build` and one `voxren-panel` entry draws both, and the transformer draws the old answer's rows and drops the new answer's rows.
- [ ] **Step 2: Run** `bun test src/e2e/coach.test.ts` — FAIL.
- [ ] **Step 3: Implement** as described.
- [ ] **Step 4: Run** `bun test src/e2e/coach.test.ts src/ui.test.ts` — PASS (update the build-strip e2e test at ~1232 to expect the panel entry; keep ~1323's resumed `voxren-build` case passing unchanged).
- [ ] **Step 5: Commit** `coach: a finished answer draws as the panel where pictures draw, older build strips still draw`.

### Task 7: Catalogue, story gate, and the lab preview

**Files:**
- Modify: `src/lab/ui-fixtures.ts` (~237-241), `src/lab/icon-check.ts` (~33-61), `src/lab/strip-preview.ts`
- Test: `src/ui-catalog.test.ts` (runs the fixtures), `src/lab/icon-check.test.ts` if present, else the stories' unit tests

**Interfaces:**
- Consumes: `panelModel`, `panelLines`.
- Produces: catalogue entries `panel <sample>-icons` over `CATALOGUE_SAMPLES`, each with a live variant (`panel <sample> live-icons`, 1830 s); `expectedIcons` also expects the portraits of the champions the answer names; `strip-preview.ts --panel` prints the panel instead of the strip.

- [ ] **Step 1: Add the fixtures and the icon expectation**; run `bun test src/ui-catalog.test.ts` — the new entries pass the text gates at every `GATE_WIDTHS` and theme; run the icon-check tests — portraits expected.
- [ ] **Step 2: Rung 5 look:** `bun run src/lab/strip-preview.ts --panel --shot panel.png` at 150 and 80 columns; read the shots; fix anything clipped or overlapping in Task 4's code with a test that pins it.
- [ ] **Step 3: Commit** `lab: the panel in the UI catalogue, the story icon gate, and the strip preview`.

### Task 8: Prompt wording (after `feat/unified-router` merges)

**Files:**
- Modify: `coach.yaml` — `<output>` short-rows rule (~line 38), `/draft` frame (~424-430), `prompts.liveQuestion` (~130-141)
- Test: `src/contracts.test.ts` (placeholders still valid), story run

- [ ] **Step 1: Rebase** `feat/coach-panel` on `origin/main` once the router PR is in; confirm none of the lines below changed under it.
- [ ] **Step 2: Edit** the short-rows rule to add: "A call row is the cue the player sees, a colon, then the action, and names the champion it is about." In `/draft`, replace "the cue first when there is one" with "the cue, a colon, then the action (Threat: Viego enters melee range: save E for his engage.)". In `prompts.liveQuestion`, add the same row-form sentence after its row list. `/pick` Setup is unchanged.
- [ ] **Step 3: Run** `bun test src/contracts.test.ts` — PASS.
- [ ] **Step 4: Live check** in the background (rule 14): `just stories --only cmd-draft-pyke,cmd-pick-pyke,cmd-matchup-one`; every story's `icons` gate passes and the rows carry a cue.
- [ ] **Step 5: Commit** `coach: call rows put the cue, a colon, then the action, so the panel splits them`.

### Task 9: Verify and ship

- [ ] **Step 1:** `just devbox` from the worktree — typecheck and the full suite pass.
- [ ] **Step 2:** Rung 5: `just wez open`, then `just wez record --pid <n> panel.gif --send "/draft" --seconds 90` in a live game (or the draft lab's live replay) at 150 and 80 columns; read `panel-sheet-1.png` and single frames: the streaming rows, then the panel replacing them with no row drawn twice and no picture wiped. `just wez close --pid <n>`.
- [ ] **Step 3:** Push, open the PR (title `coach: the answer as boxed sections with portraits, phase order, and a swap box`), squash-merge when green, `just latest` in the primary checkout. Delete the `panel-spike` worktree and `spike/panel-layout` branch (this session's own).
