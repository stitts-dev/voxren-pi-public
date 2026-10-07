# Research tools

An HTTP service an agent calls for sources it can quote. Every answer comes back cut into passages: small parts of a transcript or a page, each with an id and a link, ranked against the caller's question. It runs no model and takes no prompt from a caller, so any agent, script, or backend can use it. The one prompt it sends anywhere is the fixed transcription request to Gemini, and only when a Gemini key is set (see Transcript sources).

The Voxren coach starts it as a local child process, on Windows too (there as `uv run pythonw -m uvicorn`, so it opens no console window). Nothing in it is League-specific.

## Run

```bash
cd services/research-tools
RESEARCH_TOOLS_TOKEN=dev uv run uvicorn app.main:app --host 127.0.0.1 --port 8787
```

`uv` installs Python and the dependencies on first run. The interactive API reference is at `http://127.0.0.1:8787/docs`; the same contract is in `openapi.json`, generated from the app: each route lists its error statuses with the `ErrorBody` shape, and the bearer scheme is declared so `/docs` has an Authorize button.

To host it, run the same command with `--host 0.0.0.0 --port $PORT`, set `RESEARCH_TOOLS_TOKEN` to a long random value, and point the health check at `/health`.

## Endpoints

Every route except `/health` and the pages that describe the API (`/docs`, `/redoc`, `/openapi.json`) needs `Authorization: Bearer <RESEARCH_TOOLS_TOKEN>`. The token is checked before the request body is read, so a wrong or missing token is a 401 even when the body is not valid JSON.

| Route | What it does |
| --- | --- |
| `GET /health` | `ready` or `degraded`, the version, which settings are missing, which search providers have a key, `invalid_config` (the names of settings that are set to a value the service cannot use, never the value), and `transcript_source`: `gemini` when a usable Gemini key is set, else `captions`. A missing search or Gemini key is not `degraded`. Never fails. |
| `POST /clients` | `{"pids": [...]}`: the windows using this service now, replacing the list. The service exits once none is alive (`RESEARCH_TOOLS_WATCH_PIDS`). |
| `POST /youtube/search` | Videos for a query: id, title, channel, length, age. Filters for age, length, and words the title must hold. |
| `POST /youtube/transcript` | One video's English transcript cut into parts with start times, and the `source` that made it: YouTube's captions or Gemini. With `query`, the best-matching parts; without, every part in order. |
| `POST /youtube/research` | Search, fetch transcripts, and rank in one call: up to `max_videos` videos, each with its best passages for `focus` and its `source`. Without a Gemini key transcripts are fetched one at a time. With one, as many hits as videos are still needed are fetched at once, and the answer keeps YouTube's order. At most 12 hits are looked at and `max_per_channel` per channel are kept either way. When the query finds no video that passes the filters and `title_terms` is set, it searches once more for the title terms alone. With `deadline_seconds` (default 70, below the coach's own 90 second wait) the answer comes within that many seconds with the videos done by then: one still being fetched is listed under `skipped` as `timeout` and keeps downloading into the cache, so a retry is served from it, no fetch starts after the deadline, and Gemini gives way to the captions 20 seconds before it. |
| `POST /web/search` | Web results for a query: title, address, snippet, date. Filters for domains and age. Needs a provider key. |
| `POST /web/read` | One page's text cut into parts. With `query`, the best-matching parts; without, the first parts in order. Says whether it read the site or the Internet Archive's copy, and how old that copy is. |
| `POST /web/research` | Search, read the top results (three at a time), and rank in one call: up to `max_results` pages, each with its best passages for `focus`. A page that could not be read or had no match is listed under `skipped` with the reason. |

## Passages

A page or transcript is cut into parts of about `part_chars` characters, at sentence ends. Text with no sentence ends (a list, a table, code) is cut at a space once a part would pass twice that length. With a query, parts are ranked by BM25 over whole words. Case, apostrophes (`Fizz's` is `fizz`; `Kai'Sa`, `Kai’Sa` and `Kaisa` are one word), and common English function words (`the`, `to`, `how`) are ignored, so a part that shares only those with the question is not a match. A page or video with no matching part is listed under `skipped` as `no_match`.

