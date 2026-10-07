"""Gemini as the transcript source, with Google faked: how a video is cut into clips and what each request holds, the key
that stays in its header, how the lines are read and their times kept inside their clip, every failure, the fall back to
YouTube's captions, the cache, the limit on calls in flight, and the research walk that fetches a batch at once.
Nothing here calls Google."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import traceback

import httpx
import pytest
from pydantic import ValidationError
from test_youtube import (  # noqa: F401
    RESEARCH,
    FakeYoutube,
    Reply,
    detail,
    fresh_download_state,
    hit,
    player,
    post,
    vid,
)

from app.api import youtube as youtube_api
from app.cache import Cache
from app.clients import gemini as gemini_client
from app.clients import youtube as youtube_client
from app.clients.gemini import clip_starts, parse_lines
from app.config import Settings, get_settings
from app.errors import ToolError
from app.main import app, get_http

HOST = "generativelanguage.googleapis.com"
KEY = "test-gemini-key"
MODEL = "gemini-3.8-flash"
WATCH = "https://www.youtube.com/watch?v="
INTERNAL = (500, {"error": {"code": 500, "message": "An internal error has occurred.", "status": "INTERNAL"}})


def stamp(second: int) -> str:
    return f"[{second // 60:02d}:{second % 60:02d}]"


def talk(seconds: int, every: int = 20) -> list[tuple[int, str]]:
    """What a presenter says: a line of ten words every `every` seconds."""
    return [(second, f"at second {second} we trade charm back and keep farming") for second in range(0, seconds, every)]


def lines(speech: list[tuple[int, str]]) -> str:
    return "\n".join(f"{stamp(at)} {text}" for at, text in speech)


def content(text: str, finish: str = "STOP", thinking: bool = False) -> dict:
    """Gemini's answer to a clip: the text in one part, behind a part of its own thoughts when `thinking`."""
    parts = [{"text": "[00:00] this is a thought and not the transcript", "thought": True}] if thinking else []
    return {"candidates": [{"content": {"role": "model", "parts": [*parts, {"text": text}]}, "finishReason": finish}], "usageMetadata": {"promptTokenCount": 9000}}


def answer(reply: Reply | httpx.Response) -> httpx.Response:
    if isinstance(reply, Exception):
        raise reply
    if isinstance(reply, httpx.Response):
        return reply
    status, body = reply
    return httpx.Response(status, text=body) if isinstance(body, str) else httpx.Response(status, json=body)


class FakeGemini:
    """Answers countTokens and generateContent the way Gemini does for a public YouTube video: audio costs 32 tokens a
    second, a clip is the speech inside it, and a clip that starts at the very end is a 500. Replace an entry to make one
    video or one clip misbehave."""

    def __init__(self) -> None:
        self.model = MODEL
        self.talks: dict[str, tuple[float, list[tuple[int, str]]]] = {}  # video id -> its real length and what is said
        self.tokens: dict[str, int] = {}  # video id -> the audio tokens countTokens reports
        self.count_replies: dict[str, Reply | httpx.Response] = {}
        self.clip_replies: dict[tuple[str, int], Reply | httpx.Response | list] = {}  # (video id, clip start) -> the answer, or a list of answers used up one per call (then the real clip)
        self.delay = 0.0  # seconds every call takes, so concurrent calls really overlap
        self.delays: dict[str, float] = {}  # per video, over `delay`
        self.active = 0
        self.peak = 0  # the most calls in flight at once
        self.seen: list[httpx.Request] = []  # the fixture points this at the list the upstream helper records into

    def video(self, n: int, seconds: float = 582, speech: list[tuple[int, str]] | None = None, audio_tokens: int | None = None) -> str:
        video_id = vid(n)
        self.talks[video_id] = (seconds, talk(int(seconds)) if speech is None else speech)
        self.tokens[video_id] = round(seconds * 32) if audio_tokens is None else audio_tokens
        return video_id

    @property
    def requests(self) -> list[httpx.Request]:
        return [request for request in self.seen if request.url.host == HOST]

    @property
    def others(self) -> list[httpx.Request]:
        return [request for request in self.seen if request.url.host != HOST]

    def counted(self) -> list[str]:
        """The video of every countTokens call, in order."""
        return [self._video(request) for request in self.requests if request.url.path.endswith(":countTokens")]

    def clips(self) -> list[tuple[str, int, int]]:
        """(video, start, end) of every generateContent call, in start order."""
        found = []
        for request in self.requests:
            if request.url.path.endswith(":generateContent"):
                meta = json.loads(request.content)["contents"][0]["parts"][0]["video_metadata"]
                found.append((self._video(request), int(meta["start_offset"].removesuffix("s")), int(meta["end_offset"].removesuffix("s"))))
        return sorted(found)

    @staticmethod
    def _video(request: httpx.Request) -> str:
        uri = json.loads(request.content)["contents"][0]["parts"][0]["file_data"]["file_uri"]
        assert uri.startswith(WATCH), uri
        return uri.removeprefix(WATCH)

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.method == "POST" and request.headers["x-goog-api-key"] == KEY and request.url.query == b""
        video_id = self._video(request)
        assert video_id in self.talks, f"the test did not set up {video_id}"
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            await asyncio.sleep(self.delays.get(video_id, self.delay))
            if request.url.path == f"/v1beta/models/{self.model}:countTokens":
                return answer(self.count_replies.get(video_id) or (200, self._count(video_id)))
            if request.url.path == f"/v1beta/models/{self.model}:generateContent":
                return answer(self._generate(video_id, json.loads(request.content)))
            raise AssertionError(f"unexpected request {request.url}")
        finally:
            self.active -= 1

    def _count(self, video_id: str) -> dict:
        audio = self.tokens[video_id]
        video = round(audio * 71 / 32)
        return {"totalTokens": audio + video, "promptTokensDetails": [{"modality": "VIDEO", "tokenCount": video}, {"modality": "AUDIO", "tokenCount": audio}]}

    def _generate(self, video_id: str, body: dict) -> Reply | httpx.Response:
        meta = body["contents"][0]["parts"][0]["video_metadata"]
        start, end = int(meta["start_offset"].removesuffix("s")), int(meta["end_offset"].removesuffix("s"))
        assert meta["fps"] == 0.1 and end == start + 300
        planned = self.clip_replies.get((video_id, start))
        if isinstance(planned, list):
            if planned:
                return planned.pop(0)
        elif planned is not None:
            return planned
        seconds, speech = self.talks[video_id]
        if start >= seconds - 2:
            return INTERNAL
        return 200, content(lines([(at, text) for at, text in speech if start <= at < end]))


