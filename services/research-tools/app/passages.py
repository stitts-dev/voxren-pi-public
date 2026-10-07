"""Long text cut into passages, and passages ranked against a query.

A caller (an agent, a note builder) rarely wants a whole transcript or page: it wants the few parts that speak to its
question, each small enough to quote and to check a claim against. Ranking is BM25 over the parts of one document.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

DEFAULT_PART_CHARS = 1200
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_WORD = re.compile(r"[a-z0-9']+")
_APOSTROPHES = str.maketrans("’‘ʼ", "'''")  # the curly and modifier apostrophes that captions and pages use
# Words that say nothing about a topic. Without them a passage that shares only "the" or "to" with a question counts as
# a match, and a video about something else is never "no_match".
_STOP_WORDS = frozenset(
    "a an the of in on at to for with from by about against into as and or but if i you your he she it we they this that its their "
    "is are was were be been do does did have has had can will would could should how when what".split()
)
_BM25_K1 = 1.5
_BM25_B = 0.75


@dataclass(frozen=True)
class Passage:
    """One part of one document. `at` is the start second in a video and 0 in a page."""

    id: str
    text: str
    at: int = 0
    score: float | None = None


def squeeze(text: str) -> str:
    return " ".join(text.split())


def split_text(text: str, part_chars: int = DEFAULT_PART_CHARS) -> list[str]:
    """Cut at sentence ends into parts of about `part_chars`; a part closes once it reaches that length.

    Text with no sentence ends (a list, a table, code) is cut at a space once a part reaches twice that length, so no part
    is as long as the page.
    """
    parts: list[str] = []
    part = ""
    limit = 2 * part_chars
    for sentence in _SENTENCE_END.split(squeeze(text)):
        part = f"{part} {sentence}".strip()
        while len(part) >= limit:
            cut = part.rfind(" ", 0, limit)
            if cut < 1:  # no space to cut at: a word longer than the limit is cut through
                cut = limit
            parts.append(part[:cut])
            part = part[cut:].lstrip()
        if len(part) >= part_chars:
            parts.append(part)
            part = ""
    if part:
        parts.append(part)
    return parts


def words(text: str) -> list[str]:
    """Lower-case words of two letters or more. An apostrophe is not part of a word: "Fizz's" is "fizz", and "Kai'Sa", "Kai’Sa" and "Kaisa" are one word."""
    tokens = _WORD.findall(text.lower().translate(_APOSTROPHES))
    cleaned = (token.removesuffix("'s").replace("'", "") for token in tokens)
    return [word for word in cleaned if len(word) > 1]


def _terms(text: str) -> list[str]:
    return [word for word in words(text) if word not in _STOP_WORDS]


def rank(passages: list[Passage], query: str, limit: int) -> list[Passage]:
    """The `limit` passages that best match `query`, best first, each with its score. No match, no passage.

    ponytail: exact-word BM25, so a caption that misspells a name ("Ari" for "Ahri") misses that word.
    Add fuzzy matching here if recall on auto captions proves low.
    """
    terms = set(_terms(query))
    if not terms or not passages:
        return []
    documents = [Counter(_terms(passage.text)) for passage in passages]
    lengths = [sum(document.values()) for document in documents]
    average = (sum(lengths) / len(lengths)) or 1.0
    containing = {term: sum(1 for document in documents if term in document) for term in terms}  # once per term, not per passage
    scored: list[Passage] = []
    for passage, document, length in zip(passages, documents, lengths, strict=True):
        score = 0.0
        for term in terms:
            frequency = document.get(term, 0)
            if not frequency:
                continue
            idf = math.log(1 + (len(documents) - containing[term] + 0.5) / (containing[term] + 0.5))
            score += idf * frequency * (_BM25_K1 + 1) / (frequency + _BM25_K1 * (1 - _BM25_B + _BM25_B * length / average))
        if score > 0:
            scored.append(Passage(id=passage.id, text=passage.text, at=passage.at, score=round(score, 3)))
    scored.sort(key=lambda passage: passage.score or 0.0, reverse=True)
    return scored[:limit]
