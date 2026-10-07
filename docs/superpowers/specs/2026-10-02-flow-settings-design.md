# Per-command settings in the /flow tree

Stacked on the `/flow` spike (`claude/serene-ritchie-8sbi5v`). The player changes a command's settings from the tree itself, saved to `profile.json`.

## Contract

`profile.json` gains an optional `commands` map:

```json
{ "commands": { "review": { "args": "15" }, "otp": { "args": "Faker#KR1" }, "draft": { "auto": true } } }
```

- `args`: a saved default argument, only on `/review`, `/patch`, `/otp`, `/comp`. `/matchup` and `/build` are left out: bare, they read the live enemy laner, and a fixed default would override it. `/draft` and `/pick` take no argument.
- `auto`: only on `/draft` (AGENTS.md rule 3).
- `sanitizeProfile` drops unknown commands, unknown keys, and an `args` value the command's own parser refuses (`/review 40`), so a hand-edited file can never feed a bad default.
- Precedence: a typed argument, then the saved default, then today's fallback (the client, the main champion). The transcript line shows the argument that ran (`/review 15`).
- Auto `/draft` is on when the row is on or `VOXREN_COACH_AUTO_COMP=1`. The env var forces it on; the row then reads `on · VOXREN_COACH_AUTO_COMP` and does not toggle. The trigger checks the setting live, and a toggle runs the check at once, so a draft that already locked runs with no new poll. Trigger, cap (three per champ select), and idle rule are unchanged.
- Each change re-reads `profile.json` and writes it back with the new `commands`, so a `/config` edit is never lost. `/config` already loads fresh on open and spreads the profile, so it carries `commands` through.

## Tree

- The command's description sits on its own line under the title, so it is never cut. Below the tree, a `Settings` group: `auto   on` on `/draft`; `args   15 · what a bare /review sends` on the four commands above. The focused value reads `‹ 15 ›`.
- Lens (unchanged): ← → move, Home/End, Esc/Enter close, a typed character closes and lands in the editor. ↓ steps into the setting rows when the command has one.
- On a row: ↑ ↓ move (↑ from the first returns to the lens); ← → change the value and save it at once; Backspace or Delete clears an `args` row; Esc returns to the lens. No Enter, no menu: Enter and typed characters behave as in the lens (close, or close and land in the editor).
- An `args` row steps through a list, never free text, with `none` between the last value and the first:
  - `/review`, `/comp`: `choices` on the command in `coach.yaml` (game counts; standing questions). `validateCoachYaml` checks they are strings, and a test checks each passes the command's parser.
  - `/patch`: every Data Dragon champion (`loadChampionNames`), loaded on the first step, which lands once the list arrives; unreachable says so on the row.
  - `/otp`: the one-tricks `/otp` saved in the coach home (`savedOneTricks`), value `<player> <champion>`; none saved says how to save one, on the row.
- The hint row names the keys of the current focus.

## Verification

- Unit: `sanitizeProfile` keeps valid and drops invalid entries; a bare `/review` with a saved `15` sends 15 and a typed `5` wins; auto `/draft` fires from the profile setting with no env var and follows a toggle mid-session; `TreePanel` keys toggle, edit, refuse, clear, and return.
- Live (`just flow-stories`): S11 toggles auto on `/draft` and sees it still on after the coach restarts; S12 steps `/review` to 15 and sees it after a restart; S13 steps the live Data Dragon list on `/patch` and wraps through none, and sees `/otp` say none are saved. The stories run in a temporary coach home.

Out of scope: tier or thinking overrides, skipping a step, auto on other commands, a `/config` section for these.
