"""Transcripts from the Gemini API: it reads a public YouTube video and writes down what is spoken.

Google gets the public video URL, the clip's start and end, and the fixed prompt below, and nothing about the caller. The
key goes in a header and nowhere else, so no URL, error message, or log line holds it.

A video is cut into clips of five minutes and each clip is transcribed on its own. One call for a whole video returned
timestamps that drift (the last stamp was 14:09 on a 9:42 video); clips of 300 seconds kept every line at its time. A clip
is read at 0.1 frames a second, which cuts the input from about 91 to about 32 tokens per second of video with the same
words. Lower than that hurt the timestamps.
"""

from __future__ import annotations

import asyncio
import math
import re
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import httpx

from app.clients.captions import CaptionEvent
from app.config import Settings
from app.errors import ToolError
from app.passages import squeeze

_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
_CLIP_SECONDS = 300
_FPS = 0.1
_AUDIO_TOKENS_PER_SECOND = 32
_MAX_OUTPUT_TOKENS = 30000
# Gemini answers 500 for a clip that starts within about 2 s of the end of the video, or after it. The length is an
# estimate from tokens, so no clip starts within 5 s of the estimated end, and a 500 on a clip after the first that starts
# within 30 s of it is an empty clip, once it has been asked for twice. The first clip is never past the end.
_END_SECONDS = 5
_LAST_CLIP_SECONDS = 30
_STAMP_SLACK_SECONDS = 5  # how far outside its clip a line's time may be before it is not believed
_MIN_WORDS = 50  # fewer than this in the whole video is no speech
# A clip answers in 3 to 13 seconds (32 calls measured 2026-10-01), but now and then one takes most of a minute or
# never answers. So a clip is given 45 seconds and sent once more when it gets no answer or a 5xx; a second failure
# fails the transcript, and the caller falls back to the captions.
# ponytail: a plain call cannot tell a slow answer from a dead one. Stream the answer and time the gaps if the fallback proves common.
_CLIP_TIMEOUT = httpx.Timeout(45.0, connect=5.0)
_CLIP_TRIES = 2

_PROMPT = (
    "Transcribe everything that is spoken in this video clip, word for word, in English. "
    "Start a new line about every 20 seconds of speech and begin each line with the time it starts in the full video, as [mm:ss]. "
    "Do not summarize or describe the screen. Output only the transcript lines."
)
# [mm:ss] text, or [h:mm:ss] text. A list dash or star before it, bold around it, and a range [mm:ss - mm:ss] (its start is the time) are read too.
_LINE = re.compile(r"^\s*(?:[-*]\s+)?\**\[(\d+):(\d{2})(?::(\d{2}))?(?:\s*[-\u2013\u2014]\s*\d+:\d{2}(?::\d{2})?)?\]\**\s*(.+?)\s*$")
_STAMP = re.compile(r"\d+:\d{2}")  # a time anywhere in an answer: the answer was a transcript, whatever its format

# One place in line for every Gemini call this process makes, so requests at the same time share the limit.
_slots: asyncio.Semaphore | None = None
_slots_size = 0


def _call_slots(size: int) -> asyncio.Semaphore:
    global _slots, _slots_size
    if _slots is None or _slots_size != size:
        _slots, _slots_size = asyncio.Semaphore(size), size
    return _slots


@contextmanager
def _upstream() -> Iterator[None]:
    """A body that is not JSON, or JSON of another shape, becomes one 502, never a 500."""
    try:
        yield
    except (KeyError, TypeError, ValueError, AttributeError, IndexError) as error:
        raise ToolError("upstream_error", 502, f"Gemini answered in a shape this service does not know ({type(error).__name__}).") from None


def _retry_after(response: httpx.Response) -> int | None:
    """The seconds Google asks for, when it sends a number. A date is not read."""
    value = response.headers.get("Retry-After", "")
    return int(value) if value.isdigit() else None


async def _post(
    http: httpx.AsyncClient,
    settings: Settings,
    action: str,
    body: dict[str, Any],
    *,
    timeout: httpx.Timeout | httpx.UseClientDefault = httpx.USE_CLIENT_DEFAULT,
    empty_on_500: bool = False,
    tries: int = 1,
) -> Any:
    """One Gemini call, answered as parsed JSON. None when `empty_on_500` is set and Gemini answered 500. Every failure is a ToolError.

    With `tries` over 1, a call that got no answer or a 5xx is sent again: those are Gemini's passing faults, and so is a 500 that `empty_on_500` would
    take for an empty answer. Any other failure is final.
    """
    key = settings.gemini_api_key.get_secret_value()  # only called when transcript_source is "gemini", which needs a key
    for left in range(tries - 1, -1, -1):
        async with _call_slots(settings.gemini_concurrency):
            try:
                response = await http.post(f"{_BASE}/{settings.gemini_model}:{action}", json=body, headers={"x-goog-api-key": key}, timeout=timeout)
            except (httpx.HTTPError, httpx.InvalidURL) as error:
                if left and isinstance(error, httpx.TransportError):
                    continue
                raise ToolError("upstream_error", 502, f"Gemini did not answer usefully ({type(error).__name__}).") from None
        if not (left and response.status_code >= 500):
            break
    status = response.status_code
    if status == 403:
        raise ToolError("unplayable", 404, "Gemini cannot read this video: it is missing or private.")
    if status == 429:
        raise ToolError("rate_limited", 429, "Gemini is refusing requests: the rate limit or the quota is used up.", retry_after=_retry_after(response))
    if status in (400, 401):
        raise ToolError("upstream_error", 502, f"Gemini refused the API key or the model name (HTTP {status}).")
    if status == 500 and empty_on_500:
        return None
    if not response.is_success:
        raise ToolError("upstream_error", 502, f"Gemini did not answer usefully (HTTP {status}).")
    with _upstream():
        return response.json()


