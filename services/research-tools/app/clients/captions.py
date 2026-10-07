"""One timed line of a transcript: the shape both transcript sources produce, so neither client has to import the other."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CaptionEvent:
    at: int  # start, in whole seconds
    text: str
