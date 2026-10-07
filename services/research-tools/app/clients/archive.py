"""The Internet Archive's newest good copy of a page, for when a site refuses scripts.

The archive stores the page as the site sent it. The `id_` form of a capture URL returns those original bytes with no
toolbar. Asking for the newest capture is one request that answers with a redirect to a timestamped URL; that capture can
itself be a refusal or a bot-check page the archive recorded, and then the availability API names the closest copy that
was served with a 200.

The archive is a public service run on donations, so every request goes through one gap (at most one a second by default),
carries a User-Agent with a contact, and the caller caches what it gets.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx

from app.clients.fetch import Resolver, check_url, public_address, read_text_body, resolve
from app.config import Settings
from app.errors import ToolError
from app.extract import extract, is_challenge

WAYBACK_HOST = "web.archive.org"
WAYBACK = f"https://{WAYBACK_HOST}"
CAPTURES_PATH = "/web/"  # every request to the archive host stays under this prefix
AVAILABLE_URL = "https://archive.org/wayback/available"
ARCHIVE_DEADLINE_SECONDS = 30.0  # wall clock for the whole lookup, gap waits included; httpx timeouts apply to one read each
MAX_HOPS = 4  # a capture of a redirect points at the capture of its target
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_STAMPED_PATH = re.compile(r"^/web/(\d{14})id_/")
_STAMP = re.compile(r"^\d{14}$")


@dataclass(frozen=True)
class Snapshot:
    timestamp: str  # YYYYMMDDhhmmss, UTC, as the archive writes it
    age_days: int
    html: str
    truncated: bool = False


@dataclass(frozen=True)
class _Capture:
    status: int
    timestamp: str | None
    html: str = ""
    truncated: bool = False


class _Gap:
    """Spaces calls at least `seconds` apart, first come first served.

    There is no lock: nothing awaits between taking a slot and writing the next one, so callers on one event loop cannot
    interleave there, and nothing here is bound to a loop (tests start a new loop per test).
    """

    def __init__(self) -> None:
        self._next_slot = 0.0

    async def wait(self, seconds: float) -> None:
        now = time.monotonic()
        slot = max(now, self._next_slot)
        self._next_slot = slot + seconds
        if slot > now:
            await asyncio.sleep(slot - now)


_gap = _Gap()


def age_days(timestamp: str) -> int:
    """Whole days since an archive timestamp, never negative."""
    captured = datetime.strptime(timestamp, "%Y%m%d%H%M%S").replace(tzinfo=UTC)
    return max(0, (datetime.now(UTC) - captured).days)


def _valid_stamp(text: object) -> bool:
    if not isinstance(text, str) or not _STAMP.match(text):
        return False
    try:
        datetime.strptime(text, "%Y%m%d%H%M%S")
    except ValueError:
        return False
    return True


def _unavailable(reason: str) -> ToolError:
    return ToolError("archive_unavailable", 502, f"The Internet Archive did not give a usable answer ({reason}).")


def _stamp_of(url: httpx.URL) -> str | None:
    """The capture time in a capture URL on the archive's host; None for any other URL."""
    found = _STAMPED_PATH.match(url.path) if url.host == WAYBACK_HOST else None
    return found.group(1) if found and _valid_stamp(found.group(1)) else None


async def _capture(http: httpx.AsyncClient, settings: Settings, target: str, *, probe: bool) -> _Capture:
    """GET a capture URL, following the archive's own redirects (and only those). `probe` marks the newest-capture lookup,
    where a 404 means the page was never archived."""
    stamp = None
    for _ in range(MAX_HOPS):
        await _gap.wait(settings.archive_gap_seconds)
        try:
            wanted = httpx.URL(target)  # httpx removes dot segments here, so this is the path the archive would be asked for
            if not wanted.path.startswith(CAPTURES_PATH):
                raise _unavailable("the request would leave the archive's captures")
            stamp = stamp or _stamp_of(wanted)  # a URL that names its capture time, as the second pass does
            async with http.stream("GET", target, headers={"User-Agent": settings.user_agent, "Accept-Encoding": "gzip"}, follow_redirects=False) as response:
                location = response.headers.get("location")
                if response.status_code in _REDIRECT_STATUSES and location:
                    joined = response.url.join(location)
                    stamp = _stamp_of(joined)
                    if stamp is None:
                        raise _unavailable("it redirected away from its own captures")
                    target = f"{WAYBACK}{joined.raw_path.decode('ascii')}"  # https, our host, the path it named
                    probe = False
                    continue
                if response.status_code == 404 and probe:
                    raise ToolError("not_archived", 404, "The Internet Archive has no copy of this page.")
                if response.status_code != 200:
                    return _Capture(response.status_code, stamp)
                if stamp is None:
                    raise _unavailable("it sent a page with no capture time")
                html, truncated = await read_text_body(response)
                return _Capture(200, stamp, html, truncated)
        except (httpx.HTTPError, httpx.InvalidURL) as error:
            raise _unavailable(type(error).__name__) from None
    raise _unavailable("too many redirects")


