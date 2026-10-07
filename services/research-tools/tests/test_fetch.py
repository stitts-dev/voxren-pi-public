"""The page-fetch guard: what it refuses before connecting, how it follows redirects, what it caps, and how it reports a site that refuses or fails. No test here touches the network."""

from __future__ import annotations

import asyncio
import gzip
import ipaddress
import socket
import tracemalloc
import zlib

import httpx
import pytest
from conftest import Wire, wired

from app.clients import fetch
from app.clients.fetch import MAX_BYTES, MAX_REDIRECTS, fetch_page, resolve
from app.config import get_settings
from app.errors import ToolError

PUBLIC = ipaddress.ip_address("93.184.216.34")
HTML = {"content-type": "text/html; charset=utf-8"}
# What a few names resolve to in these tests. Any other name is a mistake in the test, not a lookup.
DNS = {
    "example.test": [PUBLIC],
    "other.test": [ipaddress.ip_address("93.184.216.35")],
    "localhost": [ipaddress.ip_address("127.0.0.1"), ipaddress.ip_address("::1")],
    "metadata.test": [ipaddress.ip_address("169.254.169.254")],
    "internal.test": [ipaddress.ip_address("10.1.2.3")],
    "mixed.test": [PUBLIC, ipaddress.ip_address("192.168.0.9")],
    "tunnel.test": [ipaddress.ip_address("::ffff:10.0.0.1")],
    "nothing.test": [],
}


async def resolver(host: str, port: int) -> list:
    if host in DNS:
        return DNS[host]
    assert host[0].isdigit() or ":" in host, f"the test would make a real DNS lookup for {host}"
    return await resolve(host, port)  # a number: judged without any lookup


def network(handler):
    """A transport that records every request it is given, and the list it records into."""
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    return httpx.MockTransport(wired(record)), seen


def ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, headers=HTML, text="<title>ok</title><p>fine</p>")


async def attempt(url: str, handler=ok):
    """Fetch `url` against a faked network. Returns what came back (the page, or the ToolError raised) and the requests made."""
    transport, seen = network(handler)
    try:
        outcome = await fetch_page(url, settings=get_settings(), transport=transport, resolver=resolver)
    except ToolError as error:
        outcome = error
    return outcome, seen


async def refused(url: str, handler=ok):
    outcome, seen = await attempt(url, handler)
    assert isinstance(outcome, ToolError), f"{url} was fetched"
    return outcome, seen


BLOCKED = [
    # scheme
    ("file:///etc/passwd", "http and https"),
    ("ftp://example.test/file", "http and https"),
    ("javascript:alert(1)", "http and https"),
    ("gopher://example.test/", "http and https"),
    ("data:text/html,hello", "http and https"),
    ("example.test/no-scheme", "http and https"),
    # credentials
    ("http://user:password@example.test/", "user name"),
    ("http://example.test@other.test/", "user name"),
    # ports
    ("http://example.test:8080/", "Port 8080"),
    ("https://example.test:8443/", "Port 8443"),
    ("http://example.test:22/", "Port 22"),
    ("http://example.test:6379/", "Port 6379"),
    # addresses written as numbers
    ("http://127.0.0.1/", "public address"),
    ("http://10.0.0.1/", "public address"),
    ("http://172.16.0.1/", "public address"),
    ("http://192.168.1.1/", "public address"),
    ("http://169.254.169.254/latest/meta-data/", "public address"),
    ("http://100.64.0.1/", "public address"),  # carrier-grade NAT
    ("http://224.0.0.1/", "public address"),  # multicast
    ("http://0.0.0.0/", "public address"),
    ("http://255.255.255.255/", "public address"),
    ("http://[::1]/", "public address"),
    ("http://[::]/", "public address"),
    ("http://[fe80::1]/", "public address"),  # link-local
    ("http://[fd00::1]/", "public address"),  # unique local
    ("http://[fec0::1]/", "public address"),  # site-local
    ("http://[ff02::1]/", "public address"),  # multicast
    ("http://[::ffff:7f00:1]/", "public address"),  # IPv4-mapped loopback
    ("http://[::ffff:10.0.0.1]/", "public address"),
    ("http://[64:ff9b::7f00:1]/", "public address"),  # NAT64 to loopback
    ("http://[2002:7f00:1::]/", "public address"),  # 6to4 of loopback
    ("http://[::127.0.0.1]/", "public address"),
    # odd ways to write 127.0.0.1
    ("http://2130706433/", "public address"),
    ("http://127.1/", "public address"),
    ("http://0x7f.1/", "public address"),
    ("http://0177.0.0.1/", "not a valid URL"),  # httpx rejects a dotted number with a leading zero
    ("http://017700000001/", "public address"),
    # names that point at a private address
    ("http://localhost/", "public address"),
    ("http://metadata.test/latest/", "public address"),
    ("http://internal.test/", "public address"),
    ("http://tunnel.test/", "public address"),
    ("http://mixed.test/", "public address"),  # one private answer among public ones is enough
    ("http://nothing.test/", "public address"),
]


