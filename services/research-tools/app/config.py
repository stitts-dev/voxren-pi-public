"""Settings, read once from the process environment and nowhere else (no .env file: a secret does not belong in the tree).
Every field is an env var named RESEARCH_TOOLS_<FIELD>; the three keys also answer to the plain names BRAVE_API_KEY,
PERPLEXITY_API_KEY, and GEMINI_API_KEY that those providers document."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.schemas import TranscriptSource

VERSION = "0.1.0"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="RESEARCH_TOOLS_", case_sensitive=False, extra="ignore")

    token: SecretStr | None = Field(default=None, description="Bearer token every tool route requires. Unset means the tool routes answer 503: the service fails closed.")
    cache_dir: Path = Field(default_factory=lambda: Path.home() / ".cache" / "research-tools", description="Where fetched transcripts and pages are kept between calls.")
    cache_max_mb: int = Field(default=512, ge=1, description="Most megabytes the cached pages and searches may hold together. Past it the oldest entries are deleted. Transcripts are not counted.")
    contact: str = Field(default="https://github.com/stitts-dev/voxren-pi-public", description="Contact URL sent in the User-Agent of requests to public archives and pages.")
    youtube_caption_gap_seconds: float = Field(default=2.0, description="Minimum gap between two caption downloads. YouTube throttles caption downloads per IP.")
    exit_on_stdin_eof: bool = Field(default=False, description="Exit when stdin closes. A parent that starts this service as a child sets it, so the child never outlives the parent.")
    watch_pids: str = Field(default="", description="Comma-separated process ids of the windows this service serves. Set, the service exits once none of them is alive, so a shared service never outlives a hard-killed starter. Windows that join later send POST /clients.")
    watch_interval_seconds: float = Field(default=5.0, gt=0, description="How often the service checks whether a watched window is still alive.")

    archive_gap_seconds: float = Field(default=1.0, description="Minimum gap between two requests to the Internet Archive, which asks scripts to stay near one request a second.")
    brave_api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("BRAVE_API_KEY", "RESEARCH_TOOLS_BRAVE_API_KEY"),
        description="Brave Search API key, the first provider web search tries. Unset means the provider is skipped.",
    )
    perplexity_api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("PERPLEXITY_API_KEY", "RESEARCH_TOOLS_PERPLEXITY_API_KEY"),
        description="Perplexity Search API key, tried after Brave. Unset means the provider is skipped.",
    )
    gemini_api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("GEMINI_API_KEY", "RESEARCH_TOOLS_GEMINI_API_KEY"),
        description="Gemini API key. With one, a transcript comes from Gemini reading the public video instead of from YouTube's caption endpoints. Unset means captions only.",
    )
    gemini_model: str = Field(default="gemini-3.8-flash", pattern=r"^[A-Za-z0-9._-]+$", description="The Gemini model that transcribes. It goes into the request path, so it is a model name and nothing else.")
    gemini_max_minutes: int = Field(default=90, ge=1, description="Longest stretch of a video Gemini transcribes, from its start. A longer video is cut here, so one request never bills an unbounded number of clips.")
    gemini_concurrency: int = Field(default=4, ge=1, description="Gemini calls in flight at once, across every request this process serves.")

    @field_validator("gemini_api_key")
    @classmethod
    def _strip_gemini_key(cls, key: SecretStr | None) -> SecretStr | None:
        """A key pasted with a newline or a space around it is the key."""
        return SecretStr(key.get_secret_value().strip()) if key else key

    @property
    def watch_pid_list(self) -> list[int]:
        return [int(pid) for pid in self.watch_pids.split(",") if pid.strip().isdigit()]

    @property
    def search_providers(self) -> list[str]:
        """The providers that have a key, in the order a search tries them."""
        keys = {"brave": self.brave_api_key, "perplexity": self.perplexity_api_key}
        return [name for name, key in keys.items() if key and key.get_secret_value()]

    @property
    def invalid_config(self) -> list[str]:
        """Settings that are set but cannot be used, by name. A Gemini key with a character a header cannot hold (non-ASCII, a control character) is one."""
        key = self.gemini_api_key.get_secret_value() if self.gemini_api_key else ""
        return ["GEMINI_API_KEY"] if key and not (key.isascii() and key.isprintable()) else []

    @property
    def transcript_source(self) -> TranscriptSource:
        """Where a transcript is made: Gemini when it has a usable key, else YouTube's caption endpoints."""
        return "gemini" if self.gemini_api_key and self.gemini_api_key.get_secret_value() and not self.invalid_config else "captions"

    @property
    def user_agent(self) -> str:
        return f"research-tools/{VERSION} (+{self.contact})"


def adopt_launch_secrets() -> None:
    """The keys come in a 0600 file named by VOXREN_LAUNCH_SECRETS, not in the exec-time environment (which same-user tools can read). Read once, deleted, then put into this process's own environ."""
    path = os.environ.pop("VOXREN_LAUNCH_SECRETS", "")
    if not path:
        return
    try:
        with open(path, encoding="utf-8") as handle:
            secrets = json.load(handle)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    for name in ("BRAVE_API_KEY", "PERPLEXITY_API_KEY"):
        if isinstance(secrets.get(name), str):
            os.environ[name] = secrets[name]
    # The launcher's name for the Gemini key (Pi's own Google provider reads GEMINI_API_KEY).
    if isinstance(secrets.get("VOXREN_GEMINI_API_KEY"), str):
        os.environ["RESEARCH_TOOLS_GEMINI_API_KEY"] = secrets["VOXREN_GEMINI_API_KEY"]


@lru_cache
def get_settings() -> Settings:
    adopt_launch_secrets()
    return Settings()
