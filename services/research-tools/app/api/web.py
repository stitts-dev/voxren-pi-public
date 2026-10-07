"""The web routes: search, read one page, and search-then-read in one call.

A page is read from the site first. A site that refuses scripts is not pressed (no browser disguise, no challenge
solving, no proxy): the service reads the Internet Archive's copy instead and says so, or reports the refusal. Whichever
copy it read, the page is cut into passages and ranked the same way as a transcript.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

import httpx
from fastapi import APIRouter, Depends

from app.auth import require_token
from app.cache import Cache, get_cache
from app.clients.archive import age_days, fetch_snapshot
from app.clients.fetch import FetchedPage, Resolver, fetch_page, resolve
from app.clients.search import web_search
from app.config import Settings, get_settings
from app.deps import get_http
from app.errors import ToolError, error_responses
from app.extract import extract, is_challenge
from app.passages import Passage, rank, split_text
from app.schemas import (
    ArchiveMode,
    PassageOut,
    ResearchPage,
    SkippedPage,
    WebReadRequest,
    WebReadResponse,
    WebResearchRequest,
    WebResearchResponse,
    WebResult,
    WebSearchRequest,
    WebSearchResponse,
)

router = APIRouter(prefix="/web", tags=["web"], dependencies=[Depends(require_token)], responses=error_responses(401, 503))

PAGE_SECONDS = {"origin": 24 * 3600, "archive": 7 * 24 * 3600}  # an archive copy does not change, so it is kept longer
READS_AT_ONCE = 3

PageFetcher = Callable[..., Awaitable[FetchedPage]]
Source = Literal["origin", "archive"]


def get_fetch_page() -> PageFetcher:
    """The page fetcher. Tests override this to give fetch_page a MockTransport and a resolver that needs no DNS."""
    return fetch_page


def get_resolver() -> Resolver:
    """The DNS lookup the archive path checks a host with. Tests override this so no test needs DNS."""
    return resolve


@dataclass(frozen=True)
class _Page:
    """A page's extracted text and where it came from; what the cache keeps."""

    title: str
    text: str
    truncated: bool
    source: Source
    snapshot_timestamp: str | None = None
    cached: bool = False


def _cache_key(url: str, source: Source) -> str:
    return f"{source} {url}"


def _cached_page(cache: Cache, url: str, source: Source) -> _Page | None:
    hit = cache.get("pages", _cache_key(url, source), PAGE_SECONDS[source])
    try:
        return _Page(title=hit["title"], text=hit["text"], truncated=hit["truncated"], source=source, snapshot_timestamp=hit["snapshot_timestamp"], cached=True) if hit else None
    except (KeyError, TypeError):
        return None


def _store_page(cache: Cache, url: str, page: _Page) -> None:
    cache.set("pages", _cache_key(url, page.source), {"title": page.title, "text": page.text, "truncated": page.truncated, "snapshot_timestamp": page.snapshot_timestamp})


async def _read_origin(url: str, settings: Settings, cache: Cache, fetch: PageFetcher) -> _Page:
    fetched = await fetch(url, settings=settings)
    if is_challenge(fetched.html):
        raise ToolError("fetch_refused", 502, "The site answered with a bot-check page instead of the content.")
    extracted = await asyncio.to_thread(extract, fetched.html)
    if not extracted.text.strip():  # a bot-check that answers 200 or 202 with only scripts: a refusal, not an empty page
        raise ToolError("fetch_refused", 502, "The site answered with a page that has no text.")
    page = _Page(title=extracted.title, text=extracted.text, truncated=fetched.truncated, source="origin")
    _store_page(cache, url, page)
    return page


async def _read_archive(url: str, http: httpx.AsyncClient, settings: Settings, cache: Cache, resolver: Resolver) -> _Page:
    snapshot = await fetch_snapshot(http, settings, url, resolver=resolver)
    extracted = await asyncio.to_thread(extract, snapshot.html)
    page = _Page(title=extracted.title, text=extracted.text, truncated=snapshot.truncated, source="archive", snapshot_timestamp=snapshot.timestamp)
    _store_page(cache, url, page)
    return page


