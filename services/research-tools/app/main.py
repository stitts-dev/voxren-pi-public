"""Research tools: an HTTP service an agent calls for sources it can quote.

Run: uv run uvicorn app.main:app --host 127.0.0.1 --port 8787
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI

from app import watchdog
from app.api import clients, health, web, youtube
from app.auth import RequireTokenMiddleware
from app.cache import get_cache
from app.config import VERSION, get_settings
from app.deps import get_http as get_http  # re-exported: tests override the dependency through this name
from app.errors import ToolError, tool_error_handler

SWEEP_SECONDS = 3600.0


async def _sweep_forever() -> None:
    while True:
        await asyncio.sleep(SWEEP_SECONDS)
        await asyncio.to_thread(get_cache().sweep)


def _exit_when_stdin_closes() -> None:
    """Block on stdin; when the parent dies or closes the pipe, leave at once. Cache writes are atomic, so nothing is lost."""
    try:
        while sys.stdin.buffer.read(4096):
            pass
    finally:
        os._exit(0)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    try:
        get_cache().check_writable()  # fail at startup, not as a 500 on the first write that loses a throttle record or transcript
    except OSError as error:
        raise RuntimeError(f"The cache folder {settings.cache_dir} is not writable ({error}). Set RESEARCH_TOOLS_CACHE_DIR to a folder that is.") from error
    get_cache().sweep()  # a long-lived host reclaims what expired while it was down
    sweeper = asyncio.create_task(_sweep_forever())
    app.state.http = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0), headers={"User-Agent": settings.user_agent})
    if settings.exit_on_stdin_eof:
        threading.Thread(target=_exit_when_stdin_closes, name="stdin-watch", daemon=True).start()
    watcher = None
    if settings.watch_pid_list:
        watchdog.watched[:] = settings.watch_pid_list
        watcher = asyncio.create_task(watchdog.watch_forever(settings.watch_interval_seconds))
    try:
        yield
    finally:
        if watcher:
            watcher.cancel()
        sweeper.cancel()
        await youtube.cancel_inflight()
        await app.state.http.aclose()


app = FastAPI(
    title="Research tools",
    description="Sources for agents: YouTube search and transcripts, web search and page text, cut into passages an agent can quote and check a claim against.",
    version=VERSION,
    lifespan=lifespan,
)
app.add_exception_handler(ToolError, tool_error_handler)  # type: ignore[arg-type]
app.add_middleware(RequireTokenMiddleware)
app.include_router(health.router)
app.include_router(clients.router)
app.include_router(youtube.router)
app.include_router(web.router)
