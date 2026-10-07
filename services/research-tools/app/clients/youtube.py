"""YouTube search and English captions, through the endpoints YouTube's own apps use (innertube).

YouTube throttles caption downloads per address: after about 15 in ten minutes every further one answers 429 for 40
minutes or more, while search and /player stay open. Everything here is built around that: a transcript is fetched once
and kept for good, a video with no usable captions is remembered for a week, downloads run one at a time with a gap,
and a 429 is recorded so no further download is tried until the throttle has had time to lift.

With a Gemini key a transcript is made by Gemini first (app.clients.gemini), and these endpoints are the fallback.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from typing import Any

import httpx

from app.cache import Cache
from app.clients import gemini
from app.clients.captions import CaptionEvent
from app.config import Settings
from app.errors import ToolError
from app.passages import Passage, squeeze
from app.schemas import TranscriptSource

_BASE = "https://www.youtube.com/youtubei/v1"
_WEB_CLIENT = {"clientName": "WEB", "clientVersion": "2.20250925.01.00", "hl": "en", "gl": "US"}
# /player answers with caption tracks for the Android client without the proof-of-origin token the web client wants.
_ANDROID_CLIENT = {"clientName": "ANDROID", "clientVersion": "20.10.38", "androidSdkVersion": 30, "hl": "en", "gl": "US"}
_ANDROID_USER_AGENT = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
_VIDEOS_ONLY = "EgIQAQ%3D%3D"  # search filter type=video: no channel rows, shelves, or shorts rows
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
# playabilityStatus values that say something lasting about the video. Others describe this address or this hour (a bot
# check, a premiere that has not started), so a miss for them would outlive the cause for a week.
_VIDEO_STATUSES = frozenset({"ERROR", "UNPLAYABLE", "AGE_VERIFICATION_REQUIRED"})
_AGE_GATE = re.compile(r"\bage\b", re.IGNORECASE)  # an age gate comes as LOGIN_REQUIRED, like the bot check does

_log = logging.getLogger(__name__)

_CAPTIONS = "captions"
# Two kinds of miss, never mixed: what YouTube's captions lack says nothing about what Gemini can hear, and the other way round.
_MISS = "captions-miss"
_GEMINI_MISS = "gemini-miss"
_THROTTLE = "throttle"
_MISS_SECONDS = 7 * 24 * 3600
_THROTTLE_SECONDS = 3600  # measured: over 40 minutes (README, YouTube limits); an hour leaves margin

_AGE = re.compile(r"(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago", re.IGNORECASE)
_AGE_IN_MONTHS = {"second": 0, "minute": 0, "hour": 0, "day": 0, "week": 0.25, "month": 1, "year": 12}

# One download at a time, so the gap below means something. A video's /player call is not throttled and runs outside it.
_download_lock = asyncio.Lock()
_last_download = -math.inf  # time.monotonic() when the last caption download ended
# The videos a request is working on, each with its lock and how many requests hold or wait for it, so a second request for one waits instead of paying for it again.
_busy: dict[str, tuple[asyncio.Lock, int]] = {}


@dataclass(frozen=True)
class Video:
    id: str
    title: str
    channel: str
    seconds: int | None  # None for a live stream or premiere
    published: str  # YouTube's own text, e.g. "Streamed 2 years ago"; empty when absent
    age_months: float | None


@dataclass(frozen=True)
class Captions:
    language: str
    generated: bool  # True for auto captions and for a Gemini transcript: a machine made it
    events: list[CaptionEvent]
    cached: bool
    source: TranscriptSource = "captions"
    cut_at: int | None = None  # second the transcript stops at, when the video was longer than Gemini's cap

    @property
    def chars(self) -> int:
        """Length of the whole transcript with one space between events."""
        return sum(len(event.text) for event in self.events) + max(len(self.events) - 1, 0)


@dataclass(frozen=True)
class _Track:
    url: str
    language: str
    generated: bool


def watch_url(video_id: str, at: int = 0) -> str:
    return f"https://youtu.be/{video_id}" + (f"?t={at}" if at else "")


def length_seconds(text: str | None) -> int | None:
    """"1:02:03" is 3723. None when there is no length (a live stream) or it is not a clock reading."""
    if not text:
        return None
    seconds = 0
    try:
        for part in text.split(":"):
            seconds = seconds * 60 + int(part)
    except ValueError:
        return None
    return seconds


def age_months(text: str | None) -> float | None:
    """YouTube's "8 months ago" or "Streamed 2 years ago" as months. Under a month counts as 0 except weeks, which are a quarter each."""
    match = _AGE.search(text or "")
    return int(match.group(1)) * _AGE_IN_MONTHS[match.group(2).lower()] if match else None


