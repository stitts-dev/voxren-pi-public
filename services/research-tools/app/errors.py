"""One error type for every tool failure, so a caller reads a code instead of parsing prose."""

from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field


class ErrorDetail(BaseModel):
    code: str = Field(description="Stable name of the failure, listed in the README's Errors table")
    message: str = Field(description="What happened, in a sentence. Never holds a key or a token")


class ErrorBody(BaseModel):
    """The JSON a ToolError becomes."""

    detail: ErrorDetail


_STATUS_TEXT = {
    401: "auth_invalid: the bearer token is missing or wrong",
    404: "The video or page cannot be had: no_captions, no_english, unplayable, not_archived",
    415: "unsupported_content: the page is not HTML or plain text",
    429: "rate_limited: wait for Retry-After seconds before asking again",
    502: "The upstream failed or refused: upstream_error, po_token_required, search_unavailable, fetch_refused, fetch_failed, archive_unavailable",
    503: "auth_unconfigured (no token set on the service), or search_unconfigured (no search key, on the search routes)",
}


def error_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """The `responses=` entries for the error statuses a route answers with, each with the ErrorBody shape."""
    found: dict[int | str, dict[str, Any]] = {status: {"model": ErrorBody, "description": _STATUS_TEXT[status]} for status in statuses}
    if 429 in found:
        found[429]["headers"] = {"Retry-After": {"description": "Seconds to wait", "schema": {"type": "integer"}}}
    return found


class ToolError(Exception):
    """A failure the caller can act on: `code` is stable, `status` is the HTTP status, `retry_after` is seconds."""

    def __init__(self, code: str, status: int, message: str, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message
        self.retry_after = retry_after


def error_response(error: ToolError) -> JSONResponse:
    """The JSON answer for a ToolError. The auth middleware answers with it too, so a refusal looks the same wherever it is made."""
    headers = {"Retry-After": str(error.retry_after)} if error.retry_after else None
    return JSONResponse(status_code=error.status, content={"detail": {"code": error.code, "message": error.message}}, headers=headers)


async def tool_error_handler(_request: Request, error: ToolError) -> JSONResponse:
    return error_response(error)