@pytest.fixture(autouse=True)
def fresh_slots(monkeypatch: pytest.MonkeyPatch) -> None:
    """The calls' semaphore belongs to the event loop that first waits on it, and each test runs its own loop."""
    monkeypatch.setattr(gemini_client, "_slots", None)


@pytest.fixture
def youtube(upstream) -> FakeYoutube:
    fake = FakeYoutube()
    fake.seen = upstream(fake)
    return fake


@pytest.fixture
def google(upstream, youtube, monkeypatch) -> FakeGemini:
    """Gemini's host answered by FakeGemini and every other host by FakeYoutube, behind one client, with the key set."""
    fake = FakeGemini()

    def route(request: httpx.Request):
        return fake(request) if request.url.host == HOST else youtube(request)

    fake.seen = youtube.seen = upstream(route)
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    get_settings.cache_clear()
    return fake


def set_env(monkeypatch: pytest.MonkeyPatch, name: str, value: str) -> None:
    monkeypatch.setenv(name, value)
    get_settings.cache_clear()


async def transcript(client, video_id: str, **body) -> httpx.Response:
    return await post(client, "/youtube/transcript", {"video_id": video_id, **body})


async def failure(video_id: str) -> ToolError:
    """Ask the Gemini client for a transcript that must fail, with the same client and settings the routes use."""
    with pytest.raises(ToolError) as caught:
        await gemini_client.transcript(app.dependency_overrides[get_http](), get_settings(), video_id)
    return caught.value


# --- settings --------------------------------------------------------------------------------------------------------


def test_the_gemini_settings_default_to_four_calls_of_the_measured_model_and_take_either_key_name(monkeypatch):
    settings = Settings()
    assert (settings.gemini_model, settings.gemini_concurrency, settings.gemini_api_key, settings.transcript_source) == (MODEL, 4, None, "captions")
    for name in ("GEMINI_API_KEY", "RESEARCH_TOOLS_GEMINI_API_KEY"):
        monkeypatch.setenv(name, KEY)
        assert Settings().transcript_source == "gemini"
        monkeypatch.delenv(name)
    with pytest.raises(ValidationError):
        Settings(gemini_model="models/../x")  # it goes into the request path
    with pytest.raises(ValidationError):
        Settings(gemini_concurrency=0)


@pytest.mark.parametrize("padded", [f"{KEY}\n", f" {KEY} ", f"\t{KEY}\r\n"], ids=["newline", "spaces", "tab and CRLF"])
async def test_a_key_pasted_with_whitespace_around_it_is_the_key(client, google, monkeypatch, padded):
    set_env(monkeypatch, "GEMINI_API_KEY", padded)
    assert get_settings().gemini_api_key.get_secret_value() == KEY
    google.video(1)
    body = (await transcript(client, vid(1))).json()  # the fake Gemini refuses a header that is not exactly the key
    assert (body["source"], body["generated"]) == ("gemini", True)


@pytest.mark.parametrize("bad", ["gm-key-0123’456789", "gm-key-\x07abc", "gm-kéy"], ids=["smart quote", "control character", "accent"])
async def test_a_key_that_cannot_be_sent_as_a_header_leaves_transcripts_with_the_captions_and_health_names_it(client, google, youtube, monkeypatch, bad):
    set_env(monkeypatch, "GEMINI_API_KEY", bad)
    youtube.video(1)
    google.video(1)
    health = await client.get("/health")
    assert (health.json()["status"], health.json()["transcript_source"], health.json()["invalid_config"]) == ("ready", "captions", ["GEMINI_API_KEY"])
    assert "gm-k" not in health.text  # the name, never the value
    response = await transcript(client, vid(1))
    assert (response.status_code, response.json()["source"]) == (200, "captions")
    research = (await post(client, "/youtube/research", RESEARCH)).json()
    assert [(video["id"], video["source"]) for video in research["videos"]] == [(vid(1), "captions")]
    assert google.requests == []


# --- the clip plan ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("seconds", "starts"),
    [
        (584.66, [0, 300]),  # the 582 s video: 18709 audio tokens
        (2192, [0, 300, 600, 900, 1200, 1500, 1800, 2100]),
        (305, [0]),  # a clip starts only while start < length - 5, so 300 is not under 300
        (305.5, [0, 300]),
        (600, [0, 300]),
        (605.5, [0, 300, 600]),
        (5.5, [0]),
        (5, []),
        (0, []),
    ],
)
def test_clips_start_every_300_seconds_while_they_start_five_seconds_before_the_end(seconds, starts):
    assert clip_starts(seconds) == starts


async def test_the_length_is_the_audio_tokens_over_32_and_asked_with_the_url_only(client, google):
    google.video(1, audio_tokens=18709)  # video tokens are 71 a second here, so any other sum gives another length
    assert await gemini_client.video_seconds(app.dependency_overrides[get_http](), get_settings(), vid(1)) == pytest.approx(584.656, abs=0.001)
    (request,) = google.requests
    assert request.url == f"https://{HOST}/v1beta/models/{MODEL}:countTokens"
    assert json.loads(request.content) == {"contents": [{"parts": [{"file_data": {"file_uri": f"{WATCH}{vid(1)}"}}]}]}


async def test_a_video_with_no_audio_tokens_has_no_speech_and_no_clip_is_asked_for(client, google):
    google.video(1)
    google.count_replies[vid(1)] = (200, {"totalTokens": 41535, "promptTokensDetails": [{"modality": "VIDEO", "tokenCount": 41535}]})
    response = await transcript(client, vid(1))
    assert (response.status_code, detail(response)["code"]) == (404, "no_captions")
    assert google.clips() == []


@pytest.mark.parametrize(
    ("seconds", "audio_tokens", "starts"),
    [(582, 18709, [0, 300]), (2192, None, [0, 300, 600, 900, 1200, 1500, 1800, 2100])],
    ids=["582 s", "2192 s"],
)
async def test_a_video_is_transcribed_in_clips_and_the_lines_come_back_at_their_times(client, google, tmp_path, seconds, audio_tokens, starts):
    google.video(1, seconds=seconds, audio_tokens=audio_tokens)
    response = await transcript(client, vid(1))
    assert response.status_code == 200
    assert google.clips() == [(vid(1), start, start + 300) for start in starts]
    assert google.counted() == [vid(1)]
    stored = Cache(tmp_path / "cache").get("captions", vid(1))
    assert stored["events"] == [{"at": at, "text": text} for at, text in talk(seconds)]  # every line once, at its own time