## Errors

A failure is JSON `{"detail": {"code": "...", "message": "..."}}` with a matching status. A request that breaks a field rule (a video id that is not 11 characters, a query under 3) is refused before any lookup with FastAPI's standard 422 body instead: `detail` is a list of field errors. Codes a caller should handle:

| Code | Status | Meaning |
| --- | --- | --- |
| `auth_invalid`, `auth_unconfigured` | 401, 503 | Wrong token, or the service has none set. |
| `no_captions`, `no_english`, `unplayable` | 404 | The video has no usable English captions, or cannot be played without signing in. With a Gemini key, `no_captions` also means Gemini heard fewer than 50 words in the whole video. |
| `po_token_required` | 502 | YouTube wants a proof-of-origin token for this video's captions, which the service cannot make. |
| `rate_limited` | 429 | YouTube is throttling caption downloads from this address. `Retry-After` says how long to wait. Do not retry sooner. |
| `upstream_error` | 502 | YouTube answered with something unexpected. |
| `search_unconfigured` | 503 | No search provider key is set. Set `BRAVE_API_KEY` or `PERPLEXITY_API_KEY`. |
| `search_unavailable` | 502 | Every configured provider failed. The message says how each one failed (a status, a timeout, no results). It never holds a key. |
| `url_blocked` | 422 | The page address is refused before any request: a scheme other than http or https, a user name or password in the address, a port other than 80 or 443, a host name that is not valid (an empty or over-long label), or a host name that points at a private, loopback, link-local, or otherwise non-public address. Applies to redirects too, and to a read with `archive` set to `only`: the address is not sent to the Internet Archive either. |
| `fetch_refused` | 502 | The site refused the request (HTTP 401, 403, 429, 451, or 503) or answered with a bot-check page or a page with no text. With `archive` set to `fallback` the service reads the archive's copy instead of returning this. |
| `fetch_failed` | 502 | The site answered with another error status, did not answer within 15 seconds, did not resolve, redirected more than 4 times, or sent a compressed body that is corrupt or cut short. |
| `unsupported_content` | 415 | The page is not HTML or plain text (a PDF, an image), or its compression is not one the service reads: more than one layer, or anything but gzip or deflate. |
| `not_archived` | 404 | The Internet Archive has no usable copy: it never saw the page, or its copies are refusals, bot-check pages, or pages with no text. |
| `archive_unavailable` | 502 | The Internet Archive did not answer, answered with something unexpected, or took longer than 30 seconds in all (every request to it and the waits between them). |

## Settings