async def _load_page(url: str, mode: ArchiveMode, http: httpx.AsyncClient, settings: Settings, cache: Cache, fetch: PageFetcher, resolver: Resolver) -> _Page:
    """The page's text from the cache, the site, or the archive, as `mode` allows.

    Both caches are asked before any request, so a page the site refused once is not asked for again while its archive
    copy is kept: a repeat read costs no upstream call.
    """
    sources: tuple[Source, ...] = ("origin", "archive")
    for source in sources:
        if (source == "origin" and mode == "only") or (source == "archive" and mode == "never"):
            continue
        if page := _cached_page(cache, url, source):
            return page
    if mode == "only":
        return await _read_archive(url, http, settings, cache, resolver)
    refusal: ToolError | None = None
    try:
        return await _read_origin(url, settings, cache, fetch)
    except ToolError as error:
        if mode == "never" or error.code != "fetch_refused":
            raise
        refusal = error
    try:
        return await _read_archive(url, http, settings, cache, resolver)
    except ToolError as error:
        raise ToolError(error.code, error.status, f"{refusal.message} {error.message}") from None


def _passages(url: str, page: _Page, query: str | None, limit: int, part_chars: int) -> tuple[int, list[PassageOut]]:
    """The page's part count and the passages to return: ranked against `query`, or the first parts in order."""
    parts = [Passage(id=f"p{number}", text=text) for number, text in enumerate(split_text(page.text, part_chars), start=1)]
    chosen = rank(parts, query, limit) if query else parts[:limit]
    return len(parts), [PassageOut(id=part.id, text=part.text, url=url, score=part.score) for part in chosen]


def _read_response(url: str, page: _Page, query: str | None, limit: int, part_chars: int) -> WebReadResponse:
    parts, passages = _passages(url, page, query, limit, part_chars)
    return WebReadResponse(
        url=url,
        source=page.source,
        snapshot_timestamp=page.snapshot_timestamp,
        snapshot_age_days=age_days(page.snapshot_timestamp) if page.snapshot_timestamp else None,
        title=page.title,
        chars=len(page.text),
        parts=parts,
        truncated=page.truncated,
        cached=page.cached,
        passages=passages,
    )


@router.post("/search", response_model=WebSearchResponse, responses=error_responses(502))
async def search(
    body: WebSearchRequest,
    http: httpx.AsyncClient = Depends(get_http),
    settings: Settings = Depends(get_settings),
    cache: Cache = Depends(get_cache),
) -> WebSearchResponse:
    provider, results = await web_search(http, settings, body, cache=cache)
    return WebSearchResponse(provider=provider, results=results)


@router.post("/read", response_model=WebReadResponse, responses=error_responses(404, 415, 502))
async def read(
    body: WebReadRequest,
    http: httpx.AsyncClient = Depends(get_http),
    settings: Settings = Depends(get_settings),
    cache: Cache = Depends(get_cache),
    fetch: PageFetcher = Depends(get_fetch_page),
    resolver: Resolver = Depends(get_resolver),
) -> WebReadResponse:
    page = await _load_page(body.url, body.archive, http, settings, cache, fetch, resolver)
    return _read_response(body.url, page, body.query, body.max_passages, body.part_chars)


@router.post("/research", response_model=WebResearchResponse, responses=error_responses(502))
async def research(
    body: WebResearchRequest,
    http: httpx.AsyncClient = Depends(get_http),
    settings: Settings = Depends(get_settings),
    cache: Cache = Depends(get_cache),
    fetch: PageFetcher = Depends(get_fetch_page),
    resolver: Resolver = Depends(get_resolver),
) -> WebResearchResponse:
    search_request = WebSearchRequest(query=body.query, domains=body.domains, max_results=body.max_results, freshness_days=body.freshness_days)
    provider, results = await web_search(http, settings, search_request, cache=cache)
    focus = body.focus or body.query
    turn = asyncio.Semaphore(READS_AT_ONCE)

    async def read_one(result: WebResult) -> ResearchPage | SkippedPage:
        async with turn:
            try:
                page = await _load_page(result.url, body.archive, http, settings, cache, fetch, resolver)
            except ToolError as error:
                return SkippedPage(url=result.url, reason=error.code)
        read_page = _read_response(result.url, page, focus, body.max_passages_per_page, body.part_chars)
        if not read_page.passages:
            return SkippedPage(url=result.url, reason="no_match")
        return ResearchPage(**read_page.model_dump(), result_title=result.title, snippet=result.snippet, date=result.date)

    outcomes = await asyncio.gather(*(read_one(result) for result in results))
    return WebResearchResponse(
        provider=provider,
        pages=[outcome for outcome in outcomes if isinstance(outcome, ResearchPage)],
        skipped=[outcome for outcome in outcomes if isinstance(outcome, SkippedPage)],
    )
