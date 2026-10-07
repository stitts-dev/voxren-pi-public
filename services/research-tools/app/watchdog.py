"""A shared service outlives the window that started it, so it watches the windows it serves and leaves when none is alive.

The starter's pid comes in through RESEARCH_TOOLS_WATCH_PIDS; windows that join later replace the list with POST /clients.
Without it a coach that is hard-killed (SIGKILL, a crash, a runner abort) leaves the service running with nobody to stop it.
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Callable

watched: list[int] = []


def pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes

        # ponytail: OpenProcess with query-limited access and the exit code; psutil is not a dependency.
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


async def watch_forever(interval: float, leave: Callable[[], None] = lambda: os._exit(0)) -> None:
    """Every `interval` seconds, call `leave` once no watched pid is alive."""
    while True:
        await asyncio.sleep(interval)
        if watched and not any(pid_alive(pid) for pid in watched):
            leave()
            return