Settings are read from the process environment and nowhere else. The service does not read a `.env` file, so a secret never has to be in the working tree.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RESEARCH_TOOLS_TOKEN` | none | Bearer token the tool routes require. Unset means they answer 503. |
| `RESEARCH_TOOLS_CACHE_DIR` | `~/.cache/research-tools` | Where transcripts, pages, and searches are kept. A transcript is fetched once. Must be writable: the service refuses to start otherwise. |
| `RESEARCH_TOOLS_CACHE_MAX_MB` | `512` | Most megabytes the cached pages and searches may hold together. Past it the oldest are deleted first. Transcripts are not counted. |
| `RESEARCH_TOOLS_CONTACT` | this repository's URL | Contact URL sent in the User-Agent. |
| `RESEARCH_TOOLS_YOUTUBE_CAPTION_GAP_SECONDS` | `2` | Minimum gap between two caption downloads. |
| `RESEARCH_TOOLS_EXIT_ON_STDIN_EOF` | `false` | Exit when stdin closes, so a child never outlives the parent that started it. |
| `RESEARCH_TOOLS_WATCH_PIDS` | none | Comma-separated pids of the windows the service serves. Set, the service exits once none is alive (`os.kill(pid, 0)` on POSIX, `OpenProcess` on Windows), so a shared service does not outlive a hard-killed starter. Windows that join later replace the list with `POST /clients` (`{"pids": [...]}`, token required). |
| `RESEARCH_TOOLS_WATCH_INTERVAL_SECONDS` | `5` | How often the service checks the watched pids. |
| `BRAVE_API_KEY` or `RESEARCH_TOOLS_BRAVE_API_KEY` | none | Brave Search API key. The first provider a web search tries. |
| `PERPLEXITY_API_KEY` or `RESEARCH_TOOLS_PERPLEXITY_API_KEY` | none | Perplexity Search API key. Tried when Brave has no key or fails. |
| `RESEARCH_TOOLS_ARCHIVE_GAP_SECONDS` | `1` | Minimum gap between two requests to the Internet Archive. |
| `GEMINI_API_KEY` or `RESEARCH_TOOLS_GEMINI_API_KEY` | none | Gemini API key. With one, a transcript is made by Gemini reading the public video, and YouTube's captions are the fallback. Spaces and line breaks around the key are dropped. A key with a character a header cannot hold (non-ASCII, or a control character) is not used, and `/health` lists `GEMINI_API_KEY` under `invalid_config`. |
| `RESEARCH_TOOLS_GEMINI_MODEL` | `gemini-3.8-flash` | The Gemini model that transcribes. |
| `RESEARCH_TOOLS_GEMINI_MAX_MINUTES` | `90` | Longest stretch of a video Gemini transcribes, from its start. A longer video gets clips for the first this many minutes only and the answer sets `cut_at_seconds`. A request never bills more than this many minutes divided by 5 clips. |
| `RESEARCH_TOOLS_GEMINI_CONCURRENCY` | `4` | Gemini calls in flight at once, across every request the process serves. |

## Cache upkeep

An entry past its age is deleted when it is read, at startup, and by a sweep every hour: site pages and searches after 24 hours (the sweep holds a page up to 7 days, since archive copies share the folder), archive copies and misses after 7 days, the caption throttle after an hour. Transcripts are kept for good. Pages and searches together are held under `RESEARCH_TOOLS_CACHE_MAX_MB`, oldest first, checked by the sweep and again once about a quarter of the cap has been written since the last check.

## Transcript sources

A transcript comes from one of two places.

- **captions**: YouTube's own caption endpoints. This is all there is without a Gemini key, and it works as described under YouTube limits.
- **gemini**: the Gemini API is asked to read the public YouTube video and write down what is spoken. It is used first when `GEMINI_API_KEY` is set. When Gemini is rate limited, cannot read the video, or fails, the service falls back to the captions and answers with their result or their error. A Gemini rate limit never counts against YouTube's throttle. A video Gemini finds under 50 words in is `no_captions`, remembered for a week like other misses, and the captions are not tried for it, since there is no speech to find. That miss is kept apart from the miss for a video with no usable captions: the captions' miss never stops Gemini from reading the video, and Gemini's miss is ignored when there is no key. A clip with times in it and no line the service can read is a Gemini failure, not silence, so the captions are tried and nothing is kept. A 400 or 401 from Google is an `upstream_error` whose message says the key or the model name was refused, and the fallback logs it. A clip that answers 500 near the end of the video is asked for once more before it is taken as past the end. Two requests for a video that is not stored yet share one transcription: the second waits and reads the result from the cache.

A response says which one made the transcript in `source`. A Gemini transcript has `generated: true` and `language: "en"`. A transcript is made once and kept for good, with its source; one stored before `source` existed reads as `captions`.

Google receives the public video URL, the start and end of the clip, and one fixed prompt that asks for a word-for-word English transcript with the start time on each line, plus the service's usual User-Agent. It receives nothing about the caller or the query. The key goes only in the `x-goog-api-key` header, never in a URL, a message, or a log line.

Measured on 2026-10-01 with `gemini-3.8-flash`:

- The video's length comes from `countTokens`, which is free and answers in about 0.3 seconds. Audio costs 32 tokens a second, so length is the audio tokens over 32.
- A video longer than `RESEARCH_TOOLS_GEMINI_MAX_MINUTES` (90 by default) is transcribed for that long from its start and no further, before any clip is sent past it. `/youtube/transcript` and `/youtube/research` then set `cut_at_seconds` to the cap, and the cut transcript is kept like any other. A transcript that was not cut has `cut_at_seconds: null`.
- The video is cut into clips of 300 seconds, each transcribed on its own and joined. One call for a whole video took 18 to 66 seconds and its timestamps drifted (the last was 14:09 on a 9:42 video, and 14 of 41 lines had the right time). Clips of 300 seconds returned every line at the right time. At most `RESEARCH_TOOLS_GEMINI_CONCURRENCY` calls run at once.
- A clip is read at 0.1 frames a second. That is about 32 input tokens per second of video instead of about 91, with the same words and correct times. Lower than 0.1 hurt the times.
- A time more than 5 seconds outside its clip is set to the clip's start, and times never go back, so a wrong time stays inside its own five minutes.
- `gemini-3.5-flash-lite` dropped words, so the default is `gemini-3.8-flash`.

Google documents a free tier of 8 hours of YouTube video a day. What a call costs beyond that is Google's to state: read their pricing page, not this file. The caption path is against YouTube's terms of service. The Gemini path is Google's documented API.

## YouTube limits

YouTube has no public API for another channel's captions. The service uses the endpoints YouTube's own apps use, which is against YouTube's terms of service and can stop working when YouTube changes them. YouTube throttles caption downloads per address: after roughly 15 downloads in ten minutes every further one is refused for a long while (over 40 minutes when measured on 2026-10-01; the service records an hour and answers `rate_limited` with the wait that is left). So the service downloads one transcript at a time with a gap, keeps each one for good, never retries in a loop, and reports `rate_limited` instead of hiding it. Search keeps working during a throttle. A video with no usable captions is remembered for a week, but an `unplayable` answer about this address or this hour (YouTube's "Sign in to confirm you're not a bot", a stream that has not started) is not: the next request asks again.

## Web limits

Search needs a provider key. Without one, `/web/search` and `/web/research` answer `search_unconfigured`; `/web/read` still works. Each search tries Brave, then Perplexity, and skips a provider that is down, out of quota, or returns nothing. A search is kept for 24 hours.

A page is read from the site first, with an honest User-Agent that names this service and a contact. Some sites refuse scripts (HTTP 401, 403, 429, 451, 503, or a "Just a moment..." bot-check page). The service does not try to get past that: no browser disguise, no challenge solving, no scraping proxy. With `archive` set to `fallback` (the default) it reads the Internet Archive's newest copy instead. That copy may be months old, so the response sets `source` to `archive` and gives `snapshot_timestamp` and `snapshot_age_days`. Use `archive: "never"` to get the refusal instead, or `"only"` to read the archive without asking the site. The archive is asked at most once a second. A page read from the site is kept 24 hours and an archive copy 7 days, and a repeat read within that time costs no request.

Pages are read up to 2 MB of text; `truncated` says when the end was dropped. The cap counts decoded bytes: the service asks for gzip and inflates it a bounded piece at a time, so a compression bomb is cut at the cap, and a page that stacks compression layers or uses an encoding the service does not read is refused as `unsupported_content`. Only HTML and plain text are read. A page address that points at a private network is refused however it is written, and so is any redirect that leads to one. The same check runs before the Internet Archive is asked, so `archive: "only"` does not send a private address to a third party. A name that does not resolve at all is passed on, since the archive may hold a copy of a site that is gone.

## Develop

```bash
uv run pytest                              # tests fake every outbound call
uv run pytest -m integration               # live: example.com and the Internet Archive; not run in CI
uv run ruff check .
uv run python scripts/export_openapi.py    # after changing a route or a model
```
