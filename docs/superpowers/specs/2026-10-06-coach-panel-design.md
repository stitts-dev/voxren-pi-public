# Coach panel: the answer as boxed sections

A finished coach answer is hard to read mid-game. The calls are plain prose under a label, the build strip is a separate block after them, and the tool cards and route row take as many rows as the advice does. The goal is an answer the player reads in one or two seconds on a second monitor: the call for this moment first, champions and items as pictures, overrides marked, colour that means something.

The layout was chosen over several rounds of mockups (artifact "Coach Panel Layout", variation P5, round 4) and a spike (`src/lab/panel-spike.ts` on `spike/panel-layout`) proved WezTerm draws it: boxes with a coloured rail, two boxes side by side, two-row portraits and icons inside the boxes, key caps, underlined names.

## What the player sees

```
[Fizz] vs [Kassadin]  middle · Emerald+                                         30:20
┏━ NOW · 30:20 ─────────────────────────────╮  ┏━ LANING ──────────────────────────╮
┃ FIGHTS  ⚔  [Sona][Cait]  Enter and burst  │  ┃ LANE  [Kass] Q shield up ▸ hold   │
┃                          Caitlyn before…  │  ┃       abilities; dodge Q with E…  │
┃                          when Sona ult…   │  ┃ KILL  Q missed and low ▸ all-in…  │
┃ THREAT  ⚠  [Viego]      Save E to dodge…  │  ┗────────────────────────────────────╯
┗───────────────────────────────────────────╯
┏━ BUILD ───────────────────────────────────╮  ┏━ SWAP ↻ ──────────────────────────╮
┃ runes  [runes] · [shards ↻] · [spells]    │  ┃ shard  [Health Scaling] → [Health]│
┃ items  [owned…] ▸ [next]                  │  ┃ Viego and Sona bring engage…      │
┗───────────────────────────────────────────╯  ┗────────────────────────────────────╯
```

