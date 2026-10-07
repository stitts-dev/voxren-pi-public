"""The web routes through HTTP with every upstream faked: search providers and their fall-through, reading a page from the site or the Internet Archive, the cache, page text extraction, and research across several pages."""

from __future__ import annotations

import asyncio
import gzip
import ipaddress
import os
import re
import socket
import time
from datetime import UTC, datetime, timedelta
from functools import partial

import httpx
import pytest
from conftest import AUTH, Wire, public_dns, wired

from app.api.web import _cache_key, get_fetch_page, get_resolver
from app.cache import Cache
from app.clients import archive as archive_module
from app.clients.fetch import fetch_page, resolve
from app.config import get_settings
from app.errors import ToolError
from app.extract import extract
from app.main import app, get_http

HTML = {"content-type": "text/html; charset=utf-8"}
BRAVE_HOST, PERPLEXITY_HOST = "api.search.brave.com", "api.perplexity.ai"
CHALLENGE = "<html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing the site.</p></body></html>"
GUIDE = "https://guide.example/ahri"


def page(title: str, *paragraphs: str) -> str:
    return f"<html><head><title>{title}</title></head><body>" + "".join(f"<p>{paragraph}</p>" for paragraph in paragraphs) + "</body></html>"


def long_paragraph(lead: str) -> str:
    """`lead` (one sentence) padded just past 300 characters, so with part_chars=300 every paragraph is exactly one part."""
    text, n = lead, 0
    while len(text) < 300:
        text += f" Filler sentence {n} keeps this part long enough."
        n += 1
    return text


def stamp(days_ago: int) -> str:
    """An archive timestamp `days_ago` days and an hour back, so the age in whole days is exactly `days_ago`."""
    return (datetime.now(UTC) - timedelta(days=days_ago, hours=1)).strftime("%Y%m%d%H%M%S")


def age_cache(tmp_path, namespace: str, hours: float) -> None:
    """Make every stored entry in a cache namespace look `hours` old."""
    then = time.time() - hours * 3600
    for entry in (tmp_path / "cache" / namespace).iterdir():
        os.utime(entry, (then, then))


# --- fakes ------------------------------------------------------------------------------------------------------------


@pytest.fixture
def set_keys(monkeypatch):
    def apply(**keys: str) -> None:
        for provider, key in keys.items():
            monkeypatch.setenv(f"{provider.upper()}_API_KEY", key)
        get_settings.cache_clear()

    return apply


@pytest.fixture
def origin():
    """Fake every page fetch from a site: pass a handler, get the requests it was given.

    The real guard still runs on every request and every redirect; only DNS and the network are faked. A request's
    site is in its Host header, because the guard connects to the address it checked.
    """

    def install(handler):
        seen: list[httpx.Request] = []

        def record(request: httpx.Request):
            seen.append(request)
            return handler(request)

        app.dependency_overrides[get_fetch_page] = lambda: partial(fetch_page, transport=httpx.MockTransport(wired(record)), resolver=public_dns)
        if get_http not in app.dependency_overrides:  # a test that does not install an archive or a provider must not reach one

            def unexpected(request: httpx.Request):
                raise AssertionError(f"unexpected request to {request.url}")

            fake = httpx.AsyncClient(transport=httpx.MockTransport(unexpected))
            app.dependency_overrides[get_http] = lambda: fake
        return seen

    return install


def site(pages: dict[str, httpx.Response]):
    """An origin handler: the response for each Host + path, 404 for the rest."""

    def handle(request: httpx.Request) -> httpx.Response:
        return pages.get(request.headers["host"] + request.url.path, httpx.Response(404, headers=HTML, text="not here"))

    return handle


def ok_page(*paragraphs: str, title: str = "A page") -> httpx.Response:
    return httpx.Response(200, headers=HTML, text=page(title, *paragraphs))


class FakeArchive:
    """The Internet Archive as it was verified on 2026-10-01.

    `GET /web/2id_/<url>` answers 302 to the newest capture or 404 when there is none. A capture is served at
    /web/<timestamp>id_/<url>. The availability API names the closest capture served with a 200, or {}.
    """

    def __init__(self) -> None:
        self.newest: dict[str, str] = {}
        self.copies: dict[tuple[str, str], tuple[int, str, dict]] = {}
        self.closest: dict[str, dict] = {}

    def add(self, url: str, timestamp: str, html: str = "", *, status: int = 200, headers: dict | None = None, newest: bool = True) -> None:
        self.copies[(url, timestamp)] = (status, html, headers or HTML)
        if newest:
            self.newest[url] = timestamp

    def offer(self, url: str, timestamp: str) -> None:
        self.closest[url] = {"status": "200", "available": True, "url": f"http://web.archive.org/web/{timestamp}/{url}", "timestamp": timestamp}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "archive.org" and request.url.path == "/wayback/available":
            closest = self.closest.get(request.url.params["url"])
            return httpx.Response(200, json={"archived_snapshots": {"closest": closest} if closest else {}})
        assert request.url.host == "web.archive.org", request.url
        found = re.match(r"^/web/(\d+)id_/(.+)$", request.url.raw_path.decode())
        assert found, request.url
        stamp_, target = found.groups()
        if stamp_ == "2":
            if target not in self.newest:
                return httpx.Response(404, text="Not Found")
            return httpx.Response(302, headers={"location": f"https://web.archive.org/web/{self.newest[target]}id_/{target}"})
        if (target, stamp_) not in self.copies:
            return httpx.Response(404, text="Not Found")
        status, html, headers = self.copies[(target, stamp_)]
        return httpx.Response(status, headers=headers, text=html)


def by_host(handlers: dict[str, object]):
    def handle(request: httpx.Request) -> httpx.Response:
        handler = handlers.get(request.url.host)
        assert handler is not None, f"unexpected request to {request.url.host}"
        return handler(request)  # type: ignore[operator]

    return handle


def brave_rows(*rows: dict) -> httpx.Response:
    return httpx.Response(200, json={"web": {"results": list(rows)}})


def perplexity_rows(*rows: dict) -> httpx.Response:
    return httpx.Response(200, json={"results": list(rows)})


