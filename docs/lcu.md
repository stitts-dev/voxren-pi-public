# League client link

*For a contributor or agent touching the League client link, and a curious user who wants to know exactly what is read.*

## What it is

The coach talks to the League client over its local LCU API, never a public Riot endpoint. `src/lcu.ts` discovers the running client, opens a TLS connection pinned to Riot's own root CA, and exposes a handful of narrow, typed reads.

**Lockfile.** The client writes a lockfile while it runs, five colon-separated fields: `process:pid:port:password:protocol`. The coach only uses the port and the password. Default paths:

| OS | Candidate paths |
| --- | --- |
| macOS | `/Applications/League of Legends.app/Contents/LoL/lockfile`, `/Applications/Riot Games/League of Legends.app/Contents/LoL/lockfile` |
| Windows | `C:\Riot Games\League of Legends\lockfile`, `D:\...`, `E:\...` |

No Linux path list exists, so `discoverLcu` finds nothing there. A missing, unreadable, or malformed lockfile (not exactly 5 fields, or a non-numeric port) is read as "client not running", never an error.

**TLS.** Every request goes through one `https.Agent` pinned to `data/riotgames.pem`, Riot's LCU root CA. `rejectUnauthorized` is never set to `false`.

**Host guard.** `isAllowedLcuHost` accepts exactly `127.0.0.1`, not `localhost` and not `::1`. `LcuClient.get` checks this before every request and throws instead of calling the transport. Standard endpoints use the lockfile's port; the in-game feed always uses the fixed port `2999`, never the lockfile port.

**Timeouts.** Each request gets 1500 ms (a wall-clock timer, since Bun only emits `close`, not `error`, for a request destroyed mid-handshake). A command-time composition read races that against its own 1500 ms budget, so a client that accepts the connection but never answers yields nothing instead of stalling the command. The Data Dragon loads (champion names, item prices) run beside the client read with half that budget of their own: a slow download leaves ids as `Champion <id>` or drops the gold clause, and never turns a draft the client answered into "No League client draft or game detected." The load keeps going and is cached for the next call. The footer poll runs every 5000 ms.

## When reads happen

Five slash commands trigger an LCU read, and only when they run: `/comp`, `/draft`, `/pick`, `/matchup`, and `/build`. The read happens once, before the command's prompt is built, whatever the arguments; an explicit enemy in `/matchup` or `/build` means the read's `enemyLaner` goes unused, not that the read is skipped.

The footer poller is the other reader. It starts in `session_start` (only when the session has a UI) and stops in `session_shutdown`. On each tick it reads the cheap gameflow phase first, then only the richer endpoint(s) that phase calls for. It polls every 5 s, and every 2 s while a champ select is open. It never invokes a tool and only updates an in-memory snapshot the footer renders on its own timer, with one exception below (two automatic calls, on by default).

## Auto /comp

By default the coach sends four calls without being asked. Turn them off with `VOXREN_COACH_AUTO_COMP=0` (or `false`, `off`) or the `auto` row on `/draft` in `/flow`. Each runs the handler a typed command runs and is logged as `pick:auto` or `draft:auto` in the exchange log.