@pytest.mark.parametrize(("env", "seconds", "starts", "cut"), [(None, 36000, list(range(0, 5400, 300)), 5400), ("10", 3600, [0, 300], 600), ("10", 600, [0, 300], None)], ids=["10 hours, default cap", "1 hour, cap 10 min", "exactly the cap"])
async def test_a_video_longer_than_the_cap_gets_clips_for_the_first_minutes_only_and_says_it_was_cut(client, google, tmp_path, monkeypatch, env, seconds, starts, cut):
    if env:
        set_env(monkeypatch, "RESEARCH_TOOLS_GEMINI_MAX_MINUTES", env)
    google.video(1, seconds=seconds)
    body = (await transcript(client, vid(1))).json()
    assert [start for _, start, _ in google.clips()] == starts
    assert body["cut_at_seconds"] == cut
    stored = Cache(tmp_path / "cache").get("captions", vid(1))
    assert max(event["at"] for event in stored["events"]) < starts[-1] + 300
    assert (await transcript(client, vid(1))).json()["cut_at_seconds"] == cut  # kept with the transcript


async def test_a_clip_request_holds_the_clip_the_frame_rate_the_prompt_and_nothing_else(client, google):
    google.video(1)
    await transcript(client, vid(1))
    clip_requests = [request for request in google.requests if request.url.path.endswith(":generateContent")]
    second = next(request for request in clip_requests if json.loads(request.content)["contents"][0]["parts"][0]["video_metadata"]["start_offset"] == "300s")
    assert second.url == f"https://{HOST}/v1beta/models/{MODEL}:generateContent"
    assert json.loads(second.content) == {
        "contents": [
            {
                "parts": [
                    {"file_data": {"file_uri": f"{WATCH}{vid(1)}"}, "video_metadata": {"start_offset": "300s", "end_offset": "600s", "fps": 0.1}},
                    {
                        "text": "Transcribe everything that is spoken in this video clip, word for word, in English. "
                        "Start a new line about every 20 seconds of speech and begin each line with the time it starts in the full video, as [mm:ss]. "
                        "Do not summarize or describe the screen. Output only the transcript lines."
                    },
                ]
            }
        ],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 30000, "thinkingConfig": {"thinkingBudget": 0}},
    }
    assert second.extensions["timeout"]["read"] == 45  # longer than the shared client allows a page, short enough to cut a stalled call


async def test_the_model_in_the_path_is_the_one_in_the_settings(client, google, monkeypatch):
    set_env(monkeypatch, "RESEARCH_TOOLS_GEMINI_MODEL", "gemini-3.9-pro")
    google.model = "gemini-3.9-pro"
    google.video(1)
    assert (await transcript(client, vid(1))).status_code == 200
    assert {request.url.path.split(":")[0] for request in google.requests} == {"/v1beta/models/gemini-3.9-pro"}


# --- the key ---------------------------------------------------------------------------------------------------------


