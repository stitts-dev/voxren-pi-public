# Jev: passage screen and grounding gate

*For a contributor tuning or evaluating the Jev layer, and a player deciding whether to set `TYPESAFE_API_KEY`.*

Jev (TypeSafe System One) answers closed questions about text: yes/no probabilities (`noul`), one option from a set (`choice`), or a place on an ordered rubric (`score`). It never writes text. Every question the coach asks lives under `jev:` in `coach.yaml`; code owns every threshold. One transport, `src/systemone.ts`, carries every request: bearer auth, byte caps both ways, and one failure taxonomy (`timeout`, `network`, `authentication`, `rate_limited`, `server`, `response`, `input`).

## What it is

With `TYPESAFE_API_KEY` set, every `web_search` result (the search answer plus each candidate passage) is sent to Jev, TypeSafe's `jev-latest` model, at `https://api.typesafe.ai/v1/systemone` (`src/passage-judge.ts`). Jev answers three yes/no probabilities per passage: `relevant`, `support`, `injection`. Code, not the model, turns those numbers into a route:

| Condition | Route |
| --- | --- |
| `injection >= 0.7` | `withheld` |
| `relevant < 0.45` | `off_topic` |
| `support >= 0.55` | `evidence` |
| otherwise | `weak` |

Injection is checked first, so a passage that is both relevant and manipulative is withheld, not kept as evidence (`src/passage-judge.ts`, `routeFor`). These are cookbook starting points that held on the first live lab run (2026-09-27, `jev-1.13.0`, 54 real passages plus 8 planted): 4 of 4 planted injections withheld at 0.93 to 0.98, no control or real passage withheld, the highest non-attack injection score 0.57. Relevance and support precision still await hand labels; see The labs below.

Without the key, `web_search` behaves exactly as it did before the screen existed: every candidate is kept, and no `judgment` field appears. The card says so (`not screened · no key`), so a search nothing screened never reads like one that passed. A keyed search with no answer and no hits has no passage to send, so it makes no request and carries no judgment either, and its card reads `not screened · nothing to screen`.

## What is sent

Three kinds of text reach Jev, all from `src/live-gateway.ts`: `web_search` passages (the search answer and each result snippet, `screenPassages`), each OP.GG summary from `voxren_meta_research` (`screenSummary`, same three questions; only `withheld` changes anything, because relevance is ill-posed for structured aggregate rows, so an off-topic route is recorded and never removes text), and, for the grounding gate below, the coach's own claims with the cited web and OP.GG passage text. Data Dragon facts text and the audit passage (the player's averages and one line of counts per game, with no Riot ID, match id, or date) are sent only inside a grounding request, as a cited passage. `voxren_otp_build` match data is never judged and never sent.

Before a query, title, or passage text leaves the process, `scrubIdentifiers` (`src/passage-judge.ts`) removes:

- text is first normalised with NFKC, so a fullwidth `＃` or letter is read as the plain character
- every configured account's full Riot ID (`Name#TAG`, case-insensitive) and, separately, its game-name part when that part is 3 or more characters, each as a whole phrase (spaces included, a name ending in a symbol such as `Faker!` too), replaced with `[riot-id]`
- any other `<name>#<tag>` Riot ID: a name of 1-16 characters, spaces allowed, starting at a word start and not ending in a space, then `#` and a 3-5 character alphanumeric tag, replaced whole with `[riot-id]`. A spaced name takes the words before the `#` that fit in 16 characters, so a word in front of one (`with Other#NA1`) can go with it; `ranked #1` and `rank #1234` survive
- match ids shaped like a platform prefix and a long number (for example `NA1_5312345678`), replaced with `[match-id]`

Each request carries the query, an optional public patch label, and one passage's title, domain, link (`url`, scrubbed, in full), date, and text, nothing else. The judge is sent the link and date because the model reads them beside the text: what reaches the model is what the judge saw, so an instruction in a URL path is scored like one in a snippet. A request over 64,000 bytes fails locally as an `input` error before any network call.

## What the model and the card see

A judged search comes back with `data.judgment`:

```
{ judge: "jev", status: "judged", model, latencyMs, inputTokens, answer: route, answerP, kept: number, removed: [{ domain, route }], note }
```

