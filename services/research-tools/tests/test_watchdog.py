"""A shared service leaves on its own once no window it serves is alive."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys

from app import watchdog
from app.config import get_settings
from app.main import app
from tests.conftest import AUTH


def dead_pid() -> int:
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait()
    return process.pid


async def wait_for(exits: list[int], seconds: float = 3.0) -> None:
    for _ in range(int(seconds / 0.01)):
        if exits:
            return
        await asyncio.sleep(0.01)


def listen_for_exit(monkeypatch) -> list[int]:
    exits: list[int] = []
    monkeypatch.setattr(watchdog.os, "_exit", exits.append)
    return exits


async def test_the_service_exits_when_the_pid_it_was_started_for_is_dead(monkeypatch):
    exits = listen_for_exit(monkeypatch)
    monkeypatch.setenv("RESEARCH_TOOLS_WATCH_PIDS", str(dead_pid()))
    monkeypatch.setenv("RESEARCH_TOOLS_WATCH_INTERVAL_SECONDS", "0.01")
    get_settings.cache_clear()
    async with app.router.lifespan_context(app):
        await wait_for(exits)
    assert exits == [0]


async def test_the_service_stays_while_any_window_is_alive(monkeypatch):
    exits = listen_for_exit(monkeypatch)
    monkeypatch.setenv("RESEARCH_TOOLS_WATCH_PIDS", f"{dead_pid()},{os.getpid()}")
    monkeypatch.setenv("RESEARCH_TOOLS_WATCH_INTERVAL_SECONDS", "0.01")
    get_settings.cache_clear()
    async with app.router.lifespan_context(app):
        await asyncio.sleep(0.2)
    assert exits == []


async def test_a_window_that_joins_replaces_the_list_and_the_route_needs_the_token(client, monkeypatch):
    exits = listen_for_exit(monkeypatch)
    monkeypatch.setenv("RESEARCH_TOOLS_WATCH_PIDS", str(dead_pid()))
    monkeypatch.setenv("RESEARCH_TOOLS_WATCH_INTERVAL_SECONDS", "0.05")
    get_settings.cache_clear()
    assert (await client.post("/clients", json={"pids": [os.getpid()]})).status_code == 401
    async with app.router.lifespan_context(app):
        assert (await client.post("/clients", json={"pids": [os.getpid()]}, headers=AUTH)).json() == {"pids": [os.getpid()]}
        await asyncio.sleep(0.3)
        assert exits == []
        await client.post("/clients", json={"pids": [dead_pid()]}, headers=AUTH)
        await wait_for(exits)
    assert exits == [0]


def test_a_dead_pid_is_not_alive_and_ours_is():
    assert not watchdog.pid_alive(dead_pid())
    assert watchdog.pid_alive(os.getpid())


def test_launch_secrets_file_is_read_once_deleted_and_never_left_in_the_exec_environment(tmp_path, monkeypatch):
    from app.config import adopt_launch_secrets

    path = tmp_path / "launch-secrets-x.json"
    path.write_text('{"BRAVE_API_KEY": "brave-FAKE", "VOXREN_GEMINI_API_KEY": "gem-FAKE"}')
    monkeypatch.setenv("VOXREN_LAUNCH_SECRETS", str(path))
    for name in ("BRAVE_API_KEY", "RESEARCH_TOOLS_GEMINI_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    adopt_launch_secrets()
    assert not path.exists()
    assert os.environ["BRAVE_API_KEY"] == "brave-FAKE"
    assert os.environ["RESEARCH_TOOLS_GEMINI_API_KEY"] == "gem-FAKE"
    assert "VOXREN_LAUNCH_SECRETS" not in os.environ