async def test_the_key_is_only_ever_in_the_header(client, google, youtube, tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    google.video(1)
    google.video(2)
    google.video(3)
    google.video(4)
    google.clip_replies[(vid(2), 0)] = (403, {"error": {"code": 403, "status": "PERMISSION_DENIED"}})
    google.clip_replies[(vid(3), 0)] = (200, content("x", finish="MAX_TOKENS"))
    google.count_replies[vid(4)] = httpx.ReadTimeout("too slow")
    for n in (2, 3, 4):
        youtube.players[vid(n)] = (200, player())  # the captions have nothing either, so each answer is an error
    bodies = [(await transcript(client, vid(n))).text for n in (1, 2, 3, 4)]
    assert google.requests
    for request in google.requests:
        assert request.headers["x-goog-api-key"] == KEY
        assert request.url.query == b"" and KEY not in str(request.url) and KEY not in request.content.decode()
    assert all(KEY not in body for body in bodies)
    assert all(KEY not in path.read_text(encoding="utf-8") for path in (tmp_path / "cache").glob("*/*.json"))
    assert KEY not in caplog.text


LEAKY_URL = f"https://{HOST}/v1beta/models/{MODEL}:generateContent?key={KEY}"
# What a transport library can say when something goes wrong with a request: the key in the text and in the request's own URL.
LEAKS = {
    "connect error": httpx.ConnectError(f"cannot connect to {LEAKY_URL}", request=httpx.Request("POST", LEAKY_URL)),
    "read timeout": httpx.ReadTimeout(f"timed out reading {LEAKY_URL}", request=httpx.Request("POST", LEAKY_URL)),
    "illegal header": httpx.LocalProtocolError(f"Illegal header value b'{KEY}'"),
    "invalid url": httpx.InvalidURL(f"Invalid URL: {LEAKY_URL}"),
}


async def test_the_key_is_not_in_an_error_message_or_its_traceback(client, google):
    replies = [
        (403, "forbidden"),
        (429, "slow down"),
        (500, "boom"),
        (200, "<html>"),
        (200, content("x", finish="SAFETY")),
        httpx.ReadTimeout("too slow"),
        httpx.ConnectError("no route"),
        *LEAKS.values(),
    ]
    for reply in replies:
        google.video(1)
        google.clip_replies[(vid(1), 0)] = reply
        error = await failure(vid(1))
        assert KEY not in error.message and KEY not in "".join(traceback.format_exception(error))


@pytest.mark.parametrize("where", ["count", "clip"])
@pytest.mark.parametrize("leak", LEAKS.values(), ids=LEAKS.keys())
async def test_an_exception_that_carries_the_key_reaches_no_message_log_record_or_response(client, google, youtube, caplog, where, leak):
    caplog.set_level(logging.DEBUG)
    youtube.video(1)
    break_video(google, where, leak)
    error = await failure(vid(1))
    assert KEY not in error.message and KEY not in "".join(traceback.format_exception(error))
    response = await transcript(client, vid(1))  # Gemini fails again and the captions answer
    assert (response.status_code, response.json()["source"]) == (200, "captions")
    assert KEY not in response.text
    assert [record for record in caplog.records if record.name == "app.clients.youtube"]  # the fallback was logged, and the log is what is searched
    assert KEY not in caplog.text
    assert all(KEY not in "".join(traceback.format_exception(*record.exc_info)) for record in caplog.records if record.exc_info)


async def test_a_transport_error_gives_its_slot_back(client, google, monkeypatch):
    set_env(monkeypatch, "RESEARCH_TOOLS_GEMINI_CONCURRENCY", "1")
    google.video(1)
    google.video(2)
    google.count_replies[vid(1)] = httpx.ConnectError("no route")
    for _ in range(3):  # more failures than there are slots
        assert (await asyncio.wait_for(failure(vid(1)), timeout=2)).code == "upstream_error"
    response = await asyncio.wait_for(transcript(client, vid(2)), timeout=2)  # a leaked slot would wait here for ever
    assert response.status_code == 200


# --- the lines -------------------------------------------------------------------------------------------------------


def test_only_lines_that_start_with_a_time_are_kept_and_their_words_are_tidied():
    text = "\n".join(["Here is the transcript:", "[00:05]   first   words ", "```", "", "00:20 no brackets", "[00:20]", "[00:25] last words"])
    assert [(event.at, event.text) for event in parse_lines(text, start=0)] == [(5, "first words"), (25, "last words")]


@pytest.mark.parametrize(
    ("line", "at"),
    [
        ("[04:55] on the edge before the clip", 295),
        ("[04:54] too early for the clip", 300),
        ("[10:05] on the edge after the clip", 605),
        ("[10:06] too late for the clip", 300),
        ("[00:10] the clock started over", 300),
        ("[20:00] far past the end", 300),
        ("[06:40] inside the clip", 400),
    ],
)
def test_a_time_more_than_five_seconds_outside_its_clip_is_set_to_the_clip_start(line, at):
    (event,) = parse_lines(line, start=300)
    assert event.at == at


@pytest.mark.parametrize(
    ("line", "start", "at"),
    [
        ("- [00:20] text", 0, 20),
        ("* [00:20] text", 0, 20),
        ("**[00:20]** text", 0, 20),
        ("* **[00:20]** text", 0, 20),
        ("[00:20 - 00:40] text", 0, 20),
        ("[00:20-00:40] text", 0, 20),
        ("[00:20 – 00:40] text", 0, 20),
        ("- **[00:20 - 00:40]** text", 0, 20),
        ("[1:02:03 - 1:02:23] text", 3600, 3723),
    ],
)
def test_a_list_mark_bold_markers_or_a_range_around_the_time_are_read_and_a_range_is_placed_at_its_start(line, start, at):
    assert [(event.at, event.text) for event in parse_lines(line, start=start)] == [(at, "text")]


def test_h_mm_ss_times_and_minutes_past_fifty_nine_are_read_in_a_clip_that_far_in():
    assert [event.at for event in parse_lines("[1:05:10] a\n[65:30] b\n[1:09:59] c", start=3900)] == [3910, 3930, 4199]


async def test_a_wrong_time_stays_inside_its_own_five_minutes_and_time_never_goes_back(client, google):
    google.video(1)
    google.clip_replies[(vid(1), 0)] = (200, content("[00:00] " + " ".join(["word"] * 50) + "\n[05:04] a line the first clip puts just past its end"))
    google.clip_replies[(vid(1), 300)] = (
        200,
        content(
            "\n".join(
                [
                    "[04:56] a line the second clip puts just before its start",  # in range, but behind the 5:04 before it
                    "[00:10] the clock started over",  # out of range: the clip start, then raised
                    "[05:10] a fine line",
                    "[05:30] a later line",
                    "[05:20] a line that goes back",
                    "[20:00] a line far past the end",
                    "[09:50] the last line",
                ]
            )
        ),
    )
    events, _ = await gemini_client.transcript(app.dependency_overrides[get_http](), get_settings(), vid(1))
    assert [event.at for event in events] == [0, 304, 304, 304, 310, 330, 330, 330, 590]
    assert all(later.at >= earlier.at for earlier, later in zip(events, events[1:], strict=False))


async def test_the_thoughts_of_the_model_are_not_in_the_transcript_and_the_parts_are_joined(client, google):
    google.video(1, seconds=300)
    google.clip_replies[(vid(1), 0)] = (200, {"candidates": [{"content": {"parts": [{"text": "[00:00] this is a thought", "thought": True}, {"text": lines(talk(100))}, {"text": lines(talk(200)[5:])}]}, "finishReason": "STOP"}]})
    events, _ = await gemini_client.transcript(app.dependency_overrides[get_http](), get_settings(), vid(1))
    assert "thought" not in " ".join(event.text for event in events)
    assert [event.at for event in events] == [0, 20, 40, 60, 80, 100, 120, 140, 160, 180]


# --- failures --------------------------------------------------------------------------------------------------------

SHARED_FAILURES = {
    "forbidden": ((403, {"error": {"code": 403, "message": "The caller does not have permission", "status": "PERMISSION_DENIED"}}), "unplayable", 404),
    "quota": ((429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}}), "rate_limited", 429),
    "server error": (INTERNAL, "upstream_error", 502),
    "unavailable": ((503, {"error": {"code": 503, "status": "UNAVAILABLE"}}), "upstream_error", 502),
    "bad request": ((400, {"error": {"code": 400, "status": "INVALID_ARGUMENT"}}), "upstream_error", 502),
    "unauthorized": ((401, {"error": {"code": 401, "status": "UNAUTHENTICATED"}}), "upstream_error", 502),
    "timeout": (httpx.ReadTimeout("too slow"), "upstream_error", 502),
    "no route": (httpx.ConnectError("no route"), "upstream_error", 502),
    "not json": ((200, "<html>consent</html>"), "upstream_error", 502),
    "a list": ((200, [1, 2, 3]), "upstream_error", 502),
    "empty object": ((200, {}), "upstream_error", 502),
}
CLIP_FAILURES = {
    "stopped at the token limit": ((200, content("[00:00] cut off", finish="MAX_TOKENS")), "upstream_error", 502),
    "stopped by a filter": ((200, content("", finish="SAFETY")), "upstream_error", 502),
    "no finish reason": ((200, {"candidates": [{"content": {"parts": [{"text": "[00:00] words"}]}}]}), "upstream_error", 502),
    "no candidates": ((200, {"promptFeedback": {"blockReason": "SAFETY"}}), "upstream_error", 502),
    "no parts": ((200, {"candidates": [{"content": {}, "finishReason": "STOP"}]}), "upstream_error", 502),
}


def break_video(google: FakeGemini, where: str, reply) -> None:
    google.video(1)
    if where == "count":
        google.count_replies[vid(1)] = reply
    else:
        google.clip_replies[(vid(1), 0)] = reply


