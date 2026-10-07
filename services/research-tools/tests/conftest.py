"""Shared fixtures: a token in the environment, no search keys, a cache in a temp folder, and a client that talks to the app in process."""

from __future__ import annotations

import inspect
import ipaddress
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Iterator

import httpx
import pytest

from app.api.web import get_resolver
from app.cache import Cache, get_cache
from app.clients.fetch import resolve
from app.config import get_settings
from app.main import app, get_http

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


class Wire(httpx.AsyncByteStream):
    """A response body that is still on the wire: raw chunks, read once, never decoded until the service reads them."""

    def __init__(self, chunks: Iterable[bytes]) -> None:
        self.chunks = list(chunks)
        self.read = 0  # chunks handed to the reader so far

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            self.read += 1
            yield chunk

    async def aclose(self) -> None:
        pass


def on_the_wire(response: httpx.Response) -> httpx.Response:
    """Hand a fake upstream's answer over the way a socket does, with the body unread.

    httpx.Response(text=...) reads itself when it is built, and httpx refuses to hand the raw bytes of a body it has
    already read. The service reads raw bytes so it can bound decompression, so every fake that reaches it goes through here.
    """
    if not response.is_stream_consumed:
        return response
    return httpx.Response(response.status_code, headers=response.headers, stream=Wire([response.content]))


def wired(handler: Callable[[httpx.Request], httpx.Response]) -> Callable[[httpx.Request], Awaitable[httpx.Response]]:
    """A MockTransport handler whose answers go through on_the_wire. The handler may be sync or async."""

    async def handle(request: httpx.Request) -> httpx.Response:
        response = handler(request)
        return on_the_wire(await response if inspect.isawaitable(response) else response)

    return handle


async def public_dns(host: str, port: int) -> list:
    """Every name resolves to one public address and a number is judged as itself, so no test makes a DNS lookup."""
    if host[0].isdigit() or ":" in host:
        return await resolve(host, port)
    return [ipaddress.ip_address("93.184.216.34")]


@pytest.fixture(autouse=True)
def settings_env(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Iterator[None]:
    monkeypatch.setenv("RESEARCH_TOOLS_TOKEN", TOKEN)
    monkeypatch.setenv("RESEARCH_TOOLS_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("RESEARCH_TOOLS_YOUTUBE_CAPTION_GAP_SECONDS", "0")
    monkeypatch.setenv("RESEARCH_TOOLS_ARCHIVE_GAP_SECONDS", "0")
    for name in ("BRAVE_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY", "RESEARCH_TOOLS_BRAVE_API_KEY", "RESEARCH_TOOLS_PERPLEXITY_API_KEY", "RESEARCH_TOOLS_GEMINI_API_KEY"):
        monkeypatch.delenv(name, raising=False)  # a developer's own keys must not reach a test
    get_settings.cache_clear()
    get_cache.cache_clear()
    app.dependency_overrides[get_cache] = lambda: Cache(tmp_path / "cache")
    app.dependency_overrides[get_resolver] = lambda: public_dns
    yield
    app.dependency_overrides.clear()
    get_settings.cache_clear()
    get_cache.cache_clear()


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
def upstream() -> Callable[[Callable[[httpx.Request], httpx.Response]], list[httpx.Request]]:
    """Fake every outbound call: pass a handler, get back the list the requests are recorded into."""

    def install(handler: Callable[[httpx.Request], httpx.Response]) -> list[httpx.Request]:
        seen: list[httpx.Request] = []

        def record(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return handler(request)

        fake = httpx.AsyncClient(transport=httpx.MockTransport(wired(record)))
        app.dependency_overrides[get_http] = lambda: fake
        return seen

    return install