`judge` is the decision model's name (`jev` today; a second provider under #157 passes its own, `SystemOneClient`'s `name`) and `model` is the model the reply names (`jev-1.13.0`). Both ride on an unavailable judgment too, where `model` is the one asked. `answer` and `answerP` appear only when a search answer was sent and judged: a keyed search that returns no answer, and a video search, carry neither.

`removed` lists the domain and route of every passage dropped for being `withheld` or `off_topic`; kept passages carry their own `route` and `p` scores in the result row. The search answer takes the same route as a snippet: `withheld` or `off_topic` blanks the answer text, `weak` keeps it and adds `data.answerRoute: "weak"` (a usable answer adds nothing), and `judgment.answer` reports the route in every case. Every judged and unavailable state carries a `note` reminding the reader the screen is not a truth check.

When the screen fails for any reason, `data.judgment.status` is `"unavailable"` and every passage comes back as it would with the screen off (date-only snippet, no snippet text, no route or score), except that its `title` is the host and its `url` is the host alone (`https://host/`): nothing judged them, so no path, query, or title text reaches the model.

Every result a decision model reads gets one judgment row under its card, collapsed and expanded alike (`judgmentLine`, `src/ui.ts`), naming the model so the player knows whose yes/no the kept passages and verdicts rest on. The word is the reply's `model`, then the judgment's `judge`, then `Jev` when a fixture or an old session carries neither; a reply that names no model reaches the card as `unknown`, which is never printed as a name:

```
screened by jev-1.13.0 · removed 1 (example.net blocked) · answer usable · 240 ms
tip screened by jev-1.13.0 · usable · 90 ms
checked by jev-1.13.0 · 300 ms
jev-latest unavailable (timeout) · passages unscreened
jev-latest unavailable (timeout)
jev-latest unavailable (cited sources carry no text)
not screened · no key
not screened · nothing to screen
no key
```

On screen a passage verdict reads in plain words: `usable` (Jev's `evidence`), `weak`, `off topic`, and `blocked` (Jev's `withheld`). The data the model reads keeps Jev's own names.

The row carries only what the card's first row lacks. That row counts a search's results and a video list's videos, and the frame's claims and how many are grounded, so the judgment row carries no `kept N` and no claim count. Judged rows read `screened by` on a search, video, or meta card, `checked by` on the frame card, and `tip screened by` on a matchup card, where the judged item is the OP.GG tip and not the card: its verdict is the bare route word (`evidence`, `weak`, `withheld`), since `answer` is the word for a search answer. A zero `removed` and an answer that was not judged are left out. An unavailable row is in the error colour and gives the judge's reason; on a screen it also names what went unscreened (passages). The frame card's first row already reads `not checked`, so its unavailable row gives the reason alone. `input` is the judge's word for more than one cause (a request over 32,000 bytes, an HTTP 400 or 422, cited sources with no text), so the row says `cited sources carry no text` only when the frame has sources and every one is marked unread, and prints the judge's own reason in every other case. A web search, video, or meta result that carries no judgment gets the dim `not screened` row with its reason: `no key`, or `no tip text` for a matchup with an empty tip (never sent), or `nothing to screen` for a search or video list with no passage. A frame with no judgment keeps `not checked` on its first row and gets `no key` under it. The frame card's status cell is the success tick only when the frame was judged, and a warning mark when nothing was checked. `just card-demo --keyless` draws these rows, the unavailable one, and an expanded frame with an unread source.

