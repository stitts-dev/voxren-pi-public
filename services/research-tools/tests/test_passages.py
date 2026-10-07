"""Passages are what every tool returns, so their cut and their ranking are pinned here."""

from __future__ import annotations

import pytest

from app import passages as passages_module
from app.cache import Cache
from app.passages import Passage, rank, split_text, words


def test_split_text_cuts_at_sentence_ends_and_loses_nothing():
    text = " ".join(f"Sentence number {n} runs for a while to fill the part." for n in range(60))
    parts = split_text(text, part_chars=600)
    assert len(parts) > 3
    assert all(part.endswith(".") for part in parts)
    assert all(600 <= len(part) < 700 for part in parts[:-1])
    assert " ".join(parts) == text


def test_split_text_squeezes_whitespace_and_handles_empty():
    assert split_text("One.\n\n  Two.\tThree.") == ["One. Two. Three."]
    assert split_text("   ") == []


def test_split_text_cuts_text_with_no_sentence_ends_at_a_space():
    """A list, a table or code has no ". ", and used to come back as one part as long as the page."""
    text = " ".join(f"item{n}" for n in range(20_000))
    parts = split_text(text, part_chars=300)
    assert len(parts) > 100
    assert all(len(part) < 600 for part in parts)  # twice part_chars
    assert all(not part.startswith(" ") and not part.endswith(" ") for part in parts)
    assert " ".join(parts) == text  # cut at spaces, so no word is split and none is lost


def test_split_text_cuts_through_a_word_only_when_there_is_no_space_to_cut_at():
    parts = split_text("x" * 2000, part_chars=300)
    assert [len(part) for part in parts] == [600, 600, 600, 200]


def test_split_text_bounds_a_long_sentence_after_shorter_ones():
    text = "Short one. " + "word " * 1000 + "end."
    parts = split_text(text, part_chars=300)
    assert all(len(part) < 600 for part in parts)
    assert " ".join(parts) == " ".join(text.split())


def test_words_lowercases_and_drops_single_letters():
    # An apostrophe is no longer part of a word, so the possessives lose theirs. Everything else is as before.
    assert words("Fizz's E dodges Ahri's Charm, a KEY trick!") == ["fizz", "dodges", "ahri", "charm", "key", "trick"]


@pytest.mark.parametrize("text", ["Kai'Sa", "Kai\u2019Sa", "Kai\u2018Sa", "Kaisa", "KAISA's", "Kai'Sa's", "kaisa'"])
def test_words_treat_apostrophes_possessives_and_curly_quotes_as_one_word(text):
    assert words(text) == ["kaisa"]


def test_rank_finds_a_champion_named_as_a_possessive_or_with_another_apostrophe():
    passages = [
        Passage(id="p1", text="Fizz's E dodges everything and Fizz's W adds damage."),
        Passage(id="p2", text="Kai\u2019Sa wins the lane by level three."),
        Passage(id="p3", text="Nothing about either champion here."),
    ]
    assert [passage.id for passage in rank(passages, "Fizz E", limit=5)] == ["p1"]
    assert [passage.id for passage in rank(passages, "Kai'Sa", limit=5)] == ["p2"]
    assert [passage.id for passage in rank(passages, "kaisa", limit=5)] == ["p2"]


def test_rank_ignores_function_words_so_a_passage_that_shares_only_those_is_not_a_match():
    unrelated = [Passage(id=f"p{n}", text=f"How to farm the wave in the early game, and when to go back, part {n}.") for n in range(5)]
    assert rank(unrelated, "how to trade against Ahri in lane", limit=4) == []
    assert rank(unrelated, "how to", limit=4) == []  # nothing left to match on
    related = [*unrelated, Passage(id="p9", text="Against Ahri you trade when her charm is down.")]
    assert [passage.id for passage in rank(related, "how to trade against Ahri in lane", limit=4)] == ["p9"]


def test_rank_counts_how_many_passages_hold_each_term_once_per_term_not_once_per_passage(monkeypatch):
    lookups = 0

    class Counting(passages_module.Counter):
        def __contains__(self, item):
            nonlocal lookups
            lookups += 1
            return super().__contains__(item)

    monkeypatch.setattr(passages_module, "Counter", Counting)
    passages = [Passage(id=f"p{n}", text="alpha beta gamma delta") for n in range(60)]
    assert len(rank(passages, "alpha beta gamma", limit=5)) == 5
    assert lookups <= 60 * 3 * 2  # one pass over the passages per term; it used to be one per passage and term


def test_rank_puts_the_matching_passage_first_and_drops_the_rest():
    passages = [
        Passage(id="p1", text="Welcome back to the channel, today we look at the lane."),
        Passage(id="p2", text="Hold E for Charm. When Ahri misses Charm you can trade.", at=120),
        Passage(id="p3", text="Ahri pushes the wave early, so farm under tower."),
    ]
    ranked = rank(passages, "ahri charm trade", limit=5)
    assert [passage.id for passage in ranked] == ["p2", "p3"]
    assert ranked[0].at == 120
    assert ranked[0].score > ranked[1].score > 0


def test_rank_respects_the_limit_and_an_empty_query():
    passages = [Passage(id=f"p{n}", text="charm charm charm") for n in range(5)]
    assert len(rank(passages, "charm", limit=2)) == 2
    assert rank(passages, "a", limit=2) == []
    assert rank([], "charm", limit=2) == []


def test_cache_round_trip_age_and_corruption(tmp_path):
    cache = Cache(tmp_path)
    assert cache.get("captions", "abc") is None
    cache.set("captions", "abc", {"events": [1, 2]})
    assert cache.get("captions", "abc") == {"events": [1, 2]}
    assert cache.get("captions", "abc", max_age_seconds=3600) == {"events": [1, 2]}
    assert cache.get("captions", "abc", max_age_seconds=-1) is None  # too old: deleted by the read
    assert cache.get("captions", "abc") is None
    assert cache.get("pages", "abc") is None
    cache.set("captions", "abc", {"events": [1, 2]})
    next(tmp_path.joinpath("captions").iterdir()).write_text("{ not json", encoding="utf-8")
    assert cache.get("captions", "abc") is None