# What a count of each unit adds to the oldest the video can be: YouTube rounds down, so "1 year ago" is 12 to 24 months.
_AGE_CEILING_MONTHS = {"second": 1 / 30, "minute": 1 / 30, "hour": 1 / 30, "day": 1 / 30, "week": 0.25, "month": 1, "year": 12}


def age_months_ceiling(text: str | None) -> float | None:
    """The oldest `text` can mean, in months: its count plus one unit. `age_months` is the youngest."""
    match = _AGE.search(text or "")
    if not match:
        return None
    unit = match.group(2).lower()
    count = int(match.group(1)) if unit in ("day", "week", "month", "year") else 0  # under a day, one day is the bound
    return count * _AGE_CEILING_MONTHS[unit] + _AGE_CEILING_MONTHS[unit]


def _letters_and_digits(text: str) -> str:
    return re.sub(r"[\W_]+", "", text.lower())


def title_matches(title: str, terms: list[str]) -> bool:
    """Every term is in the title, compared without case, spaces, or punctuation, so "Kai'Sa" finds "kaisa"."""
    squashed = _letters_and_digits(title)
    return all(_letters_and_digits(term) in squashed for term in terms)


def caption_passages(captions: Captions, video_id: str, part_chars: int) -> list[Passage]:
    """Join events into parts of about `part_chars`: a part closes once it reaches that length. `at` is its first event's second.

    `video_id` is not in the passage itself (ids are p1, p2, ...); the route turns it and `at` into a link.
    """
    passages: list[Passage] = []
    texts: list[str] = []
    start = 0
    length = -1  # joined length: each text adds itself and one space
    for event in captions.events:
        if not texts:
            start = event.at
        texts.append(event.text)
        length += len(event.text) + 1
        if length >= part_chars:
            passages.append(Passage(id=f"p{len(passages) + 1}", text=" ".join(texts), at=start))
            texts, length = [], -1
    if texts:
        passages.append(Passage(id=f"p{len(passages) + 1}", text=" ".join(texts), at=start))
    return passages


@contextmanager
def _upstream() -> Iterator[None]:
    """Whatever YouTube gets wrong (a bad status, a timeout, a body of another shape) becomes one 502, never a 500."""
    try:
        yield
    except (httpx.HTTPError, httpx.InvalidURL) as error:
        detail = f"HTTP {error.response.status_code}" if isinstance(error, httpx.HTTPStatusError) else type(error).__name__
        raise ToolError("upstream_error", 502, f"YouTube did not answer usefully ({detail}).") from error
    except (KeyError, TypeError, ValueError, AttributeError, IndexError) as error:
        raise ToolError("upstream_error", 502, f"YouTube answered in a shape this service does not know ({type(error).__name__}).") from error


async def search_videos(http: httpx.AsyncClient, query: str) -> list[Video]:
    """One page of video results in YouTube's order. Filtering and cutting are the caller's."""
    with _upstream():
        response = await http.post(f"{_BASE}/search?prettyPrint=false", json={"context": {"client": _WEB_CLIENT}, "query": query, "params": _VIDEOS_ONLY})
        response.raise_for_status()
        sections = response.json()["contents"]["twoColumnSearchResultsRenderer"]["primaryContents"]["sectionListRenderer"]["contents"]
        return [_video(item["videoRenderer"]) for section in sections for item in section.get("itemSectionRenderer", {}).get("contents", []) if "videoRenderer" in item]