Expanded (Pi's `ctrl+o`), a judged card lists each claim or passage once with what the judge found under it. A card has three levels of detail, and the launch sets which one `ctrl+o` opens (`VOXREN_COACH_CARD_DETAIL`, see [configuration.md](configuration.md); a session-wide display choice, so it is an environment variable and not a row in `/flow`, whose rows belong to one command, or `/config`, whose rows change on Enter):

| Level | What shows |
| --- | --- |
| `brief` | the collapsed card above. Set at launch, it keeps an expanded card as short as a collapsed one |
| `claims` | the default when expanded: each claim or passage once, below |
| `full` | the judge's own view, the questions and score bars, kept for debugging a verdict |

At `claims` a check card (`claimDetailRows` and `sourceRows` in `src/ui.ts`) lists each claim once: its verdict word in its colour, the claim, then one dim line of what the judge found: the best source and its score (`game-1 88%`) or `no source`, `stated` (the `supported` score), `opposed` (the `contradicted` score), and for a contradicted or disputed claim `by` the id that opposes it. A claim nothing judged has no such line. The sources follow, one per line, a cited id that had no stored text last and marked `(not read)`: the check never saw it, so a claim resting on it is unsupported for that reason. When an unsupported claim exists and a source was not read, one more dim line says an unsupported claim could not be checked against it, which is the player's cue to verify that claim by hand. The mark is for the card only, the model's text of the frame carries no `unread` key. The goal sentence, the judge's questions, and the contract line are `full` only:

```
CHECK    ✓ 0.7s  2 claims · 1 grounded · 1 unsupported
  checked by jev-1.13.0 · 480 ms

  grounded     Sample claim 1
               source game-1 88% · stated 91% · opposed 3%
  unsupported  Sample claim 2
               no source · stated 20% · opposed 4%
  cut-offs     contradicted from opposed 60% · grounded from stated 50%

  sources      game-1 Sample champion facts
               web-4 Sample result four (not read)
               an unsupported claim could not be checked against web-4
```

The `cut-offs` row states the two thresholds the verdicts rest on (`GROUNDING_THRESHOLDS` in `src/grounding-judge.ts`), once per card and only when a claim was judged: a claim is contradicted from `opposed 60%` when a source opposes it and no other source states it, else grounded from `stated 50%` when a source states it, else unsupported. Without it a grounded claim that reads `stated 63% · opposed 57%` cannot be interpreted.

Search, video, and meta cards list each judged passage the same way (`passageRows`): its verdict in plain words (`usable`, `weak`, `off topic`, `blocked`), its label, a removed one marked `(removed)` (an OP.GG tip the screen blanked, `(blanked)`), and under it one dim line with its three scores named in plain words, `on topic` (the relevance question), `support` (the support question; not `usable`, which is a verdict word), and `injection`. A kept result carries its link, and a video its date, whether its words are auto captions, and its quoted parts, each with the minute it starts at. A matchup's judged passage is its tip, labelled with the evidence id of its card, the id a check's claims cite it by: `usable       matchup-1 tip: Close in while her Q is down.`, or `blocked      matchup-1 tip (blanked)`; a card with no evidence entry has no id. These rows replace the evidence rows and the video list the `full` level keeps, so no passage shows twice:

```
SEARCH   ✓ 1.3s  "katarina vs ahri mid lane matchup" · live web (hosted search) · 3 results
  screened by jev-1.13.0 · removed 1 (example.net blocked) · answer usable · 410 ms

  usable       search answer
               on topic 92% · support 88% · injection 2%
  usable       web-1 Sample result one
               on topic 95% · support 90% · injection 2%
               https://example.invalid/web-1
  blocked      example.net Sample guide that tells the reader what to do (removed)
               on topic 90% · support 50% · injection 97%
```

A usable video quotes at most two parts, each at most 200 characters, a longer one cut at a word with `…` (`QUOTE_PARTS` and `QUOTE_PART_CHARS` in `src/ui.ts`). When parts were left out or cut, one dim line under them counts them, so the player knows the quotes are partial: `3 more quoted parts not shown`, `1 quoted part cut short`, or `2 more quoted parts not shown, 1 cut short`. A blank row follows a result that quoted, to set the next one apart. A video the screen called weak or off topic shows no quoted part and no such line; `full` shows every part whole.

A card nothing screened (no key, nothing to screen, the judge unavailable) lists its results the same way, so a keyed and a keyless session read alike: each result once in the same order of details (id and title, a video's date and caption note, the link, then its quoted parts under the limits above, a video nothing screened being taken as usable), in the same columns with the verdict column left blank and no scores line. The row that says why nothing was screened sits directly under the first row (after the `request` row, where a card has one), where the judgment row sits on a judged card. A matchup with no judgment keeps its `tip:` row, since the tip is not a listed result. `just card-demo --keyless --expanded` draws it:

```
VIDEOS   ✓ 2.1s  "katarina vs ahri matchup guide" · YouTube transcripts · 2 videos
  not screened · no key

               video-1 Sample video one
               2 months ago · auto captions
               https://example.invalid/video-1
                3:05 Hold E for charm, then step in once and leave before her return
                     damage lands. Hold E for charm, then step in once and leave before
                     her return damage lands. Hold E for charm, then step in once and…
               10:10 All in at six.
               2 more quoted parts not shown, 1 cut short
               video-2 Sample video two
               3 weeks ago
               https://example.invalid/video-2
                0:00 Charm when she lands.
```

A title or name a card prints (a result's title, an evidence row, a cited source) shows the box-drawing bars `│` and `┃` as `|`, so a channel name never reads as a second card bar.

At `claims` no row is cut with an ellipsis except a video's long quoted part above: long text wraps with a hanging indent and every wrapped line keeps the card's bar, at any pane width. A search's whole query shows on the expanded card, where the collapsed card keeps its first words, cut between words when a space falls in the second half of the 56 characters it allows (`SEARCH_QUERY_CHARS`), else where the limit falls. A card's first row, which wraps like any row, never opens a line with a bare `·`: the separator stays at the end of the line before it. The contract line (`contract research-contract-v1 · strategy_frame · voxren_strategy_frame`) shows at `full`, and at `claims` only on a card no decision model reads (facts, audit, one-trick, remember).

`full` is today's view of what Jev was asked and answered (`jevLines`): each question's text as written in `coach.yaml` (minus the untrusted preamble), then one row per passage or claim under it with a yes/no at the live threshold, a ten-cell bar, the percentage, and the item, sorted by probability; then the verdict rule and one verdict row per item. A frame card lists its sources first and answers the source question with the chosen id and its probability. Its rows are cut to the width, not wrapped:

```
sources  matchup-1 OP.GG matchup: Fizz vs Syndra mid · web-1 MatchupCoach Fizz vs Syndra
Q1  Does at least one passage state the same fact, number, build, timing, or recommendation as the claim?
    yes  █████████░ 92%   Runes: Electrocute, Sudden Impact, Grisly Mementos, Treasure Hunter…
    no   ███░░░░░░░ 31%   Level 3: take Q; punish Syndra E being spent with Q, auto, W…
Q2  Does at least one passage state the opposite of the claim, or a different number, order, or item…
    yes  █████████░ 88%   Level 3: take Q; punish Syndra E being spent with Q, auto, W…
Q3  Which passage id best supports the claim? Pick none when no passage states the claim's fact.
    matchup-1  88%   Runes: Electrocute, Sudden Impact, Grisly Mementos, Treasure Hunter…
    none       61%   Level 3: take Q; punish Syndra E being spent with Q, auto, W…
Q4  Which passage id contradicts the claim? Pick none when no passage disagrees with the claim's fact.
    none        Runes: Electrocute, Sudden Impact, Grisly Mementos, Treasure Hunter…
    web-1       Level 3: take Q; punish Syndra E being spent with Q, auto, W…
verdicts   yes to Q2 wins, then yes to Q1 with a source, else unsupported
    grounded · matchup-1   Runes: Electrocute, Sudden Impact, Grisly Mementos, Treasure Hunter…
    contradicted · web-1   Level 3: take Q; punish Syndra E being spent with Q, auto, W…
```

Collapsed cards show only the route rows and the judgment row. The question text is read from `coach.yaml` at render time, so a prompt edit changes the `full` card too. `just card-demo --expanded` draws every card at `claims`, and `--expanded --detail full` at `full`.

When the screen is on, the system prompt gets one extra paragraph, `prompts.passageJudge` in `coach.yaml`, telling the model what `judgment`, `route`, and `removed` mean and that a kept passage is still untrusted text.

## The grounding gate

`voxren_strategy_frame` takes the rows the coach is about to state as `claims` (1 to 8, required) and the evidence ids they rest on. For every cited id the gateway remembers passage text in a bounded store (`src/evidence-store.ts`, 64 entries, oldest evicted): a web snippet only after a judged screen, an OP.GG summary, the structured matchup rows rendered as one passage under `matchup-1`, the matchup note for that pair, when the coach has built one, under `guide-1` (rows distilled from matchup videos and written guides, each already checked against the text it came from; see `src/matchup-note-build.ts`), Data Dragon facts rendered as one passage under `game-1` (public static data: each ability's description with its cooldown, cost, and range, so a mechanic claim can be checked against it), and the audit rendered under `audit-1` (the averages and totals first, then one line per game, carrying every number the model reads, so a true claim is never unsupported for lack of text) with the one-trick reference under `audit-ref-N` (numbered per call, listed only when the result carries the reference). An OTP id stores no text. An id never returned this session is a validation error.

Stored notes and cards are checked on load against what the builders can write: a note's `authors` cannot exceed its distinct source authors, its links must be a source's url (or that url with `?t=`), card source ids are unique, and card lists hold at most three rows. A file that breaks a rule is skipped and logged as `load-failed`, never served. Stored files carry no content hash: a hand edit that keeps the structure valid is the owner's own text (cards are committed and reviewed in git; notes live in the owner's coach home). Rows are not re-grounded on load.

A matchup lookup's item, rune, summoner spell, and skill names are not passed through the Jev screen. Each must match a Data Dragon name (a skill is Q, W, E, or R), which is exact and costs no call; an unknown name is dropped and logged, so third-party text reaches the model only as a name Riot publishes. Only the tip is free text, and it is screened.

Per claim, one request (`src/grounding-judge.ts`) asks four questions over the cited passages: `supported` and `contradicted` (noul), `source` (a choice over the passage ids plus `none`, the passage that backs the claim), and `contradictedBy` (the same choice shape, the passage that disagrees with it). Code routes:

| Condition | Route |
| --- | --- |
| `contradicted >= 0.6` and `contradictedBy` names a cited passage, and `supported >= 0.5` with a different cited `source` | `disputed`, carrying both ids: one source states the claim and another opposes it, so neither outranks the other (#202: a source stating a claim at 88% lost to another opposing it at 69%) |
| `contradicted >= 0.6` and `contradictedBy` names a cited passage | `contradicted`, with that id. A score with no passage named is not a flag: on live turns it fired on true claims (a negation, a claim another passage merely did not cover), while all four planted contradictions in the lab name their passage |
| `supported >= 0.5` and the chosen `source` is a cited passage id | `grounded`, with that `source` id |
| otherwise | `unsupported` |

Those cuts come from `src/lab/grounding-lab.ts` on planted pairs (supported 0.83 to 0.97 on true pairs against 0.01 to 0.17 on false ones, one mixed pair at 0.59; contradicted 0.95 to 0.97 against 0.04 to 0.22; source choice 5 of 5). The gate flags and never removes: without a judge every claim is `not_judged` and no `judgment` field exists; a claim set whose cited ids carry no text is `not_judged` with reason `input`; a failed batch is `not_judged` with the failure reason (an unrecognized `source` or `contradictedBy` id counts as a response failure, same as any other malformed answer). The collapsed card is one row, `check    N claims · N grounded · N unsupported · N disputed · N contradicted` (zero counts left out), the judgment row, and one row per contradicted claim with the disagreeing passage id and one per disputed claim naming both (`[web-2 vs video-1]`): those are the verdicts the player must read. Unsupported claims follow, one `unsupported` row each with the claim cut to the width, three at most and then `+N more` (#219), so a glance shows which claim the check could not back. Grounded rows repeat the answer, so they stay a count. The expanded card lists every claim once with what the judge found, and the sources; the questions are the `full` level. The prompt addendum tells the model to keep grounded rows, drop or flag unsupported ones in five words or fewer, name the source that disagrees with a contradicted one, keep a disputed one with "sources disagree", and state `not_judged` rows as unverified.

### No pushback after the turn

The frame runs mid-turn and the model sees its verdict rows before it answers. A post-answer pushback (Jev asked whether the answer still stated a flagged claim, then the coach sent itself a rewrite request) ran from 2026-09-29 to 2026-09-30 and was cut. Over about 22 live turns on `gpt-6-sol` and `gpt-6-luna` it fired twice, both times on a claim that was true (once a stale flag that a later frame in the same turn had re-grounded, once a negation the frame itself misjudged), and each rewrite deleted correct rows, one of them the row correcting the player's own false premise. It never fired on a wrong claim: in 10 false-premise turns (5 "Fizz has 58% into Ahri right?", 5 "I never buy Dark Seal and die 8 times after 15, right?" after `/review 3`) the model corrected the premise 10 of 10 times on its own. A rewrite also costs a turn, which lands after the lock in champ select. The restated question and its lab (`restated-lab.ts`, 22 planted pairs, every cut from 0.3 to 0.8 clean) went with it; git has them at `1626d13`.

## Model routing

Before a typed prompt starts a turn, `routePrompt` (`src/model-router.ts`) asks `jev.route`, a
`choice` question — not a `score`, because the switch rule below needs a probability for the
winning option, not just its rank — to grade how much reasoning the player's message needs:

| Tier | Model | Thinking | Meant for |
| --- | --- | --- | --- |
| `quick` | `gpt-6-luna` | `low` | a single fact, number, or definition; a one-line answer |
| `standard` | `gpt-6-sol` | `medium` | normal coaching: a matchup, a build, a decision with reasons |
| `deep` | `gpt-6-sol` | `high` | multi-game review, comparing several options against the player's own data, a plan across a whole game |

`standard` is the fallback and the first-turn default. A slash command carries its own fixed
tier from `coach.yaml` (`review` and `otp` are `deep`; `matchup`, `build`, `patch`, and `comp`
are `standard`) and applies it, with no Jev call, only to the one turn whose prompt is exactly
that command's text — a typed prompt never inherits a pending command's tier, and a command's
own text is never sent to Jev. A command run while a turn is still going waits for that turn to
finish, then starts its own turn, so its tier applies.

With `VOXREN_COACH_THINKING` set at launch, the router still picks the model but never changes the
thinking level.

For a routed prompt, the message is scrubbed of Riot IDs and match ids with the same
`scrubIdentifiers` the passage screen uses, then cut to its first `ROUTE_PROMPT_CHARS` (4,000)
characters. A prompt that scrubs down to nothing — one that was only a Riot ID, say — never
reaches Jev at all: it keeps the current model at `standard`'s thinking (`medium`), source
`fallback`, failure `input`. Every call carries a `ROUTE_DEADLINE_MS` (1,500 ms) deadline; a
slower reply, or any other `JudgeFailure`, does the same with its failure reason attached — the
model does not flip on an intermittent timeout. Without `TYPESAFE_API_KEY`, `createRouteJudge`
hands back no judge and every prompt runs the full `standard` tier (`gpt-6-sol`), source
`fallback`, failure `off`.

The winning tier always sets the thinking level. The model changes only when that tier's
probability is at least `ROUTE_SWITCH_P` (0.7); below that the current model stays — thinking
still moves to the winning tier's — and the source is `held`, so a borderline grade cannot
thrash the model (and its prompt cache) every turn.

The footer's right side reads `<model> · thinking <level> · <word>`, the model always the one
that actually answered the turn, and the word naming who chose it:

| Source | Word |
| --- | --- |
| `jev`, `held` | the decision model as the route row names it (`jev-1.13.0`), `jev` when the route names none |
| `command` | `/<command name>` |
| `fallback` without a key | `jev off` |
| `fallback` after a failure | `<decision model> <reason>` (for example `jev-latest timeout`), `jev <reason>` when none is named |
| `pinned` (model and thinking both) | `pinned` |

With only one of the two pinned, the word gains ` · model pinned` or ` · thinking pinned` (for
example `jev · thinking pinned`). When the chosen model could not be applied (the model registry
does not know it, or the provider is not signed in), the current model stays: a Jev pick then
reads `jev`, as for `held`, while a command or fallback keeps its own word.

In the TUI each turn also gets one dim `route` row in the chat between the prompt and the answer
(for example `route    jev-1.13.0 quick 82% · gpt-6-luna · low · 280 ms`): which decision model
picked (the reply's model, `Route.by`; `Jev` when none is named), the winning
tier's probability and its call time when it was asked, `kept <model>` when the model did not
switch, and why a grade was `held`. It is a `voxren-route` custom message that a `context` handler
removes before every request, so the model never sees it; print mode shows no row.

**Pinning.** The extension's own routing calls and the player's own choices reach Pi through the
same `model_select` and `thinking_level_select` events with no field that tells them apart, so
the extension holds a `routing` flag around its own `pi.setModel`/`pi.setThinkingLevel` calls and
treats any change made outside it as the player's. A player model pick (ctrl+p) pins the model
and a thinking pick (shift+tab) pins thinking, each on its own: the router keeps choosing the
other. With both pinned, Jev is not called and nothing is applied (source `pinned`). A pick made
while Jev is still grading the turn's prompt wins too. Pi's `setModel` resets thinking to the new
model's default, so when the router switches the model under a thinking pin it puts the player's
level back inside the same `routing` window. A `model_select` whose `source` is `"restore"` —
replaying a saved session's model on `coach -c` or `coach -r` — is not a player choice and does
not pin. `VOXREN_COACH_MODEL` or `VOXREN_COACH_PROVIDER` set at launch starts with the model
pinned (and narrows Pi's `--models` to that one model); `VOXREN_COACH_THINKING` starts with
thinking pinned. A new session resets both pins to these launch values.

## Failure behavior

Any failure once the screen is on (a rejected key, a timeout, a network error, another non-2xx response, or a malformed reply) leaves every passage unscreened and sets `status: "unavailable"` with a `reason` (`timeout`, `network`, `authentication`, `rate_limited`, `server`, `response`, or `input`). The whole batch is all-or-nothing: one failed passage makes the entire batch unavailable rather than returning a mixed judged/unjudged set (`PassageJudge.judge` in `src/passage-judge.ts`). The request times out at 3000 ms (`PASSAGE_JUDGE_TIMEOUT_MS`); an aborted tool call cancels the screen the same way.

Every judge failure also writes a `judge-failed` line to the coach log (`coach.log.ndjson`, `just logs`) with the judge, the model asked, and the reason; a failed route grade writes `route-failed`. The matchup-note builder's lines (each dropped row with its reason, and `distilled N rows from M sources, Jev kept K`) go there as `build-line`, so a thin matchup can be told from a Jev outage.

## The labs

Two measurement scripts under `src/lab/`, none of them tests, each writing only into the `--out` directory.

```bash
bun run src/lab/passage-judge-lab.ts --out <private dir>
```

It fetches live search passages for six coach-shaped queries (Fizz build, matchup, patch questions) through a worker Pi's hosted web search (`pi` and `node` on `PATH`, coach signed in), unless `--replay` reruns against a previously written `corpus.json`, and appends a fixed set of planted passages (four prompt injections, two ordinary imperative-advice controls, two off-topic pages) to the first query. If `TYPESAFE_API_KEY` is set, every query's passages go through the real Jev call; without it, the summary says `TYPESAFE_API_KEY` is absent and the Rows table's Jev columns show `-`, but the corpus and baseline are still written.

It writes into `<dir>` only: `corpus.json` (the fetched passages), `results.json` (every row with its route and scores), `labels.template.json` (a relevance/support label to fill in by hand), and `summary.md` (precision/recall against any hand-filled `labels.json`, injection catch rate on the planted set, token cost, and latency). Nothing is written into the repository.

The summary states the thresholds it ran with; read `summary.md`'s injection and relevance/support lines against your own judgment of the `## Rows` table before trusting a threshold change.

```bash
bun run src/lab/grounding-lab.ts --out <private dir> [--corpus <passage lab dir>] [--dry-run]
```

With `--frozen <corpus.json> [--runs n]` it judges a labelled corpus (`data/lab/grounding/dispute-corpus.json`, labels and a reason per claim written before any score) n times and prints the previous routing against the current one per run. Judges ten planted claim/passage pairs with known labels (and, with `--corpus`, real passages paired with hand-written claims from `<out>/claims.json`), then sweeps thresholds from 0.4 to 0.8 and reports precision and recall for `supported` and `contradicted` plus source-choice accuracy. `GROUNDING_THRESHOLDS` in `src/grounding-judge.ts` are set from its summary; rerun it before moving them.

The answer rubric has no script of its own: the story runner (`just stories`) asks Jev to grade each answer on the coach's own rules (`jev.answerRubric` in `coach.yaml`): a five-level `score` (0 to 4) plus three nouls (intro or closing line, hedging, unsourced game number). With `--compare <old stats.json>` the report carries each turn's change against the baseline repeats' noise, so a `coach.yaml` edit gets a number before and after. The first baseline (2026-09-27, five fixed questions in print mode) scored a mean of 1.18 of 4, with `unsourced_number` above 0.85 on `/matchup` and `/patch`. That rubric's instructions asked for rows only and for a named source on every number, which the current answers (prose paragraphs with a bold action, BUILD strip lines, no source named) break by design, so it scored good answers 0 to 2.2. The 2026-10-04 rewrite describes the current format; on a frozen corpus of 22 real answers and 6 planted bad ones (two runs each) agreement with hand labels rose from Spearman 0.26 to 0.66, and the mean gap between good real answers and planted ones went from 0.3 (1.2 against 0.9) to 1.8 (2.1 against 0.3). No single quality mark keeps every good answer and fails every planted one (a good `/patch` answer scores 1.0 to 1.1, a planted intro-and-outro answer 1.1), so `RUBRIC_PASS_QUALITY` stays unset; `has_intro_or_closing` catches that planted answer (0.98) and is the candidate second gate.

### Doctrine questions

`jev.doctrine` in `coach.yaml` turns doctrine rules into closed checks on a finished answer: `generic_copout` (a yes means the rule was broken), `names_tradeoff`, `death_as_trade`, `resist_matches_threat`, `one_sentence_win_condition`, `leads_with_one_fix`, `contrast_reason`, and `tier_fit`, a choice of which band of tiers the advice is written for. With the four `answerRubric` questions that is the first set. Each names the doctrine ids it enforces (`enforces`: an id, or `group.*` for every id under it), and loading `coach.yaml` fails when an entry matches no rule, so a low score always points at rows that exist. `unsourced_number` does not count a coaching heuristic (break after two losses) as a game number.

`gradeDoctrine` (`src/lab/answer-rubric.ts`) asks them of one answer: a yes/no question's score is how sure Jev is the rule was followed, and under 0.5 counts as not followed. The story runner grades the answer of every rubric story and writes a per-answer table into `report.md` and `answers` into `stats.json`: the claim counts `voxren_strategy_frame` routed (grounded, unsupported, contradicted, disputed, read from the exchange log), the coach model's tokens and dollars, the Jev tokens, the doctrine score, and for each question under the mark the doctrine rows to edit. It is report-only: no hand labels measure Jev's agreement on these questions yet. A story's `applies` names the questions its answers are graded on (a name that is no `jev.doctrine` question fails the story's validation); a story with none is asked all of them, and a rule the answer had no occasion for then shows as not followed.

## The header badge

While the screen is on, the right end of the header title rule carries a Jev badge (`src/jev-badge.ts`, drawn by `titleRule` in `src/ui.ts`). It pulses (`◇ ◈ ◆`) while a `web_search`, `voxren_meta_research`, or `voxren_strategy_frame` call is in flight, so a slower search is visibly the screen at work, and it then carries the session tally folded from each result's `judgment` in code: passages screened and cut, claims checked and flagged. Zero counts are left out; a failed screen replaces the tally with `Jev unavailable (reason)` until the next judged result, so the player knows the passages behind that answer went unscreened. As the pane narrows the tally drops first, then the badge, then the rule. Without the key the header has no trace of it.

```
VOXREN COACH  Player01#NA1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━ ◆ Jev · 12 screened · 3 cut
```

## Turning it off

Unset `TYPESAFE_API_KEY`, or remove the stored key from `/config`'s Keys section if it was set
there instead. `web_search` and `voxren_meta_research` revert to keeping every passage with no judgment field and no prompt
addendum, and their cards carry a dim `not screened · no key` row; `voxren_strategy_frame` reports every claim `not_judged`, its card reads `not checked` with `no key` under it, and its status cell shows the warning mark.