def timeout(request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("too slow", request=request)


async def post(client, path: str, **body):
    return await client.post(path, json=body, headers=AUTH)


# --- search -----------------------------------------------------------------------------------------------------------


async def test_brave_gets_the_documented_request_and_its_rows_become_results(client, upstream, set_keys):
    set_keys(brave="brave-key-1")
    seen = upstream(
        lambda request: brave_rows(
            {"title": "Ahri charm", "url": "https://a.example/charm", "description": "Charm roots.", "extra_snippets": ["It lasts 1.5 s.", "It costs mana."], "page_age": "2026-09-01T08:00:00"},
            {"title": "Older", "url": "https://b.example/old", "description": "Plain.", "age": "3 weeks ago"},
            {"title": "No description", "url": "https://c.example/"},
            {"title": "No address"},
        )
    )
    response = await post(client, "/web/search", query="ahri charm", domains=["a.example", "b.example"], max_results=5, freshness_days=7)
    assert response.status_code == 200
    assert response.json() == {
        "provider": "brave",
        "results": [
            {"title": "Ahri charm", "url": "https://a.example/charm", "snippet": "Charm roots. It lasts 1.5 s. It costs mana.", "date": "2026-09-01T08:00:00"},
            {"title": "Older", "url": "https://b.example/old", "snippet": "Plain.", "date": "3 weeks ago"},
            {"title": "No description", "url": "https://c.example/", "snippet": "", "date": None},
        ],
    }
    (request,) = seen
    assert (request.method, request.url.host, request.url.path) == ("GET", BRAVE_HOST, "/res/v1/web/search")
    assert request.headers["x-subscription-token"] == "brave-key-1"
    assert request.headers["accept"] == "application/json"
    assert dict(request.url.params) == {"q": "(site:a.example OR site:b.example) ahri charm", "count": "5", "extra_snippets": "true", "text_decorations": "false", "freshness": "pw"}


async def test_brave_one_domain_is_a_plain_site_filter_and_no_freshness_sends_none(client, upstream, set_keys):
    set_keys(brave="brave-key-1")
    seen = upstream(lambda request: brave_rows({"title": "T", "url": "https://a.example/", "description": "d"}))
    await post(client, "/web/search", query="ahri charm", domains=["a.example"])
    assert dict(seen[0].url.params) == {"q": "site:a.example ahri charm", "count": "8", "extra_snippets": "true", "text_decorations": "false"}
    await post(client, "/web/search", query="ahri charm")
    assert seen[1].url.params["q"] == "ahri charm"


@pytest.mark.parametrize(("days", "step"), [(1, "pd"), (2, "pw"), (7, "pw"), (8, "pm"), (31, "pm"), (32, "py"), (365, "py")])
async def test_brave_freshness_rounds_up_to_a_day_week_month_or_year(client, upstream, set_keys, days, step):
    set_keys(brave="brave-key-1")
    seen = upstream(lambda request: brave_rows({"title": "T", "url": "https://a.example/", "description": "d"}))
    await post(client, "/web/search", query="ahri charm", freshness_days=days)
    assert seen[0].url.params["freshness"] == step


async def test_perplexity_gets_the_documented_request_and_its_rows_become_results(client, upstream, set_keys):
    set_keys(perplexity="pplx-key-1")
    seen = upstream(
        lambda request: perplexity_rows(
            {"title": "Ahri charm", "url": "https://a.example/charm", "snippet": "Charm roots.", "date": "2026-09-01"},
            {"title": "Updated", "url": "https://b.example/", "snippet": "Plain.", "date": None, "last_updated": "2026-08-01"},
            {"title": "Bare", "url": "https://c.example/", "snippet": None},
        )
    )
    response = await post(client, "/web/search", query="ahri charm", domains=["a.example"], max_results=3, freshness_days=30)
    assert response.status_code == 200
    assert response.json() == {
        "provider": "perplexity",
        "results": [
            {"title": "Ahri charm", "url": "https://a.example/charm", "snippet": "Charm roots.", "date": "2026-09-01"},
            {"title": "Updated", "url": "https://b.example/", "snippet": "Plain.", "date": "2026-08-01"},
            {"title": "Bare", "url": "https://c.example/", "snippet": "", "date": None},
        ],
    }
    (request,) = seen
    assert (request.method, request.url.host, request.url.path) == ("POST", PERPLEXITY_HOST, "/search")
    assert request.headers["authorization"] == "Bearer pplx-key-1"
    assert request.headers["content-type"] == "application/json"
    assert httpx.Response(200, content=request.content).json() == {
        "query": "ahri charm",
        "max_results": 3,
        "max_tokens_per_page": 512,
        "search_domain_filter": ["a.example"],
        "search_recency_filter": "month",
    }


async def test_perplexity_sends_no_filters_that_were_not_asked_for(client, upstream, set_keys):
    set_keys(perplexity="pplx-key-1")
    seen = upstream(lambda request: perplexity_rows({"title": "T", "url": "https://a.example/", "snippet": "s"}))
    await post(client, "/web/search", query="ahri charm")
    assert httpx.Response(200, content=seen[0].content).json() == {"query": "ahri charm", "max_results": 8, "max_tokens_per_page": 512}


@pytest.mark.parametrize(("days", "step"), [(1, "day"), (7, "week"), (8, "month"), (31, "month"), (365, "year")])
async def test_perplexity_recency_rounds_up_to_a_day_week_month_or_year(client, upstream, set_keys, days, step):
    set_keys(perplexity="pplx-key-1")
    seen = upstream(lambda request: perplexity_rows({"title": "T", "url": "https://a.example/", "snippet": "s"}))
    await post(client, "/web/search", query="ahri charm", freshness_days=days)
    assert httpx.Response(200, content=seen[0].content).json()["search_recency_filter"] == step


@pytest.mark.parametrize("name", ["BRAVE_API_KEY", "RESEARCH_TOOLS_BRAVE_API_KEY"])
async def test_a_key_is_read_from_the_plain_or_the_prefixed_name(client, upstream, monkeypatch, name):
    monkeypatch.setenv(name, "brave-key-2")
    get_settings.cache_clear()
    seen = upstream(lambda request: brave_rows({"title": "T", "url": "https://a.example/", "description": "d"}))
    assert (await post(client, "/web/search", query="ahri charm")).status_code == 200
    assert seen[0].headers["x-subscription-token"] == "brave-key-2"


FAILURES = {
    "401": lambda request: httpx.Response(401, json={"error": "bad key"}),
    "403": lambda request: httpx.Response(403, text="forbidden"),
    "429": lambda request: httpx.Response(429, headers={"retry-after": "30"}, text="quota"),
    "500": lambda request: httpx.Response(500, text="oops"),
    "503": lambda request: httpx.Response(503, text="busy"),
    "timeout": timeout,
    "not json": lambda request: httpx.Response(200, text="<html>not json</html>"),
    "wrong shape": lambda request: httpx.Response(200, json=["a", "list"]),
    "rows that are not objects": lambda request: httpx.Response(200, json={"web": {"results": ["x", 3]}}),
    "zero results": lambda request: brave_rows(),
    "no usable rows": lambda request: brave_rows({"title": "No address"}),
    "no web section": lambda request: httpx.Response(200, json={}),
}


@pytest.mark.parametrize("failure", FAILURES, ids=list(FAILURES))
async def test_search_falls_through_to_the_next_provider_on_every_kind_of_failure(client, upstream, set_keys, failure):
    set_keys(brave="brave-key-1", perplexity="pplx-key-1")
    seen = upstream(by_host({BRAVE_HOST: FAILURES[failure], PERPLEXITY_HOST: lambda request: perplexity_rows({"title": "T", "url": "https://a.example/", "snippet": "s"})}))
    response = await post(client, "/web/search", query="ahri charm")
    assert response.status_code == 200
    assert response.json()["provider"] == "perplexity"
    assert [request.url.host for request in seen] == [BRAVE_HOST, PERPLEXITY_HOST]


async def test_the_first_provider_that_answers_ends_the_search(client, upstream, set_keys):
    set_keys(brave="brave-key-1", perplexity="pplx-key-1")
    seen = upstream(by_host({BRAVE_HOST: lambda request: brave_rows({"title": "T", "url": "https://a.example/", "description": "d"})}))
    assert (await post(client, "/web/search", query="ahri charm")).json()["provider"] == "brave"
    assert [request.url.host for request in seen] == [BRAVE_HOST]


async def test_perplexity_alone_falls_back_to_nothing_and_reports_it(client, upstream, set_keys):
    set_keys(perplexity="pplx-key-1")
    seen = upstream(lambda request: httpx.Response(402, json={"error": "quota exceeded for pplx-key-1"}))
    response = await post(client, "/web/search", query="ahri charm")
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "search_unavailable"
    assert response.json()["detail"]["message"] == "No search provider answered: perplexity HTTP 402."
    assert len(seen) == 1


async def test_when_every_provider_fails_the_message_lists_each_and_never_a_key(client, upstream, set_keys):
    set_keys(brave="brave-secret-123", perplexity="pplx-secret-456")
    upstream(
        by_host(
            {
                BRAVE_HOST: lambda request: httpx.Response(429, json={"error": "key brave-secret-123 is over quota"}),
                PERPLEXITY_HOST: timeout,
            }
        )
    )
    response = await post(client, "/web/search", query="ahri charm")
    assert response.status_code == 502
    detail = response.json()["detail"]
    assert detail["code"] == "search_unavailable"
    assert detail["message"] == "No search provider answered: brave HTTP 429, perplexity timeout."
    assert "secret" not in response.text


async def test_search_without_a_key_says_which_variables_to_set(client, upstream):
    seen = upstream(lambda request: httpx.Response(500))
    response = await post(client, "/web/search", query="ahri charm")
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["code"] == "search_unconfigured"
    assert "BRAVE_API_KEY" in detail["message"] and "PERPLEXITY_API_KEY" in detail["message"]
    assert seen == []


async def test_a_search_is_kept_for_a_day_whichever_provider_answered(client, upstream, set_keys, tmp_path):
    set_keys(brave="brave-key-1", perplexity="pplx-key-1")
    seen = upstream(by_host({BRAVE_HOST: lambda request: httpx.Response(429), PERPLEXITY_HOST: lambda request: perplexity_rows({"title": "T", "url": "https://a.example/", "snippet": "s"})}))
    first = await post(client, "/web/search", query="ahri charm")
    assert len(seen) == 2
    again = await post(client, "/web/search", query="ahri charm")
    assert again.json() == first.json()
    assert again.json()["provider"] == "perplexity"
    assert len(seen) == 2  # no provider was asked, not even the one that failed

    await post(client, "/web/search", query="ahri charm", max_results=3)
    assert len(seen) == 4  # a different request is a different search

    age_cache(tmp_path, "search", 23)
    await post(client, "/web/search", query="ahri charm")
    assert len(seen) == 4
    age_cache(tmp_path, "search", 25)
    await post(client, "/web/search", query="ahri charm")
    assert len(seen) == 6


async def test_a_failed_search_is_not_kept(client, upstream, set_keys):
    set_keys(brave="brave-key-1")
    seen = upstream(lambda request: httpx.Response(500))
    assert (await post(client, "/web/search", query="ahri charm")).status_code == 502
    assert (await post(client, "/web/search", query="ahri charm")).status_code == 502
    assert len(seen) == 2


@pytest.mark.parametrize(
    "body",
    [
        {"query": "ab"},
        {"query": "x" * 301},
        {"query": "ahri charm", "domains": ["a.example/path"]},
        {"query": "ahri charm", "domains": ["a b.example"]},
        {"query": "ahri charm", "domains": [f"d{n}.example" for n in range(11)]},
        {"query": "ahri charm", "max_results": 0},
        {"query": "ahri charm", "max_results": 21},
        {"query": "ahri charm", "freshness_days": 0},
        {"query": "ahri charm", "freshness_days": 366},
        {"query": "ahri charm", "colour": "red"},
    ],
)
async def test_search_rejects_a_malformed_request(client, upstream, set_keys, body):
    set_keys(brave="brave-key-1")
    seen = upstream(lambda request: httpx.Response(500))
    response = await client.post("/web/search", json=body, headers=AUTH)
    assert response.status_code == 422
    assert seen == []


# --- read -------------------------------------------------------------------------------------------------------------


async def test_read_cuts_the_page_into_parts_and_ranks_them_against_the_query(client, upstream, origin):
    paragraphs = [long_paragraph(lead) for lead in ("Intro to the lane.", "Ahri charm roots a champion who steps forward.", "Farm under tower early.", "Back at level six.")]
    origin(site({"guide.example/ahri": ok_page(*paragraphs, title="Ahri guide")}))
    response = await post(client, "/web/read", url=GUIDE, query="ahri charm", max_passages=2, part_chars=300)
    assert response.status_code == 200
    body = response.json()
    assert (body["url"], body["source"], body["title"], body["cached"], body["truncated"]) == (GUIDE, "origin", "Ahri guide", False, False)
    assert (body["snapshot_timestamp"], body["snapshot_age_days"]) == (None, None)
    assert body["parts"] == 4  # the whole page, not just the passages returned
    assert body["chars"] > 1200
    assert len(body["passages"]) == 1  # only one part holds a query word
    top = body["passages"][0]
    assert "charm roots a champion" in top["text"]
    assert top["id"] == "p2" and top["url"] == GUIDE and top["at"] == 0 and top["score"] > 0


async def test_read_without_a_query_returns_the_first_parts_in_order(client, upstream, origin):
    origin(site({"guide.example/ahri": ok_page(*[long_paragraph(f"Part {n} starts here.") for n in range(5)])}))
    body = (await post(client, "/web/read", url=GUIDE, max_passages=3, part_chars=300)).json()
    assert [passage["id"] for passage in body["passages"]] == ["p1", "p2", "p3"]
    assert [passage["text"].startswith(f"Part {n} starts") for n, passage in enumerate(body["passages"])] == [True, True, True]
    assert all(passage["score"] is None and passage["url"] == GUIDE for passage in body["passages"])
    assert body["parts"] == 5


async def test_read_cuts_a_page_longer_than_the_cap_and_says_so(client, upstream, origin, monkeypatch):
    monkeypatch.setattr("app.clients.fetch.MAX_BYTES", 3000)
    origin(site({"guide.example/ahri": ok_page(*[f"Sentence number {n} is a unique line of the page." for n in range(400)])}))
    body = (await post(client, "/web/read", url=GUIDE, max_passages=1)).json()
    assert body["truncated"] is True
    assert body["chars"] < 3000


EXTRACTION_FIXTURE = """<!doctype html><html><head><title>Ahri Guide &amp; Notes</title>
<style>.ad { display: none }</style><script>trackEverything('analytics-beacon')</script></head>
<body>
<header>Site banner and login links</header>
<nav><a href="/">Home</a> <a href="/builds">Builds menu</a></nav>
<h1>Ahri guide</h1>
<p>Charm is her best tool for picking off a champion who steps out of position.</p>
<table><tr><th>Skill</th><th>Cooldown</th></tr><tr><td>Charm</td><td>12 seconds</td></tr><tr><td>Orb</td><td>7 seconds</td></tr></table>
<div>This long related-guides block repeats near the top and again near the bottom of the page.</div>
<p>Spirit Rush gives three dashes, so keep one back for an escape.</p>
<div>This long related-guides block repeats near the top and again near the bottom of the page.</div>
<p>Next</p><p>Next</p>
<form action="/comment"><label>Leave a comment</label><button>Sign in to post</button></form>
<aside>Advertisement for a keyboard</aside>
<footer>Copyright footer and privacy links</footer>
</body></html>"""


async def test_read_keeps_content_and_table_text_and_drops_menus_scripts_and_repeats(client, upstream, origin):
    origin(site({"guide.example/ahri": httpx.Response(200, headers=HTML, text=EXTRACTION_FIXTURE)}))
    body = (await post(client, "/web/read", url=GUIDE, max_passages=10)).json()
    text = " ".join(passage["text"] for passage in body["passages"])
    assert body["title"] == "Ahri Guide & Notes"
    assert "Charm is her best tool" in text and "Spirit Rush gives three dashes" in text
    assert "Skill Cooldown" in text and "Charm 12 seconds" in text and "Orb 7 seconds" in text  # cells stay apart when the markup has no whitespace
    assert text.count("related-guides block repeats") == 1
    assert text.count("Next") == 2  # a short line may repeat
    for dropped in ("trackEverything", "analytics-beacon", "display: none", "Site banner", "Home", "Builds menu", "Leave a comment", "Sign in to post", "Advertisement", "Copyright footer"):
        assert dropped not in text, dropped


@pytest.mark.parametrize("status", [401, 403, 429, 451, 503])
async def test_read_falls_back_to_the_archive_when_the_site_refuses_scripts(client, upstream, origin, status):
    seen_origin = origin(lambda request: httpx.Response(status, headers=HTML, text="denied"))
    archive = FakeArchive()
    captured = stamp(100)
    archive.add(GUIDE, captured, page("Ahri guide (archived)", long_paragraph("Ahri charm roots a champion.")))
    seen_archive = upstream(archive)
    response = await post(client, "/web/read", url=GUIDE, query="ahri charm")
    assert response.status_code == 200
    body = response.json()
    assert (body["source"], body["snapshot_timestamp"], body["snapshot_age_days"], body["title"]) == ("archive", captured, 100, "Ahri guide (archived)")
    assert "charm roots a champion" in body["passages"][0]["text"]
    assert body["passages"][0]["url"] == GUIDE
    assert len(seen_origin) == 1  # the site was asked once and not pressed
    assert [str(request.url) for request in seen_archive] == [f"https://web.archive.org/web/2id_/{GUIDE}", f"https://web.archive.org/web/{captured}id_/{GUIDE}"]
    assert all(get_settings().contact in request.headers["user-agent"] for request in seen_archive)


async def test_read_falls_back_to_the_archive_when_the_site_serves_a_challenge_page(client, upstream, origin):
    origin(lambda request: httpx.Response(200, headers=HTML, text=CHALLENGE))
    archive = FakeArchive()
    archive.add(GUIDE, stamp(10), page("Real title", "The real content of the page."))
    upstream(archive)
    body = (await post(client, "/web/read", url=GUIDE)).json()
    assert body["source"] == "archive"
    assert body["title"] == "Real title"
    assert body["snapshot_age_days"] == 10
    assert "Just a moment" not in " ".join(passage["text"] for passage in body["passages"])


@pytest.mark.parametrize("status", [400, 404, 410, 500, 502])
async def test_read_does_not_use_the_archive_when_the_site_is_merely_broken(client, upstream, origin, status):
    origin(lambda request: httpx.Response(status, headers=HTML, text="broken"))
    seen_archive = upstream(FakeArchive())
    response = await post(client, "/web/read", url=GUIDE)
    assert (response.status_code, response.json()["detail"]["code"]) == (502, "fetch_failed")
    assert seen_archive == []


async def test_read_with_archive_never_reports_the_refusal_and_does_not_ask_the_archive(client, upstream, origin):
    origin(lambda request: httpx.Response(403, headers=HTML, text="denied"))
    seen_archive = upstream(FakeArchive())
    response = await post(client, "/web/read", url=GUIDE, archive="never")
    assert (response.status_code, response.json()["detail"]["code"]) == (502, "fetch_refused")
    assert "403" in response.json()["detail"]["message"]
    assert seen_archive == []


@pytest.mark.parametrize(
    "html",
    [
        "<select><option>A<option>B</select><p>The real text.</p>",  # option's end tag is optional
        "<head><title>T</title><meta charset=utf-8><body><p>The real text.</p>",  # so is head's
        "<nav>Menu</span></nav><footer></footer></footer><p>The real text.</p>",  # a stray end tag must not push below zero and eat the next skip
    ],
    ids=["option", "head", "stray-end"],
)
def test_an_omitted_end_tag_does_not_drop_the_rest_of_the_page(html):
    assert extract(html).text == "The real text."


async def test_read_of_a_host_name_that_cannot_be_encoded_is_url_blocked(client, upstream):
    upstream(lambda request: httpx.Response(404))
    app.dependency_overrides[get_resolver] = lambda: resolve  # the real resolver: the bad name fails in getaddrinfo itself
    response = await post(client, "/web/read", url=f"https://{'a' * 64}.example/")
    assert (response.status_code, response.json()["detail"]["code"]) == (422, "url_blocked")


@pytest.mark.parametrize(
    ("status", "html"),
    [(202, ""), (200, "<html><head><title>Checking</title><script>challenge()</script></head><body><script>run()</script></body></html>")],
    ids=["202 empty body", "200 script only"],
)
async def test_read_falls_back_to_the_archive_when_the_site_serves_a_page_with_no_text(client, upstream, origin, tmp_path, status, html):
    origin(lambda request: httpx.Response(status, headers=HTML, text=html))
    archive = FakeArchive()
    archive.add(GUIDE, stamp(10), page("Real title", "The real content of the page."))
    upstream(archive)
    body = (await post(client, "/web/read", url=GUIDE)).json()
    assert (body["source"], body["title"]) == ("archive", "Real title")
    assert Cache(tmp_path / "cache").get("pages", _cache_key(GUIDE, "origin")) is None


async def test_read_with_archive_never_treats_a_challenge_page_as_a_refusal(client, upstream, origin):
    origin(lambda request: httpx.Response(200, headers=HTML, text=CHALLENGE))
    seen_archive = upstream(FakeArchive())
    response = await post(client, "/web/read", url=GUIDE, archive="never")
    assert (response.status_code, response.json()["detail"]["code"]) == (502, "fetch_refused")
    assert seen_archive == []


async def test_read_with_archive_only_never_touches_the_site(client, upstream, origin):
    seen_origin = origin(lambda request: ok_page("The live page."))
    archive = FakeArchive()
    archive.add(GUIDE, stamp(40), page("Archived", "The archived page."))
    upstream(archive)
    body = (await post(client, "/web/read", url=GUIDE, archive="only")).json()
    assert (body["source"], body["snapshot_age_days"]) == ("archive", 40)
    assert "archived page" in body["passages"][0]["text"]
    assert seen_origin == []


@pytest.mark.parametrize(("status", "html"), [(403, "Forbidden"), (200, CHALLENGE), (404, "Not found")], ids=["captured 403", "captured challenge", "captured 404"])
async def test_a_newest_capture_that_is_a_refusal_sends_it_to_the_availability_api(client, upstream, origin, status, html):
    origin(lambda request: httpx.Response(403, headers=HTML, text="denied"))
    archive = FakeArchive()
    newest, good = stamp(2), stamp(60)
    archive.add(GUIDE, newest, html, status=status)
    archive.add(GUIDE, good, page("Good copy", "The good copy of the page."), newest=False)
    archive.offer(GUIDE, good)
    seen = upstream(archive)
    body = (await post(client, "/web/read", url=GUIDE)).json()
    assert (body["source"], body["snapshot_timestamp"], body["snapshot_age_days"]) == ("archive", good, 60)
    assert "good copy" in body["passages"][0]["text"]
    assert [(request.url.host, request.url.path) for request in seen] == [
        ("web.archive.org", f"/web/2id_/{GUIDE}"),
        ("web.archive.org", f"/web/{newest}id_/{GUIDE}"),
        ("archive.org", "/wayback/available"),
        ("web.archive.org", f"/web/{good}id_/{GUIDE}"),
    ]
    assert seen[2].url.params["url"] == GUIDE


async def test_when_only_refusals_are_archived_the_page_is_not_archived(client, upstream, origin):
    origin(lambda request: httpx.Response(403, headers=HTML, text="denied"))
    archive = FakeArchive()
    archive.add(GUIDE, stamp(2), CHALLENGE)
    upstream(archive)  # the availability API has nothing
    response = await post(client, "/web/read", url=GUIDE)
    assert (response.status_code, response.json()["detail"]["code"]) == (404, "not_archived")


async def test_a_page_the_archive_never_saw_is_not_archived_after_one_request(client, upstream):
    seen = upstream(FakeArchive())
    response = await post(client, "/web/read", url=GUIDE, archive="only")
    assert (response.status_code, response.json()["detail"]["code"]) == (404, "not_archived")
    assert len(seen) == 1


async def test_a_refused_page_the_archive_never_saw_reports_both(client, upstream, origin):
    origin(lambda request: httpx.Response(403, headers=HTML, text="denied"))
    upstream(FakeArchive())
    response = await post(client, "/web/read", url=GUIDE)
    assert (response.status_code, response.json()["detail"]["code"]) == (404, "not_archived")
    assert "refused" in response.json()["detail"]["message"] and "no copy" in response.json()["detail"]["message"]


@pytest.mark.parametrize(
    "handler",
    [
        lambda request: httpx.Response(503, text="overloaded"),
        lambda request: httpx.Response(429, text="slow down"),
        timeout,
        lambda request: httpx.Response(302, headers={"location": "https://evil.example/web/20200101000000id_/x"}),
        lambda request: httpx.Response(302, headers={"location": "https://web.archive.org/somewhere/else"}),
        lambda request: httpx.Response(200, headers=HTML, text="<p>no capture time on this one</p>"),
    ],
    ids=["503", "429", "timeout", "redirect off the archive", "redirect off its captures", "no capture time"],
)
async def test_an_archive_that_fails_is_reported_as_unavailable_and_never_followed_elsewhere(client, upstream, handler):
    seen = upstream(handler)
    response = await post(client, "/web/read", url=GUIDE, archive="only")
    assert (response.status_code, response.json()["detail"]["code"]) == (502, "archive_unavailable")
    assert all(request.url.host == "web.archive.org" for request in seen)


async def test_a_malformed_availability_answer_is_unavailable_not_a_crash(client, upstream):
    archive = FakeArchive()
    archive.add(GUIDE, stamp(2), "forbidden", status=403)

    def handler(request):
        if request.url.host == "archive.org":
            return httpx.Response(200, json={"archived_snapshots": ["not", "a", "dict"]})
        return archive(request)

    upstream(handler)
    response = await post(client, "/web/read", url=GUIDE, archive="only")
    assert (response.status_code, response.json()["detail"]["code"]) == (502, "archive_unavailable")


async def test_a_capture_that_is_itself_a_redirect_is_followed_inside_the_archive(client, upstream):
    moved = "https://guide.example/ahri-new"
    first, second = stamp(30), stamp(20)
    archive = FakeArchive()
    archive.add(GUIDE, first, status=301, headers={"location": f"http://web.archive.org/web/{second}id_/{moved}"})
    archive.add(moved, second, page("Moved", "The page at its new address."), newest=False)
    seen = upstream(archive)
    body = (await post(client, "/web/read", url=GUIDE, archive="only")).json()
    assert (body["snapshot_timestamp"], body["snapshot_age_days"]) == (second, 20)
    assert "new address" in body["passages"][0]["text"]
    assert all(request.url.scheme == "https" for request in seen)  # an http Location is upgraded, never followed as http


async def test_a_url_with_credentials_is_not_sent_to_the_archive(client, upstream):
    seen = upstream(FakeArchive())
    response = await post(client, "/web/read", url="https://user:secret@guide.example/ahri", archive="only")
    assert (response.status_code, response.json()["detail"]["code"]) == (422, "url_blocked")
    assert seen == []


async def test_a_url_with_dot_segments_cannot_climb_out_of_the_archives_captures(client, upstream):
    """httpx removes dot segments from a request path, so a URL pasted raw into /web/2id_/<url> could reach /save/ on the archive."""
    crafted = "http://x.example/../../../../../../save/http://victim.example/"
    checked = "http://x.example/save/http://victim.example/"  # what httpx makes of it, and what is embedded
    archive = FakeArchive()
    newest, good = stamp(2), stamp(30)
    archive.add(checked, newest, "Forbidden", status=403)
    archive.add(checked, good, page("Good copy", "The good copy of the page."), newest=False)
    archive.offer(checked, good)
    seen = upstream(archive)
    response = await post(client, "/web/read", url=crafted, archive="only")
    assert response.status_code == 200
    assert response.json()["url"] == crafted  # the caller gets back what it sent
    assert [(request.url.host, request.url.path) for request in seen] == [
        ("web.archive.org", f"/web/2id_/{checked}"),
        ("web.archive.org", f"/web/{newest}id_/{checked}"),
        ("archive.org", "/wayback/available"),
        ("web.archive.org", f"/web/{good}id_/{checked}"),
    ]
    assert seen[2].url.params["url"] == checked
    assert all(request.url.path.startswith("/web/") for request in seen if request.url.host == "web.archive.org")


@pytest.mark.parametrize(
    "target",
    ["https://web.archive.org/web/2id_/http://x.example/../../../../../../save/http://victim.example/", "https://web.archive.org/save/http://victim.example/", "https://web.archive.org/"],
)
async def test_the_archive_client_sends_nothing_outside_its_captures(target):
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(record)) as http:
        with pytest.raises(ToolError) as caught:
            await archive_module._capture(http, get_settings(), target, probe=True)
    assert caught.value.code == "archive_unavailable"
    assert seen == []


