"""The cache gives disk back: an expired entry is deleted when it is read and by a sweep at startup and on a timer, and pages and searches are held under a size cap, oldest first."""

from __future__ import annotations

import asyncio
import os
import time

from app import main as main_module
from app.cache import Cache
from app.config import Settings
from app.main import app


def age(cache: Cache, namespace: str, key: str, hours: float) -> None:
    then = time.time() - hours * 3600
    os.utime(cache._path(namespace, key), (then, then))


def left(cache: Cache, namespace: str) -> int:
    folder = cache.root / namespace
    return len(list(folder.glob("*.json"))) if folder.exists() else 0


def test_an_expired_entry_is_deleted_when_it_is_read(tmp_path):
    cache = Cache(tmp_path)
    cache.set("search", "q", {"a": 1})
    age(cache, "search", "q", 25)
    assert cache.get("search", "q", 24 * 3600) is None
    assert not cache._path("search", "q").exists()


def test_a_fresh_entry_and_a_read_with_no_age_limit_leave_the_file(tmp_path):
    cache = Cache(tmp_path)
    cache.set("search", "q", {"a": 1})
    cache.set("captions", "v", {"a": 2})
    age(cache, "captions", "v", 24 * 365)
    assert cache.get("search", "q", 24 * 3600) == {"a": 1}
    assert cache.get("captions", "v") == {"a": 2}
    assert left(cache, "search") == left(cache, "captions") == 1


def test_a_sweep_deletes_each_namespace_past_its_own_age_and_never_a_transcript(tmp_path):
    cache = Cache(tmp_path)
    for namespace, hours in [("search", 25), ("captions-miss", 24 * 8), ("gemini-miss", 24 * 8), ("throttle", 2), ("pages", 24 * 8)]:
        cache.set(namespace, "old", {})
        age(cache, namespace, "old", hours)
        cache.set(namespace, "new", {})
    cache.set("captions", "kept", {})
    age(cache, "captions", "kept", 24 * 365)
    cache.sweep()
    assert [left(cache, namespace) for namespace in ("search", "captions-miss", "gemini-miss", "throttle", "pages", "captions")] == [1, 1, 1, 1, 1, 1]
    assert cache.get("search", "new") == {}


def test_a_sweep_keeps_pages_and_searches_under_the_size_cap_dropping_the_oldest_first(tmp_path):
    cache = Cache(tmp_path, max_bytes=1000)
    for number in range(6):  # 6 x about 300 bytes
        cache.set("pages", f"p{number}", {"text": "x" * 290})
        age(cache, "pages", f"p{number}", 6 - number)  # p0 is the oldest
    cache.set("captions", "kept", {"text": "x" * 5000})
    cache.sweep()
    assert [cache.get("pages", f"p{number}") is not None for number in range(6)] == [False, False, False, True, True, True]
    assert cache.get("captions", "kept") is not None  # a transcript is not counted and not evicted


def test_writing_past_the_cap_evicts_without_waiting_for_a_sweep(tmp_path):
    cache = Cache(tmp_path, max_bytes=1000)
    for number in range(8):
        cache.set("search", f"s{number}", {"text": "x" * 290})
        age(cache, "search", f"s{number}", 8 - number)
    total = sum(path.stat().st_size for path in (tmp_path / "search").glob("*.json"))
    assert total <= 1000
    assert cache.get("search", "s7") is not None
    assert cache.get("search", "s0") is None


def test_the_cache_cap_is_a_setting_in_megabytes():
    assert Settings().cache_max_mb == 512


async def test_startup_deletes_what_has_expired(tmp_path):
    cache = Cache(tmp_path / "cache")
    cache.set("search", "old", {})
    age(cache, "search", "old", 25)
    async with app.router.lifespan_context(app):
        assert not cache._path("search", "old").exists()


async def test_the_sweep_runs_again_on_a_timer(tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "SWEEP_SECONDS", 0.05)
    cache = Cache(tmp_path / "cache")
    async with app.router.lifespan_context(app):
        cache.set("search", "late", {})
        age(cache, "search", "late", 25)
        for _ in range(40):
            if not cache._path("search", "late").exists():
                break
            await asyncio.sleep(0.05)
        assert not cache._path("search", "late").exists()
