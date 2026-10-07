"""Readable text out of an HTML page, with the standard library only.

Guide and wiki sites keep their useful text in tables and lists and wrap it in menus, footers, and sign-in forms. The
parser drops the wrapping, keeps table text, and drops a long line it has already seen, which is how repeated menus and
"related" blocks show up in the text.
"""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser

# Text inside these is chrome or code, not content.
_SKIP = frozenset({"script", "style", "noscript", "svg", "head", "template", "iframe", "form", "nav", "footer", "aside", "button", "select", "option", "header"})
# These end a line. Table cells only separate words, so a minified table does not run its cells together.
_BLOCK = frozenset({"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "ul", "ol", "table", "blockquote", "dt", "dd", "pre", "hr", "figcaption", "main", "caption"})
_CELL = frozenset({"td", "th"})
_VOID = frozenset({"img", "input", "hr", "meta", "link", "source", "area", "base", "col", "embed", "param", "track", "wbr"})
_REPEAT_MIN_CHARS = 40  # a short line ("Next", "Top") is allowed to repeat; a long one is a repeated block
_CHALLENGE_SCAN_CHARS = 20_000


@dataclass(frozen=True)
class Extracted:
    title: str
    text: str


class _TextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.title_parts: list[str] = []
        self._skipping: list[str] = []  # open skipped tags, innermost last
        self._in_title = False
        self._title_done = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title" and not self._title_done:
            self._in_title = True
        elif tag in _VOID:
            if tag in _BLOCK:
                self.out.append("\n")
        elif tag in _SKIP:
            # An option's end tag is optional, so a new option closes the one before it.
            if not (tag == "option" and self._skipping[-1:] == ["option"]):
                self._skipping.append(tag)
        elif tag == "body":
            self._skipping.clear()  # head's end tag is optional too; the body always starts the content
            self.out.append("\n")
        elif tag in _BLOCK:
            self.out.append("\n")
        elif tag in _CELL:
            self.out.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title" and self._in_title:
            self._in_title, self._title_done = False, True
        elif tag in _SKIP:
            # Close the nearest open tag of this kind and what was left open inside it; a stray end tag closes nothing.
            if tag in self._skipping:
                del self._skipping[len(self._skipping) - 1 - self._skipping[::-1].index(tag) :]
        elif tag in _BLOCK:
            self.out.append("\n")
        elif tag in _CELL:
            self.out.append(" ")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_parts.append(data)
        elif not self._skipping:
            self.out.append(data)


def extract(html: str) -> Extracted:
    """The page's title and its text, one block per line, long repeated lines dropped.

    ponytail: a page wrapped in a single <form> (old ASP.NET sites) extracts as empty, because forms are skipped whole.
    Retry without skipping forms when the text comes back much shorter than the markup, if such a site matters.
    """
    parser = _TextParser()
    parser.feed(html)
    parser.close()
    seen: set[str] = set()
    lines: list[str] = []
    for raw in "".join(parser.out).split("\n"):
        line = " ".join(raw.split())
        if not line:
            continue
        if len(line) > _REPEAT_MIN_CHARS:
            if line in seen:
                continue
            seen.add(line)
        lines.append(line)
    return Extracted(title=" ".join("".join(parser.title_parts).split()), text="\n".join(lines))


def is_challenge(html: str) -> bool:
    """True for a bot-check page ("Just a moment..."): a site's refusal that arrives as a 200 or as a captured copy."""
    return extract(html[:_CHALLENGE_SCAN_CHARS]).title.lower().startswith("just a moment")