@pytest.mark.parametrize("url", ["http://10.0.0.5/", "http://169.254.169.254/latest/meta-data/?token=abc", "http://intranet.test/wiki?token=abc", "http://mixed.test/"])
async def test_archive_only_does_not_send_a_private_or_internal_host_to_the_archive(client, upstream, url):
    """With archive "only" the site is never asked, so nothing else would have judged the address before the archive got it."""

    async def dns(host: str, port: int) -> list:
        private = {"intranet.test": ["10.1.2.3"], "mixed.test": ["93.184.216.34", "192.168.0.9"]}
        return [ipaddress.ip_address(address) for address in private[host]] if host in private else await public_dns(host, port)

    app.dependency_overrides[get_resolver] = lambda: dns
    seen = upstream(FakeArchive())
    response = await post(client, "/web/read", url=url, archive="only")
    assert (response.status_code, response.json()["detail"]["code"]) == (422, "url_blocked")
    assert seen == []


async def test_archive_only_still_reads_a_copy_of_a_site_that_no_longer_resolves(client, upstream):
    """A name nobody resolves is not private. A site that is gone is what the archive is for."""

    async def gone(host: str, port: int) -> list:
        raise socket.gaierror("no such host")

    app.dependency_overrides[get_resolver] = lambda: gone
    archive = FakeArchive()
    archive.add(GUIDE, stamp(300), page("Gone", "The page of a site that is gone."))
    seen = upstream(archive)
    response = await post(client, "/web/read", url=GUIDE, archive="only")
    assert response.status_code == 200
    assert len(seen) == 2  # the lookup and the capture