@pytest.mark.parametrize(("url", "reason"), BLOCKED, ids=[url for url, _ in BLOCKED])
async def test_a_blocked_target_is_refused_before_any_connection(url, reason):
    error, seen = await refused(url)
    assert (error.code, error.status) == ("url_blocked", 422)
    assert reason in error.message
    assert seen == []


@pytest.mark.parametrize("url", ["http://8.8.8.8/", "http://[2606:4700:4700::1111]/", "http://[::ffff:8.8.8.8]/", "https://example.test:443/x", "http://example.test:80/x"])
async def test_public_targets_are_fetched(url):
    page, seen = await attempt(url)
    assert page.status == 200 and page.html.startswith("<title>ok")
    assert len(seen) == 1


async def test_it_connects_to_the_address_it_checked_and_looks_a_name_up_once():
    """The first answer is public and every later one is private. A fetch that looked the name up twice would connect to 127.0.0.1."""
    asked: list[str] = []

    async def rebinding(host: str, port: int) -> list:
        asked.append(host)
        return [PUBLIC if len(asked) == 1 else ipaddress.ip_address("127.0.0.1")]

    transport, seen = network(ok)
    await fetch_page("https://example.test/guide?x=1", settings=get_settings(), transport=transport, resolver=rebinding)
    assert asked == ["example.test"]
    assert len(seen) == 1
    assert str(seen[0].url) == "https://93.184.216.34/guide?x=1"
    assert seen[0].headers["host"] == "example.test"
    assert seen[0].extensions["sni_hostname"] == "example.test"  # the certificate is checked against the name, not the address


async def test_it_identifies_itself_honestly_and_does_not_look_like_a_browser():
    page, seen = await attempt("https://example.test/")
    agent = seen[0].headers["user-agent"]
    assert agent == get_settings().user_agent
    assert get_settings().contact in agent
    assert "mozilla" not in agent.lower()
    assert set(seen[0].headers) <= {"host", "user-agent", "accept", "accept-encoding", "connection"}


async def test_the_client_ignores_proxies_and_never_keeps_a_connection_alive(monkeypatch):
    """Not observable without a socket, so the client's own settings are pinned: a proxy or a pooled connection would skip the address check."""
    built: dict = {}

    class Spy(httpx.AsyncClient):
        def __init__(self, **kwargs):
            built.update(kwargs)
            super().__init__(**kwargs)

    monkeypatch.setattr(fetch.httpx, "AsyncClient", Spy)
    await attempt("https://example.test/")
    assert built["trust_env"] is False
    assert built["follow_redirects"] is False
    assert built["limits"].max_keepalive_connections == 0


async def test_a_redirect_to_a_private_address_is_blocked_and_never_requested():
    def to_loopback(request):
        return httpx.Response(302, headers={"location": "http://127.0.0.1/admin"})

    error, seen = await refused("http://example.test/", to_loopback)
    assert (error.code, error.status) == ("url_blocked", 422)
    assert [request.headers["host"] for request in seen] == ["example.test"]


@pytest.mark.parametrize("location", ["http://internal.test/", "http://[::1]/", "file:///etc/passwd", "http://user:pw@other.test/", "http://other.test:8080/"])
async def test_every_redirect_hop_is_checked_like_the_first_request(location):
    error, seen = await refused("http://example.test/", lambda request: httpx.Response(301, headers={"location": location}))
    assert error.code == "url_blocked"
    assert len(seen) == 1


async def test_redirects_are_followed_with_relative_and_absolute_locations():
    def route(request):
        host, path = request.headers["host"], request.url.path
        if host == "example.test" and path == "/start":
            return httpx.Response(301, headers={"location": "/moved"})
        if host == "example.test" and path == "/moved":
            return httpx.Response(302, headers={"location": "https://other.test/final"})
        return httpx.Response(200, headers=HTML, text="<p>arrived</p>")

    page, seen = await attempt("https://example.test/start", route)
    assert [(request.headers["host"], request.url.path) for request in seen] == [("example.test", "/start"), ("example.test", "/moved"), ("other.test", "/final")]
    assert page.final_url == "https://other.test/final"
    assert page.html == "<p>arrived</p>"


async def test_a_redirect_loop_stops():
    error, seen = await refused("http://example.test/", lambda request: httpx.Response(302, headers={"location": "http://example.test/"}))
    assert (error.code, error.status) == ("fetch_failed", 502)
    assert "redirected" in error.message
    assert len(seen) == MAX_REDIRECTS + 1


