"""The YouTube routes: search, one video's transcript cut into parts, and search plus transcripts plus ranking in one call.

Every error comes from the client as a ToolError; this module only decides what a caller asked for and shapes the answer.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import asdict

import httpx
from fastapi import APIRouter, Depends

from app.auth import require_token
from app.cache import Cache, get_cache
from app.clients import youtube
from app.clients.youtube import Captions, Video
from app.config import Settings, get_settings
from app.deps import get_http
from app.errors import ToolError, error_responses
from app.passages import Passage, rank
from app.schemas import (
    PassageOut,
    ResearchVideo,
    SkippedVideo,
    TranscriptRequest,
    TranscriptResponse,
    VideoOut,
    YoutubeResearchRequest,
    YoutubeResearchResponse,
    YoutubeSearchRequest,
    YoutubeSearchResponse,
)

router = APIRouter(prefix="/youtube", tags=["youtube"], dependencies=[Depends(require_token)], responses=error_responses(401, 503))

# Each caption download counts against YouTube's throttle, so one research call looks at a bounded number of videos.
MAX_CANDIDATES = 12
# Videos that cannot be quoted; the caller sees why and goes on. Any other failure is reported as "error".
_SKIPPABLE = {"no_captions", "no_english", "unplayable", "po_token_required", "timeout"}
# With a deadline, Gemini gives way to the captions this long before it: room to find and download a few caption tracks
# one at a time, with the gap between downloads.
CAPTIONS_RESERVE_SECONDS = 20.0
# G16 (#154): a fetch left running past a request's deadline finishes into the cache, but only this long after it started.
LATE_FETCH_CEILING_SECONDS = 180.0
# One fetch in flight per video: a retry joins it instead of starting a second download or Gemini call.
_inflight: dict[str, asyncio.Task[Captions]] = {}


async def _bounded_fetch(http: httpx.AsyncClient, cache: Cache, settings: Settings, video_id: str, gemini_until: float | None) -> Captions:
    async with asyncio.timeout(LATE_FETCH_CEILING_SECONDS):
        return await youtube.fetch_captions(http, cache, settings, video_id, gemini_until=gemini_until)


def _start_fetch(http: httpx.AsyncClient, cache: Cache, settings: Settings, video_id: str, gemini_until: float | None) -> asyncio.Task[Captions]:
    task = _inflight.get(video_id)
    if task is None:
        task = asyncio.ensure_future(_bounded_fetch(http, cache, settings, video_id, gemini_until))
        _inflight[video_id] = task

        def finished(done: asyncio.Task[Captions]) -> None:
            if _inflight.get(video_id) is done:
                del _inflight[video_id]
            done.cancelled() or done.exception()  # nobody may await a late task; mark its error as seen

        task.add_done_callback(finished)
    return task


async def cancel_inflight() -> None:
    """Shutdown: stop every fetch still running past its request."""
    tasks = list(_inflight.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def _passages_out(passages: list[Passage], video_id: str) -> list[PassageOut]:
    return [PassageOut(id=passage.id, text=passage.text, at=passage.at, url=youtube.watch_url(video_id, passage.at), score=passage.score) for passage in passages]


def _wanted(video: Video, request: YoutubeSearchRequest | YoutubeResearchRequest) -> bool:
    """The request's filters. A video missing the fact a filter needs (a live stream has no length) fails that filter."""
    if not youtube.title_matches(video.title, request.title_terms):
        return False
    if request.max_age_months is not None and (video.age_months is None or youtube.age_months_ceiling(video.published) > request.max_age_months):
        return False
    if request.min_seconds is not None or request.max_seconds is not None:
        if video.seconds is None:
            return False
        if video.seconds < (request.min_seconds or 0) or video.seconds > (request.max_seconds or math.inf):
            return False
    return True


async def _search(http: httpx.AsyncClient, request: YoutubeSearchRequest | YoutubeResearchRequest) -> list[Video]:
    """Search once, then drop repeats and what the filters rule out. YouTube's order is kept: it is the relevance order."""
    seen: set[str] = set()
    videos: list[Video] = []
    for video in await youtube.search_videos(http, request.query):
        if video.id not in seen and _wanted(video, request):
            videos.append(video)
        seen.add(video.id)
    return videos


@router.post("/search", response_model=YoutubeSearchResponse, responses=error_responses(502))
async def search(request: YoutubeSearchRequest, http: httpx.AsyncClient = Depends(get_http)) -> YoutubeSearchResponse:
    videos = await _search(http, request)
    return YoutubeSearchResponse(videos=[VideoOut(**asdict(video), url=youtube.watch_url(video.id)) for video in videos[: request.max_results]])


@router.post("/transcript", response_model=TranscriptResponse, responses=error_responses(404, 429, 502))
async def transcript(
    request: TranscriptRequest,
    http: httpx.AsyncClient = Depends(get_http),
    cache: Cache = Depends(get_cache),
    settings: Settings = Depends(get_settings),
) -> TranscriptResponse:
    captions = await youtube.fetch_captions(http, cache, settings, request.video_id)
    parts = youtube.caption_passages(captions, request.video_id, request.part_chars)
    chosen = parts if request.query is None else rank(parts, request.query, request.max_passages)
    return TranscriptResponse(
        video_id=request.video_id,
        language=captions.language,
        generated=captions.generated,
        source=captions.source,
        chars=captions.chars,
        parts=len(parts),
        cut_at_seconds=captions.cut_at,
        cached=captions.cached,
        passages=_passages_out(chosen, request.video_id),
    )