def _video_part(video_id: str) -> dict[str, Any]:
    return {"file_data": {"file_uri": f"https://www.youtube.com/watch?v={video_id}"}}


async def video_seconds(http: httpx.AsyncClient, settings: Settings, video_id: str) -> float:
    """The video's length, from the tokens its audio costs: 32 a second. countTokens answers in a third of a second and costs nothing."""
    data = await _post(http, settings, "countTokens", {"contents": [{"parts": [_video_part(video_id)]}]})
    with _upstream():
        return sum(row["tokenCount"] for row in data["promptTokensDetails"] if row["modality"] == "AUDIO") / _AUDIO_TOKENS_PER_SECOND


def clip_starts(seconds: float) -> list[int]:
    """The start second of every clip of a video this long. A clip that would start within 5 s of the end is left out."""
    return [start for start in range(0, math.ceil(seconds), _CLIP_SECONDS) if start < seconds - _END_SECONDS]


def parse_lines(text: str, start: int) -> list[CaptionEvent]:
    """The events in one clip's answer, in the order given. A line with no time is not a transcript line and is dropped.

    A time more than 5 s before the clip or after its end is a wrong time, and the line is placed at the clip's start.
    """
    events: list[CaptionEvent] = []
    for line in text.splitlines():
        match = _LINE.match(line)
        if not match:
            continue
        first, second, third, spoken = match.groups()
        at = int(first) * 3600 + int(second) * 60 + int(third) if third else int(first) * 60 + int(second)
        if not start - _STAMP_SLACK_SECONDS <= at <= start + _CLIP_SECONDS + _STAMP_SLACK_SECONDS:
            at = start
        events.append(CaptionEvent(at=at, text=squeeze(spoken)))
    return events


async def _clip(http: httpx.AsyncClient, settings: Settings, video_id: str, start: int, length: float) -> list[CaptionEvent]:
    body = {
        "contents": [{"parts": [{**_video_part(video_id), "video_metadata": {"start_offset": f"{start}s", "end_offset": f"{start + _CLIP_SECONDS}s", "fps": _FPS}}, {"text": _PROMPT}]}],
        # No thinking: a transcript needs none, and thought tokens are billed as output.
        "generationConfig": {"temperature": 0, "maxOutputTokens": _MAX_OUTPUT_TOKENS, "thinkingConfig": {"thinkingBudget": 0}},
    }
    near_the_end = start > 0 and start >= length - _LAST_CLIP_SECONDS
    data = await _post(http, settings, "generateContent", body, timeout=_CLIP_TIMEOUT, empty_on_500=near_the_end, tries=_CLIP_TRIES)
    if data is None:
        return []
    with _upstream():
        candidate = data["candidates"][0]
        if candidate.get("finishReason") != "STOP":
            raise ToolError("upstream_error", 502, f"Gemini stopped before it finished a clip ({candidate.get('finishReason')}).")
        text = "\n".join(part["text"] for part in candidate["content"]["parts"] if not part.get("thought"))
    events = parse_lines(text, start)
    if not events and _STAMP.search(text):
        # A clip with times in it and no line read is a format this service does not know, not silence: the video must not become a miss or a transcript with a hole.
        raise ToolError("upstream_error", 502, "Gemini wrote a clip in a format this service does not read.")
    return events


async def transcript(http: httpx.AsyncClient, settings: Settings, video_id: str) -> tuple[list[CaptionEvent], int | None]:
    """English events in time order, from clips transcribed at most `gemini_concurrency` at a time, and the second the video was cut at.

    Only the first `gemini_max_minutes` of a longer video are transcribed; the second part is that cap, or None when the whole video was.

    Raises ToolError: unplayable, rate_limited, or upstream_error when Gemini fails, and no_captions when the video has under 50 spoken words.
    """
    length = await video_seconds(http, settings, video_id)
    cap = settings.gemini_max_minutes * 60
    tasks = [asyncio.create_task(_clip(http, settings, video_id, start, length)) for start in clip_starts(min(length, cap))]
    try:
        clips = await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()  # once one clip has failed, the rest are not worth their quota
    events: list[CaptionEvent] = []
    at = 0
    for event in (event for clip in clips for event in clip):
        at = max(at, event.at)  # a wrong time stays inside its own five minutes: the transcript never goes back
        events.append(CaptionEvent(at=at, text=event.text))
    if sum(len(event.text.split()) for event in events) < _MIN_WORDS:
        raise ToolError("no_captions", 404, f"The video has fewer than {_MIN_WORDS} spoken words.")
    return events, (cap if length > cap else None)