SCRIPT_ONLY = "<html><head><title>x</title></head><body><script>var a=1</script></body></html>"


async def test_an_archive_capture_with_no_text_sends_it_to_the_availability_api(client, upstream, tmp_path):
    archive = FakeArchive()
    newest, good = stamp(2), stamp(60)
    archive.add(GUIDE, newest, SCRIPT_ONLY)
    archive.add(GUIDE, good, page("Good copy", "The good copy of the page."), newest=False)
    archive.offer(GUIDE, good)
    upstream(archive)
    body = (await post(client, "/web/read", url=GUIDE, archive="only")).json()
    assert (body["snapshot_timestamp"], body["chars"]) == (good, len("The good copy of the page."))
    assert Cache(tmp_path / "cache").get("pages", _cache_key(GUIDE, "archive")) is not None


async def test_when_every_archive_capture_has_no_text_the_page_is_not_archived_and_nothing_is_kept(client, upstream, tmp_path):
    archive = FakeArchive()
    archive.add(GUIDE, stamp(2), SCRIPT_ONLY)
    upstream(archive)  # the availability API has nothing
    response = await post(client, "/web/read", url=GUIDE, archive="only")
    assert (response.status_code, response.json()["detail"]["code"]) == (404, "not_archived")
    assert not (tmp_path / "cache" / "pages").exists()


