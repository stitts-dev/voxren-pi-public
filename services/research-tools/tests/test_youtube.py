"""The YouTube routes, with YouTube faked: search parsing and filters, transcripts and the cache, the caption throttle
(one 429 stops further downloads, a cached transcript is still served), the research walk, and the token gate.
The one integration test calls live YouTube search and never a caption URL."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time

import httpx
import pytest
from conftest import AUTH

from app.api import youtube as youtube_api
from app.cache import Cache
from app.clients import youtube as youtube_client
from app.clients.youtube import (
    CaptionEvent,
    Captions,
    age_months,
    age_months_ceiling,
    caption_passages,
    length_seconds,
    title_matches,
)
from app.config import get_settings
from app.errors import ToolError
from app.main import app, get_http
from app.schemas import YoutubeResearchRequest

TIMEDTEXT = "https://www.youtube.com/api/timedtext"

# A talk of 30 lines ten seconds apart, one of them about the thing the tests search for.
NEEDLE = "at level three you trade charm back with your auto attacks"
FILLER = [(n * 10, f"we keep farming the wave and watching the timer pass {n}") for n in range(30)]
SPEECH = [*FILLER[:12], (120, NEEDLE), *FILLER[13:]]


def vid(n: int) -> str:
    return f"vid{n:08d}"


def search_json(hits: list[dict]) -> dict:
    items = [{"videoRenderer": hit} for hit in hits]
    items.insert(1, {"shelfRenderer": {}})  # a row that is not a video is passed over
    return {"contents": {"twoColumnSearchResultsRenderer": {"primaryContents": {"sectionListRenderer": {"contents": [
        {"itemSectionRenderer": {"contents": items}},
        {"continuationItemRenderer": {}},
    ]}}}}}


def hit(n: int, title: str = "Ahri matchup guide", channel: str | None = None, length: str | None = "10:00", published: str | None = "2 months ago") -> dict:
    renderer: dict = {"videoId": vid(n), "title": {"runs": [{"text": title[:3]}, {"text": title[3:]}]}, "ownerText": {"runs": [{"text": channel or f"Channel {n}"}]}}
    if length:
        renderer["lengthText"] = {"simpleText": length, "accessibility": {"accessibilityData": {"label": "long"}}}
    if published:
        renderer["publishedTimeText"] = {"simpleText": published}
    return renderer


def track(video_id: str, language: str = "en", asr: bool = False, signature: str = "SIG", extra: str = "") -> dict:
    found: dict = {"languageCode": language, "baseUrl": f"{TIMEDTEXT}?v={video_id}&fmt=srv3&signature={signature}&lang={language}{extra}"}
    if asr:
        found["kind"] = "asr"
    return found


def player(*tracks: dict, status: str = "OK", reason: str | None = None) -> dict:
    body: dict = {"playabilityStatus": {"status": status, **({"reason": reason} if reason else {})}}
    if tracks:
        body["captions"] = {"playerCaptionsTracklistRenderer": {"captionTracks": list(tracks)}}
    return body


def json3(lines: list[tuple[int, str]]) -> dict:
    """A caption file as YouTube serves it: a window event with no text, a start a quarter second into each second,
    and a lone newline event that carries no words."""
    events: list[dict] = [{"tStartMs": 0, "dDurationMs": 999999}]
    for second, text in lines:
        events.append({"tStartMs": second * 1000 + 250, "dDurationMs": 2000, "segs": [{"utf8": text.replace(" ", "\n", 1)}]})
        events.append({"tStartMs": second * 1000 + 900, "segs": [{"utf8": "\n"}]})
    return {"wireMagic": "pb3", "events": events}


Reply = tuple[int, dict | list | str] | Exception


class FakeYoutube:
    """Answers search, /player, and the caption URL the way YouTube does. Replace an entry to make one video misbehave."""

    def __init__(self) -> None:
        self.hits: list[dict] = []
        self.hits_for: dict[str, list[dict]] = {}  # search results for one exact query; any other query gets `hits`
        self.search_reply: Reply | None = None
        self.players: dict[str, Reply] = {}
        self.captions: dict[str, Reply] = {}
        self.caption_times: list[float] = []
        self.delay = 0.0  # seconds every answer takes, so concurrent requests really overlap
        self.delays: dict[str, float] = {}  # per video, seconds its /player answer takes on top of `delay`: one video that stalls
        self.seen: list[httpx.Request] = []  # the fixture points this at the list the upstream helper records into

    def video(self, n: int, lines: list[tuple[int, str]] = SPEECH, asr: bool = False, hit_kwargs: dict | None = None) -> None:
        """A video in the search results that also has English captions."""
        self.hits.append(hit(n, **(hit_kwargs or {})))
        self.players[vid(n)] = (200, player(track(vid(n), asr=asr)))
        self.captions[vid(n)] = (200, json3(lines))

    def calls(self, path: str) -> list[httpx.Request]:
        return [request for request in self.seen if request.url.path == path]

    @property
    def caption_calls(self) -> list[httpx.Request]:
        return self.calls("/api/timedtext")

    @property
    def player_ids(self) -> list[str]:
        return [json.loads(request.content)["videoId"] for request in self.calls("/youtubei/v1/player")]

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.delay:
            await asyncio.sleep(self.delay)
        if request.url.path == "/youtubei/v1/search":
            return self._answer(self.search_reply or (200, search_json(self.hits_for.get(json.loads(request.content)["query"], self.hits))), request)
        if request.url.path == "/youtubei/v1/player":
            video_id = json.loads(request.content)["videoId"]
            if video_id in self.delays:
                await asyncio.sleep(self.delays[video_id])
            return self._answer(self._known(self.players, video_id), request)
        if request.url.path == "/api/timedtext":
            self.caption_times.append(time.monotonic())
            return self._answer(self._known(self.captions, request.url.params["v"]), request)
        raise AssertionError(f"unexpected request {request.url}")

    @staticmethod
    def _known(replies: dict[str, Reply], video_id: str) -> Reply:
        if video_id not in replies:  # AssertionError, not KeyError: the service turns a KeyError into a 502 and would hide the mistake
            raise AssertionError(f"the test did not set up {video_id}")
        return replies[video_id]

    @staticmethod
    def _answer(reply: Reply, request: httpx.Request) -> httpx.Response:
        if isinstance(reply, Exception):
            raise reply
        status, body = reply
        return httpx.Response(status, text=body) if isinstance(body, str) else httpx.Response(status, json=body)


@pytest.fixture(autouse=True)
def fresh_download_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """The download lock belongs to the event loop that first waits on it, and each test runs its own loop."""
    monkeypatch.setattr(youtube_client, "_download_lock", asyncio.Lock())
    monkeypatch.setattr(youtube_client, "_last_download", float("-inf"))


@pytest.fixture
def youtube(upstream) -> FakeYoutube:
    fake = FakeYoutube()
    fake.seen = upstream(fake)
    return fake


async def post(client, path: str, body: dict) -> httpx.Response:
    return await client.post(path, json=body, headers=AUTH)


def detail(response: httpx.Response) -> dict:
    return response.json()["detail"]


# --- search ----------------------------------------------------------------------------------------------------------


def catalog(youtube: FakeYoutube) -> None:
    youtube.hits = [
        hit(1, "Ahri vs Zed: full guide", "Alpha", "12:00", "2 months ago"),
        hit(2, "Kai'Sa matchups explained", "Beta", "1:02:03", "Streamed 2 years ago"),
        hit(3, "Ahri quick tip", "Gamma", "0:45", "3 weeks ago"),
        hit(4, "Ahri LIVE now", "Delta", None, None),
        hit(1, "Ahri vs Zed: full guide", "Alpha", "12:00", "2 months ago"),
    ]


async def test_search_parses_videos_and_keeps_youtubes_order(client, youtube):
    catalog(youtube)
    response = await post(client, "/youtube/search", {"query": "ahri matchup"})
    assert response.status_code == 200
    videos = response.json()["videos"]
    assert [video["id"] for video in videos] == [vid(1), vid(2), vid(3), vid(4)]  # the repeat of video 1 is dropped
    assert videos[1] == {
        "id": vid(2),
        "title": "Kai'Sa matchups explained",
        "channel": "Beta",
        "seconds": 3723,
        "published": "Streamed 2 years ago",
        "age_months": 24,
        "url": f"https://youtu.be/{vid(2)}",
    }
    assert (videos[3]["seconds"], videos[3]["published"], videos[3]["age_months"]) == (None, "", None)  # a live stream has neither


async def test_search_asks_for_videos_only_through_the_web_client(client, youtube):
    catalog(youtube)
    await post(client, "/youtube/search", {"query": "ahri matchup"})
    (call,) = youtube.seen
    body = json.loads(call.content)
    assert body["query"] == "ahri matchup"
    assert body["params"] == "EgIQAQ%3D%3D"
    assert body["context"]["client"]["clientName"] == "WEB"


@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        ({}, [1, 2, 3, 4]),
        ({"title_terms": ["kaisa"]}, [2]),
        ({"title_terms": ["AHRI", "Full Guide"]}, [1]),
        ({"title_terms": ["ahri", "kaisa"]}, []),
        ({"max_age_months": 6}, [1, 3]),  # 24 months is too old and a live stream has no age, so both go
        ({"min_seconds": 600}, [1, 2]),  # 45 s is too short and a live stream has no length
        ({"max_seconds": 800}, [1, 3]),
        ({"min_seconds": 60, "max_seconds": 800}, [1]),
        ({"max_results": 2}, [1, 2]),
    ],
    ids=["none", "term", "terms-ignore-case-and-spaces", "every-term", "age", "min", "max", "between", "cut"],
)
async def test_search_filters(client, youtube, filters, expected):
    catalog(youtube)
    response = await post(client, "/youtube/search", {"query": "ahri matchup", **filters})
    assert [video["id"] for video in response.json()["videos"]] == [vid(n) for n in expected]


def timeout(request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("too slow", request=request)


@pytest.mark.parametrize(
    "respond",
    [
        lambda request: httpx.Response(500, text="oops"),
        lambda request: httpx.Response(200, text="<html>consent page</html>"),
        lambda request: httpx.Response(200, json={"contents": {}}),
        lambda request: httpx.Response(200, json=[1, 2, 3]),
        lambda request: httpx.Response(200, json={"contents": {"twoColumnSearchResultsRenderer": {"primaryContents": {"sectionListRenderer": {"contents": [{"itemSectionRenderer": {"contents": [{"videoRenderer": {"title": {"runs": []}}}]}}]}}}}}),
        timeout,
    ],
    ids=["status", "not-json", "no-results-block", "list", "no-video-id", "timeout"],
)
async def test_search_failures_are_a_502_never_a_500(client, upstream, respond):
    upstream(respond)
    response = await post(client, "/youtube/search", {"query": "ahri matchup"})
    assert response.status_code == 502
    assert detail(response)["code"] == "upstream_error"


# --- transcript ------------------------------------------------------------------------------------------------------


async def test_transcript_prefers_a_manual_track_and_keeps_the_signature(client, youtube):
    video_id = vid(1)
    youtube.players[video_id] = (200, player(track(video_id, asr=True, signature="AUTO"), track(video_id, signature="MANUAL")))
    youtube.captions[video_id] = (200, json3(SPEECH))
    response = await post(client, "/youtube/transcript", {"video_id": video_id})
    assert response.status_code == 200
    assert response.json()["generated"] is False
    (caption_call,) = youtube.caption_calls
    assert caption_call.url.params["signature"] == "MANUAL"
    assert caption_call.url.params.get_list("fmt") == ["json3"]  # replaced, not added next to srv3
    assert "srv3" not in str(caption_call.url)
    (player_call,) = youtube.calls("/youtubei/v1/player")
    assert json.loads(player_call.content)["context"]["client"]["clientName"] == "ANDROID"
    assert player_call.headers["User-Agent"].startswith("com.google.android.youtube/")


async def test_transcript_falls_back_to_an_auto_track_and_takes_any_english(client, youtube):
    youtube.players[vid(1)] = (200, player(track(vid(1), language="es"), track(vid(1), language="en-GB", asr=True)))
    youtube.captions[vid(1)] = (200, json3(SPEECH))
    body = (await post(client, "/youtube/transcript", {"video_id": vid(1)})).json()
    assert (body["language"], body["generated"]) == ("en-GB", True)


async def test_transcript_without_a_query_returns_every_part_in_order(client, youtube):
    youtube.video(1)
    response = await post(client, "/youtube/transcript", {"video_id": vid(1), "max_passages": 1, "part_chars": 300})
    body = response.json()
    passages = body["passages"]
    spoken = [text for _, text in SPEECH]
    assert [passage["id"] for passage in passages] == [f"p{n}" for n in range(1, len(passages) + 1)]
    assert len(passages) == body["parts"] > 3  # max_passages did not cut it
    assert " ".join(passage["text"] for passage in passages) == " ".join(spoken)  # nothing lost, the empty events gone
    assert body["chars"] == len(" ".join(spoken))
    assert all(passage["score"] is None for passage in passages)
    assert passages[0]["at"] == 0 and passages[0]["url"] == f"https://youtu.be/{vid(1)}"  # no ?t= at the start
    ats = [passage["at"] for passage in passages]
    assert ats == sorted(ats) and set(ats) <= {second for second, _ in SPEECH}  # whole seconds, each a first event's start
    assert all(passage["url"] == f"https://youtu.be/{vid(1)}?t={passage['at']}" for passage in passages[1:])
    assert all(len(passage["text"]) >= 300 for passage in passages[:-1])


async def test_transcript_with_a_query_returns_the_best_parts_and_may_return_none(client, youtube):
    youtube.video(1)
    everything = (await post(client, "/youtube/transcript", {"video_id": vid(1), "part_chars": 300})).json()["passages"]
    holder = next(passage for passage in everything if NEEDLE in passage["text"])

    best = (await post(client, "/youtube/transcript", {"video_id": vid(1), "part_chars": 300, "query": "trade charm level three"})).json()
    assert [(passage["id"], passage["at"], passage["url"]) for passage in best["passages"]] == [(holder["id"], holder["at"], holder["url"])]
    assert best["passages"][0]["score"] > 0
    assert best["parts"] == len(everything)

    limited = (await post(client, "/youtube/transcript", {"video_id": vid(1), "part_chars": 300, "query": "farming wave", "max_passages": 2})).json()
    assert len(limited["passages"]) == 2
    assert limited["passages"][0]["score"] >= limited["passages"][1]["score"]

    nothing = await post(client, "/youtube/transcript", {"video_id": vid(1), "query": "zeppelin"})
    assert nothing.status_code == 200 and nothing.json()["passages"] == []


async def test_a_transcript_is_fetched_once_and_kept_for_good(client, youtube, tmp_path):
    youtube.video(1)
    first = (await post(client, "/youtube/transcript", {"video_id": vid(1), "part_chars": 600})).json()
    seen = len(youtube.seen)
    second = (await post(client, "/youtube/transcript", {"video_id": vid(1)})).json()
    assert (first["cached"], second["cached"]) == (False, True)
    assert len(youtube.seen) == seen == 2  # /player and the caption file, then nothing
    assert second["parts"] < first["parts"]  # the cache holds the text, so a new part size needs no new download
    stored = Cache(tmp_path / "cache").get("captions", vid(1))
    assert set(stored) == {"language", "generated", "events", "source"}
    assert (first["source"], second["source"], stored["source"]) == ("captions",) * 3
    assert stored["events"][:2] == [{"at": 0, "text": FILLER[0][1]}, {"at": 10, "text": FILLER[1][1]}]
    for path in (tmp_path / "cache" / "captions").glob("*.json"):
        os.utime(path, (0, 0))  # a transcript has no expiry: even a file from 1970 is served
    assert (await post(client, "/youtube/transcript", {"video_id": vid(1)})).json()["cached"] is True
    assert len(youtube.seen) == 2


@pytest.mark.parametrize(
    ("code", "reply", "text"),
    [
        ("no_captions", (200, player()), "no captions"),
        ("no_english", (200, player(track(vid(1), language="es"), track(vid(1), language="fr"))), "es, fr"),
        ("unplayable", (200, player(status="LOGIN_REQUIRED", reason="Sign in to confirm your age")), "Sign in to confirm your age"),
        ("unplayable", (200, player(status="UNPLAYABLE", reason="Video unavailable")), "Video unavailable"),
        ("unplayable", (200, player(status="ERROR", reason="This video has been removed")), "This video has been removed"),
        ("unplayable", (200, player(status="AGE_VERIFICATION_REQUIRED")), "AGE_VERIFICATION_REQUIRED"),
    ],
    ids=["no_captions", "no_english", "age gate", "unavailable", "removed", "age verification"],
)
async def test_a_video_with_no_usable_captions_is_a_404_and_asking_again_costs_nothing(client, youtube, code, reply, text):
    youtube.players[vid(1)] = reply
    first = await post(client, "/youtube/transcript", {"video_id": vid(1)})
    assert first.status_code == 404
    assert detail(first)["code"] == code
    assert text in detail(first)["message"]
    seen = len(youtube.seen)
    second = await post(client, "/youtube/transcript", {"video_id": vid(1)})
    assert (second.status_code, detail(second)) == (404, detail(first))
    assert len(youtube.seen) == seen == 1
    assert youtube.caption_calls == []


@pytest.mark.parametrize(
    ("status", "reason"),
    [
        ("LOGIN_REQUIRED", "Sign in to confirm you\u2019re not a bot"),  # YouTube's answer to every video from a flagged address
        ("LIVE_STREAM_OFFLINE", "This live event will begin in 2 hours."),  # a premiere that has not started
    ],
    ids=["bot check", "not live yet"],
)
async def test_a_playability_answer_about_this_address_or_this_hour_is_not_remembered_as_the_videos(client, youtube, status, reason):
    youtube.players[vid(1)] = (200, player(status=status, reason=reason))
    first = await post(client, "/youtube/transcript", {"video_id": vid(1)})
    assert (first.status_code, detail(first)["code"]) == (404, "unplayable")
    assert reason in detail(first)["message"]
    youtube.players[vid(1)] = (200, player(track(vid(1))))  # the check has lifted, or the stream has started and has captions
    youtube.captions[vid(1)] = (200, json3(SPEECH))
    second = await post(client, "/youtube/transcript", {"video_id": vid(1)})
    assert second.status_code == 200
    assert youtube.player_ids == [vid(1), vid(1)]  # asked again, not answered from a week-long miss


async def test_a_remembered_miss_is_asked_about_again_after_a_week(client, youtube, tmp_path):
    youtube.players[vid(1)] = (200, player())
    await post(client, "/youtube/transcript", {"video_id": vid(1)})
    old = time.time() - 8 * 24 * 3600
    for path in (tmp_path / "cache" / "captions-miss").glob("*.json"):
        os.utime(path, (old, old))
    youtube.players[vid(1)] = (200, player(track(vid(1))))
    youtube.captions[vid(1)] = (200, json3(SPEECH))
    assert (await post(client, "/youtube/transcript", {"video_id": vid(1)})).status_code == 200


async def test_a_track_that_needs_a_po_token_is_a_502_and_is_not_remembered(client, youtube):
    youtube.players[vid(1)] = (200, player(track(vid(1), extra="&exp=xpe")))
    for expected_calls in (1, 2):
        response = await post(client, "/youtube/transcript", {"video_id": vid(1)})
        assert (response.status_code, detail(response)["code"]) == (502, "po_token_required")
        assert len(youtube.calls("/youtubei/v1/player")) == expected_calls
    assert youtube.caption_calls == []


@pytest.mark.parametrize(
    ("where", "reply"),
    [
        ("captions", (500, "boom")),
        ("captions", (200, "")),
        ("captions", (200, {"unexpected": True})),
        ("captions", (200, {"events": [{"tStartMs": 0}]})),
        ("captions", (200, {"events": [{"tStartMs": "soon", "segs": [{"utf8": "hello"}]}]})),
        ("captions", httpx.ReadTimeout("too slow")),
        ("players", (500, "boom")),
        ("players", (200, "<html>")),
        ("players", (200, [])),
        ("players", (200, {})),
        ("players", httpx.ConnectError("no route")),
    ],
    ids=["caption-status", "caption-empty", "caption-shape", "caption-no-text", "caption-bad-start", "caption-timeout", "player-status", "player-html", "player-list", "player-no-status", "player-connect"],
)
async def test_upstream_faults_are_a_502_and_nothing_is_kept(client, youtube, tmp_path, where, reply):
    youtube.video(1)
    getattr(youtube, where)[vid(1)] = reply
    response = await post(client, "/youtube/transcript", {"video_id": vid(1)})
    assert response.status_code == 502
    assert detail(response)["code"] == "upstream_error"
    assert list((tmp_path / "cache").glob("*/*.json")) == []


@pytest.mark.parametrize("video_id", ["short", "x" * 12, "has space!", ""])
async def test_a_malformed_video_id_is_a_422_before_any_request(client, youtube, video_id):
    response = await post(client, "/youtube/transcript", {"video_id": video_id})
    assert response.status_code == 422
    assert youtube.seen == []


# --- the caption throttle --------------------------------------------------------------------------------------------


async def test_a_429_is_remembered_and_stops_every_later_caption_download(client, youtube, tmp_path):
    for n in (1, 2, 3):
        youtube.video(n)
    youtube.captions[vid(2)] = (429, "<html>Sorry...</html>")
    assert (await post(client, "/youtube/transcript", {"video_id": vid(1)})).status_code == 200

    limited = await post(client, "/youtube/transcript", {"video_id": vid(2)})
    assert limited.status_code == 429
    assert detail(limited)["code"] == "rate_limited"
    assert limited.headers["Retry-After"] == "3600"
    assert len(youtube.caption_calls) == 2  # one refused download, no retry
    until = Cache(tmp_path / "cache").get("throttle", "captions")["until"]
    assert 3590 < until - time.time() <= 3600

    requests_so_far = len(youtube.seen)
    later = await post(client, "/youtube/transcript", {"video_id": vid(3)})
    assert (later.status_code, detail(later)["code"]) == (429, "rate_limited")
    assert 3590 <= int(later.headers["Retry-After"]) <= 3600
    assert len(youtube.seen) == requests_so_far  # nothing is asked of YouTube while the throttle lasts

    cached = await post(client, "/youtube/transcript", {"video_id": vid(1)})
    assert (cached.status_code, cached.json()["cached"]) == (200, True)


async def test_the_throttle_ends_when_its_time_has_passed(client, youtube, tmp_path):
    youtube.video(1)
    Cache(tmp_path / "cache").set("throttle", "captions", {"until": time.time() - 1})
    assert (await post(client, "/youtube/transcript", {"video_id": vid(1)})).status_code == 200
    assert len(youtube.caption_calls) == 1


async def test_a_throttled_video_with_no_captions_still_gets_its_404(client, youtube):
    youtube.players[vid(1)] = (200, player())
    await post(client, "/youtube/transcript", {"video_id": vid(1)})
    youtube.video(2)
    youtube.captions[vid(2)] = (429, "")
    await post(client, "/youtube/transcript", {"video_id": vid(2)})
    again = await post(client, "/youtube/transcript", {"video_id": vid(1)})
    assert (again.status_code, detail(again)["code"]) == (404, "no_captions")


async def test_caption_downloads_run_one_at_a_time_with_the_configured_gap(client, youtube, monkeypatch):
    monkeypatch.setenv("RESEARCH_TOOLS_YOUTUBE_CAPTION_GAP_SECONDS", "0.2")
    get_settings.cache_clear()
    for n in (1, 2, 3):
        youtube.video(n)
    responses = await asyncio.gather(*(post(client, "/youtube/transcript", {"video_id": vid(n)}) for n in (1, 2, 3)))
    assert [response.status_code for response in responses] == [200, 200, 200]
    gaps = [later - earlier for earlier, later in zip(youtube.caption_times, youtube.caption_times[1:], strict=False)]
    assert len(gaps) == 2 and all(gap >= 0.15 for gap in gaps)


async def test_two_requests_for_one_video_download_it_once(client, youtube):
    youtube.video(1)
    youtube.delay = 0.02
    responses = await asyncio.gather(*(post(client, "/youtube/transcript", {"video_id": vid(1)}) for _ in range(2)))
    assert sorted(response.json()["cached"] for response in responses) == [False, True]
    assert len(youtube.caption_calls) == 1


# --- research --------------------------------------------------------------------------------------------------------


RESEARCH = {"query": "ahri matchup guide", "focus": "trade charm level three", "min_chars": 500}


async def test_research_ranks_against_focus_and_falls_back_to_the_query(client, youtube):
    youtube.video(1, asr=True, hit_kwargs={"title": "Ahri matchup guide", "channel": "Alpha"})
    response = await post(client, "/youtube/research", {**RESEARCH, "part_chars": 300})
    assert response.status_code == 200
    body = response.json()
    assert (body["skipped"], body["rate_limited"]) == ([], False)
    (video,) = body["videos"]
    assert (video["id"], video["channel"], video["language"], video["generated"], video["source"]) == (vid(1), "Alpha", "en", True, "captions")
    assert video["url"] == f"https://youtu.be/{vid(1)}" and video["published"] == "2 months ago" and video["seconds"] == 600
    assert video["chars"] == len(" ".join(text for _, text in SPEECH)) and video["parts"] > 3
    assert NEEDLE in video["passages"][0]["text"] and video["passages"][0]["score"] > 0
    assert video["passages"][0]["at"] > 0
    assert video["passages"][0]["url"] == f"https://youtu.be/{vid(1)}?t={video['passages'][0]['at']}"

    byquery = await post(client, "/youtube/research", {"query": "trade charm level three", "min_chars": 500, "max_passages_per_video": 1})
    (video,) = byquery.json()["videos"]
    assert len(video["passages"]) == 1 and NEEDLE in video["passages"][0]["text"]


async def test_research_caps_videos_per_channel_and_in_total(client, youtube):
    for n, channel in enumerate(["Alpha", "Alpha", "Alpha", "Beta", "Gamma", "Delta"], start=1):
        youtube.video(n, hit_kwargs={"channel": channel})
    response = await post(client, "/youtube/research", {**RESEARCH, "max_per_channel": 2, "max_videos": 3})
    body = response.json()
    assert [video["id"] for video in body["videos"]] == [vid(1), vid(2), vid(4)]
    assert body["skipped"] == []  # the third Alpha video is passed over without a mention
    assert [request.url.params["v"] for request in youtube.caption_calls] == [vid(1), vid(2), vid(4)]  # and never downloaded


async def test_research_without_a_gemini_key_fetches_one_transcript_at_a_time(client, youtube):
    for n in (1, 2, 3):
        youtube.video(n)
    youtube.delay = 0.01  # long enough that two requests made together would show
    body = (await post(client, "/youtube/research", RESEARCH)).json()
    assert [video["id"] for video in body["videos"]] == [vid(1), vid(2), vid(3)]
    assert [request.url.path for request in youtube.seen] == ["/youtubei/v1/search", *["/youtubei/v1/player", "/api/timedtext"] * 3]


async def test_research_says_why_each_video_was_skipped(client, youtube):
    for n in range(1, 9):
        youtube.video(n)
    youtube.players[vid(1)] = (200, player())
    youtube.players[vid(2)] = (200, player(track(vid(2), language="de")))
    youtube.players[vid(3)] = (200, player(status="UNPLAYABLE", reason="Video unavailable"))
    youtube.players[vid(4)] = (200, player(track(vid(4), extra="&exp=xpe")))
    youtube.captions[vid(5)] = (500, "boom")
    youtube.captions[vid(6)] = (200, json3([(0, "a very short talk"), (4, "that says little")]))
    youtube.captions[vid(7)] = (200, json3(FILLER))
    response = await post(client, "/youtube/research", RESEARCH)
    body = response.json()
    assert [(skipped["id"], skipped["reason"]) for skipped in body["skipped"]] == [
        (vid(1), "no_captions"),
        (vid(2), "no_english"),
        (vid(3), "unplayable"),
        (vid(4), "po_token_required"),
        (vid(5), "error"),
        (vid(6), "too_short"),
        (vid(7), "no_match"),
    ]
    assert body["skipped"][0]["title"] == "Ahri matchup guide"
    assert [video["id"] for video in body["videos"]] == [vid(8)]
    assert body["rate_limited"] is False


async def test_research_answers_by_its_deadline_with_what_is_done_and_names_the_video_still_being_fetched(client, youtube):
    for n in (1, 2, 3):
        youtube.video(n)
    # Video 1 answers at once and video 2 stalls far past the deadline, so no runner's speed can move either across it:
    # the answer is video 1, video 2 cut off mid-fetch, and video 3 never started.
    youtube.delays = {vid(2): 60.0}
    started = time.monotonic()
    body = (await post(client, "/youtube/research", {**RESEARCH, "deadline_seconds": 1.0})).json()
    assert time.monotonic() - started < 30  # the deadline cut video 2's minute short
    assert [video["id"] for video in body["videos"]] == [vid(1)]
    assert [(skipped["id"], skipped["reason"]) for skipped in body["skipped"]] == [(vid(2), "timeout")]
    assert youtube.player_ids == [vid(1), vid(2)]  # the third video is never started
    assert (await post(client, "/youtube/research", {**RESEARCH, "deadline_seconds": 0})).status_code == 422


async def test_a_video_cut_off_at_the_deadline_keeps_downloading_into_the_cache_for_the_retry(client, youtube):
    youtube.video(1)
    youtube.delays = {vid(1): 0.6}
    first = (await post(client, "/youtube/research", {**RESEARCH, "deadline_seconds": 0.2})).json()
    assert ([skipped["reason"] for skipped in first["skipped"]], first["videos"]) == (["timeout"], [])
    await asyncio.sleep(1.0)  # the cut-off fetch was not cancelled, so it finishes and stores the transcript
    retry = (await post(client, "/youtube/research", {**RESEARCH, "deadline_seconds": 0.2})).json()
    assert [video["id"] for video in retry["videos"]] == [vid(1)]
    assert len(youtube.caption_calls) == 1  # the retry was served from the cache


@pytest.fixture
def slow_fetch(monkeypatch):
    """fetch_captions replaced by one that waits `seconds`; records its calls and whether it was cancelled."""
    from app.clients import youtube as client_module

    class Slow:
        calls: list[str] = []
        cancelled: list[str] = []
        seconds = 30.0

    async def fetch(http, cache, settings, video_id, gemini_until=None):
        Slow.calls.append(video_id)
        try:
            await asyncio.sleep(Slow.seconds)
        except asyncio.CancelledError:
            Slow.cancelled.append(video_id)
            raise
        raise ToolError("no_captions", 404, "none")

    Slow.calls, Slow.cancelled, Slow.seconds = [], [], 30.0
    monkeypatch.setattr(client_module, "fetch_captions", fetch)
    return Slow


async def test_a_retry_joins_the_fetch_still_running_for_the_same_video(client, youtube, slow_fetch):
    youtube.video(1)
    slow_fetch.seconds = 0.5
    body = {**RESEARCH, "deadline_seconds": 0.1}
    first = (await post(client, "/youtube/research", body)).json()
    second = (await post(client, "/youtube/research", body)).json()
    assert [s["reason"] for s in first["skipped"]] == [s["reason"] for s in second["skipped"]] == ["timeout"]
    assert slow_fetch.calls == [vid(1)]  # one fetch, not two
    await asyncio.sleep(0.6)
    assert youtube_api._inflight == {}  # the entry goes when the fetch ends


async def test_a_fetch_past_the_deadline_is_cancelled_at_the_hard_ceiling(client, youtube, slow_fetch, monkeypatch):
    youtube.video(1)
    monkeypatch.setattr(youtube_api, "LATE_FETCH_CEILING_SECONDS", 0.3)
    await post(client, "/youtube/research", {**RESEARCH, "deadline_seconds": 0.1})
    assert slow_fetch.cancelled == []
    await asyncio.sleep(0.5)
    assert slow_fetch.cancelled == [vid(1)]
    assert youtube_api._inflight == {}


async def test_shutdown_cancels_fetches_still_in_flight(client, youtube, slow_fetch):
    youtube.video(1)
    async with app.router.lifespan_context(app):
        await post(client, "/youtube/research", {**RESEARCH, "deadline_seconds": 0.1})
        assert slow_fetch.cancelled == []
    assert slow_fetch.cancelled == [vid(1)]
    assert youtube_api._inflight == {}


def test_research_has_a_deadline_of_its_own_below_the_coachs_90_seconds():
    assert YoutubeResearchRequest(query="ahri matchup").deadline_seconds == 70


async def test_research_after_a_rate_limit_asks_youtube_for_nothing_more_and_still_serves_cached_videos(client, youtube):
    for n in (1, 2, 3, 4):
        youtube.video(n)
    # Video 4 was fetched on an earlier day; video 2 is where YouTube starts refusing.
    await post(client, "/youtube/transcript", {"video_id": vid(4)})
    youtube.captions[vid(2)] = (429, "<html>Sorry...</html>")
    first = (await post(client, "/youtube/research", RESEARCH)).json()
    # The walk goes on past the refusal: the cached video behind it is served, the uncached ones are skipped.
    assert [video["id"] for video in first["videos"]] == [vid(1), vid(4)]
    assert [(skipped["id"], skipped["reason"]) for skipped in first["skipped"]] == [(vid(2), "rate_limited"), (vid(3), "rate_limited")]
    assert first["rate_limited"] is True
    # After the 429 nothing more is asked of YouTube: no caption download and no player call for video 3.
    assert [request.url.params["v"] for request in youtube.caption_calls] == [vid(4), vid(1), vid(2)]
    assert youtube.player_ids == [vid(4), vid(1), vid(2)]

    again = (await post(client, "/youtube/research", RESEARCH)).json()
    assert [video["id"] for video in again["videos"]] == [vid(1), vid(4)]  # both from the cache
    assert [skipped["reason"] for skipped in again["skipped"]] == ["rate_limited", "rate_limited"] and again["rate_limited"] is True
    assert len(youtube.caption_calls) == 3


async def test_research_looks_at_no_more_than_twelve_candidates(client, youtube):
    for n in range(1, 21):
        youtube.hits.append(hit(n))
        youtube.players[vid(n)] = (200, player())
    body = (await post(client, "/youtube/research", {**RESEARCH, "max_videos": 8})).json()
    assert [skipped["id"] for skipped in body["skipped"]] == [vid(n) for n in range(1, 13)]
    assert youtube.player_ids == [vid(n) for n in range(1, 13)]
    assert body["videos"] == []


async def test_research_only_fetches_videos_the_filters_let_through(client, youtube):
    youtube.hits = [
        hit(1, "Ahri matchup guide", length="10:00", published="2 months ago"),
        hit(2, "Ahri matchup guide", length="1:02:03"),
        hit(3, "Ahri matchup guide", published="2 years ago"),
        hit(4, "Ahri matchup guide", length=None, published=None),
        hit(5, "Ahri matchup guide", length="0:45"),
        hit(6, "Zed matchup guide"),
        hit(7, "Ahri matchup guide", published=None),
    ]
    youtube.players[vid(1)] = (200, player())
    response = await post(client, "/youtube/research", {**RESEARCH, "title_terms": ["ahri"]})
    assert [skipped["id"] for skipped in response.json()["skipped"]] == [vid(1)]
    assert youtube.player_ids == [vid(1)]


async def test_research_with_a_query_too_narrow_for_youtube_searches_once_more_on_the_title_terms(client, youtube):
    narrow = "Fizz vs Ahri mid matchup guide level 1 6 charm cooldown"
    youtube.video(1, hit_kwargs={"title": "Fizz vs Ahri matchup guide"})
    youtube.hits_for = {narrow: [], "Fizz Ahri": youtube.hits}
    searched = lambda: [json.loads(request.content)["query"] for request in youtube.calls("/youtubei/v1/search")]  # noqa: E731
    body = (await post(client, "/youtube/research", {**RESEARCH, "query": narrow, "title_terms": ["Fizz", "Ahri"]})).json()
    assert [video["id"] for video in body["videos"]] == [vid(1)]
    assert searched() == [narrow, "Fizz Ahri"]
    # With no title terms there is no wider search to fall back on, and a search that found videos is not repeated.
    assert (await post(client, "/youtube/research", {**RESEARCH, "query": narrow})).json()["videos"] == []
    assert [video["id"] for video in (await post(client, "/youtube/research", {**RESEARCH, "title_terms": ["Fizz", "Ahri"]})).json()["videos"]] == [vid(1)]
    assert searched() == [narrow, "Fizz Ahri", narrow, RESEARCH["query"]]


async def test_a_failed_search_is_the_routes_own_502(client, youtube):
    youtube.search_reply = (500, "boom")
    response = await post(client, "/youtube/research", RESEARCH)
    assert (response.status_code, detail(response)["code"]) == (502, "upstream_error")


# --- the token -------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/youtube/search", {"query": "ahri matchup"}),
        ("/youtube/transcript", {"video_id": "abcdefghijk"}),
        ("/youtube/research", {"query": "ahri matchup"}),
    ],
)
@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}], ids=["no-token", "wrong-token"])
async def test_every_youtube_route_refuses_a_missing_or_wrong_token(client, youtube, path, body, headers):
    response = await client.post(path, json=body, headers=headers)
    assert (response.status_code, detail(response)["code"]) == (401, "auth_invalid")
    assert youtube.seen == []


# --- pure helpers ----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "seconds"),
    [("1:02:03", 3723), ("35:49", 2149), ("0:45", 45), ("10:00:00", 36000), (None, None), ("", None), ("LIVE", None), ("1:xx", None)],
)
def test_length_text_to_seconds(text, seconds):
    assert length_seconds(text) == seconds


@pytest.mark.parametrize(
    ("text", "months"),
    [
        ("8 months ago", 8),
        ("1 month ago", 1),
        ("1 year ago", 12),
        ("Streamed 2 years ago", 24),
        ("3 weeks ago", 0.75),
        ("Premiered 5 hours ago", 0),
        ("2 days ago", 0),
        ("10 minutes ago", 0),
        ("30 seconds ago", 0),
        ("Scheduled for tomorrow", None),
        ("", None),
        (None, None),
    ],
)
def test_published_text_to_months(text, months):
    assert age_months(text) == months


@pytest.mark.parametrize(
    ("text", "ceiling"),
    [("11 months ago", 12), ("1 year ago", 24), ("Streamed 2 years ago", 36), ("3 weeks ago", 1), ("2 months ago", 3), ("5 hours ago", 1 / 30), ("20 days ago", 21 / 30), ("Scheduled for tomorrow", None), (None, None)],
)
def test_published_text_to_the_oldest_age_it_can_mean(text, ceiling):
    assert age_months_ceiling(text) == pytest.approx(ceiling) if ceiling is not None else age_months_ceiling(text) is None


@pytest.mark.parametrize(("published", "kept"), [("11 months ago", True), ("1 year ago", False), ("2 months ago", True), ("2 years ago", False)])
async def test_the_age_filter_reads_youtubes_rounded_down_age_as_its_oldest_meaning(client, youtube, published, kept):
    youtube.hits = [hit(1, published=published)]
    response = await post(client, "/youtube/search", {"query": "ahri matchup", "max_age_months": 12})
    assert [video["id"] for video in response.json()["videos"]] == ([vid(1)] if kept else [])


@pytest.mark.parametrize(
    ("title", "terms", "matches"),
    [
        ("Kai'Sa Guide", ["kaisa"], True),
        ("Ahri vs. Zed!", ["ahri vs zed"], True),
        ("Ahri vs Zed", ["AHRI", "vs Zed"], True),
        ("Level 3 trade", ["level3"], True),
        ("Ahri vs Zed", ["ahri", "fizz"], False),
        ("Ahri vs Zed", ["fizz"], False),
        ("Anything at all", [], True),
    ],
)
def test_title_terms_ignore_case_spaces_and_punctuation(title, terms, matches):
    assert title_matches(title, terms) is matches


def test_caption_passages_close_a_part_once_it_reaches_the_target_length():
    captions = Captions("en", False, [CaptionEvent(at=at, text=text) for at, text in [(5, "aaaa"), (6, "bbbb"), (7, "cccc"), (8, "dddd"), (9, "eeee")]], cached=False)
    exact = caption_passages(captions, "abcdefghijk", part_chars=9)  # "aaaa bbbb" is exactly 9 long, so it closes
    assert [(passage.id, passage.text, passage.at) for passage in exact] == [("p1", "aaaa bbbb", 5), ("p2", "cccc dddd", 7), ("p3", "eeee", 9)]
    longer = caption_passages(captions, "abcdefghijk", part_chars=10)  # 9 is short of 10, so one more event joins
    assert [(passage.text, passage.at) for passage in longer] == [("aaaa bbbb cccc", 5), ("dddd eeee", 8)]
    assert caption_passages(Captions("en", False, [], cached=False), "abcdefghijk", part_chars=9) == []
    assert captions.chars == len("aaaa bbbb cccc dddd eeee")


# --- live ------------------------------------------------------------------------------------------------------------


@pytest.mark.integration
async def test_live_search_returns_videos(client):
    """Search only: the caption URL is throttled per address, so no test here may call it."""
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": get_settings().user_agent}) as live:
        app.dependency_overrides[get_http] = lambda: live
        response = await post(client, "/youtube/search", {"query": "league of legends ahri matchup guide", "max_results": 5})
    assert response.status_code == 200
    videos = response.json()["videos"]
    assert 1 <= len(videos) <= 5
    for video in videos:
        assert re.fullmatch(r"[A-Za-z0-9_-]{11}", video["id"])
        assert video["title"] and video["channel"]
        assert video["url"] == f"https://youtu.be/{video['id']}"
    assert any(video["seconds"] for video in videos)