- **Pick call (`/pick`).** The snapshot carries `selfPick` (the player's own champion, locked or hovered) and, once it is due, `pickKey`. A lock sets the key at once. A hover sets it only when the same champion was there on the previous poll too (about 2 s), so a flick across champions sets none. The key is the champion alone, so locking the champion already advised on as a hover is the same key and sends nothing, and a switch to a new champion is a new key. The footer poller derives the key from two consecutive snapshots (`settlePick` in `src/lcu.ts`).
- **Team call (`/draft`).** The snapshot carries `lockedDraft` (the player's pick and the enemy's locked ids) once the player and four enemies have locked; hovers and teammates' locks never count. A new `lockedDraft` sends the call: at the fourth enemy lock, the fifth, and again if a swap changes it. Four locks are enough to read the lanes and leave the last pick's time for the answer.

- **Game calls.** The first live read past 0:00 (within 120 s) sends `/comp` with an opener question; the footer leaving a game for the lobby sends `/review 1`. Each once a game, only while idle, logged as `comp:auto` and `review:auto`; switched by the `auto` rows on `/comp` and `/review`.

The two champ-select calls share one budget: a set of keys already run and a cap of 5 automatic turns per champ select. When a new team key and a new pick key are both due, the team call runs and the pick key is marked as seen. A coach mid-turn is skipped and retried on the next poll and when its turn settles, reading the latest state, so only the pick held then is sent. The budget restarts when the client goes back to the lobby or into the game, not on a failed read. Off by default: each call is one model turn.

One more path exists outside the footer and the five commands: `voxren_player_audit` calls `readSignedInRiotId` (just `current-summoner`) to find which account is the player's own when `riot_id` is omitted. It never touches champ select or the live-game feed.

## Endpoints

| Method + path | Fields consumed | Used by |
| --- | --- | --- |
| `GET /lol-gameflow/v1/gameflow-phase` | the phase string itself | Gates every footer tick and the `/comp`, `/draft`, `/pick`, `/matchup`, and `/build` reads |
| `GET /lol-summoner/v1/current-summoner` | `gameName`, `tagLine`, `summonerLevel` | Header player name, footer rows, `voxren_player_audit`'s own-account lookup |
| `GET /lol-ranked/v1/current-ranked-stats` | `queueMap.RANKED_SOLO_5x5.{tier,division,leaguePoints,wins,losses}` | Footer lobby row |
| `GET /lol-champ-select/v1/session` | `myTeam[]`, `theirTeam[]`, `actions[][]` (ban rounds), `localPlayerCellId`, `timer` | `/comp`, `/draft`, `/pick`, enemy fill for `/matchup`/`/build`, footer champ-select row |
| `GET /lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=9` | `games.games[].queueId`, `participants[0].stats.win` | Footer lobby recent-form strip (last 5 ranked solo results) |
| `GET /liveclientdata/allgamedata` (fixed port `2999`) | `allPlayers[]` (game name and tag, level, score, respawn timer, items, keystone, summoner spells), `gameData.{gameTime,mapTerrain}`, `activePlayer.{riotIdGameName,riotIdTagLine,riotId,summonerName,currentGold,championStats,fullRunes,abilities}`, `events.Events[]` (dragon, baron, herald, turret, inhibitor, champion kills) | `/comp`, `/draft`, `/pick`, `/matchup`, `/build`, footer in-game row |

## Commands

`/comp [question]` sends the current champ-select or live-game state as a composition block, with the model's question appended. With no client draft or game open, it shows "No League client draft or game detected." instead of running a turn.

A plain question typed while a game is running needs no command: it is sent with the same live-game block above it (clock, gold, health, the rune page taken, objectives, both rosters), so the coach answers from the game instead of asking for it. The transcript shows the line as typed. Outside a game, and in champ select, a plain question reads nothing.

The lane-opponent line ends with the gold lead: `Your lane opponent: Darius; you are +1 level, +32 cs, -117 gold on them (item gold 3333 vs 3450).` It counts item cost only: each held item (trinket excluded) at its built `gold.total` from Data Dragon's `item.json` for the latest patch (`loadItemPrices`), consumed items (`consumed: true`) at 0, so a Refillable or Corrupting Potion keeps its price, and an item times its count only when Data Dragon says it stacks (`stacks` above 1), since a permanent potion's count is charges, so components already merged into a finished item count at the finished price and unspent gold is not included. The enemy's unspent gold is not in the feed, so the lead is approximate. When Data Dragon cannot be reached, or either laner holds an item it has no price for, the clause is left out and the line reads `... +32 cs on them.` The line is written only when the player's position is one of the five lanes and exactly one enemy has it: in ARAM, or any queue where the feed reports `NONE` or nothing for every position, there is no lane opponent. A level the feed left out for either laner drops the level and cs lead. The `Your deaths` line is left out when the player, a killer, or an assister of the last death has a game name two players in the game share, since the event feed names players without their tag; it names only players among the assisters. An event later than the game clock is given its time with no `ago`. The player's own row, the one marked `(you)` that decides which team is `yours`, is the row with the active player's game name and tag; the name alone decides only when the active player or the row carries no tag. The tag is compared at the read and kept nowhere.

`/draft` reads the same draft for the last seconds of champ select: four short rows (lane, kill, threat, fights), then runes and build, from one OP.GG matchup read, checked by the grounding frame, in about 17 s where `/comp` takes 20 to 35.

`/pick` reads the same draft for the player's own champion, hovered or locked, and answers with a short pick call in labelled rows. Matchup: against the `Your lane opponent:` line, or, until all five enemies are locked and that line exists, against the enemy paired with the player's position on the `Lanes:` line, said to be probable; with neither, what to watch for from the picks that could still land in the lane. Setup: only the one or two rune, shard, or summoner changes this whole draft calls for against the OP.GG matchup page (enemy damage mix, hard CC and engage, the laner's threat, what the ally comp needs), each as "page choice to your choice, because named threat"; with no change the row is left out, never a "keep the page" row. Dodge: a third row with its reason, only when the draft is bad enough to consider dodging. Like `/draft` it runs at tier `quick` from one `voxren_meta_research` read, a `matchup` query when a laner is known or probable, otherwise `champion_overview` for the player's position, checked by the grounding frame. With no client draft or game it shows the same "No League client draft or game detected." notice as `/comp`; with the player's own slot neither hovered nor locked it shows "Hover or lock a champion first: /pick needs your own pick." and sends no turn. Nothing runs it automatically: the player types it. The composition marks the player's own champion `(you, hovering)` when there is a pick intent but no lock, and `(you)` once it is locked, so no command reads a hover as a final pick (this text is also what `/comp` and `/draft` send).

A bare `/matchup <enemy>` or `/build [enemy]` (no argument, or no `vs` split for matchup) fills the enemy from `composition.enemyLaner` when a client read has one; an explicit enemy or opponent name always wins over the client.

Ranked champ select never shows enemy roles, so the composition guesses them: `inferPositions` gives each locked enemy pick one lane, choosing the assignment with the highest summed play rate in `data/championRoles.json` (Poppy goes top when Nautilus takes support). The enemy line says the roles are guessed, a pick left in a lane it plays under 20% of the time is marked `?` (an off-role pick), and a `Lanes:` line pairs each of the player's teammates with the enemy guessed into the same lane. An enemy who has a role but no pick yet is left out of that line (it never reads "vs undefined"), so `/pick` falls back to what could still land in the lane.

`enemyLaner` comes from `deriveEnemyLaner`: first, the enemy pick whose `assignedPosition` matches the player's own. If the session carries no enemy role assignment, the coach guesses only once every one of the five enemy picks is locked (`championId > 0` on all five) and the pick `inferPositions` puts in the player's lane plays it at least 20% of the time; that guess is marked `(guessed by lane rate)` in the text. Any other case (an open enemy slot, a hover, or every candidate under the floor) yields no enemy laner and the command falls back to asking for a name.

`/matchup` and `/build` also read `composition.selfLane`: the local player's own `assignedPosition` in champ select, mapped to the coaching word ("mid", not "middle"). It beats `VOXREN_COACH_LANE` and the champion's usual lane for that one command's `{{lane}}`; a live game (no `assignedPosition` on that read) carries no `selfLane`.

## Record and replay

Two launch variables swap the client for a file, so a draft or a game can be replayed through the real commands (the draft lab does this; see `src/lab/draft-lab.ts`):

- `VOXREN_LCU_RECORD=<file>` reads the real client and appends to `<file>` every champ-select session that changed and a Live Client Data frame at most every 30 s, as `{ts, path, body}` lines. The footer's 5 s poll feeds it, so a whole draft is recorded pick by pick just by leaving the coach open.
- `VOXREN_LCU_REPLAY=<file>` plays such a file as a fake client: one frame every `VOXREN_LCU_REPLAY_STEP_MS` (default 3 s), then it holds the last. A draft fills in pick by pick in the footer and auto `/draft` fires on it exactly as in a real champ select. `<file>#index` holds one frame instead (a negative index counts from the end). A file of bare `allgamedata` lines, like the desktop app's `live-client-raw.ndjson`, replays too. `just lab` writes a playable file per draft to `<out>/timelines/`.

## Footer

The footer shows the existing cost/context row, plus one more row while the client is open. Exact strings from `lcuFooterLine`, 80 vs. 120 columns (120 spells out the same facts, never adds a new one):

| Phase | 80 columns | 120 columns |
| --- | --- | --- |
| Client closed | (no second row) | (no second row) |
| Lobby | `Name#NA1 · GOLD II 47LP · 132W-118L` | `Name#NA1 · Gold II · 47 LP · 132W-118L this season` |
| Champ select | `champ select · 0:24 left · you TOP · picks 4/10` | `champ select · 0:24 left in current phase · you TOP · picks 4/10 · bans 3/6` |
| In game | `in game 14:32 · Aatrox TOP 4/1/6` | `in game 14:32 · Aatrox TOP 4/1/6 · cs 122 · lvl 11` |

Recent-form letters (`W`/`L`, newest first) prefix the lobby row when match history was readable. The bans count only appears at 120 columns, and only once the session has ban slots. It counts finished slots, so a player who skipped or timed out of a ban still completes it (`bans 10/10`): the count says whether the ban phase is over, not how many champions were banned. The named `Bans` list leaves skipped slots out. The in-game row is withheld entirely if the active player is not yet found in the roster.

The header's player name follows the same open-client-first rule: the signed-in account name (from the footer's last snapshot) when the client is open, else the configured `VOXREN_COACH_ACCOUNTS`, else "player not set".

## Security

The lockfile password is read only inside `httpsTransport` (called from `LcuClient.get`), to build the request's Basic auth header. Every exported read function (`readSummoner`, `readRankedSolo`, `readChampSelect`, `readLiveGame`, …) returns a hand-typed shape built field by field from the response, never the raw body, so the password can never leak into a formatted composition, a tool result, or the transcript. No tool lets the model choose an LCU endpoint or target; only command handlers, the footer poller, and `voxren_player_audit`'s own-account lookup (`readSignedInRiotId`) call into `src/lcu.ts`. Every request is a `GET`.

`src/lcu.test.ts` asserts this directly. Host guard: `"accepts 127.0.0.1 at any port, including the fixed live-client port 2999"`, `"rejects localhost, ::1, and any other host"`, `"LcuClient.get throws for a disallowed host without ever calling the transport"`. Redaction: `"no read function's output ever contains the lockfile password"`, which plants the password in every wire fixture and checks every read's output, including the formatted composition text.

## Failure behavior

Client closed (no lockfile): every read returns `undefined` immediately, no request is made. Lockfile present but unreadable or malformed: same silent `undefined`, never a thrown error. An unreachable or torn-down session mid-poll (champ select ends between the phase read and the session read): the richer read returns `undefined` and the footer falls back to the closed bucket. A changed or partial JSON shape: every read function type-checks each field it uses and treats a missing or wrong-typed field as absent, so a shape change degrades to "nothing to show" rather than a crash.