CAPTURED = "20240101000000"


def archive_serving(capture: httpx.Response):
    """The archive: the newest-capture lookup redirects to a capture at CAPTURED, and that capture is `capture`."""

    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/web/2id_/"):
            return httpx.Response(302, headers={"location": f"https://web.archive.org/web/{CAPTURED}id_/{GUIDE}"})
        return capture

    return handle


class Drip(httpx.AsyncByteStream):
    """A body that sends one byte every 0.2 s, so no single read ever times out."""

    async def __aiter__(self):
        for _ in range(30):
            await asyncio.sleep(0.2)
            yield b"x"

    async def aclose(self) -> None:
        pass


async def test_an_archive_that_drips_its_capture_is_cut_off_at_the_deadline(client, upstream, monkeypatch):
    monkeypatch.setattr(archive_module, "ARCHIVE_DEADLINE_SECONDS", 0.3)
    upstream(archive_serving(httpx.Response(200, headers=HTML, stream=Drip())))
    started = time.monotonic()
    response = await post(client, "/web/read", url=GUIDE, archive="only")
    assert time.monotonic() - started < 1
    assert (response.status_code, response.json()["detail"]["code"]) == (502, "archive_unavailable")
    assert "within 0.3 seconds" in response.json()["detail"]["message"]


async def test_the_archive_deadline_counts_the_gap_waits(client, upstream, monkeypatch):
    monkeypatch.setattr(archive_module, "ARCHIVE_DEADLINE_SECONDS", 0.3)
    monkeypatch.setenv("RESEARCH_TOOLS_ARCHIVE_GAP_SECONDS", "5")
    get_settings.cache_clear()
    archive_module._gap._next_slot = time.monotonic() + 5  # the archive was just asked: the next request must wait
    upstream(archive_serving(ok_page("never read")))
    started = time.monotonic()
    response = await post(client, "/web/read", url=GUIDE, archive="only")
    assert time.monotonic() - started < 1
    assert (response.status_code, response.json()["detail"]["code"]) == (502, "archive_unavailable")
    archive_module._gap._next_slot = 0.0


