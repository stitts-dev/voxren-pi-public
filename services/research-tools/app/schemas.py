"""The wire contract: every request and response model. A change here is a change to openapi.json."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class Request(BaseModel):
    """Requests refuse unknown fields, so a misspelled option fails instead of being ignored."""

    model_config = ConfigDict(extra="forbid")


class PassageOut(BaseModel):
    id: str = Field(description="Stable within one document: p1, p2, ... in document order")
    text: str
    at: int = Field(default=0, description="Start second in a video; 0 in a page")
    url: str | None = Field(default=None, description="Link to this spot: a video link with a start time, or the page")
    score: float | None = Field(default=None, description="BM25 score against the query; null when no query was given")


# --- YouTube ---------------------------------------------------------------------------------------------------------

VIDEO_ID_PATTERN = r"^[A-Za-z0-9_-]{11}$"
TranscriptSource = Literal["captions", "gemini"]


class VideoOut(BaseModel):
    id: str
    title: str
    channel: str
    seconds: int | None = Field(description="Length; null for a live stream or premiere")
    published: str = Field(description='YouTube\'s own relative age, e.g. "3 months ago"; empty when absent')
    age_months: float | None = Field(description="`published` as months, rounded down the way YouTube does (\"1 year ago\" is 12, though the video may be up to 24 months old); null when YouTube gave no age")
    url: str


class YoutubeSearchRequest(Request):
    query: str = Field(min_length=3, max_length=200)
    max_results: int = Field(default=10, ge=1, le=25)
    max_age_months: float | None = Field(default=None, gt=0, description="Drop videos that may be older than this, and videos with no age. YouTube rounds ages down, so the oldest a video can be is its age plus one unit: \"1 year ago\" counts as 24 months")
    min_seconds: int | None = Field(default=None, ge=0)
    max_seconds: int | None = Field(default=None, ge=1)
    title_terms: list[str] = Field(default_factory=list, max_length=6, description="Every term must be in the title, compared without case, spaces, or punctuation")


class YoutubeSearchResponse(BaseModel):
    videos: list[VideoOut]


class TranscriptRequest(Request):
    video_id: str = Field(pattern=VIDEO_ID_PATTERN)
    query: str | None = Field(default=None, max_length=300, description="Rank the parts against this and return the best `max_passages`. Omit for every part in order.")
    max_passages: int = Field(default=8, ge=1, le=200)
    part_chars: int = Field(default=1200, ge=300, le=4000, description="Target size of one part of the transcript")


class TranscriptResponse(BaseModel):
    video_id: str
    language: str
    generated: bool = Field(description="True when a machine made the transcript (auto captions, or Gemini), which can misspell names")
    source: TranscriptSource = Field(description="captions: YouTube's own caption track. gemini: Gemini read the video and wrote down what is said")
    chars: int = Field(description="Length of the whole transcript")
    parts: int = Field(description="Number of parts the whole transcript was cut into")
    cut_at_seconds: int | None = Field(default=None, description="Set when the video is longer than Gemini's cap: the transcript covers only the first this many seconds")
    cached: bool
    passages: list[PassageOut]


SkipReason = Literal["no_captions", "no_english", "unplayable", "too_short", "no_match", "rate_limited", "po_token_required", "timeout", "error"]


class YoutubeResearchRequest(Request):
    query: str = Field(min_length=3, max_length=200, description="What to search YouTube for")
    focus: str | None = Field(default=None, max_length=300, description="What to rank transcript parts against; defaults to `query`")
    title_terms: list[str] = Field(default_factory=list, max_length=6)
    max_videos: int = Field(default=4, ge=1, le=8)
    max_per_channel: int = Field(default=2, ge=1, le=8)
    max_age_months: float | None = Field(default=12, gt=0, description="Drop videos that may be older than this, and videos with no age. YouTube rounds ages down, so \"1 year ago\" counts as 24 months")
    min_seconds: int = Field(default=180, ge=0)
    max_seconds: int = Field(default=2700, ge=1)
    min_chars: int = Field(default=2500, ge=0, description="Skip a transcript shorter than this: a replay with no commentary")
    max_passages_per_video: int = Field(default=4, ge=1, le=20)
    part_chars: int = Field(default=1200, ge=300, le=4000)
    deadline_seconds: float | None = Field(default=70, gt=0, le=600, description="Answer within this many seconds with the videos done by then: one still being fetched is skipped as timeout (it keeps downloading into the cache, so a retry is served from it), and Gemini gives way to the captions early enough for them to arrive. The default, 70, is below the Voxren coach's own 90 second wait.")


class ResearchVideo(VideoOut):
    language: str
    generated: bool
    source: TranscriptSource
    chars: int
    parts: int
    cut_at_seconds: int | None = Field(default=None, description="Set when the video is longer than Gemini's cap: the transcript covers only the first this many seconds")
    passages: list[PassageOut]


class SkippedVideo(BaseModel):
    id: str
    title: str
    reason: SkipReason


class YoutubeResearchResponse(BaseModel):
    videos: list[ResearchVideo]
    skipped: list[SkippedVideo]
    rate_limited: bool = Field(description="True when YouTube throttled caption downloads; the list is what was fetched before that. Wait before calling again.")


# --- Web -------------------------------------------------------------------------------------------------------------

DOMAIN_PATTERN = r"^[A-Za-z0-9.-]{1,253}$"
Domain = Annotated[str, Field(pattern=DOMAIN_PATTERN)]
ArchiveMode = Literal["fallback", "only", "never"]
_URL_PATTERN = r"^[Hh][Tt][Tt][Pp][Ss]?://"  # no inline flag: openapi.json is read by clients whose regex dialect lacks one


class WebResult(BaseModel):
    title: str
    url: str
    snippet: str = Field(description="What the provider quotes from the page for this query; may be empty")
    date: str | None = Field(description="The provider's own date or age for the page, as it gave it; null when absent")


class WebSearchRequest(Request):
    query: str = Field(min_length=3, max_length=300)
    domains: list[Domain] = Field(default_factory=list, max_length=10, description="Only results from these domains, e.g. example.com")
    max_results: int = Field(default=8, ge=1, le=20)
    freshness_days: int | None = Field(default=None, ge=1, le=365, description="Only pages from about this many days back. Providers filter in steps: a day, a week, a month, a year")


class WebSearchResponse(BaseModel):
    provider: str = Field(description="Which provider answered: brave or perplexity")
    results: list[WebResult]


class WebReadRequest(Request):
    url: str = Field(max_length=2000, pattern=_URL_PATTERN, description="An http or https page. Addresses on a private network are refused")
    query: str | None = Field(default=None, max_length=300, description="Rank the parts against this and return the best `max_passages`. Omit for the first parts in order.")
    max_passages: int = Field(default=6, ge=1, le=100)
    part_chars: int = Field(default=1200, ge=300, le=4000, description="Target size of one part of the page")
    archive: ArchiveMode = Field(
        default="fallback",
        description="fallback: read the site, and read the Internet Archive's copy when the site refuses scripts. only: read the archive's copy. never: read the site only.",
    )


class WebReadResponse(BaseModel):
    url: str = Field(description="The URL that was asked for")
    source: Literal["origin", "archive"] = Field(description="origin: the site itself. archive: the Internet Archive's copy, which can be months old")
    snapshot_timestamp: str | None = Field(description="When the archive captured the copy, YYYYMMDDhhmmss in UTC; null for origin")
    snapshot_age_days: int | None = Field(description="Age of the archive's copy in days; null for origin")
    title: str = Field(description="The page's title; empty when it has none")
    chars: int = Field(description="Length of the whole page's text")
    parts: int = Field(description="Number of parts the whole page was cut into")
    truncated: bool = Field(description="True when the page was longer than the 2 MB the service reads and the end was dropped")
    cached: bool
    passages: list[PassageOut]


class WebResearchRequest(Request):
    query: str = Field(min_length=3, max_length=300, description="What to search the web for")
    focus: str | None = Field(default=None, max_length=300, description="What to rank page parts against; defaults to `query`")
    domains: list[Domain] = Field(default_factory=list, max_length=10)
    max_results: int = Field(default=4, ge=1, le=8, description="How many of the top results to read")
    max_passages_per_page: int = Field(default=3, ge=1, le=20)
    part_chars: int = Field(default=1200, ge=300, le=4000)
    freshness_days: int | None = Field(default=None, ge=1, le=365)
    archive: ArchiveMode = "fallback"


class ResearchPage(WebReadResponse):
    result_title: str = Field(description="The title the search provider gave this result")
    snippet: str
    date: str | None


class SkippedPage(BaseModel):
    url: str
    reason: str = Field(description="The error code the read failed with (fetch_refused, not_archived, ...), or no_match when no part matched the focus")


class WebResearchResponse(BaseModel):
    provider: str
    pages: list[ResearchPage]
    skipped: list[SkippedPage]
