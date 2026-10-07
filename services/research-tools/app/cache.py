"""A small JSON file cache: one file per key, written whole, read back until it is too old."""

from __future__ import annotations

import hashlib
import json
import os
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.config import get_settings

DAY = 24 * 3600
# How long each namespace is useful: the sweep deletes an entry past this. A namespace not listed (the transcripts, `captions`) is kept for good.
# `pages` holds site copies (1 day) and archive copies (7 days) together, so the sweep uses 7 days and a read still judges each by its own age.
# ponytail: a site copy lives up to 6 days past its day on disk; the size cap bounds it. Split the namespace if that proves too long.
MAX_AGE_SECONDS = {"pages": 7 * DAY, "search": DAY, "captions-miss": 7 * DAY, "gemini-miss": 7 * DAY, "throttle": 3600}
CAPPED = ("pages", "search")  # the namespaces whose size is bounded: anyone with the token can make a new entry
DEFAULT_MAX_BYTES = 512 * 1024 * 1024


class Cache:
    def __init__(self, root: Path, max_bytes: int = DEFAULT_MAX_BYTES) -> None:
        self.root = root
        self.max_bytes = max_bytes
        self._written = 0  # bytes written since the last sweep

    def _path(self, namespace: str, key: str) -> Path:
        return self.root / namespace / f"{hashlib.sha256(key.encode()).hexdigest()[:32]}.json"

    def get(self, namespace: str, key: str, max_age_seconds: float | None = None) -> Any | None:
        """The stored value, or None when there is none, it is older than `max_age_seconds`, or it no longer parses."""
        path = self._path(namespace, key)
        try:
            if max_age_seconds is not None and time.time() - path.stat().st_mtime > max_age_seconds:
                path.unlink(missing_ok=True)
                return None
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def set(self, namespace: str, key: str, value: Any) -> None:
        """Write to a temp file and rename, so a reader never sees half a value."""
        path = self._path(namespace, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(f".{os.getpid()}.tmp")
        data = json.dumps(value)
        temp.write_text(data, encoding="utf-8")
        temp.replace(path)
        if namespace in CAPPED:
            self._written += len(data)
            if self._written > self.max_bytes // 4:  # a burst of writes is bounded between timed sweeps
                self.sweep()

    def sweep(self) -> None:
        """Delete every entry past its namespace's age, then the oldest pages and searches until they fit `max_bytes`."""
        self._written = 0
        now = time.time()
        kept: list[tuple[float, int, Path]] = []
        for namespace, max_age in MAX_AGE_SECONDS.items():
            for path in (self.root / namespace).glob("*.json"):
                try:
                    stat = path.stat()
                    if now - stat.st_mtime > max_age:
                        path.unlink()
                    elif namespace in CAPPED:
                        kept.append((stat.st_mtime, stat.st_size, path))
                except OSError:
                    pass  # another request removed it first
        total = sum(size for _, size, _ in kept)
        for _, size, path in sorted(kept):
            if total <= self.max_bytes:
                break
            path.unlink(missing_ok=True)
            total -= size

    def check_writable(self) -> None:
        """Create the folder and write and remove a probe file; an OSError means the folder cannot hold a value."""
        self.root.mkdir(parents=True, exist_ok=True)
        probe = self.root / f".probe.{os.getpid()}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()


@lru_cache
def get_cache() -> Cache:
    settings = get_settings()
    return Cache(settings.cache_dir, settings.cache_max_mb * 1024 * 1024)