@pytest.mark.parametrize("where", ["count", "clip"])
@pytest.mark.parametrize(("reply", "code", "status"), SHARED_FAILURES.values(), ids=SHARED_FAILURES.keys())
async def test_a_gemini_failure_is_a_tool_error_with_the_code_that_says_what_to_do(client, google, where, reply, code, status):
    break_video(google, where, reply)
    error = await failure(vid(1))
    assert (error.code, error.status) == (code, status)


@pytest.mark.parametrize(("reply", "code", "status"), CLIP_FAILURES.values(), ids=CLIP_FAILURES.keys())
async def test_a_clip_answer_that_did_not_finish_or_has_no_text_is_an_upstream_error(client, google, reply, code, status):
    break_video(google, "clip", reply)
    error = await failure(vid(1))
    assert (error.code, error.status) == (code, status)


@pytest.mark.parametrize("status", [400, 401])
@pytest.mark.parametrize("where", ["count", "clip"])
async def test_a_400_or_401_says_the_key_or_the_model_was_refused_and_never_what_google_echoes(client, google, where, status):
    break_video(google, where, (status, {"error": {"code": status, "message": f"API key not valid: {KEY}", "status": "INVALID_ARGUMENT"}}))
    error = await failure(vid(1))
    assert (error.code, error.status, error.message) == ("upstream_error", 502, f"Gemini refused the API key or the model name (HTTP {status}).")