async def test_an_archive_capture_is_bounded_the_same_way_as_a_page_from_the_site(client, upstream, monkeypatch):
    monkeypatch.setattr("app.clients.fetch.MAX_BYTES", 3000)
    bomb = gzip.compress(page("Bomb", *[f"Sentence number {n} is a unique line of the page." for n in range(4000)]).encode())
    seen = upstream(archive_serving(httpx.Response(200, headers={**HTML, "content-encoding": "gzip"}, stream=Wire([bomb[start : start + 2048] for start in range(0, len(bomb), 2048)]))))
    body = (await post(client, "/web/read", url=GUIDE, archive="only", max_passages=1)).json()
    assert body["truncated"] is True
    assert body["chars"] < 3000
    assert [request.headers["accept-encoding"] for request in seen] == ["gzip", "gzip"]  # both requests to the capture ask for gzip only


async def test_an_archive_capture_with_stacked_encodings_is_refused(client, upstream):
    nested = gzip.compress(gzip.compress(b"<p>" + b"a" * 100_000 + b"</p>"))
    upstream(archive_serving(httpx.Response(200, headers={**HTML, "content-encoding": "gzip, gzip"}, stream=Wire([nested]))))
    response = await post(client, "/web/read", url=GUIDE, archive="only")
    assert (response.status_code, response.json()["detail"]["code"]) == (415, "unsupported_content")


