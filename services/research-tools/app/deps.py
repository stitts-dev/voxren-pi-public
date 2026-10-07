"""Dependencies the routers share. They live here, not in main.py, because main imports the routers and a router that
imported main would be a cycle."""

from __future__ import annotations

import httpx
from fastapi import Request


def get_http(request: Request) -> httpx.AsyncClient:
    """The shared outbound client. Tests override this with a client on an httpx.MockTransport."""
    return request.app.state.http