@pytest.mark.parametrize(
    ("headers", "retry_after"),
    [({"Retry-After": "17"}, 17), ({}, None), ({"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}, None), ({"Retry-After": "soon"}, None)],
    ids=["seconds", "none sent", "a date", "words"],
)
async def test_a_429_carries_the_retry_after_google_sends(client, google, headers, retry_after):
    break_video(google, "clip", httpx.Response(429, json={"error": {"status": "RESOURCE_EXHAUSTED"}}, headers=headers))
    error = await failure(vid(1))
    assert (error.code, error.status, error.retry_after) == ("rate_limited", 429, retry_after)


async def test_a_clip_that_fails_stops_the_clips_that_have_not_started(client, google, monkeypatch):
    set_env(monkeypatch, "RESEARCH_TOOLS_GEMINI_CONCURRENCY", "1")
    google.video(1, seconds=2192)  # eight clips, asked one after another
    google.clip_replies[(vid(1), 0)] = (400, {"error": {"code": 400, "status": "INVALID_ARGUMENT"}})
    google.delay = 0.01
    assert (await failure(vid(1))).code == "upstream_error"
    await asyncio.sleep(0.2)  # long enough for clips left running to be asked for: seven more, one at a time
    assert len(google.clips()) <= 2  # the failed clip, and at most the next one, which was woken as the failed one finished


PASSING_FAULTS = {"no answer in time": httpx.ReadTimeout("stalled"), "connection dropped": httpx.ConnectError("reset"), "unavailable": (503, {"error": {"status": "UNAVAILABLE"}}), "internal": INTERNAL}


def asked(google: FakeGemini, start: int) -> int:
    return sum(1 for clip in google.clips() if clip[1] == start)


@pytest.mark.parametrize("fault", PASSING_FAULTS.values(), ids=PASSING_FAULTS.keys())
async def test_a_clip_that_got_no_answer_or_a_5xx_is_asked_for_once_more(client, google, fault):
    """About one clip call in ten stalls for close to a minute; one more try gets the transcript instead of giving it up."""
    video_id = google.video(1)
    google.clip_replies[(video_id, 0)] = [fault]
    events, _ = await gemini_client.transcript(app.dependency_overrides[get_http](), get_settings(), video_id)
    assert events[0].at == 0 and events[-1].at > 300
    assert (asked(google, 0), asked(google, 300)) == (2, 1)


@pytest.mark.parametrize("fault", PASSING_FAULTS.values(), ids=PASSING_FAULTS.keys())
async def test_a_clip_that_fails_twice_fails_the_transcript_and_is_not_asked_for_a_third_time(client, google, fault):
    video_id = google.video(1)
    google.clip_replies[(video_id, 0)] = [fault, fault, fault]
    assert (await failure(video_id)).code == "upstream_error"
    assert asked(google, 0) == 2


FINAL_FAULTS = {
    "bad request": (400, {"error": {"status": "INVALID_ARGUMENT"}}),
    "unauthorized": (401, {"error": {"status": "UNAUTHENTICATED"}}),
    "forbidden": (403, {"error": {"status": "PERMISSION_DENIED"}}),
    "quota": (429, {"error": {"status": "RESOURCE_EXHAUSTED"}}),
    "not finished": (200, content("[00:00] cut off", finish="MAX_TOKENS")),
    "not json": (200, "<html>consent</html>"),
}


@pytest.mark.parametrize("fault", FINAL_FAULTS.values(), ids=FINAL_FAULTS.keys())
async def test_a_fault_that_asking_again_cannot_fix_is_not_asked_for_again(client, google, fault):
    video_id = google.video(1)
    google.clip_replies[(video_id, 0)] = [fault]
    await failure(video_id)
    assert asked(google, 0) == 1


async def test_the_500_at_the_end_of_a_video_is_asked_for_once_more_and_the_length_call_is_not_asked_for_again(client, google):
    video_id = google.video(1, seconds=600, audio_tokens=round(610 * 32))  # the estimate runs 10 s long, so a clip starts at the very end
    await gemini_client.transcript(app.dependency_overrides[get_http](), get_settings(), video_id)
    assert asked(google, 600) == 2  # a 500 that stays a 500 is the end of the video; one that does not was a passing fault
    broken = google.video(2)
    google.count_replies[broken] = (503, {"error": {"status": "UNAVAILABLE"}})
    assert (await failure(broken)).code == "upstream_error"
    assert google.counted().count(broken) == 1


async def test_a_500_on_a_clip_that_starts_near_the_end_is_an_empty_clip_and_the_rest_is_kept(client, google, tmp_path):
    # The length is a guess from tokens: this video is 901 s long and its audio says 925 s, so a clip starts at 900 and Gemini answers 500.
    google.video(1, seconds=901, speech=talk(880), audio_tokens=29600)
    response = await transcript(client, vid(1))
    assert response.status_code == 200
    assert [start for _, start, _ in google.clips()] == [0, 300, 600, 900, 900]  # the clip at 900 is asked for twice before it is called empty
    at, text = talk(880)[-1]
    assert Cache(tmp_path / "cache").get("captions", vid(1))["events"][-1] == {"at": at, "text": text}  # the last line of speech, and nothing from the empty clip


async def test_a_500_is_tolerated_only_within_thirty_seconds_of_the_estimated_end(client, google):
    google.video(1, seconds=901, speech=talk(880), audio_tokens=29792)  # 931 s: the clip at 900 is 31 s from the end
    assert (await failure(vid(1))).code == "upstream_error"
    google.video(2, seconds=901, speech=talk(880), audio_tokens=29760)  # 930 s: 30 s from the end
    events, _ = await gemini_client.transcript(app.dependency_overrides[get_http](), get_settings(), vid(2))
    assert events[-1].at == talk(880)[-1][0]
    google.video(3, seconds=901, speech=talk(880), audio_tokens=29600)
    google.clip_replies[(vid(3), 600)] = INTERNAL  # an earlier clip is never an empty one
    assert (await failure(vid(3))).code == "upstream_error"
    google.video(4)
    google.count_replies[vid(4)] = INTERNAL  # nor is the length
    assert (await failure(vid(4))).code == "upstream_error"


async def test_a_passing_500_on_the_last_clip_does_not_cut_the_transcript_off(client, google, tmp_path):
    google.video(1, seconds=625, speech=talk(625))  # speech to 620 s, in the clip that starts at 600
    google.clip_replies[(vid(1), 600)] = [INTERNAL]  # one 500, then the real answer
    assert (await transcript(client, vid(1))).status_code == 200
    assert asked(google, 600) == 2
    assert Cache(tmp_path / "cache").get("captions", vid(1))["events"][-1]["at"] == 620


async def test_a_500_on_the_only_clip_of_a_short_video_is_never_taken_for_silence(client, google, youtube, tmp_path):
    """The first clip cannot be past the end of the video, so a 500 on it is Gemini's fault, and a miss would hide the video for a week."""
    youtube.video(1)
    google.video(1, seconds=25, speech=[(0, " ".join(["word"] * 60))])
    google.clip_replies[(vid(1), 0)] = INTERNAL
    response = await transcript(client, vid(1))
    assert (response.status_code, response.json()["source"]) == (200, "captions")
    assert Cache(tmp_path / "cache").get("gemini-miss", vid(1)) is None


def clock(speech: list[tuple[int, str]]) -> str:
    """Lines that carry a time in a format this service does not read: no brackets."""
    return "\n".join(f"{at // 60:02d}:{at % 60:02d} {text}" for at, text in speech)


async def test_clips_with_times_and_no_line_this_service_reads_fall_back_to_the_captions_and_leave_no_miss(client, google, youtube, tmp_path):
    youtube.video(1)
    google.video(1)
    for start in (0, 300):
        google.clip_replies[(vid(1), start)] = (200, content(clock([(at, text) for at, text in talk(582) if start <= at < start + 300])))
    response = await transcript(client, vid(1))
    assert (response.status_code, response.json()["source"]) == (200, "captions")
    assert len(youtube.caption_calls) == 1
    assert [Cache(tmp_path / "cache").get(space, vid(1)) for space in ("gemini-miss", "captions-miss")] == [None, None]


async def test_one_unreadable_clip_does_not_become_a_gemini_transcript_with_a_hole_in_it(client, google, youtube, tmp_path):
    youtube.video(1)
    google.video(1, seconds=900)
    google.clip_replies[(vid(1), 300)] = (200, content(clock([(at, text) for at, text in talk(900) if 300 <= at < 600])))
    response = await transcript(client, vid(1))
    assert (response.status_code, response.json()["source"]) == (200, "captions")
    assert Cache(tmp_path / "cache").get("captions", vid(1))["source"] == "captions"


@pytest.mark.parametrize("silence", ["[Music]", "", "No speech in this clip.", "(applause)"])
async def test_a_clip_with_no_time_in_it_is_an_empty_clip_and_the_rest_of_the_video_is_kept(client, google, tmp_path, silence):
    google.video(1)
    google.clip_replies[(vid(1), 0)] = (200, content(silence))
    response = await transcript(client, vid(1))
    assert (response.status_code, response.json()["source"]) == (200, "gemini")
    assert Cache(tmp_path / "cache").get("captions", vid(1))["events"][0]["at"] == 300


@pytest.mark.parametrize(("words", "kept"), [(49, False), (50, True)])
async def test_a_video_with_under_50_words_is_a_miss_that_is_remembered_and_the_captions_are_not_tried(client, google, youtube, tmp_path, words, kept):
    google.video(1, speech=[(0, " ".join(["word"] * words))])
    youtube.video(1)  # YouTube has captions, but a video with no speech has none worth reading
    first = await transcript(client, vid(1))
    if kept:
        assert first.status_code == 200
        return
    assert (first.status_code, detail(first)["code"]) == (404, "no_captions")
    assert Cache(tmp_path / "cache").get("gemini-miss", vid(1))["code"] == "no_captions"
    assert Cache(tmp_path / "cache").get("captions-miss", vid(1)) is None  # YouTube's captions were never asked about this video
    seen = len(google.seen)
    second = await transcript(client, vid(1))
    assert (second.status_code, detail(second)) == (404, detail(first))
    assert len(google.seen) == seen  # asking again costs no request, to Google or to YouTube
    assert google.others == []


# --- Gemini first, the captions second -------------------------------------------------------------------------------


async def test_a_gemini_failure_does_not_hide_a_video_that_has_no_captions_from_gemini(client, google, youtube):
    google.video(1)
    google.clip_replies[(vid(1), 0)] = (429, {})
    youtube.players[vid(1)] = (200, player())  # no caption tracks
    for _ in range(2):  # Gemini keeps failing: the captions' own miss saves the second /player call
        response = await transcript(client, vid(1))
        assert (response.status_code, detail(response)["code"]) == (404, "no_captions")
    assert youtube.player_ids == [vid(1)]
    del google.clip_replies[(vid(1), 0)]  # Gemini has recovered
    response = await transcript(client, vid(1))
    assert (response.status_code, response.json()["source"]) == (200, "gemini")


async def test_a_caption_miss_from_before_the_key_was_set_does_not_hide_the_video_from_gemini(client, google, tmp_path):
    Cache(tmp_path / "cache").set("captions-miss", vid(1), {"code": "no_captions", "message": "The video has no captions."})
    google.video(1)
    assert (await transcript(client, vid(1))).json()["source"] == "gemini"


async def test_a_no_speech_miss_is_honoured_only_while_gemini_is_the_source(client, google, youtube, monkeypatch):
    google.video(1, speech=[(0, "a few words")])
    youtube.video(1)
    assert (await transcript(client, vid(1))).status_code == 404
    monkeypatch.delenv("GEMINI_API_KEY")
    get_settings.cache_clear()
    response = await transcript(client, vid(1))  # no key now: the captions are the source and know nothing of that miss
    assert (response.status_code, response.json()["source"]) == (200, "captions")


async def test_two_requests_for_one_uncached_video_transcribe_it_once(client, google):
    google.video(1)
    google.delay = 0.02
    responses = await asyncio.gather(transcript(client, vid(1)), transcript(client, vid(1)))
    assert [response.status_code for response in responses] == [200, 200]
    assert sorted(response.json()["cached"] for response in responses) == [False, True]
    assert google.counted() == [vid(1)]
    assert [start for _, start, _ in google.clips()] == [0, 300]
    assert youtube_client._busy == {}  # nothing is left behind for a video that is done


async def test_two_requests_for_one_video_with_no_speech_ask_about_it_once(client, google):
    google.video(1, speech=[(0, "a few words")])
    google.delay = 0.02
    responses = await asyncio.gather(transcript(client, vid(1)), transcript(client, vid(1)))
    assert [(response.status_code, detail(response)["code"]) for response in responses] == [(404, "no_captions")] * 2
    assert google.counted() == [vid(1)]


async def test_a_gemini_transcript_is_marked_and_kept_with_its_source(client, google, tmp_path):
    google.video(1)
    first = (await transcript(client, vid(1))).json()
    assert (first["source"], first["generated"], first["language"], first["cached"]) == ("gemini", True, "en", False)
    stored = Cache(tmp_path / "cache").get("captions", vid(1))
    assert set(stored) == {"language", "generated", "events", "source"} and stored["source"] == "gemini"
    seen = len(google.seen)
    second = (await transcript(client, vid(1))).json()
    assert (second["source"], second["cached"]) == ("gemini", True)
    assert len(google.seen) == seen  # a transcript is made once and kept for good


async def test_a_record_from_before_source_was_kept_reads_as_captions_and_is_served_without_asking_google(client, google, tmp_path):
    Cache(tmp_path / "cache").set("captions", vid(1), {"language": "en", "generated": True, "events": [{"at": 0, "text": "hello there"}]})
    body = (await transcript(client, vid(1))).json()
    assert (body["source"], body["cached"], body["generated"]) == ("captions", True, True)
    assert google.seen == []


@pytest.mark.parametrize("where", ["count", "clip"])
@pytest.mark.parametrize("reply", [reply for reply, _, _ in SHARED_FAILURES.values()], ids=SHARED_FAILURES.keys())
async def test_when_gemini_fails_the_captions_are_tried_and_the_youtube_throttle_is_left_alone(client, google, youtube, tmp_path, where, reply):
    youtube.video(1)
    break_video(google, where, reply)
    response = await transcript(client, vid(1))
    body = response.json()
    assert response.status_code == 200
    assert (body["source"], body["generated"]) == ("captions", False)
    assert len(youtube.caption_calls) == 1
    assert Cache(tmp_path / "cache").get("throttle", "captions") is None
    assert Cache(tmp_path / "cache").get("captions", vid(1))["source"] == "captions"


async def test_the_fallback_says_in_the_log_why_gemini_gave_nothing(client, google, youtube, caplog):
    """Without this line a transcript that quietly came from the captions looks like Gemini working."""
    youtube.video(1)
    break_video(google, "clip", (400, {"error": {"code": 400, "status": "INVALID_ARGUMENT"}}))
    assert (await transcript(client, vid(1))).json()["source"] == "captions"
    assert [record.getMessage() for record in caplog.records if record.name == "app.clients.youtube"] == [f"Gemini gave no transcript for {vid(1)} (upstream_error: Gemini refused the API key or the model name (HTTP 400).); trying YouTube's captions"]


@pytest.mark.parametrize("reply", [reply for reply, _, _ in CLIP_FAILURES.values()], ids=CLIP_FAILURES.keys())
async def test_a_clip_that_did_not_finish_falls_back_to_the_captions_too(client, google, youtube, reply):
    youtube.video(1)
    break_video(google, "clip", reply)
    assert (await transcript(client, vid(1))).json()["source"] == "captions"


async def test_when_gemini_and_the_captions_both_fail_the_answer_is_the_captions_error(client, google, youtube):
    google.video(1)
    google.clip_replies[(vid(1), 0)] = (429, {})
    youtube.players[vid(1)] = (200, player())
    response = await transcript(client, vid(1))
    assert (response.status_code, detail(response)["code"], detail(response)["message"]) == (404, "no_captions", "The video has no captions.")


async def test_a_gemini_rate_limit_is_not_a_youtube_throttle_and_a_real_throttle_answers_in_youtubes_words(client, google, youtube, tmp_path):
    google.video(1)
    google.clip_replies[(vid(1), 0)] = httpx.Response(429, json={}, headers={"Retry-After": "5"})
    youtube.video(1)
    Cache(tmp_path / "cache").set("throttle", "captions", {"until": time.time() + 600})
    response = await transcript(client, vid(1))
    assert response.status_code == 429
    assert "YouTube" in detail(response)["message"] and "Gemini" not in detail(response)["message"]
    assert 590 <= int(response.headers["Retry-After"]) <= 600


async def test_gemini_still_works_while_youtube_is_throttled(client, google, youtube, tmp_path):
    google.video(1)
    Cache(tmp_path / "cache").set("throttle", "captions", {"until": time.time() + 600})
    response = await transcript(client, vid(1))
    assert (response.status_code, response.json()["source"]) == (200, "gemini")
    assert google.others == []


@pytest.mark.parametrize("key", [None, ""], ids=["no key", "empty key"])
async def test_without_a_key_no_request_goes_to_google_and_the_captions_work_as_before(client, google, youtube, monkeypatch, key):
    monkeypatch.delenv("GEMINI_API_KEY")
    if key is not None:
        set_env(monkeypatch, "GEMINI_API_KEY", key)
    get_settings.cache_clear()
    google.video(1)
    youtube.video(1)
    body = (await transcript(client, vid(1))).json()
    assert (body["source"], body["generated"]) == ("captions", False)
    research = (await post(client, "/youtube/research", RESEARCH)).json()
    assert [(video["id"], video["source"]) for video in research["videos"]] == [(vid(1), "captions")]
    assert google.requests == []


# --- no more than gemini_concurrency calls at once -------------------------------------------------------------------


async def test_calls_in_flight_never_pass_the_limit_even_across_requests(client, google, monkeypatch):
    set_env(monkeypatch, "RESEARCH_TOOLS_GEMINI_CONCURRENCY", "2")
    google.delay = 0.02
    google.video(1, seconds=2192)
    google.video(2, seconds=2192)
    responses = await asyncio.gather(transcript(client, vid(1)), transcript(client, vid(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert len(google.requests) == 18  # two lengths and sixteen clips, all of them let through
    assert google.peak == 2  # at the limit, never over it: a limit for each request would show 4


async def test_four_calls_are_in_flight_at_once_by_default(client, google):
    google.delay = 0.02
    google.video(1, seconds=2192)
    assert (await transcript(client, vid(1))).status_code == 200
    assert google.peak == 4


# --- the research walk -----------------------------------------------------------------------------------------------


def candidates(google: FakeGemini, youtube: FakeYoutube, count: int, channels: dict[int, str] | None = None) -> None:
    """`count` search hits, each a video of 300 s that Gemini can transcribe. `channels` names the channel of some of them."""
    for n in range(1, count + 1):
        youtube.hits.append(hit(n, channel=(channels or {}).get(n)))
        google.video(n, seconds=300)


async def test_research_with_a_key_fetches_a_batch_at_once_and_keeps_youtubes_order(client, google, youtube):
    candidates(google, youtube, 4)
    google.delays = {vid(1): 0.08, vid(2): 0.04}  # the first hit finishes last
    google.delay = 0.01
    body = (await post(client, "/youtube/research", {**RESEARCH, "max_videos": 4})).json()
    assert [(video["id"], video["source"], video["generated"]) for video in body["videos"]] == [(vid(n), "gemini", True) for n in (1, 2, 3, 4)]
    assert body["skipped"] == []
    assert google.peak == 4  # all four at once; one at a time would be 1


async def test_research_asks_only_for_the_videos_still_needed_and_stops_when_it_has_them(client, google, youtube):
    candidates(google, youtube, 6)
    google.video(2, speech=[(0, "a few words and no more")])  # no speech
    body = (await post(client, "/youtube/research", {**RESEARCH, "max_videos": 3})).json()
    assert [video["id"] for video in body["videos"]] == [vid(1), vid(3), vid(4)]
    assert [(skipped["id"], skipped["reason"]) for skipped in body["skipped"]] == [(vid(2), "no_captions")]
    assert google.counted() == [vid(1), vid(2), vid(3), vid(4)]  # three at first, then the one still needed; 5 and 6 never asked about


async def test_research_looks_at_no_more_than_twelve_candidates_with_a_key(client, google, youtube):
    candidates(google, youtube, 20)
    for n in range(1, 21):
        google.video(n, speech=[(0, "too few words")])
    body = (await post(client, "/youtube/research", {**RESEARCH, "max_videos": 8})).json()
    assert [skipped["id"] for skipped in body["skipped"]] == [vid(n) for n in range(1, 13)]
    assert sorted(google.counted()) == [vid(n) for n in range(1, 13)]


async def test_research_keeps_the_channel_cap_with_a_key(client, google, youtube):
    candidates(google, youtube, 4, {1: "Alpha", 2: "Alpha", 3: "Alpha", 4: "Beta"})
    body = (await post(client, "/youtube/research", {**RESEARCH, "max_per_channel": 2, "max_videos": 3})).json()
    assert [video["id"] for video in body["videos"]] == [vid(1), vid(2), vid(4)]
    assert body["skipped"] == []
    assert google.counted() == [vid(1), vid(2), vid(4)]  # the third Alpha video is passed over and never asked about


async def test_a_failed_fetch_does_not_cost_a_later_video_of_its_channel_its_place(client, google, youtube):
    candidates(google, youtube, 3, {1: "Alpha", 2: "Alpha", 3: "Alpha"})
    google.video(1, speech=[(0, "a few words and no more")])
    body = (await post(client, "/youtube/research", {**RESEARCH, "max_per_channel": 2, "max_videos": 2})).json()
    assert [video["id"] for video in body["videos"]] == [vid(2), vid(3)]  # in YouTube's order, with the failed first video left out
    assert [skipped["id"] for skipped in body["skipped"]] == [vid(1)]


async def test_with_a_deadline_gemini_gives_way_to_the_captions_in_time_and_says_so_in_the_log(client, google, youtube, monkeypatch, caplog):
    # Gemini gives way at 1 s and the captions then have a whole second before the deadline. Everything else answers at once
    # and Gemini stalls a minute over video 2, so no runner's speed can move the outcome.
    monkeypatch.setattr(youtube_api, "CAPTIONS_RESERVE_SECONDS", 1.0)
    for n in (1, 2):
        youtube.video(n)
        google.video(n, seconds=300)
    google.delays = {vid(2): 60.0}
    started = time.monotonic()
    body = (await post(client, "/youtube/research", {**RESEARCH, "max_videos": 2, "deadline_seconds": 2.0})).json()
    assert time.monotonic() - started < 30  # Gemini's minute over video 2 was cut short
    assert [(video["id"], video["source"]) for video in body["videos"]] == [(vid(1), "gemini"), (vid(2), "captions")]
    assert body["skipped"] == []
    assert f"Gemini gave no transcript for {vid(2)} (timeout: Gemini ran out of the time the request left it.); trying YouTube's captions" in [record.getMessage() for record in caplog.records]


async def test_a_batch_that_falls_back_to_the_captions_still_downloads_one_at_a_time(client, google, youtube, monkeypatch):
    set_env(monkeypatch, "RESEARCH_TOOLS_YOUTUBE_CAPTION_GAP_SECONDS", "0.2")
    for n in (1, 2, 3):
        youtube.video(n)
        google.video(n)
        google.count_replies[vid(n)] = (429, {})
    body = (await post(client, "/youtube/research", RESEARCH)).json()
    assert [(video["id"], video["source"]) for video in body["videos"]] == [(vid(n), "captions") for n in (1, 2, 3)]
    gaps = [later - earlier for earlier, later in zip(youtube.caption_times, youtube.caption_times[1:], strict=False)]
    assert len(gaps) == 2 and all(gap >= 0.15 for gap in gaps)
