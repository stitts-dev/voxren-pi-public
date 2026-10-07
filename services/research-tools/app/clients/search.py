"""Web search through the first configured provider that answers: Brave, then Perplexity, one result shape for both.

A provider that is down, throttled, out of quota, or answers with something unreadable is skipped, so one expired key
does not take search down while another provider has a working one. A caller sees which provider answered.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from app.cache import Cache
from app.config import Settings
from app.errors import ToolError
from app.schemas import WebResult, WebSearchRequest

BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
PERPLEXITY_URL = "https://api.perplexity.ai/search"
CACHE_SECONDS = 24 * 3600
PERPLEXITY_TOKENS_PER_PAGE = 512
_BRAVE_FRESHNESS = {"day": "pd", "week": "pw", "month": "pm", "year": "py"}


class _ProviderFailed(Exception):
    """`reason` is a status or a word, never a response body or a key: it goes into the message a caller reads."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _freshness_step(days: int) -> str:
    """Providers filter by a day, a week, a month, or a year, so `days` rounds up to the next step."""
    return "day" if days <= 1 else "week" if days <= 7 else "month" if days <= 31 else "year"


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _result(title: object, url: object, snippet: str, date: object) -> WebResult | None:
    """None for a row with no usable title or web address, so one bad row does not spoil the rest."""
    if not (isinstance(title, str) and isinstance(url, str) and url.startswith(("http://", "https://"))):
        return None
    return WebResult(title=title, url=url, snippet=snippet, date=_text(date))


async def _call(http: httpx.AsyncClient, method: str, url: str, **kwargs: Any) -> Any:
    """One provider request returned as parsed JSON; every failure becomes a _ProviderFailed with a safe reason."""
    try:
        response = await http.request(method, url, **kwargs)
    except httpx.TimeoutException:
        raise _ProviderFailed("timeout") from None
    except httpx.HTTPError:
        raise _ProviderFailed("unreachable") from None
    if not response.is_success:
        raise _ProviderFailed(f"HTTP {response.status_code}")
    try:
        return response.json()
    except ValueError:
        raise _ProviderFailed("malformed response") from None


def _brave_query(request: WebSearchRequest) -> str:
    sites = [f"site:{domain}" for domain in request.domains]
    if not sites:
        return request.query
    return f"{sites[0]} {request.query}" if len(sites) == 1 else f"({' OR '.join(sites)}) {request.query}"


async def _brave(http: httpx.AsyncClient, key: str, request: WebSearchRequest) -> list[WebResult]:
    params: dict[str, str | int] = {"q": _brave_query(request), "count": request.max_results, "extra_snippets": "true", "text_decorations": "false"}
    if request.freshness_days:
        params["freshness"] = _BRAVE_FRESHNESS[_freshness_step(request.freshness_days)]
    data = await _call(http, "GET", BRAVE_URL, params=params, headers={"X-Subscription-Token": key, "Accept": "application/json"})
    try:
        rows = (data.get("web") or {}).get("results") or []
        results = [
            _result(row.get("title"), row.get("url"), " ".join(part for part in [row.get("description"), *(row.get("extra_snippets") or [])] if _text(part)), row.get("page_age") or row.get("age"))
            for row in rows
        ]
    except (AttributeError, TypeError):
        raise _ProviderFailed("malformed response") from None
    return [result for result in results if result]


async def _perplexity(http: httpx.AsyncClient, key: str, request: WebSearchRequest) -> list[WebResult]:
    body: dict[str, Any] = {"query": request.query, "max_results": request.max_results, "max_tokens_per_page": PERPLEXITY_TOKENS_PER_PAGE}
    if request.domains:
        body["search_domain_filter"] = request.domains
    if request.freshness_days:
        body["search_recency_filter"] = _freshness_step(request.freshness_days)
    data = await _call(http, "POST", PERPLEXITY_URL, json=body, headers={"Authorization": f"Bearer {key}"})
    try:
        results = [_result(row.get("title"), row.get("url"), _text(row.get("snippet")) or "", row.get("date") or row.get("last_updated")) for row in data.get("results") or []]
    except (AttributeError, TypeError):
        raise _ProviderFailed("malformed response") from None
    return [result for result in results if result]


async def web_search(http: httpx.AsyncClient, settings: Settings, request: WebSearchRequest, *, cache: Cache | None = None) -> tuple[str, list[WebResult]]:
    """The provider that answered and its results. A search is kept 24 hours, whichever provider answered it."""
    key = json.dumps(request.model_dump(), sort_keys=True)
    if cache is not None:
        hit = cache.get("search", key, CACHE_SECONDS)
        try:
            if hit:
                return hit["provider"], [WebResult(**row) for row in hit["results"]]
        except (KeyError, TypeError, ValueError):
            pass  # a stored search this version cannot read is a miss
    providers = settings.search_providers
    if not providers:
        raise ToolError("search_unconfigured", 503, "Web search needs a provider key: set BRAVE_API_KEY or PERPLEXITY_API_KEY on the service.")
    keys = {"brave": settings.brave_api_key, "perplexity": settings.perplexity_api_key}
    failures: list[str] = []
    for name in providers:
        search = _brave if name == "brave" else _perplexity
        try:
            results = await search(http, keys[name].get_secret_value(), request)  # search_providers lists only names that have a key
            if not results:
                raise _ProviderFailed("no results")
        except _ProviderFailed as failed:
            failures.append(f"{name} {failed.reason}")
            continue
        results = results[: request.max_results]
        if cache is not None:
            cache.set("search", key, {"provider": name, "results": [result.model_dump() for result in results]})
        return name, results
    raise ToolError("search_unavailable", 502, f"No search provider answered: {', '.join(failures)}.")
