# Contributing

## Setup

```bash
git clone https://github.com/stitts-dev/voxren-pi-public.git voxren-pi
cd voxren-pi && npm run setup
coach
```

Needs Node 22.19.0+ and [Bun](https://bun.sh) for the tests. `npm run setup` installs Pi 0.87.1 if it is missing and puts `coach` on your PATH. npm is the one supported install path; Bun only runs the tests, so there is no `bun.lock` — never run `bun install` here, always `npm ci`/`npm install`.

A second worktree of this repo shares its coach home (`.env`, the key store, sessions) with every other checkout, but has no `node_modules` of its own. Run `npm run setup:worktree` in it once: `npm ci` from the tracked `package-lock.json`, no pi-install or `npm link` (already done for the primary checkout).

## Checks

```bash
npm run typecheck
```

```bash
bun test
```

Run both before opening a pull request. CI runs them on Ubuntu and Windows. Tests sit next to the module they test (`src/lcu.test.ts` tests `src/lcu.ts`) and assert the output of public functions; a test never greps a source file. On Windows the macOS key-store suites skip, and the DPAPI backend is checked by hand with `/riot-key` inside the coach.

Tests do not verify a card or a command. After changing one, run the coach and read the result: [docs/agent-terminal.md](docs/agent-terminal.md) lists the ladder from `bun test` to print mode to a live terminal.

## Data

`data/championRoles.json` (per-champion lane play rates, read by `primaryLane`/`laneRate` in `src/lcu.ts`) goes stale as patches ship new champions or shift roles. Refresh it by hand:

```bash
bun run src/lab/refresh-champion-roles.ts
```

This pulls the current champion list from Data Dragon and per-lane play rates from OP.GG's public tier_list MCP, then rewrites the file with a bumped `meta.patch`/`meta.generated`. It prints any champion that fell back to its previous row (no OP.GG data this run) or was dropped (no OP.GG data and no previous row); mention those in the PR. Commit the regenerated file together with `bun test` passing (it asserts every current Data Dragon champion id has a row).

## Pull requests

- One concern per commit. Subject in the form `feat(coach): ...`, `fix(lcu): ...`, `test: ...`, `docs: ...`.
- Say what changed and how you verified it: which command you ran in the coach and what the terminal showed. A screenshot of the card or footer is welcome.
- Changes to `bin/` or the key store need a run on both macOS and Windows; say which one you could not run.
- Prompt changes go in `coach.yaml` with a before/after of a real answer.

## What is out of scope

- Automatic champ-select coaching beyond the two default-on calls: `/pick` on a settled hover or lock, `/draft` on a final draft (off with `VOXREN_COACH_AUTO_COMP=0` or the `auto` row in `/flow`). Everything else the coach reads from the client, it reads when you run a command.
- Champion-specific code paths. Behaviour must hold for every champion and lane.
- Anything that stores a key in the repo or in `.env`.

[AGENTS.md](AGENTS.md) holds the rules coding agents follow; they apply to people too.