def _next_batch(pending: list[Video], size: int, per_channel: dict[str, int], cap: int) -> tuple[list[Video], list[Video]]:
    """The next hits to fetch together, and the hits after them. A hit whose channel already has `cap` videos is dropped.

    The batch ends before a hit whose channel is full only if every earlier hit in the batch is kept. That hit waits for the
    next batch, so a fetch that fails never costs a later video of the same channel its place, and the order stays YouTube's.
    """
    batch: list[Video] = []
    counts = dict(per_channel)
    for index, hit in enumerate(pending):
        if per_channel.get(hit.channel, 0) >= cap:
            continue
        if len(batch) == size or counts.get(hit.channel, 0) >= cap:
            return batch, pending[index:]
        batch.append(hit)
        counts[hit.channel] = counts.get(hit.channel, 0) + 1
    return batch, []


async def _captions_or_error(http: httpx.AsyncClient, cache: Cache, settings: Settings, hit: Video, deadline: float | None) -> Captions | ToolError:
    """A fetch that fails, or is still running at the deadline (the event loop's clock), comes back as its error, so one
    video's failure does not end the others fetched with it.

    A fetch still running at the deadline is not cancelled: it finishes into the cache, so a retry is served from it.
    """
    task = _start_fetch(http, cache, settings, hit.id, None if deadline is None else deadline - CAPTIONS_RESERVE_SECONDS)
    loop = asyncio.get_running_loop()
    done, _ = await asyncio.wait({task}, timeout=None if deadline is None else max(0.0, deadline - loop.time()))
    if not done:
        return ToolError("timeout", 504, "The transcript was still being fetched at the request's deadline.")
    try:
        return task.result()
    except ToolError as error:
        return error
    except TimeoutError:  # the hard ceiling ended it
        return ToolError("timeout", 504, "The transcript fetch ran past its time limit.")
    except asyncio.CancelledError:
        if task.cancelled():  # shut down, or the joined fetch was cancelled: this request alone is not
            return ToolError("timeout", 504, "The transcript fetch was cancelled.")
        raise


@router.post("/research", response_model=YoutubeResearchResponse, responses=error_responses(502))
async def research(
    request: YoutubeResearchRequest,
    http: httpx.AsyncClient = Depends(get_http),
    cache: Cache = Depends(get_cache),
    settings: Settings = Depends(get_settings),
) -> YoutubeResearchResponse:
    """Walk the first MAX_CANDIDATES search hits in order until `max_videos` have passages.

    Without a Gemini key the walk fetches one transcript at a time: each caption download counts against YouTube's throttle.
    With one it fetches as many hits at once as videos are still needed, and the answer keeps YouTube's order.
    With `deadline_seconds` the answer is what is done by then, and no fetch starts after it.
    """
    loop = asyncio.get_running_loop()
    deadline = None if request.deadline_seconds is None else loop.time() + request.deadline_seconds
    videos: list[ResearchVideo] = []
    skipped: list[SkippedVideo] = []
    per_channel: dict[str, int] = {}
    rate_limited = False
    hits = await _search(http, request)
    if not hits and request.title_terms:
        # YouTube finds little for a long, specific query. The title terms alone are the widest search whose results can
        # still pass the title filter; `focus` goes on choosing the parts.
        hits = await _search(http, request.model_copy(update={"query": " ".join(request.title_terms)}))
    pending = hits[:MAX_CANDIDATES]
    # A fetch cut off at the deadline ends the walk. The clock alone is not enough: the loop's timer fires up to a clock tick
    # early (15 ms on Windows), so the time can still read just short of the deadline and let one more fetch start.
    expired = False
    while pending and len(videos) < request.max_videos and not expired and (deadline is None or loop.time() < deadline):
        size = request.max_videos - len(videos) if settings.transcript_source == "gemini" else 1
        batch, pending = _next_batch(pending, size, per_channel, request.max_per_channel)
        outcomes = await asyncio.gather(*(_captions_or_error(http, cache, settings, hit, deadline) for hit in batch))
        for hit, captions in zip(batch, outcomes, strict=True):
            if isinstance(captions, ToolError):
                expired = expired or captions.code == "timeout"
                if captions.code == "rate_limited":
                    skipped.append(SkippedVideo(id=hit.id, title=hit.title, reason="rate_limited"))
                    rate_limited = True
                    # Keep walking: the throttle is remembered, so a later hit costs no request to YouTube, and one whose
                    # transcript is already cached is still served. Stopping here would hide every cached video behind the first uncached one.
                    continue
                skipped.append(SkippedVideo(id=hit.id, title=hit.title, reason=captions.code if captions.code in _SKIPPABLE else "error"))
                continue
            if captions.chars < request.min_chars:
                skipped.append(SkippedVideo(id=hit.id, title=hit.title, reason="too_short"))
                continue
            parts = youtube.caption_passages(captions, hit.id, request.part_chars)
            ranked = rank(parts, request.focus or request.query, request.max_passages_per_video)
            if not ranked:
                skipped.append(SkippedVideo(id=hit.id, title=hit.title, reason="no_match"))
                continue
            per_channel[hit.channel] = per_channel.get(hit.channel, 0) + 1
            videos.append(
                ResearchVideo(
                    **asdict(hit),
                    url=youtube.watch_url(hit.id),
                    language=captions.language,
                    generated=captions.generated,
                    source=captions.source,
                    chars=captions.chars,
                    parts=len(parts),
                    cut_at_seconds=captions.cut_at,
                    passages=_passages_out(ranked, hit.id),
                )
            )
    return YoutubeResearchResponse(videos=videos, skipped=skipped, rate_limited=rate_limited)
