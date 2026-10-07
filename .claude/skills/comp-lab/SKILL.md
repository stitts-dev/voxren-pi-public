---
name: comp-lab
description: Use when running, continuing, or reporting on the /comp advice-quality research loop (issue #30) — a draft-lab.ts sweep, a coach.yaml prompt change for /comp, or any round of measuring /comp output quality across lanes.
---

# comp-lab

The runbook is `docs/comp-lab.md` — scenarios, sweep commands, scorer fields, `tui.ts`
verification, loop discipline. Read it first; this skill only adds what that doc can't say for
itself: what a round must produce, every time.

## What every round produces

A round is one change (or one measurement pass) plus these four things, in order. Skipping any of
them is an incomplete round, not a faster one.

1. **The sweep.** `bun run src/lab/draft-lab.ts ... --n 5 --parallel 5 --out /tmp/comp-lab-<round>`
   across all scenarios in `data/lab/drafts/`, both lanes in `coach.yaml`'s `agent.models`. S5 (or
   any live-client scenario) runs separately with `--minutes 0` — the default `--minutes` values
   all snap to one frame and collide.
2. **One metric widget.** Load `mcp__visualize__read_me` once per session before the first widget.
   Before/after a change: metric cards for both lanes + one bar chart for the metric that moved.
   Baseline-only round: metric cards alone. Never paste the raw markdown table into chat as a
   substitute — the table goes in `report.md`, the widget is what the human reads.
3. **One real terminal capture**, on the scenario the change affects most:
   `node src/lab/tui.ts --replay data/lab/drafts/<scenario> --step 200 --send "/comp@3" --for 75 --every 0`.
   Render it as a terminal-styled widget (dark panel, monospace, the actual captured text) —
   scorer numbers alone don't show what changed on screen. `tui.ts`'s text capture strips ANSI, so
   a claim about color or bold rendering is verified by reading the renderer's source
   (`node_modules/@earendil-works/pi-tui`), not by screenshotting the capture.
4. **A commit**, message carrying the actual numbers (before → after, n, which rounds), not just
   "improve /comp". Stage files explicitly.

Then stop and report. Wait for a decision before the next change — never chain edits.

## Common mistakes (from the first four rounds)

| Mistake | Fix |
|---|---|
| n=1 read as a finding | n>=5 per scenario per lane is the floor; n=1 is noise (issue #30) |
| Trusting `enemiesNamed` on S5 | At 0:23 fresh spawn, naming only the lane opponent is often correct coaching, not an omission — read the answer before flagging |
| A bulleted row counted as "not prose" | `coach.yaml`'s "one idea per row" is about sentence count, not the presence of a `-` marker |
| Flagging bold as a leak after the prompt starts asking for it | Update the scorer in the same commit as the prompt change, or every later round reports a fake regression |
| Skipping the widget or the terminal capture "to move faster" | That's the whole reason a human can tell what changed — do both every round |
