"""The gate on every tool route: a shared bearer token, compared in constant time, refused when unset.

The gate is a middleware first and a dependency second. A dependency runs after FastAPI has read and parsed the whole
request body, so a caller with no token could still make the service buffer a large body, and a malformed one would
answer 422 instead of 401. The middleware refuses before the body is read. `require_token` stays on every router: it is
what the route walk in the tests looks for, and it keeps a router that is mounted without the middleware closed.
"""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import Depends, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import Settings, get_settings
from app.errors import ToolError, error_response

# What answers without a token: the health check a host probes and the pages that describe the API.
OPEN_PATHS = frozenset({"/health", "/docs", "/redoc", "/openapi.json"})


def check_token(authorization: str | None, settings: Settings) -> None:
    if settings.token is None or not settings.token.get_secret_value():
        raise ToolError("auth_unconfigured", 503, "RESEARCH_TOOLS_TOKEN is not set on the service.")
    expected = f"Bearer {settings.token.get_secret_value()}"
    if authorization is None or not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise ToolError("auth_invalid", 401, "Missing or wrong bearer token.")


bearer = HTTPBearer(auto_error=False)  # the scheme only describes the header in openapi.json; check_token judges it


def require_token(credentials: Annotated[HTTPAuthorizationCredentials | None, Security(bearer)] = None, settings: Settings = Depends(get_settings)) -> None:
    check_token(f"{credentials.scheme} {credentials.credentials}" if credentials else None, settings)


class RequireTokenMiddleware:
    """Refuse a request to any path but OPEN_PATHS before the app sees it, so its body is never read."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["path"] not in OPEN_PATHS:
            try:
                check_token(Headers(scope=scope).get("authorization"), get_settings())
            except ToolError as error:
                await error_response(error)(scope, receive, send)
                return
        await self.app(scope, receive, send)