@pytest.mark.parametrize("archive", ["fallback", "never", "only"])
@pytest.mark.parametrize("url", ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:80/admin", "http://[::1]/", "http://2130706433/", "https://guide.example:8443/x", "http://user:pw@guide.example/"])
async def test_read_refuses_a_private_or_odd_target_and_does_not_fall_back_to_the_archive(client, upstream, origin, url, archive):
    seen_origin = origin(lambda request: ok_page("secret"))
    seen_archive = upstream(FakeArchive())
    response = await post(client, "/web/read", url=url, archive=archive)
    assert (response.status_code, response.json()["detail"]["code"]) == (422, "url_blocked")
    assert seen_origin == [] and seen_archive == []


@pytest.mark.parametrize("url", ["ftp://guide.example/ahri", "file:///etc/passwd", "javascript:alert(1)", "guide.example/ahri", "https://" + "a" * 2000 + ".example/"])
async def test_read_rejects_what_is_not_an_http_url_in_the_request_itself(client, upstream, origin, url):
    seen = origin(lambda request: ok_page("x"))
    response = await post(client, "/web/read", url=url)
    assert response.status_code == 422
    assert seen == []


async def test_read_accepts_an_upper_case_scheme(client, upstream, origin):
    seen = origin(site({"guide.example/ahri": ok_page("The live page.")}))
    response = await post(client, "/web/read", url="HTTPS://guide.example/ahri")
    assert response.status_code == 200
    assert len(seen) == 1


async def test_read_rejects_a_bad_request_shape(client, upstream, origin):
    origin(lambda request: ok_page("x"))
    for body in ({"url": GUIDE, "archive": "sometimes"}, {"url": GUIDE, "max_passages": 0}, {"url": GUIDE, "max_passages": 101}, {"url": GUIDE, "part_chars": 299}, {"url": GUIDE, "part_chars": 4001}, {"url": GUIDE, "query": "x" * 301}, {"url": GUIDE, "extra": 1}):
        assert (await client.post("/web/read", json=body, headers=AUTH)).status_code == 422, body


async def test_a_pdf_is_not_read(client, upstream, origin):
    origin(lambda request: httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF-1.7"))
    response = await post(client, "/web/read", url="https://guide.example/file.pdf")
    assert (response.status_code, response.json()["detail"]["code"]) == (415, "unsupported_content")


# --- the page cache ---------------------------------------------------------------------------------------------------


async def test_a_second_read_costs_no_upstream_call_and_any_query_is_served_from_the_same_page(client, upstream, origin):
    seen_origin = origin(lambda request: ok_page(long_paragraph("Ahri charm roots."), long_paragraph("Spirit Rush dashes.")))
    seen_archive = upstream(FakeArchive())
    first = (await post(client, "/web/read", url=GUIDE, query="ahri charm", part_chars=300)).json()
    assert first["cached"] is False
    second = (await post(client, "/web/read", url=GUIDE, query="spirit rush", part_chars=300)).json()
    assert second["cached"] is True
    assert "Spirit Rush" in second["passages"][0]["text"]  # ranked afresh against the new query
    assert (len(seen_origin), len(seen_archive)) == (1, 0)


async def test_an_archive_copy_is_kept_and_a_repeat_read_does_not_ask_the_site_again(client, upstream, origin):
    seen_origin = origin(lambda request: httpx.Response(403, headers=HTML, text="denied"))
    archive = FakeArchive()
    captured = stamp(45)
    archive.add(GUIDE, captured, page("Archived", "The archived page."))
    seen_archive = upstream(archive)
    first = (await post(client, "/web/read", url=GUIDE)).json()
    requests_made = (len(seen_origin), len(seen_archive))
    assert requests_made == (1, 2)
    second = (await post(client, "/web/read", url=GUIDE)).json()
    assert (len(seen_origin), len(seen_archive)) == requests_made
    assert second["cached"] is True and first["cached"] is False
    assert (second["source"], second["snapshot_timestamp"], second["snapshot_age_days"]) == ("archive", captured, 45)
    assert second["passages"] == first["passages"]


async def test_the_site_and_the_archive_are_cached_apart(client, upstream, origin):
    seen_origin = origin(lambda request: ok_page("The live page."))
    archive = FakeArchive()
    archive.add(GUIDE, stamp(5), page("Archived", "The archived page."))
    seen_archive = upstream(archive)
    assert (await post(client, "/web/read", url=GUIDE, archive="never")).json()["source"] == "origin"
    assert (await post(client, "/web/read", url=GUIDE, archive="only")).json()["source"] == "archive"
    assert (await post(client, "/web/read", url=GUIDE, archive="never")).json()["cached"] is True
    assert (await post(client, "/web/read", url=GUIDE, archive="only")).json()["cached"] is True
    assert (len(seen_origin), len(seen_archive)) == (1, 2)


async def test_a_site_copy_is_kept_a_day_and_an_archive_copy_a_week(client, upstream, origin, tmp_path):
    seen_origin = origin(lambda request: ok_page("The live page."))
    await post(client, "/web/read", url=GUIDE, archive="never")
    age_cache(tmp_path, "pages", 23)
    await post(client, "/web/read", url=GUIDE, archive="never")
    assert len(seen_origin) == 1
    age_cache(tmp_path, "pages", 25)
    await post(client, "/web/read", url=GUIDE, archive="never")
    assert len(seen_origin) == 2

    archive = FakeArchive()
    archive.add("https://guide.example/other", stamp(5), page("Archived", "The archived page."))
    seen_archive = upstream(archive)
    other = "https://guide.example/other"
    await post(client, "/web/read", url=other, archive="only")
    assert len(seen_archive) == 2
    for entry in (tmp_path / "cache" / "pages").iterdir():
        if "archived page" in entry.read_text():
            then = time.time() - 6 * 24 * 3600
            os.utime(entry, (then, then))
    await post(client, "/web/read", url=other, archive="only")
    assert len(seen_archive) == 2  # six days old: still kept
    for entry in (tmp_path / "cache" / "pages").iterdir():
        if "archived page" in entry.read_text():
            then = time.time() - 8 * 24 * 3600
            os.utime(entry, (then, then))
    await post(client, "/web/read", url=other, archive="only")
    assert len(seen_archive) == 4  # eight days old: fetched again


async def test_a_refusal_is_not_cached(client, upstream, origin):
    seen = origin(lambda request: httpx.Response(403, headers=HTML, text="denied"))
    upstream(FakeArchive())
    for _ in range(2):
        assert (await post(client, "/web/read", url=GUIDE, archive="never")).status_code == 502
    assert len(seen) == 2


async def test_archive_requests_are_spaced_by_the_configured_gap(client, upstream, monkeypatch):
    """Reset the shared gap for this test, so what it learned from other tests cannot add waiting here."""
    monkeypatch.setenv("RESEARCH_TOOLS_ARCHIVE_GAP_SECONDS", "0.2")
    get_settings.cache_clear()
    monkeypatch.setattr(archive_module, "_gap", archive_module._Gap())
    archive = FakeArchive()
    other = "https://guide.example/other"
    for url in (GUIDE, other):
        archive.add(url, stamp(5), page("Archived", "The archived page."))
    times: list[float] = []

    def timed(request):
        times.append(time.monotonic())
        return archive(request)

    upstream(timed)
    await asyncio.gather(post(client, "/web/read", url=GUIDE, archive="only"), post(client, "/web/read", url=other, archive="only"))
    assert len(times) == 4
    times.sort()
    gaps = [later - earlier for earlier, later in zip(times, times[1:], strict=False)]
    assert min(gaps) >= 0.15, gaps  # the gap is 0.2; the margin covers a coarse timer on Windows


# --- research ---------------------------------------------------------------------------------------------------------


def results(*urls: str) -> httpx.Response:
    return brave_rows(*[{"title": f"Result {n}", "url": url, "description": f"About result {n}.", "page_age": f"2026-09-0{n + 1}"} for n, url in enumerate(urls)])


async def test_research_reads_the_top_results_and_ranks_each_page_against_the_focus(client, upstream, origin, set_keys):
    set_keys(brave="brave-key-1")
    seen_search = upstream(lambda request: results("https://a.example/guide", "https://b.example/guide"))
    seen_origin = origin(
        site(
            {
                "a.example/guide": ok_page(long_paragraph("Ahri overview and lane plan."), long_paragraph("Her mana cost is high early, so buy a Tear."), long_paragraph("Ahri charm and spirit rush combos."), title="Page A"),
                "b.example/guide": ok_page(long_paragraph("Another take on the mana cost of her abilities."), title="Page B"),
            }
        )
    )
    response = await post(client, "/web/research", query="ahri guide", focus="mana cost", max_results=2, max_passages_per_page=2, part_chars=300)
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "brave" and body["skipped"] == []
    assert [page_["url"] for page_ in body["pages"]] == ["https://a.example/guide", "https://b.example/guide"]
    first = body["pages"][0]
    assert (first["result_title"], first["snippet"], first["date"], first["title"], first["source"]) == ("Result 0", "About result 0.", "2026-09-01", "Page A", "origin")
    assert first["parts"] == 3
    assert len(first["passages"]) == 1 and "mana cost" in first["passages"][0]["text"]  # ranked by the focus, not by "ahri guide"
    assert first["passages"][0]["url"] == "https://a.example/guide"
    assert seen_search[0].url.params["q"] == "ahri guide"  # the search used the query
    assert len(seen_origin) == 2


async def test_research_ranks_against_the_query_when_there_is_no_focus(client, upstream, origin, set_keys):
    set_keys(brave="brave-key-1")
    upstream(lambda request: results("https://a.example/guide"))
    origin(site({"a.example/guide": ok_page(long_paragraph("Unrelated opening."), long_paragraph("The ahri guide proper."))}))
    body = (await post(client, "/web/research", query="ahri guide", part_chars=300)).json()
    assert "ahri guide proper" in body["pages"][0]["passages"][0]["text"]


async def test_research_says_why_each_page_was_skipped(client, upstream, origin, set_keys):
    set_keys(brave="brave-key-1")
    urls = ["https://good.example/g", "https://off-topic.example/g", "https://refuses.example/g", "https://broken.example/g", "http://127.0.0.1/admin", "https://file.example/g.pdf", "https://nowhere.example/g"]
    upstream(lambda request: results(*urls))
    origin(
        site(
            {
                "good.example/g": ok_page("Ahri charm roots a champion."),
                "off-topic.example/g": ok_page("A page about something else entirely."),
                "refuses.example/g": httpx.Response(403, headers=HTML, text="denied"),
                "broken.example/g": httpx.Response(500, headers=HTML, text="oops"),
                "file.example/g.pdf": httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF"),
            }
        )
    )
    response = await post(client, "/web/research", query="ahri charm", archive="never", max_results=7)
    assert response.status_code == 200
    body = response.json()
    assert [page_["url"] for page_ in body["pages"]] == ["https://good.example/g"]
    assert body["skipped"] == [
        {"url": "https://off-topic.example/g", "reason": "no_match"},
        {"url": "https://refuses.example/g", "reason": "fetch_refused"},
        {"url": "https://broken.example/g", "reason": "fetch_failed"},
        {"url": "http://127.0.0.1/admin", "reason": "url_blocked"},  # a search result is untrusted input
        {"url": "https://file.example/g.pdf", "reason": "unsupported_content"},
        {"url": "https://nowhere.example/g", "reason": "fetch_failed"},  # the fake site answers 404
    ]


async def test_research_reads_a_refused_page_from_the_archive_and_reports_a_page_it_does_not_have(client, upstream, origin, set_keys):
    set_keys(brave="brave-key-1")
    refused, missing = "https://refuses.example/g", "https://missing.example/g"
    archive = FakeArchive()
    archive.add(refused, stamp(90), page("Archived", "Ahri charm roots a champion."))
    search = results(refused, missing)
    upstream(by_host({BRAVE_HOST: lambda request: search, "web.archive.org": archive, "archive.org": archive}))
    origin(lambda request: httpx.Response(403, headers=HTML, text="denied"))
    body = (await post(client, "/web/research", query="ahri charm")).json()
    assert [(page_["url"], page_["source"], page_["snapshot_age_days"]) for page_ in body["pages"]] == [(refused, "archive", 90)]
    assert body["skipped"] == [{"url": missing, "reason": "not_archived"}]


async def test_research_reads_at_most_three_pages_at_a_time(client, upstream, origin, set_keys):
    set_keys(brave="brave-key-1")
    urls = [f"https://site{n}.example/g" for n in range(7)]
    upstream(lambda request: results(*urls))
    active = peak = 0

    async def slow(request: httpx.Request) -> httpx.Response:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.05)
        active -= 1
        return ok_page("Ahri charm roots a champion.")

    seen = origin(slow)
    body = (await post(client, "/web/research", query="ahri charm", max_results=7)).json()
    assert len(body["pages"]) == 7 and len(seen) == 7
    assert peak == 3


async def test_research_reads_only_max_results_pages_and_keeps_the_search_order(client, upstream, origin, set_keys):
    set_keys(brave="brave-key-1")
    upstream(lambda request: results(*[f"https://site{n}.example/g" for n in range(6)]))
    seen = origin(lambda request: ok_page("Ahri charm roots a champion."))
    body = (await post(client, "/web/research", query="ahri charm", max_results=3)).json()
    assert [page_["result_title"] for page_ in body["pages"]] == ["Result 0", "Result 1", "Result 2"]
    assert [request.headers["host"] for request in seen] == ["site0.example", "site1.example", "site2.example"]


async def test_research_passes_the_search_filters_through(client, upstream, origin, set_keys):
    set_keys(brave="brave-key-1")
    seen = upstream(lambda request: results("https://a.example/g"))
    origin(lambda request: ok_page("Ahri charm roots a champion."))
    await post(client, "/web/research", query="ahri charm", domains=["a.example"], freshness_days=30, max_results=2)
    assert dict(seen[0].url.params) == {"q": "site:a.example ahri charm", "count": "2", "extra_snippets": "true", "text_decorations": "false", "freshness": "pm"}


async def test_research_search_failures_are_the_routes_own_error(client, upstream, origin, set_keys):
    seen_origin = origin(lambda request: ok_page("x"))
    response = await post(client, "/web/research", query="ahri charm")
    assert (response.status_code, response.json()["detail"]["code"]) == (503, "search_unconfigured")
    set_keys(brave="brave-key-1")
    upstream(lambda request: httpx.Response(500))
    response = await post(client, "/web/research", query="ahri charm")
    assert (response.status_code, response.json()["detail"]["code"]) == (502, "search_unavailable")
    assert seen_origin == []


async def test_research_with_no_results_is_an_empty_answer_not_an_error(client, upstream, origin, set_keys):
    set_keys(brave="brave-key-1", perplexity="pplx-key-1")
    upstream(by_host({BRAVE_HOST: lambda request: brave_rows(), PERPLEXITY_HOST: lambda request: perplexity_rows({"title": "T", "url": "https://a.example/g", "snippet": "s"})}))
    origin(lambda request: ok_page("Ahri charm roots a champion."))
    body = (await post(client, "/web/research", query="ahri charm")).json()
    assert body["provider"] == "perplexity"
    assert len(body["pages"]) == 1


async def test_a_second_research_call_reads_nothing_new(client, upstream, origin, set_keys):
    set_keys(brave="brave-key-1")
    seen_search = upstream(lambda request: results("https://a.example/g", "https://b.example/g"))
    seen_origin = origin(lambda request: ok_page("Ahri charm roots a champion."))
    first = (await post(client, "/web/research", query="ahri charm")).json()
    second = (await post(client, "/web/research", query="ahri charm")).json()
    assert (len(seen_search), len(seen_origin)) == (1, 2)
    assert [page_["cached"] for page_ in first["pages"]] == [False, False]
    assert [page_["cached"] for page_ in second["pages"]] == [True, True]


@pytest.mark.parametrize(
    ("path", "body"),
    [("/web/search", {"query": "ahri charm"}), ("/web/read", {"url": GUIDE}), ("/web/research", {"query": "ahri charm"})],
)
async def test_every_web_route_needs_the_token(client, upstream, origin, set_keys, path, body):
    set_keys(brave="brave-key-1")
    seen_origin = origin(lambda request: ok_page("x"))
    seen = upstream(lambda request: results("https://a.example/g"))
    for headers in ({}, {"Authorization": "Bearer wrong"}):
        response = await client.post(path, json=body, headers=headers)
        assert (response.status_code, response.json()["detail"]["code"]) == (401, "auth_invalid")
    assert seen == [] and seen_origin == []


# --- live: not run in CI. `uv run pytest -m integration` ---------------------------------------------------------------


@pytest.fixture
async def live(monkeypatch):
    """The real network: a real client for providers and the archive, the real guard and DNS for pages, the archive's one-a-second gap."""
    monkeypatch.setenv("RESEARCH_TOOLS_ARCHIVE_GAP_SECONDS", "1")
    get_settings.cache_clear()
    app.dependency_overrides.pop(get_resolver)  # the archive path checks a host with real DNS too
    async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0), headers={"User-Agent": get_settings().user_agent}) as http:
        app.dependency_overrides[get_http] = lambda: http
        yield


@pytest.mark.integration
async def test_live_a_page_that_allows_scripts_is_read_from_the_site(client, live):
    response = await post(client, "/web/read", url="https://example.com/", query="example domain")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["source"] == "origin"
    assert "Example Domain" in body["title"]
    assert body["passages"]


@pytest.mark.integration
async def test_live_a_page_is_read_from_the_archive_when_asked(client, live):
    """A guide site that has refused script fetches. Whether it refuses today depends on the site and the network, so
    the archive path is asked for directly with archive="only"; with "fallback" the site's own answer decides."""
    url = "https://www.mobafire.com/league-of-legends/build/s15-challenger-fizz-guide-all-matchups-items-explained-609527"
    response = await post(client, "/web/read", url=url, query="Ahri charm", archive="only")
    assert response.status_code == 200, response.text
    body = response.json()
    print("snapshot_timestamp", body["snapshot_timestamp"], "age_days", body["snapshot_age_days"])
    print("top passage", body["passages"][0]["text"][:150])
    assert body["source"] == "archive"
    assert re.fullmatch(r"\d{14}", body["snapshot_timestamp"]) and body["snapshot_age_days"] >= 0
    assert "Ahri" in body["passages"][0]["text"]
