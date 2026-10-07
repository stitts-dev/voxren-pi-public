"""Health never raises and needs no token: a parent polls it to know the service is up and what it can do."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.config import VERSION, Settings, get_settings
from app.schemas import TranscriptSource

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: Literal["ready", "degraded"] = Field(description="degraded means a tool route will refuse: see missing_config")
    service: str
    version: str
    missing_config: list[str] = Field(description="Environment variables the service needs and does not have")
    invalid_config: list[str] = Field(description="Environment variables that are set to a value the service cannot use, by name and never by value. The service works without them: a Gemini key that cannot be sent as a header leaves transcripts with the captions")
    search_providers: list[str] = Field(description="Web search providers that have a key, in the order a search tries them. Empty is not degraded: only /web/search and /web/research need one")
    transcript_source: TranscriptSource = Field(description="Where a transcript is made first: gemini when a usable Gemini key is set, else captions (YouTube's caption endpoints)")


@router.get("/health", response_model=HealthResponse)
async def health(settings: Settings = Depends(get_settings)) -> HealthResponse:
    missing = [] if settings.token and settings.token.get_secret_value() else ["RESEARCH_TOOLS_TOKEN"]
    return HealthResponse(status="degraded" if missing else "ready", service="research-tools", version=VERSION, missing_config=missing, invalid_config=settings.invalid_config, search_providers=settings.search_providers, transcript_source=settings.transcript_source)