async def test_a_redirect_without_a_location_is_a_failure_not_a_page():
    error, seen = await refused("http://example.test/", lambda request: httpx.Response(302))
    assert error.code == "fetch_failed"


async def test_the_decoded_size_cap_truncates_and_a_smaller_page_is_whole():
    big = "<p>" + "a" * (MAX_BYTES + 5000) + "</p>"
    page, _ = await attempt("https://example.test/", lambda request: httpx.Response(200, headers=HTML, text=big))
    assert page.truncated is True
    assert len(page.html) == MAX_BYTES

    page, _ = await attempt("https://example.test/", lambda request: httpx.Response(200, headers=HTML, text="<p>small</p>"))
    assert page.truncated is False
    assert page.html == "<p>small</p>"


def on_the_wire_as(raw: bytes, encoding: str | None, *, chunk_size: int = 4096, headers: dict | None = None) -> tuple[httpx.Response, Wire]:
    """A response whose body is `raw`, cut into chunks as a socket would deliver it, with nothing decoded by httpx."""
    wire = Wire([raw[start : start + chunk_size] for start in range(0, len(raw), chunk_size)])
    return httpx.Response(200, headers={**(headers or HTML), **({"content-encoding": encoding} if encoding else {})}, stream=wire), wire


def layered(data: bytes, layers: int) -> bytes:
    for _ in range(layers):
        data = gzip.compress(data)
    return data


async def test_a_compression_bomb_is_cut_at_the_cap_without_inflating_all_of_it():
    """20 MB inflated from about 20 KB. The cap is applied to every chunk's inflation, so what is held at once stays near the cap."""
    bomb = layered(b"a" * 20_000_000, 1)
    assert len(bomb) < 100_000
    response, wire = on_the_wire_as(bomb, "gzip", chunk_size=16_384)
    tracemalloc.start()
    try:
        page, _ = await attempt("https://example.test/", lambda request: response)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert page.truncated is True
    assert len(page.html) == MAX_BYTES
    assert peak < 4 * MAX_BYTES
    assert wire.read < len(wire.chunks)  # it stopped reading at the cap


@pytest.mark.parametrize("encoding", ["gzip, gzip", "deflate, gzip", "gzip,deflate", "br", "zstd", "compress", "something-new"])
async def test_stacked_or_unknown_content_encodings_are_refused_before_the_body_is_read(encoding):
    """A layer inside a layer is how a 600-byte body becomes hundreds of megabytes. Only none, or one gzip or deflate, is read."""
    response, wire = on_the_wire_as(layered(b"<p>" + b"a" * 1000 + b"</p>", 2), encoding)
    error, seen = await refused("https://example.test/", lambda request: response)
    assert (error.code, error.status) == ("unsupported_content", 415)
    assert wire.read == 0


async def test_a_request_asks_for_gzip_and_nothing_else():
    page, seen = await attempt("https://example.test/")
    assert seen[0].headers["accept-encoding"] == "gzip"


PAGE = "<html><title>caf\xe9</title><p>" + "A sentence that is long enough to compress. " * 500 + "</p></html>"


@pytest.mark.parametrize(
    ("raw", "encoding"),
    [
        (PAGE.encode(), None),
        (PAGE.encode(), "identity"),
        (gzip.compress(PAGE.encode()), "gzip"),
        (gzip.compress(PAGE.encode()), "GZip, identity"),
        (zlib.compress(PAGE.encode()), "deflate"),
    ],
    ids=["plain", "identity", "gzip", "gzip-and-identity", "deflate"],
)
@pytest.mark.parametrize("chunk_size", [7, 4096])
async def test_a_plain_page_and_a_page_with_one_layer_of_compression_are_read_whole(raw, encoding, chunk_size):
    response, _ = on_the_wire_as(raw, encoding, chunk_size=chunk_size)
    page, _ = await attempt("https://example.test/", lambda request: response)
    assert page.html == PAGE
    assert page.truncated is False