def _video(renderer: dict[str, Any]) -> Video:
    published = renderer.get("publishedTimeText", {}).get("simpleText")
    return Video(
        id=renderer["videoId"],
        title="".join(run.get("text", "") for run in renderer["title"]["runs"]),
        channel=(renderer.get("ownerText", {}).get("runs") or [{}])[0].get("text", ""),
        seconds=length_seconds(renderer.get("lengthText", {}).get("simpleText")),
        published=published or "",
        age_months=age_months(published),
    )


@asynccontextmanager
async def _one_request_at_a_time(video_id: str) -> AsyncIterator[None]:
    """A request for a video waits here while another request for the same video is working on it, then finds what that one kept."""
    lock, holders = _busy.get(video_id) or (asyncio.Lock(), 0)
    _busy[video_id] = (lock, holders + 1)
    try:
        async with lock:
            yield
    finally:
        lock, holders = _busy[video_id]
        if holders == 1:
            del _busy[video_id]
        else:
            _busy[video_id] = (lock, holders - 1)


async def fetch_captions(http: httpx.AsyncClient, cache: Cache, settings: Settings, video_id: str, gemini_until: float | None = None) -> Captions:
    """An English transcript for one video: the cache first, then Gemini when it has a key, then YouTube's captions.

    Gemini failing (rate limited, broken, refused the video, or still at work at `gemini_until`, on the event loop's clock)
    falls back to the captions, whose result or error is the answer.
    A video Gemini finds no speech in is a miss of its own, honoured only while Gemini is the source: there is nothing for the
    captions to add. A video the captions lack is another miss, and Gemini does not read it. Raises ToolError for every way that can fail.
    """
    if not _VIDEO_ID.match(video_id):
        raise ToolError("invalid_video_id", 422, "A video id is 11 characters: letters, digits, '-' or '_'.")
    async with _one_request_at_a_time(video_id):
        stored = cache.get(_CAPTIONS, video_id)  # a request for the same video may have finished while this one waited
        if stored is not None:
            return _read(stored, cached=True)
        if settings.transcript_source == "gemini":
            miss = cache.get(_GEMINI_MISS, video_id, max_age_seconds=_MISS_SECONDS)
            if miss is not None:
                raise ToolError(miss["code"], 404, miss["message"])
            try:
                async with asyncio.timeout_at(gemini_until):
                    events, cut_at = await gemini.transcript(http, settings, video_id)
            except TimeoutError:
                # The caller's deadline is near: the captions may still make it where Gemini did not.
                _log.warning("Gemini gave no transcript for %s (timeout: Gemini ran out of the time the request left it.); trying YouTube's captions", video_id)
            except ToolError as error:
                if error.code == "no_captions":
                    raise _miss(cache, _GEMINI_MISS, video_id, error.code, error.message) from None
                # Anything else is Gemini's trouble, not the video's: YouTube's own captions may still have it. The YouTube throttle is not touched.
                _log.warning("Gemini gave no transcript for %s (%s: %s); trying YouTube's captions", video_id, error.code, error.message)
            else:
                return _keep(cache, video_id, Captions(language="en", generated=True, events=events, cached=False, source="gemini", cut_at=cut_at))
        miss = cache.get(_MISS, video_id, max_age_seconds=_MISS_SECONDS)
        if miss is not None:
            raise ToolError(miss["code"], 404, miss["message"])
        _refuse_while_throttled(cache)
        track = await _find_track(http, cache, video_id)
        async with _download_lock:
            _refuse_while_throttled(cache)  # a download for another video may have been refused while this one waited
            gap = settings.youtube_caption_gap_seconds - (time.monotonic() - _last_download)
            if gap > 0:
                await asyncio.sleep(gap)
            return _keep(cache, video_id, Captions(language=track.language, generated=track.generated, events=await _download(http, cache, track), cached=False))


def _keep(cache: Cache, video_id: str, captions: Captions) -> Captions:
    """Store a transcript for good, with where it came from."""
    cache.set(_CAPTIONS, video_id, {"language": captions.language, "generated": captions.generated, "events": [{"at": event.at, "text": event.text} for event in captions.events], "source": captions.source, **({"cut_at": captions.cut_at} if captions.cut_at else {})})
    return captions