async def _is_refusal(capture: _Capture) -> bool:
    """A capture of something the site refused to serve: a 4xx (not the archive's own 429), a bot-check page, or a page with no text."""
    if 400 <= capture.status < 500 and capture.status != 429:
        return True
    return capture.status == 200 and (is_challenge(capture.html) or not (await asyncio.to_thread(extract, capture.html)).text.strip())


async def _closest_good_stamp(http: httpx.AsyncClient, settings: Settings, url: str) -> str:
    """The timestamp of the archive's closest capture that was served with a 200."""
    await _gap.wait(settings.archive_gap_seconds)
    try:
        response = await http.get(AVAILABLE_URL, params={"url": url}, headers={"User-Agent": settings.user_agent}, follow_redirects=False)
    except httpx.HTTPError as error:
        raise _unavailable(type(error).__name__) from None
    if response.status_code != 200:
        raise _unavailable(f"HTTP {response.status_code}")
    try:
        closest = response.json()["archived_snapshots"].get("closest")
        if not closest:
            raise ToolError("not_archived", 404, "The Internet Archive has no copy of this page.")
        if closest.get("available") is True and str(closest.get("status")) == "200" and _valid_stamp(closest.get("timestamp")):
            return closest["timestamp"]
    except (ValueError, KeyError, TypeError, AttributeError):
        raise _unavailable("malformed answer") from None
    raise ToolError("not_archived", 404, "The Internet Archive has no usable copy of this page.")


async def fetch_snapshot(http: httpx.AsyncClient, settings: Settings, url: str, *, resolver: Resolver | None = None) -> Snapshot:
    """The page's newest usable capture. Raises not_archived when there is none and archive_unavailable when the archive fails.

    The URL passes the same checks as a fetch from the site: a private address, a port, or credentials are refused before
    anything is sent to a third party. The checked URL is the one embedded, because httpx removes dot segments from the
    request path: pasting a caller's "http://x/../../save/..." would otherwise reach /save/ on the archive.
    """
    target = check_url(url)
    try:
        async with asyncio.timeout(ARCHIVE_DEADLINE_SECONDS):
            return await _snapshot(http, settings, target, resolver or resolve)
    except TimeoutError:
        raise _unavailable(f"it did not answer within {ARCHIVE_DEADLINE_SECONDS:g} seconds") from None


async def _snapshot(http: httpx.AsyncClient, settings: Settings, target: httpx.URL, resolver: Resolver) -> Snapshot:
    try:
        await public_address(target, resolver)
    except OSError:  # a name that does not resolve is not private, and the archive may hold a copy of a site that is gone
        pass
    url = str(target)
    capture = await _capture(http, settings, f"{WAYBACK}/web/2id_/{url}", probe=True)
    if await _is_refusal(capture):
        stamp = await _closest_good_stamp(http, settings, url)
        capture = await _capture(http, settings, f"{WAYBACK}/web/{stamp}id_/{url}", probe=False)
        if await _is_refusal(capture):
            raise ToolError("not_archived", 404, "The Internet Archive's copies of this page are refusals, bot-check pages, or pages with no text.")
    if capture.status != 200 or capture.timestamp is None:
        raise _unavailable(f"HTTP {capture.status}")
    return Snapshot(timestamp=capture.timestamp, age_days=age_days(capture.timestamp), html=capture.html, truncated=capture.truncated)