@pytest.mark.parametrize("damage", ["cut short", "not gzip"])
async def test_a_corrupt_or_cut_short_compressed_body_is_a_fetch_failure(damage):
    whole = gzip.compress(PAGE.encode())
    raw = whole[: len(whole) // 2] if damage == "cut short" else b"this is not a gzip stream at all"
    response, _ = on_the_wire_as(raw, "gzip")
    error, seen = await refused("https://example.test/", lambda request: response)
    assert (error.code, error.status) == ("fetch_failed", 502)


async def test_an_empty_body_that_claims_to_be_compressed_is_an_empty_page():
    response, _ = on_the_wire_as(b"", "gzip")
    page, _ = await attempt("https://example.test/", lambda request: response)
    assert (page.html, page.truncated) == ("", False)


@pytest.mark.parametrize("content_type", ["application/pdf", "image/png", "application/octet-stream", "application/json", "video/mp4", None])
async def test_only_html_and_plain_text_are_read(content_type):
    headers = {"content-type": content_type} if content_type else {}
    error, seen = await refused("https://example.test/file", lambda request: httpx.Response(200, headers=headers, content=b"%PDF-1.7 binary"))
    assert (error.code, error.status) == ("unsupported_content", 415)


@pytest.mark.parametrize("content_type", ["text/html", "TEXT/HTML; charset=utf-8", "application/xhtml+xml", "text/plain"])
async def test_text_types_are_read(content_type):
    page, _ = await attempt("https://example.test/", lambda request: httpx.Response(200, headers={"content-type": content_type}, text="hello"))
    assert page.html == "hello"


async def test_the_declared_charset_is_used_and_an_unknown_one_does_not_crash():
    latin = "<p>caf\xe9</p>".encode("latin-1")
    page, _ = await attempt("https://example.test/", lambda request: httpx.Response(200, headers={"content-type": "text/html; charset=iso-8859-1"}, content=latin))
    assert page.html == "<p>caf\xe9</p>"
    page, _ = await attempt("https://example.test/", lambda request: httpx.Response(200, headers={"content-type": "text/html; charset=no-such-charset"}, content="<p>caf\xe9</p>".encode()))
    assert page.html == "<p>caf\xe9</p>"


@pytest.mark.parametrize("charset", ["idna", "undefined"])
async def test_a_charset_that_is_a_codec_but_not_for_text_falls_back_to_utf8(charset):
    """Python has codecs under these names, and decoding with them raises UnicodeError even with errors="replace"."""
    page, _ = await attempt("https://example.test/", lambda request: httpx.Response(200, headers={"content-type": f"text/html; charset={charset}"}, content="<p>caf\xe9</p>".encode()))
    assert page.html == "<p>caf\xe9</p>"


@pytest.mark.parametrize("status", [401, 403, 429, 451, 503])
async def test_a_site_that_refuses_scripts_is_a_refusal(status):
    error, seen = await refused("https://example.test/", lambda request: httpx.Response(status, headers=HTML, text="denied"))
    assert (error.code, error.status) == ("fetch_refused", 502)
    assert str(status) in error.message
    assert len(seen) == 1  # asked once, not pressed


@pytest.mark.parametrize("status", [400, 404, 410, 418, 500, 502, 504])
async def test_any_other_error_status_is_a_failure(status):
    error, seen = await refused("https://example.test/", lambda request: httpx.Response(status, headers=HTML, text="nope"))
    assert (error.code, error.status) == ("fetch_failed", 502)
    assert str(status) in error.message


@pytest.mark.parametrize("raised", [httpx.ConnectTimeout("slow"), httpx.ReadTimeout("slow"), httpx.ConnectError("refused"), httpx.RemoteProtocolError("garbled")])
async def test_a_network_failure_or_timeout_is_a_failure(raised):
    def fail(request):
        raise raised

    error, seen = await refused("https://example.test/", fail)
    assert (error.code, error.status) == ("fetch_failed", 502)
    assert type(raised).__name__ in error.message or "within" in error.message


async def test_a_host_that_does_not_resolve_is_a_failure():
    async def nowhere(host: str, port: int) -> list:
        raise socket.gaierror("no such host")

    transport, seen = network(ok)
    with pytest.raises(ToolError) as caught:
        await fetch_page("https://missing.test/", settings=get_settings(), transport=transport, resolver=nowhere)
    assert (caught.value.code, caught.value.status) == ("fetch_failed", 502)
    assert seen == []


@pytest.mark.parametrize("host", ["a" * 64 + ".example", "a..example"], ids=["label too long", "empty label"])
async def test_a_host_name_the_resolver_cannot_encode_is_url_blocked_not_a_crash(host):
    with pytest.raises(ToolError) as caught:
        await resolve(host, 443)  # getaddrinfo raises UnicodeError for these before any lookup
    assert (caught.value.code, caught.value.status) == ("url_blocked", 422)


async def test_the_whole_fetch_has_a_wall_clock_deadline(monkeypatch):
    """A site that answers one byte at a time never trips a per-operation timeout; the total is what stops it."""
    monkeypatch.setattr(fetch, "DEADLINE_SECONDS", 0.05)

    async def slow(request):
        await asyncio.sleep(2)
        return httpx.Response(200, headers=HTML, text="late")

    error, seen = await refused("https://example.test/", slow)
    assert (error.code, error.status) == ("fetch_failed", 502)
    assert "did not load" in error.message