def _read(stored: dict[str, Any], cached: bool) -> Captions:
    """A stored transcript. A record from before `source` was kept has none and reads as captions, which is all there were."""
    return Captions(
        language=stored["language"],
        generated=stored["generated"],
        events=[CaptionEvent(at=event["at"], text=event["text"]) for event in stored["events"]],
        cached=cached,
        source=stored.get("source", "captions"),
        cut_at=stored.get("cut_at"),
    )


def _refuse_while_throttled(cache: Cache) -> None:
    """After a 429 YouTube refuses every caption download for a long while (over 40 minutes measured), so do not ask again until the recorded hour is up."""
    entry = cache.get(_THROTTLE, "captions")
    until = entry.get("until") if isinstance(entry, dict) else None
    if isinstance(until, int | float) and until > time.time():
        raise _throttled(until - time.time())


def _throttled(seconds_left: float) -> ToolError:
    wait = max(1, math.ceil(seconds_left))
    return ToolError("rate_limited", 429, f"YouTube is refusing caption downloads from this address. Try again in {wait} seconds. A transcript fetched before is still served.", retry_after=wait)


def _miss(cache: Cache, space: str, video_id: str, code: str, message: str) -> ToolError:
    """Remember a video with no usable captions, or no speech for Gemini, so asking about it again costs no request."""
    cache.set(space, video_id, {"code": code, "message": message})
    return ToolError(code, 404, message)


async def _find_track(http: httpx.AsyncClient, cache: Cache, video_id: str) -> _Track:
    """Ask /player which caption tracks the video has and pick the English one, a manual track before an auto one."""
    with _upstream():
        response = await http.post(f"{_BASE}/player?prettyPrint=false", json={"context": {"client": _ANDROID_CLIENT}, "videoId": video_id}, headers={"User-Agent": _ANDROID_USER_AGENT})
        response.raise_for_status()
        player = response.json()
        playability = player["playabilityStatus"]
        status = playability.get("status")
        if status != "OK":
            reason = playability.get("reason") or status
            message = f"The video cannot be played: {reason}."
            if status in _VIDEO_STATUSES or (status == "LOGIN_REQUIRED" and _AGE_GATE.search(str(reason))):
                raise _miss(cache, _MISS, video_id, "unplayable", message)
            raise ToolError("unplayable", 404, message)
        tracks = player.get("captions", {}).get("playerCaptionsTracklistRenderer", {}).get("captionTracks")
        if not tracks:
            raise _miss(cache, _MISS, video_id, "no_captions", "The video has no captions.")
        english = sorted((track for track in tracks if track.get("languageCode", "").startswith("en")), key=lambda track: track.get("kind") == "asr")
        if not english:
            languages = ", ".join(sorted({track.get("languageCode", "?") for track in tracks}))
            raise _miss(cache, _MISS, video_id, "no_english", f"The video has captions only in: {languages}.")
        track = english[0]
        if "exp=xpe" in track["baseUrl"]:
            raise ToolError("po_token_required", 502, "YouTube wants a proof-of-origin token for this track, which this service cannot make.")
        return _Track(url=track["baseUrl"], language=track["languageCode"], generated=track.get("kind") == "asr")


async def _download(http: httpx.AsyncClient, cache: Cache, track: _Track) -> list[CaptionEvent]:
    global _last_download
    try:
        with _upstream():
            # copy_merge_params, not params=: params= replaces the whole query string and drops the signature, and YouTube answers 404.
            response = await http.get(httpx.URL(track.url).copy_merge_params({"fmt": "json3"}))
            if response.status_code == 429:
                cache.set(_THROTTLE, "captions", {"until": time.time() + _THROTTLE_SECONDS})
                raise _throttled(_THROTTLE_SECONDS)
            response.raise_for_status()
            events = [
                CaptionEvent(at=event["tStartMs"] // 1000, text=text)
                for event in response.json()["events"]
                if (text := squeeze("".join(seg.get("utf8", "") for seg in event.get("segs", []))))
            ]
    finally:
        _last_download = time.monotonic()
    if not events:
        # Not cached: a throttled or half-served response can look like this, and a transcript is kept for good.
        raise ToolError("upstream_error", 502, "YouTube answered with a caption file that has no text.")
    return events