- **Boxes.** Each section is a box: a heavy rail in the section colour down the left, the title set in the top edge, a faint outline. At 130 columns or more the boxes sit two to a row (calls | the other phase's calls, then build | swap); narrower, they stack in that order.
- **Sections and colours.** NOW (cyan) holds the calls for this phase of the game. The other phase's calls sit in a quiet box (slate). BUILD is gold, SWAP amber. Labels take a colour by kind: Fights violet, Threat orange, Kill green, Lane slate, everything else cyan.
- **Phase.** No live game, or a game clock under 14:00: NOW holds the answer row, Lane, Kill, Gank, Side, Matchup, Threat, and the quiet box is titled LATER and holds Fights, Macro, Win, Edge, Now, Next. From 14:00: NOW holds the answer row, Fights, Threat, Macro, Now, Next, Win, Edge, and the quiet box is LANING with Lane, Kill, Gank, Side. A label in neither list goes in NOW. A box with no rows is not drawn.
- **A call row.** The label in the label column; a glyph for the kind (⚔ fights, ⚠ threat, nothing else); the portraits of the champions the row names, two rows tall; then the action in bold white. The cue (the text before the row's first ": ", as today) goes on the line under it in dim text, after "when". A row with no cue is all action.
- **Key information in text.** A standalone Q, W, E, or R is a cyan key cap. A champion name is bold white and underlined. The bold action word the prompt already asks for keeps its bold.
- **Header.** The player's champion and the lane opponent as portraits, the role and the rank filter, the game clock on the right in a live game.
- **Build.** The runes page as today's strip (one row of groups at two-row height), the swapped-in piece followed by an amber ↻. In a live game the items row marks owned items and puts a gold ▸ before the next item to buy; owned items draw grey when the rasterizer is loaded and plain with a dim ✓ after them when it is not.
- **Swap.** Every `Swap:` build line and every `/pick` `Setup:` swap is a row in the SWAP box: the old piece's icon, an amber →, the new piece's icon, and the reason under it in amber. Names Data Dragon does not know stay as words.
- **Status line.** Under the boxes one dim line: the route (command, tier, model, thinking), the meta source, and the check verdict ("✓ /draft · gpt-6-luna low · 3.2s · ✓ 4/4 grounded"). The tool cards and route row above the answer are unchanged in this work; folding them is a separate change (out of scope below).
- **No side scrolling.** Every row is cut or wrapped to the pane width: text wraps inside its box, icon rows pack whole groups and wrap between them (`packPieces`), and nothing is wider than the pane.

Where pictures do not draw (Windows Terminal, the desktop app's pane, tui-test), nothing changes: the answer stays today's labelled rows and the build lines stay text. The boxes need pictures only for the icons, but changing the text-only path is out of scope.

## How it is built

### One panel entry in place of the build strip

Today the answer rows are Pi's assistant Markdown, rewritten by `answerMarkdown` (`src/ui.ts`), and the build strip is a session entry appended at `agent_end` (`showBuildStrip`, `BUILD_ENTRY_TYPE`, `src/index.ts`). Boxes side by side need the calls and the build drawn by one component, so the strip entry becomes a panel entry:

- `showBuildStrip` becomes `showPanel`. It appends `PANEL_ENTRY_TYPE` with `{ source, ownPicks, answer, champions, live }` when the answer has call rows or build lines and pictures draw. `answer` is the finished answer text; `champions` the champion names found in it; `live` the clock and owned items when a game is running (below). An entry written by an older build (`BUILD_ENTRY_TYPE`) keeps drawing with `createBuildStrip`, so a resumed session still renders.
- `createPanel(theme, data)` in a new `src/panel.ts` draws the header, boxes, and status line at the width it is given. `src/ui.ts` keeps the pieces it shares (`chip`, `packPieces`, `barLines`, theme roles); they are exported, not copied.
- While the answer streams, `answerMarkdown` draws today's rows. The Markdown transformer gets no message id, so `src/index.ts` keeps the set of answer texts that have a panel: `showPanel` adds the answer it drew, and session start adds the `answer` of every panel entry on the resumed branch. An answer in that set is drawn without the rows the panel draws (call rows and build lines), keeping any prose, so nothing shows twice; any other answer, an older session's included, draws as today. `showPanel` appends its entry even when an icon or live read fails (names stand in for icons), so a turn never loses its rows.

### Champion portraits

`IconKind` gains `"champion"`; `iconLine(name, ["champion"], rows)` draws a cached portrait the way it draws a rune. Champion names are found in the answer text against Data Dragon's champion list (`loadKnownNames` already loads it), so no game state is needed to know who a row is about. `showPanel` prefetches the portraits it found (`prefetchChampionIcons`) before it appends the entry, the way it prefetches item and rune icons today.

### Live state

The full live feed (`LiveGameState`, `src/lcu.ts`) has the clock and every player's items. When the turn ran in a live game, `showPanel` reads it once at `agent_end` and stores `{ gameTimeSec, ownedItems }`. This is a read for a turn the player started (AGENTS.md rule 3). A failed read logs and draws the panel without the live parts.

The phase split reads `gameTimeSec` from that record; the 14:00 cutoff is one named constant in `src/panel.ts`.

Owned items draw grey through the existing rasterizer (`svgToPng`, a desaturating filter, cached per icon). Without the rasterizer they draw as they are with a dim ✓, and `raiseNotice` is not raised: the plain icon is an expected fallback, not a broken capability.

### Prompt adjustments (`coach.yaml`)

The renderer reads what the rows already carry; three wording changes make it reliable:

1. `<output>`, the short-rows rule: a call row is "the cue the player sees, a colon, then the action", and names the champion the call is about. The existing good examples already have this form.
2. `/draft` rows (Lane, Kill, Threat, Fights): "the cue first when there is one" becomes "the cue, a colon, then the action", with one example.
3. `/pick` Setup: unchanged in form; the renderer parses "<page choice> to <your choice>, because ..." beside the build `Swap:` form.

4. `prompts.liveQuestion` (the in-game question frame: Answer, Lane, Macro, Threat, Fights): the same row-form sentence.

The unified command router (`feat/unified-router`) also edits `coach.yaml` (a new `jev.command` block and `prompts.routedQuestion`) and goes first, as agreed between the two sessions; this work rebases on it and edits only the lines above, none of which the router touches.

## Errors and fallbacks

- An icon that is not cached draws as its name (today's chip fallback); a portrait that is not cached is left out of its row.
- A row whose text has no cue draws as action only.
- A live read that fails: no clock, no owned marks, phase taken as laning; logged (`panel-live-read-failed`, rules 9 and 10).
- A width under 40 columns: the panel draws stacked with labels cut to 5 cells; nothing is drawn wider than the width.

## Testing

- `src/panel.test.ts`: `createPanel` with fixed data at 150, 100, and 60 columns, asserting rows by their visible text (box titles, labels, the action and cue split, the phase split before and after 14:00, a box with no rows left out, side by side at 130 and stacked below, no row wider than the width). Pictures through `setCapabilities` like `src/ui.test.ts`'s build-strip tests.
- `src/ui.test.ts`: the answer's rows are left out once a panel entry exists, kept while streaming; today's strip tests stay for `createBuildStrip` (older entries).
- `src/e2e/coach.test.ts`: the `agent_end` entry is a panel entry with the answer, champions, and (with a stubbed live read) the clock and owned items.
- UI catalogue: `panel <sample>-icons` entries over `CATALOGUE_SAMPLES` in `src/lab/ui-fixtures.ts`, so `src/ui-catalog.test.ts` gates them at every width and theme.
- Story `icons` gate (`src/lab/icon-check.ts`): the expected set adds the portraits the answer names.
- Rung 5: `just wez record` of `/draft` in a live game and of `/pick` in champ select, frames read, at 150 and 80 columns.

## Out of scope

- Folding the route row and tool cards into the status line (Pi draws them as their own transcript items; a separate change).
- The text-only path where pictures do not draw.
- Cue words as new model output (variation P4).
- Kitty and xterm.js tall icons (`iconRows` is two rows in WezTerm only, as today).
